/**
 * Adapted in part from OpenClaw extensions/discord/src/approval-handler.runtime.ts.
 * See THIRD_PARTY_NOTICES.md for attribution and license details.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText } from "../harness/redaction.js";
import type { INeonGatewayShadowRun, TNeonGatewayRunStatus } from "./types.js";
import { readNeonGatewayRuns } from "./runStore.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import {
  createNeonDeliveryPayloadHash,
  executeNeonExactlyOnceDelivery
} from "./deliveryReceiptStore.js";
import type {
  INeonDiscordComponentActionContext,
  INeonDiscordComponentActionOutcome,
  INeonDiscordComponentActionRegistry
} from "./discordComponentActionRegistry.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import type { INeonDiscordEmbed } from "./discordRichPayload.js";
import {
  formatNeonDiscordExpiryCountdown,
  neonDiscordSeverityColors
} from "./discordUiColors.js";
import type { INeonOutboundSendResult } from "./outboundSender.js";

export type TNeonDiscordRecoveryAction = "retry" | "continue" | "close";
export type TNeonDiscordRecoveryStatus =
  | "preparing"
  | "pending"
  | "running"
  | "recovered"
  | "failed-again"
  | "closed";

export interface INeonDiscordRecoverySession {
  readonly version: 1;
  readonly recoveryId: string;
  readonly runId: string;
  readonly ownerUserId: string;
  readonly sessionKey: string;
  readonly target: INeonDeliveryQueueTarget;
  readonly allowedActions: readonly TNeonDiscordRecoveryAction[];
  readonly status: TNeonDiscordRecoveryStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly retryCustomId?: string;
  readonly continueCustomId?: string;
  readonly closeCustomId?: string;
  readonly cardMessageId?: string;
  readonly selectedAction?: TNeonDiscordRecoveryAction;
  readonly recoveryRunId?: string;
  readonly recoveryRunStatus?: TNeonGatewayRunStatus;
}

export interface INeonDiscordRecoveryTransport {
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[],
    embeds?: readonly INeonDiscordEmbed[]
  ): Promise<{ readonly messageId: string }>;
}

export interface INeonDiscordRecoveryExecutionRequest {
  readonly action: Exclude<TNeonDiscordRecoveryAction, "close">;
  readonly run: INeonGatewayShadowRun;
}

export interface ICreateNeonDiscordRecoveryRuntimeOptions {
  readonly projectRoot: string;
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly transport: INeonDiscordRecoveryTransport;
  readonly canContinue: (run: INeonGatewayShadowRun) => Promise<boolean>;
  readonly execute: (
    request: INeonDiscordRecoveryExecutionRequest
  ) => Promise<{ readonly runId: string; readonly status: TNeonGatewayRunStatus }>;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export type TNeonDiscordRecoveryStartResult =
  | { readonly state: "not-applicable"; readonly reason: "run-not-failed" | "not-discord" | "recovery-resolved" }
  | { readonly state: "recovery-pending"; readonly recoveryId: string; readonly messageId: string }
  | { readonly state: "transport-error"; readonly recoveryId: string };

export interface INeonDiscordRecoveryRuntime {
  start(run: INeonGatewayShadowRun): Promise<TNeonDiscordRecoveryStartResult>;
  handleAction(context: INeonDiscordComponentActionContext): Promise<INeonDiscordComponentActionOutcome>;
}

const RECOVERY_ACTION_PREFIX = "run-recovery:";
const DEFAULT_RECOVERY_TTL_MS = 30 * 60 * 1_000;

export function isNeonDiscordRecoveryActionType(actionType: string): boolean {
  return actionType.startsWith(RECOVERY_ACTION_PREFIX);
}

export function resolveNeonDiscordRecoverySessionPath(projectRoot: string, recoveryId: string): string {
  return join(
    projectRoot,
    "state",
    "gateway",
    "discord-recoveries",
    `${requireRecoveryId(recoveryId)}.json`
  );
}

export async function readNeonDiscordRecoverySession(
  projectRoot: string,
  recoveryId: string
): Promise<INeonDiscordRecoverySession | undefined> {
  try {
    return parseRecoverySession(
      JSON.parse(await readFile(resolveNeonDiscordRecoverySessionPath(projectRoot, recoveryId), "utf8"))
    );
  } catch {
    return undefined;
  }
}

export function createNeonDiscordRecoveryRuntime(
  options: ICreateNeonDiscordRecoveryRuntimeOptions
): INeonDiscordRecoveryRuntime {
  const now = options.now ?? (() => new Date());
  const ttlMs = normalizeTtl(options.ttlMs);

  const handleAction = async (
    context: INeonDiscordComponentActionContext
  ): Promise<INeonDiscordComponentActionOutcome> => {
    const recoveryId = requireRecoveryId(context.resourceRef ?? "");
    const session = await readNeonDiscordRecoverySession(options.projectRoot, recoveryId);
    if (!session) {
      throw new Error("Discord recovery session is unavailable");
    }
    if (session.ownerUserId !== context.interaction.userId || session.sessionKey !== context.sessionKey) {
      throw new Error("Discord recovery session scope changed");
    }
    if (session.status !== "pending" || Date.parse(session.expiresAt) <= now().getTime()) {
      throw new Error("Discord recovery session is no longer pending");
    }
    const action = parseRecoveryActionType(context.actionType);
    if (!session.allowedActions.includes(action)) {
      throw new Error("Discord recovery action is not allowed for this run");
    }
    if (action === "close") {
      await writeRecoverySession(options.projectRoot, {
        ...session,
        status: "closed",
        selectedAction: action,
        updatedAt: now().toISOString()
      });
      return { message: "Recovery geschlossen. Es wurde kein neuer Lauf gestartet." };
    }

    const run = (await readNeonGatewayRuns(options.projectRoot)).find((candidate) => candidate.runId === session.runId);
    if (!run || run.status !== "failed") {
      throw new Error("Failed run for Discord recovery is unavailable");
    }
    await writeRecoverySession(options.projectRoot, {
      ...session,
      status: "running",
      selectedAction: action,
      updatedAt: now().toISOString()
    });
    try {
      const executed = await options.execute({ action, run });
      const recovered = executed.status === "completed";
      await writeRecoverySession(options.projectRoot, {
        ...session,
        status: recovered ? "recovered" : "failed-again",
        selectedAction: action,
        recoveryRunId: executed.runId,
        recoveryRunStatus: executed.status,
        updatedAt: now().toISOString()
      });
      return {
        message: recovered
          ? `Recovery abgeschlossen. Neuer Lauf: ${redactText(executed.runId).slice(0, 80)}.`
          : "Recovery ausgeführt, der neue Lauf ist jedoch nicht erfolgreich abgeschlossen."
      };
    } catch {
      await writeRecoverySession(options.projectRoot, {
        ...session,
        status: "failed-again",
        selectedAction: action,
        updatedAt: now().toISOString()
      });
      throw new Error("Discord recovery execution failed");
    }
  };

  return {
    start: async (run) => {
      if (run.status !== "failed") {
        return { state: "not-applicable", reason: "run-not-failed" };
      }
      if (run.request.channel !== "discord") {
        return { state: "not-applicable", reason: "not-discord" };
      }
      const recoveryId = createRecoveryId(run);
      const existing = await readNeonDiscordRecoverySession(options.projectRoot, recoveryId);
      if (existing?.status === "pending" && existing.cardMessageId) {
        return { state: "recovery-pending", recoveryId, messageId: existing.cardMessageId };
      }
      if (existing?.status === "pending") {
        return { state: "transport-error", recoveryId };
      }
      if (existing && existing.status !== "preparing") {
        return { state: "not-applicable", reason: "recovery-resolved" };
      }
      if (existing && Date.parse(existing.expiresAt) <= now().getTime()) {
        return { state: "transport-error", recoveryId };
      }
      const timestamp = now().toISOString();
      let session = existing?.status === "preparing" && hasRegisteredRecoveryActions(existing)
        ? existing
        : await prepareRecoverySession(options, run, recoveryId, timestamp, ttlMs, handleAction);
      const target = session.target;
      const rows = createRecoveryRows(session);
      const body = "⚠️ Lauf fehlgeschlagen. Wähle eine sichere Recovery-Aktion für diese Session.";
      // Severity-colored card with a client-side live countdown, rebuilt after
      // OpenClaw's approval cards (extensions/discord/src/approval-handler.runtime.ts).
      const embed: INeonDiscordEmbed = {
        description: `Läuft ab ${formatNeonDiscordExpiryCountdown(session.expiresAt)}`,
        color: neonDiscordSeverityColors.critical
      };
      const delivery = await executeNeonExactlyOnceDelivery({
        projectRoot: options.projectRoot,
        intentId: `run-recovery-card:${recoveryId}`,
        runId: run.runId,
        kind: "text",
        target,
        payloadHash: createNeonDeliveryPayloadHash([
          body,
          embed.description ?? "",
          ...rows.flatMap((row) => "buttons" in row ? row.buttons.map((button) => button.customId ?? "") : [])
        ]),
        now,
        send: async (deliveryTarget) => {
          const posted = await options.transport.postComponents(deliveryTarget, body, rows, [embed]);
          return toOutboundResult(deliveryTarget, body, posted.messageId, now());
        }
      });
      if ((delivery.state !== "delivered" && delivery.state !== "already-delivered") || !delivery.messageId) {
        return { state: "transport-error", recoveryId };
      }
      session = {
        ...session,
        status: "pending",
        cardMessageId: delivery.messageId,
        updatedAt: now().toISOString()
      };
      await writeRecoverySession(options.projectRoot, session);
      return { state: "recovery-pending", recoveryId, messageId: delivery.messageId };
    },
    handleAction
  };
}

async function prepareRecoverySession(
  options: ICreateNeonDiscordRecoveryRuntimeOptions,
  run: INeonGatewayShadowRun,
  recoveryId: string,
  timestamp: string,
  ttlMs: number,
  handler: (context: INeonDiscordComponentActionContext) => Promise<INeonDiscordComponentActionOutcome>
): Promise<INeonDiscordRecoverySession> {
  const expiresAt = new Date(Date.parse(timestamp) + ttlMs).toISOString();
  const canContinue = run.harnessId === "codex-app-server" && await options.canContinue(run);
  const allowedActions: readonly TNeonDiscordRecoveryAction[] = [
    ...(run.request.messageId ? ["retry" as const] : []),
    ...(canContinue ? ["continue" as const] : []),
    "close"
  ];
  const target: INeonDeliveryQueueTarget = {
    channel: "discord",
    accountId: run.request.accountId,
    ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
    channelId: run.request.channelId,
    ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
    ...(run.request.messageId ? { replyToMessageId: run.request.messageId } : {})
  };
  let session: INeonDiscordRecoverySession = {
    version: 1,
    recoveryId,
    runId: run.runId,
    ownerUserId: run.request.userId,
    sessionKey: run.harnessSessionKey,
    target,
    allowedActions,
    status: "preparing",
    expiresAt,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await writeRecoverySession(options.projectRoot, session);
  const actionIds = new Map<TNeonDiscordRecoveryAction, string>();
  for (const action of allowedActions) {
    const registered = options.registry.register({
      ownerUserId: session.ownerUserId,
      ...(target.guildId ? { guildId: target.guildId } : {}),
      channelId: target.threadId ?? target.channelId,
      sessionKey: session.sessionKey,
      actionType: `${RECOVERY_ACTION_PREFIX}${action}`,
      interactionKind: "button",
      consumptionKey: `run-recovery:${recoveryId}`,
      resourceRef: recoveryId,
      expiresAt,
      handler
    });
    actionIds.set(action, registered.customId);
  }
  const retryCustomId = actionIds.get("retry");
  const continueCustomId = actionIds.get("continue");
  const closeCustomId = actionIds.get("close");
  session = {
    ...session,
    ...(retryCustomId ? { retryCustomId } : {}),
    ...(continueCustomId ? { continueCustomId } : {}),
    ...(closeCustomId ? { closeCustomId } : {}),
    updatedAt: timestamp
  };
  await writeRecoverySession(options.projectRoot, session);
  return session;
}

function hasRegisteredRecoveryActions(session: INeonDiscordRecoverySession): boolean {
  return session.allowedActions.every((action) =>
    action === "retry"
      ? Boolean(session.retryCustomId)
      : action === "continue"
        ? Boolean(session.continueCustomId)
        : Boolean(session.closeCustomId)
  );
}

function createRecoveryRows(session: INeonDiscordRecoverySession): readonly TNeonDiscordActionRow[] {
  const buttons = [
    ...(session.retryCustomId
      ? [{ label: "Erneut versuchen", style: "primary" as const, customId: session.retryCustomId }]
      : []),
    ...(session.continueCustomId
      ? [{ label: "Fortsetzen", style: "secondary" as const, customId: session.continueCustomId }]
      : []),
    ...(session.closeCustomId
      ? [{ label: "Schließen", style: "danger" as const, customId: session.closeCustomId }]
      : [])
  ];
  if (buttons.length === 0) {
    throw new Error("Discord recovery session has no registered actions");
  }
  return [{ buttons }];
}

function parseRecoveryActionType(actionType: string): TNeonDiscordRecoveryAction {
  const action = actionType.slice(RECOVERY_ACTION_PREFIX.length);
  if (action === "retry" || action === "continue" || action === "close") {
    return action;
  }
  throw new Error("Unknown Discord recovery action");
}

async function writeRecoverySession(projectRoot: string, session: INeonDiscordRecoverySession): Promise<void> {
  const path = resolveNeonDiscordRecoverySessionPath(projectRoot, session.recoveryId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

function parseRecoverySession(value: unknown): INeonDiscordRecoverySession | undefined {
  if (!isRecord(value) || value["version"] !== 1) {
    return undefined;
  }
  const recoveryId = readString(value["recoveryId"], 32);
  const runId = readString(value["runId"], 200);
  const ownerUserId = readString(value["ownerUserId"], 100);
  const sessionKey = readString(value["sessionKey"], 200);
  const target = parseTarget(value["target"]);
  const allowedActions = parseAllowedActions(value["allowedActions"]);
  const status = parseRecoveryStatus(value["status"]);
  const expiresAt = readTimestamp(value["expiresAt"]);
  const createdAt = readTimestamp(value["createdAt"]);
  const updatedAt = readTimestamp(value["updatedAt"]);
  if (!recoveryId || !runId || !ownerUserId || !sessionKey || !target || !allowedActions || !status || !expiresAt || !createdAt || !updatedAt) {
    return undefined;
  }
  const retryCustomId = readString(value["retryCustomId"], 100);
  const continueCustomId = readString(value["continueCustomId"], 100);
  const closeCustomId = readString(value["closeCustomId"], 100);
  const cardMessageId = readString(value["cardMessageId"], 100);
  const selectedAction = parseOptionalRecoveryAction(value["selectedAction"]);
  const recoveryRunId = readString(value["recoveryRunId"], 200);
  const recoveryRunStatus = parseOptionalRunStatus(value["recoveryRunStatus"]);
  return {
    version: 1,
    recoveryId,
    runId,
    ownerUserId,
    sessionKey,
    target,
    allowedActions,
    status,
    expiresAt,
    createdAt,
    updatedAt,
    ...(retryCustomId ? { retryCustomId } : {}),
    ...(continueCustomId ? { continueCustomId } : {}),
    ...(closeCustomId ? { closeCustomId } : {}),
    ...(cardMessageId ? { cardMessageId } : {}),
    ...(selectedAction ? { selectedAction } : {}),
    ...(recoveryRunId ? { recoveryRunId } : {}),
    ...(recoveryRunStatus ? { recoveryRunStatus } : {})
  };
}

function parseTarget(value: unknown): INeonDeliveryQueueTarget | undefined {
  if (!isRecord(value) || value["channel"] !== "discord") {
    return undefined;
  }
  const accountId = readString(value["accountId"], 100);
  const channelId = readString(value["channelId"], 100);
  if (!accountId || !channelId) {
    return undefined;
  }
  const guildId = readString(value["guildId"], 100);
  const threadId = readString(value["threadId"], 100);
  const replyToMessageId = readString(value["replyToMessageId"], 100);
  return {
    channel: "discord",
    accountId,
    channelId,
    ...(guildId ? { guildId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {})
  };
}

function parseAllowedActions(value: unknown): readonly TNeonDiscordRecoveryAction[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    return undefined;
  }
  const actions = value.filter((entry): entry is TNeonDiscordRecoveryAction => entry === "retry" || entry === "continue" || entry === "close");
  return actions.length === value.length && new Set(actions).size === actions.length ? actions : undefined;
}

function parseRecoveryStatus(value: unknown): TNeonDiscordRecoveryStatus | undefined {
  return value === "preparing" || value === "pending" || value === "running" || value === "recovered" || value === "failed-again" || value === "closed"
    ? value
    : undefined;
}

function parseOptionalRecoveryAction(value: unknown): TNeonDiscordRecoveryAction | undefined {
  return value === "retry" || value === "continue" || value === "close" ? value : undefined;
}

function parseOptionalRunStatus(value: unknown): TNeonGatewayRunStatus | undefined {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled" ? value : undefined;
}

function createRecoveryId(run: INeonGatewayShadowRun): string {
  return createHash("sha256")
    .update(`${run.runId}\0${run.harnessSessionKey}\0${run.request.userId}`)
    .digest("hex")
    .slice(0, 32);
}

function requireRecoveryId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-f0-9]{32}$/u.test(normalized)) {
    throw new Error("Discord recovery id is invalid");
  }
  return normalized;
}

function toOutboundResult(
  target: INeonDeliveryQueueTarget,
  body: string,
  messageId: string,
  sentAt: Date
): INeonOutboundSendResult {
  return {
    outboundSent: true,
    target,
    bodyPreview: redactText(body).slice(0, 280),
    cutoverStage: "canary",
    messageId,
    sentAt: sentAt.toISOString()
  };
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_RECOVERY_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 24 * 60 * 60 * 1_000) {
    throw new Error("Discord recovery ttlMs must be between 1 minute and 24 hours");
  }
  return ttl;
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
