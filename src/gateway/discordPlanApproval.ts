import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText } from "../harness/redaction.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type {
  INeonDiscordComponentActionContext,
  INeonDiscordComponentActionOutcome,
  INeonDiscordComponentActionRegistry
} from "./discordComponentActionRegistry.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import { readNeonGatewayRuns } from "./runStore.js";
import type { INeonGatewayShadowRun } from "./types.js";

export interface INeonDiscordPlanApprovalMarkerParseResult {
  readonly text: string;
  readonly planApproval?: {
    readonly planText: string;
  };
}

export type TNeonDiscordPlanApprovalStatus =
  | "pending"
  | "approved"
  | "revision-requested"
  | "discarded";

export interface INeonDiscordPlanApprovalSession {
  readonly version: 1;
  readonly approvalId: string;
  readonly runId: string;
  readonly ownerUserId: string;
  readonly sessionKey: string;
  readonly target: INeonDeliveryQueueTarget;
  readonly planText: string;
  readonly status: TNeonDiscordPlanApprovalStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly approvedRunId?: string;
  readonly revisionRequest?: string;
  readonly revisionRunId?: string;
  readonly actedByUserId?: string;
  readonly actedByDisplayName?: string;
}

export interface INeonDiscordPlanApprovalActionInput {
  readonly approvalId: string;
  readonly run: INeonGatewayShadowRun;
  readonly planText: string;
}

export interface INeonDiscordPlanRevisionInput extends INeonDiscordPlanApprovalActionInput {
  readonly request: string;
}

export interface INeonDiscordPlanApprovalTransport {
  postPublic(
    target: INeonDeliveryQueueTarget,
    content: string
  ): Promise<{ readonly messageId: string }>;
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }>;
}

export interface ICreateNeonDiscordPlanApprovalRuntimeOptions {
  readonly projectRoot: string;
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly transport: INeonDiscordPlanApprovalTransport;
  readonly disabledChannelIds?: readonly string[];
  readonly approve: (input: INeonDiscordPlanApprovalActionInput) => Promise<{ readonly runId: string }>;
  readonly requestRevision: (input: INeonDiscordPlanRevisionInput) => Promise<{ readonly runId: string }>;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export interface INeonDiscordPlanApprovalRuntime {
  present(
    run: INeonGatewayShadowRun,
    target: INeonDeliveryQueueTarget,
    planText: string
  ): Promise<{ readonly approvalId: string; readonly messageId: string } | undefined>;
  handleAction(context: INeonDiscordComponentActionContext): Promise<INeonDiscordComponentActionOutcome>;
}

export const NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION =
  "Discord work governance: Whenever the user asks you to create or edit a PDF, invoke $neon-pdf before touching the document and follow its preview, visual-review, and publish gates. Execute clear PDF and file tasks directly without a separate planning round. If the requested outcome is materially unclear, invoke $neon-grill-me and ask exactly one question in that reply, then wait. Invoke $grill-with-docs additionally only when the clarification establishes durable domain language or a genuinely hard-to-reverse architecture decision; never create documentation merely because a question was asked. Use approval only when the user explicitly requests a plan or when the task includes a genuinely risky or irreversible external action that needs a separate decision. In those exceptional cases, show one concise, testable plan and append exactly <NEON_PLAN_APPROVAL /> on its own final line. Do not append that marker to ordinary answers, clear document work, or already approved execution results. Only an explicit approval message produced by Neonika's plan-approval button authorizes execution; edit means revise the plan only, and discard means stop without executing.";

const NEON_DISCORD_DIRECT_WORK_GOVERNANCE_INSTRUCTION =
  "Discord work governance for this channel: Plan approval is disabled. Execute clear tasks directly. For PDF work, invoke $neon-pdf and follow its preview, visual-review, and publish gates without adding a separate planning round. If the requested outcome is materially unclear, invoke $neon-grill-me, ask exactly one question, and wait. Never emit a plan-approval marker in this channel.";

const PLAN_APPROVAL_MARKER_PATTERN = /<NEON_PLAN_APPROVAL\s*\/>/gu;
const PLAN_APPROVAL_ACTION_PREFIX = "plan-approval:";
const PLAN_APPROVAL_FIELD = "plan-change-request";
const PLAN_APPROVAL_TTL_MS = 30 * 60 * 1_000;
const PLAN_TEXT_MAX_LENGTH = 6_000;
const REVISION_REQUEST_MAX_LENGTH = 1_000;

export function parseNeonDiscordPlanApprovalMarker(
  text: string
): INeonDiscordPlanApprovalMarkerParseResult {
  const markerPresent = PLAN_APPROVAL_MARKER_PATTERN.test(text);
  PLAN_APPROVAL_MARKER_PATTERN.lastIndex = 0;
  const cleaned = text
    .replace(PLAN_APPROVAL_MARKER_PATTERN, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  PLAN_APPROVAL_MARKER_PATTERN.lastIndex = 0;
  if (!markerPresent || cleaned.length === 0) {
    return { text: cleaned };
  }
  const planText = normalizePlanText(cleaned);
  return { text: planText, planApproval: { planText } };
}

export function isNeonDiscordPlanApprovalActionType(actionType: string): boolean {
  return actionType.startsWith(PLAN_APPROVAL_ACTION_PREFIX);
}

export function resolveNeonDiscordWorkGovernanceInstruction(
  channelId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const disabledChannelIds = new Set(
    (env["NEON_DISCORD_PLAN_APPROVAL_DISABLED_CHANNELS"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
  return disabledChannelIds.has(channelId)
    ? NEON_DISCORD_DIRECT_WORK_GOVERNANCE_INSTRUCTION
    : NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION;
}

export function resolveNeonDiscordPlanApprovalSessionPath(
  projectRoot: string,
  approvalId: string
): string {
  return join(
    projectRoot,
    "state",
    "gateway",
    "plan-approvals",
    `${requireApprovalId(approvalId)}.json`
  );
}

export function createNeonDiscordPlanApprovalRuntime(
  options: ICreateNeonDiscordPlanApprovalRuntimeOptions
): INeonDiscordPlanApprovalRuntime {
  const now = options.now ?? (() => new Date());
  const ttlMs = normalizeTtl(options.ttlMs);
  const disabledChannelIds = new Set(
    (options.disabledChannelIds ?? [])
      .map((channelId) => channelId.trim())
      .filter((channelId) => channelId.length > 0)
  );

  const handleAction = async (
    context: INeonDiscordComponentActionContext
  ): Promise<INeonDiscordComponentActionOutcome> => {
    const approvalId = requireApprovalId(context.resourceRef ?? "");
    const session = await requireOpenSession(options.projectRoot, approvalId, context, now());

    if (context.actionType === `${PLAN_APPROVAL_ACTION_PREFIX}edit`) {
      const modalAction = options.registry.register({
        ownerUserId: session.ownerUserId,
        ...(session.target.guildId ? { guildId: session.target.guildId } : {}),
        channelId: session.target.threadId ?? session.target.channelId,
        sessionKey: session.sessionKey,
        actionType: `${PLAN_APPROVAL_ACTION_PREFIX}revision-submit`,
        interactionKind: "modal-submit",
        resourceRef: session.approvalId,
        expiresAt: session.expiresAt,
        handler: handleAction
      });
      return {
        message: "Änderungsdialog geöffnet.",
        modal: {
          customId: modalAction.customId,
          title: "Plan bearbeiten",
          inputs: [
            {
              customId: PLAN_APPROVAL_FIELD,
              label: "Was soll am Plan geändert werden?",
              style: "paragraph",
              placeholder: "Eine konkrete Änderung beschreiben",
              required: true,
              minLength: 3,
              maxLength: REVISION_REQUEST_MAX_LENGTH
            }
          ]
        }
      };
    }

    if (context.actionType === `${PLAN_APPROVAL_ACTION_PREFIX}revision-submit`) {
      const request = normalizeRevisionRequest(context.interaction.fields?.[PLAN_APPROVAL_FIELD]);
      const sourceRun = await readSourceRun(options.projectRoot, session.runId);
      const revision = await options.requestRevision({
        approvalId,
        run: sourceRun,
        planText: session.planText,
        request
      });
      await writeNeonDiscordPlanApprovalSession(options.projectRoot, {
        ...session,
        status: "revision-requested",
        revisionRequest: request,
        revisionRunId: revision.runId,
        ...resolveActorAudit(context),
        updatedAt: now().toISOString()
      });
      return {
        message: "Änderung übernommen. Ein neuer Plan wird erstellt.",
        publicMessage: `✏️ Planänderung von ${resolveActorLabel(context)} angefordert.`
      };
    }

    if (context.actionType === `${PLAN_APPROVAL_ACTION_PREFIX}discard`) {
      await writeNeonDiscordPlanApprovalSession(options.projectRoot, {
        ...session,
        status: "discarded",
        ...resolveActorAudit(context),
        updatedAt: now().toISOString()
      });
      return {
        message: "Plan verworfen. Es wurde nichts ausgeführt.",
        publicMessage: `❌ Plan verworfen von ${resolveActorLabel(context)}.`
      };
    }

    if (context.actionType !== `${PLAN_APPROVAL_ACTION_PREFIX}approve`) {
      throw new Error("Unknown Discord plan approval action");
    }

    const publicMessage = `✅ Plan genehmigt von ${resolveActorLabel(context)}. Die Ausführung startet.`;
    await options.transport.postPublic(session.target, publicMessage);
    const sourceRun = await readSourceRun(options.projectRoot, session.runId);
    const approved = await options.approve({
      approvalId,
      run: sourceRun,
      planText: session.planText
    });
    await writeNeonDiscordPlanApprovalSession(options.projectRoot, {
      ...session,
      status: "approved",
      approvedRunId: approved.runId,
      ...resolveActorAudit(context),
      updatedAt: now().toISOString()
    });
    return {
      message: "Plan genehmigt. Die Ausführung läuft im Channel."
    };
  };

  return {
    present: async (run, target, untrustedPlanText) => {
      if (disabledChannelIds.has(target.channelId)) {
        return undefined;
      }
      const approvalId = createApprovalId();
      const timestamp = now();
      const expiresAt = new Date(timestamp.getTime() + ttlMs).toISOString();
      const session: INeonDiscordPlanApprovalSession = {
        version: 1,
        approvalId,
        runId: run.runId,
        ownerUserId: run.request.userId,
        sessionKey: run.harnessSessionKey,
        target,
        planText: normalizePlanText(untrustedPlanText),
        status: "pending",
        expiresAt,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString()
      };
      await writeNeonDiscordPlanApprovalSession(options.projectRoot, session);
      const consumptionKey = `${PLAN_APPROVAL_ACTION_PREFIX}${approvalId}`;
      const buttons = [
        registerDecisionButton(options.registry, session, "approve", "Genehmigen", "success", consumptionKey, handleAction),
        registerDecisionButton(options.registry, session, "edit", "Bearbeiten", "primary", consumptionKey, handleAction, "modal"),
        registerDecisionButton(options.registry, session, "discard", "Verwerfen", "danger", consumptionKey, handleAction)
      ];
      try {
        const posted = await options.transport.postComponents(target, "Plan prüfen und freigeben:", [
          { buttons }
        ]);
        return { approvalId, messageId: posted.messageId };
      } catch {
        return undefined;
      }
    },
    handleAction
  };
}

export async function readNeonDiscordPlanApprovalSession(
  projectRoot: string,
  approvalId: string
): Promise<INeonDiscordPlanApprovalSession | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(resolveNeonDiscordPlanApprovalSessionPath(projectRoot, approvalId), "utf8")
    );
    return parseSession(parsed);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function requireOpenSession(
  projectRoot: string,
  approvalId: string,
  context: INeonDiscordComponentActionContext,
  currentTime: Date
): Promise<INeonDiscordPlanApprovalSession> {
  const session = await readNeonDiscordPlanApprovalSession(projectRoot, approvalId);
  if (!session) {
    throw new Error("Discord plan approval session is unavailable");
  }
  if (session.sessionKey !== context.sessionKey) {
    throw new Error("Discord plan approval session scope changed");
  }
  if (session.status !== "pending") {
    throw new Error("Discord plan approval is no longer pending");
  }
  if (Date.parse(session.expiresAt) <= currentTime.getTime()) {
    throw new Error("Discord plan approval session expired");
  }
  return session;
}

function registerDecisionButton(
  registry: INeonDiscordComponentActionRegistry,
  session: INeonDiscordPlanApprovalSession,
  action: "approve" | "edit" | "discard",
  label: string,
  style: "success" | "primary" | "danger",
  consumptionKey: string,
  handler: (context: INeonDiscordComponentActionContext) => Promise<INeonDiscordComponentActionOutcome>,
  responseMode?: "modal"
): { readonly label: string; readonly style: "success" | "primary" | "danger"; readonly customId: string } {
  const registered = registry.register({
    ownerUserId: session.ownerUserId,
    ...(action === "approve" ? { audience: "channel" as const } : {}),
    ...(session.target.guildId ? { guildId: session.target.guildId } : {}),
    channelId: session.target.threadId ?? session.target.channelId,
    sessionKey: session.sessionKey,
    actionType: `${PLAN_APPROVAL_ACTION_PREFIX}${action}`,
    interactionKind: "button",
    ...(responseMode ? { responseMode } : {}),
    consumptionKey,
    resourceRef: session.approvalId,
    expiresAt: session.expiresAt,
    handler
  });
  return { label, style, customId: registered.customId };
}

function resolveActorAudit(
  context: INeonDiscordComponentActionContext
): Pick<INeonDiscordPlanApprovalSession, "actedByUserId" | "actedByDisplayName"> {
  const actedByDisplayName = normalizeActorDisplayName(context.interaction.userDisplayName);
  return {
    actedByUserId: context.interaction.userId,
    ...(actedByDisplayName ? { actedByDisplayName } : {})
  };
}

function resolveActorLabel(context: INeonDiscordComponentActionContext): string {
  return normalizeActorDisplayName(context.interaction.userDisplayName) ?? "einem Channel-Mitglied";
}

function normalizeActorDisplayName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = redactText(value.trim()).replaceAll("@", "@​").slice(0, 80).trim();
  return normalized.length > 0 ? normalized : undefined;
}

async function writeNeonDiscordPlanApprovalSession(
  projectRoot: string,
  session: INeonDiscordPlanApprovalSession
): Promise<void> {
  const path = resolveNeonDiscordPlanApprovalSessionPath(projectRoot, session.approvalId);
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readSourceRun(projectRoot: string, runId: string): Promise<INeonGatewayShadowRun> {
  const run = (await readNeonGatewayRuns(projectRoot)).find((candidate) => candidate.runId === runId);
  if (!run) {
    throw new Error("Discord plan approval source run is unavailable");
  }
  return run;
}

function parseSession(value: unknown): INeonDiscordPlanApprovalSession {
  const record = requireRecord(value, "Discord plan approval session");
  const version = requireNumber(record, "version");
  if (version !== 1) {
    throw new Error("Discord plan approval session version is invalid");
  }
  const status = requireString(record, "status");
  if (!isPlanApprovalStatus(status)) {
    throw new Error("Discord plan approval session status is invalid");
  }
  const targetRecord = requireRecord(record["target"], "Discord plan approval target");
  const guildId = optionalString(targetRecord, "guildId");
  const threadId = optionalString(targetRecord, "threadId");
  const replyToMessageId = optionalString(targetRecord, "replyToMessageId");
  const target: INeonDeliveryQueueTarget = {
    channel: "discord",
    accountId: requireString(targetRecord, "accountId"),
    ...(guildId ? { guildId } : {}),
    channelId: requireString(targetRecord, "channelId"),
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {})
  };
  const approvedRunId = optionalString(record, "approvedRunId");
  const revisionRequest = optionalString(record, "revisionRequest");
  const revisionRunId = optionalString(record, "revisionRunId");
  const actedByUserId = optionalString(record, "actedByUserId");
  const actedByDisplayName = optionalString(record, "actedByDisplayName");
  const session: INeonDiscordPlanApprovalSession = {
    version: 1,
    approvalId: requireApprovalId(requireString(record, "approvalId")),
    runId: requireString(record, "runId"),
    ownerUserId: requireString(record, "ownerUserId"),
    sessionKey: requireString(record, "sessionKey"),
    target,
    planText: normalizePlanText(requireString(record, "planText")),
    status,
    expiresAt: requireTimestamp(record, "expiresAt"),
    createdAt: requireTimestamp(record, "createdAt"),
    updatedAt: requireTimestamp(record, "updatedAt"),
    ...(approvedRunId ? { approvedRunId } : {}),
    ...(revisionRequest ? { revisionRequest } : {}),
    ...(revisionRunId ? { revisionRunId } : {}),
    ...(actedByUserId ? { actedByUserId } : {}),
    ...(actedByDisplayName ? { actedByDisplayName } : {})
  };
  return session;
}

function normalizePlanText(value: string): string {
  const normalized = redactText(value.trim()).slice(0, PLAN_TEXT_MAX_LENGTH).trim();
  if (normalized.length === 0) {
    throw new Error("Discord plan approval requires a non-empty plan");
  }
  return normalized;
}

function normalizeRevisionRequest(value: string | undefined): string {
  const normalized = redactText(value?.trim() ?? "").slice(0, REVISION_REQUEST_MAX_LENGTH).trim();
  if (normalized.length < 3) {
    throw new Error("Discord plan revision request is too short");
  }
  return normalized;
}

function normalizeTtl(value: number | undefined): number {
  const ttlMs = value ?? PLAN_APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
    throw new Error("Discord plan approval ttlMs is invalid");
  }
  return ttlMs;
}

function createApprovalId(): string {
  return randomBytes(18).toString("base64url");
}

function requireApprovalId(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(value)) {
    throw new Error("Discord plan approval id is invalid");
  }
  return value;
}

function isPlanApprovalStatus(value: string): value is TNeonDiscordPlanApprovalStatus {
  return value === "pending" || value === "approved" || value === "revision-requested" || value === "discarded";
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Discord plan approval ${key} is invalid`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Discord plan approval ${key} is invalid`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Discord plan approval ${key} is invalid`);
  }
  return value;
}

function requireTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireString(record, key);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Discord plan approval ${key} is invalid`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
