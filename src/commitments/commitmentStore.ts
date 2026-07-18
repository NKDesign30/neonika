import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";

/**
 * Commitment store + lifecycle + read-only due-view (P4 Automation).
 *
 * A commitment is a promise/follow-up the agent would proactively surface
 * ("check in after the event", "deadline is tomorrow"). This module persists
 * commitments (gated, append-only JSONL), runs the pure status state-machine,
 * and answers the read-only question "which commitments would be due now" —
 * WITHOUT sending anything (shadow contract: outbound stays suppressed).
 *
 * Gated like the other persistence seams: writing requires
 * `NEON_COMMITMENTS_STORE_ENABLED` (default-off) AND an explicit isolated
 * `storePath`. Reads are always allowed.
 *
 * Deliberately leaner than upstream `src/commitments/store.ts`: redaction-first
 * (suggestedText through `redactText`), and the deprecated raw sourceUserText /
 * sourceAssistantText fields are dropped (the gap-MD flags them "do not replay").
 * LLM extraction (candidate inference) and real delivery stay out of scope —
 * they need a model gate and the canary cutover respectively.
 */
export type TNeonCommitmentKind =
  | "event_check_in"
  | "deadline_check"
  | "care_check_in"
  | "open_loop";

export type TNeonCommitmentStatus = "pending" | "sent" | "dismissed" | "snoozed" | "expired";

export type TNeonCommitmentSource = "inferred_user_context" | "agent_promise";

export interface INeonCommitmentDueWindow {
  readonly earliestMs: number;
  readonly latestMs: number;
  readonly timezone: string;
}

export interface INeonCommitmentRecord {
  readonly id: string;
  readonly agentId: string;
  readonly sessionKey: string;
  readonly channel: string;
  readonly kind: TNeonCommitmentKind;
  readonly source: TNeonCommitmentSource;
  readonly status: TNeonCommitmentStatus;
  /** Redacted suggested delivery text. */
  readonly suggestedText: string;
  readonly dedupeKey: string;
  readonly confidence: number;
  readonly dueWindow: INeonCommitmentDueWindow;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly attempts: number;
  readonly sentAtMs?: number;
  readonly dismissedAtMs?: number;
  readonly snoozedUntilMs?: number;
  readonly expiredAtMs?: number;
}

export interface IBuildNeonCommitmentInput {
  readonly id: string;
  readonly agentId: string;
  readonly sessionKey: string;
  readonly channel: string;
  readonly kind: TNeonCommitmentKind;
  readonly source: TNeonCommitmentSource;
  readonly suggestedText: string;
  readonly dedupeKey: string;
  readonly confidence: number;
  readonly dueWindow: INeonCommitmentDueWindow;
}

const commitmentStoreEnabledEnvKey = "NEON_COMMITMENTS_STORE_ENABLED";

export interface INeonCommitmentStoreGate {
  readonly enabled: boolean;
  readonly reason: "store-enabled" | "store-disabled";
  readonly envKey: typeof commitmentStoreEnabledEnvKey;
}

export type TNeonCommitmentAppendState = "appended" | "blocked";

export interface INeonCommitmentAppendResult {
  readonly state: TNeonCommitmentAppendState;
  readonly gate: INeonCommitmentStoreGate;
  readonly storePath?: string;
  readonly commitmentId?: string;
  readonly diagnostics: readonly string[];
}

export type TNeonCommitmentTransition =
  | { readonly applied: true; readonly commitment: INeonCommitmentRecord }
  | { readonly applied: false; readonly reason: string };

const ACTIVE_STATUSES: ReadonlySet<TNeonCommitmentStatus> = new Set<TNeonCommitmentStatus>([
  "pending",
  "snoozed"
]);

export function resolveNeonCommitmentStoreGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCommitmentStoreGate {
  const enabled = readReadyCutoverEnv(env, commitmentStoreEnabledEnvKey);
  return {
    enabled,
    reason: enabled ? "store-enabled" : "store-disabled",
    envKey: commitmentStoreEnabledEnvKey
  };
}

export function resolveNeonCommitmentStorePath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "commitments", "commitments.jsonl");
}

export function isActiveNeonCommitmentStatus(status: TNeonCommitmentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function buildNeonCommitmentRecord(
  input: IBuildNeonCommitmentInput,
  nowMs: number
): INeonCommitmentRecord {
  return {
    id: input.id,
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    channel: input.channel,
    kind: input.kind,
    source: input.source,
    status: "pending",
    suggestedText: redactText(input.suggestedText),
    dedupeKey: input.dedupeKey,
    confidence: clampConfidence(input.confidence),
    dueWindow: input.dueWindow,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    attempts: 0
  };
}

/**
 * Pure status transition. Only active (pending/snoozed) commitments transition;
 * a snooze needs an explicit `snoozedUntilMs`. Returns the updated record on a
 * valid transition, or a reason on an invalid one — never mutates the input.
 */
export function applyNeonCommitmentStatus(
  commitment: INeonCommitmentRecord,
  status: TNeonCommitmentStatus,
  nowMs: number,
  options: { readonly snoozedUntilMs?: number } = {}
): TNeonCommitmentTransition {
  if (!isActiveNeonCommitmentStatus(commitment.status)) {
    return {
      applied: false,
      reason: `commitment ${commitment.id} is ${commitment.status} (inactive); no transition`
    };
  }
  if (status === "pending") {
    return { applied: false, reason: "cannot transition back to pending" };
  }
  if (status === "snoozed" && options.snoozedUntilMs === undefined) {
    return { applied: false, reason: "snooze requires snoozedUntilMs" };
  }

  const next: INeonCommitmentRecord = {
    ...commitment,
    status,
    updatedAtMs: nowMs,
    ...(status === "sent" ? { sentAtMs: nowMs } : {}),
    ...(status === "dismissed" ? { dismissedAtMs: nowMs } : {}),
    ...(status === "expired" ? { expiredAtMs: nowMs } : {}),
    ...(status === "snoozed" && options.snoozedUntilMs !== undefined
      ? { snoozedUntilMs: options.snoozedUntilMs }
      : {})
  };
  return { applied: true, commitment: next };
}

export async function appendNeonCommitment(options: {
  readonly commitment: INeonCommitmentRecord;
  readonly gate: INeonCommitmentStoreGate;
  readonly storePath?: string;
}): Promise<INeonCommitmentAppendResult> {
  if (!options.gate.enabled || !options.storePath) {
    return {
      state: "blocked",
      gate: options.gate,
      ...(options.storePath ? { storePath: options.storePath } : {}),
      diagnostics: [
        "commitment-store blocked: requires NEON_COMMITMENTS_STORE_ENABLED and an explicit isolated storePath"
      ]
    };
  }

  await mkdir(dirname(options.storePath), { recursive: true });
  await appendFile(options.storePath, `${JSON.stringify(options.commitment)}\n`, "utf8");

  return {
    state: "appended",
    gate: options.gate,
    storePath: options.storePath,
    commitmentId: options.commitment.id,
    diagnostics: [`commitment appended (${options.commitment.status})`]
  };
}

export async function readNeonCommitments(options: {
  readonly storePath: string;
}): Promise<readonly INeonCommitmentRecord[]> {
  let raw: string;
  try {
    raw = await readFile(options.storePath, "utf8");
  } catch {
    return [];
  }

  const records = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCommitment)
    .filter((record): record is INeonCommitmentRecord => record !== undefined);

  return projectLatestCommitmentPerId(records);
}

export function findActiveNeonCommitmentByDedupeKey(
  commitments: readonly INeonCommitmentRecord[],
  dedupeKey: string
): INeonCommitmentRecord | undefined {
  return commitments.find(
    (commitment) =>
      commitment.dedupeKey === dedupeKey && isActiveNeonCommitmentStatus(commitment.status)
  );
}

/**
 * Read-only due view: active commitments whose due window has opened and whose
 * snooze (if any) has elapsed. Optionally scoped to one session. No send, no
 * attempt write — shadow contract keeps delivery suppressed.
 */
export function listNeonDueCommitments(
  commitments: readonly INeonCommitmentRecord[],
  nowMs: number,
  sessionKey?: string
): readonly INeonCommitmentRecord[] {
  return commitments.filter((commitment) => {
    if (!isActiveNeonCommitmentStatus(commitment.status)) {
      return false;
    }
    if (sessionKey !== undefined && commitment.sessionKey !== sessionKey) {
      return false;
    }
    if (
      commitment.status === "snoozed" &&
      commitment.snoozedUntilMs !== undefined &&
      commitment.snoozedUntilMs > nowMs
    ) {
      return false;
    }
    return commitment.dueWindow.earliestMs <= nowMs;
  });
}

export function renderNeonDueCommitmentsReport(
  due: readonly INeonCommitmentRecord[]
): string {
  if (due.length === 0) {
    return "Due commitments: none (suppressed; read-only, no send)";
  }
  return [
    `Due commitments: ${due.length} (suppressed; read-only, no send)`,
    ...due.map((commitment) => {
      const dueAt = new Date(commitment.dueWindow.earliestMs).toISOString();
      return `  ${commitment.id} [${commitment.kind}/${commitment.status}] session=${commitment.sessionKey} due>=${dueAt} :: ${commitment.suggestedText}`;
    })
  ].join("\n");
}

function projectLatestCommitmentPerId(
  records: readonly INeonCommitmentRecord[]
): readonly INeonCommitmentRecord[] {
  const byId = new Map<string, INeonCommitmentRecord>();
  for (const record of records) {
    const existing = byId.get(record.id);
    if (existing === undefined || record.updatedAtMs >= existing.updatedAtMs) {
      byId.set(record.id, record);
    }
  }
  return [...byId.values()];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function parseCommitment(line: string): INeonCommitmentRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const id = record["id"];
  const agentId = record["agentId"];
  const sessionKey = record["sessionKey"];
  const channel = record["channel"];
  const kind = record["kind"];
  const source = record["source"];
  const status = record["status"];
  const suggestedText = record["suggestedText"];
  const dedupeKey = record["dedupeKey"];
  const confidence = record["confidence"];
  const createdAtMs = record["createdAtMs"];
  const updatedAtMs = record["updatedAtMs"];
  const attempts = record["attempts"];

  if (
    typeof id !== "string" ||
    typeof agentId !== "string" ||
    typeof sessionKey !== "string" ||
    typeof channel !== "string" ||
    typeof suggestedText !== "string" ||
    typeof dedupeKey !== "string" ||
    typeof confidence !== "number" ||
    typeof createdAtMs !== "number" ||
    typeof updatedAtMs !== "number" ||
    typeof attempts !== "number"
  ) {
    return undefined;
  }
  if (!isCommitmentKind(kind) || !isCommitmentSource(source) || !isCommitmentStatus(status)) {
    return undefined;
  }

  const dueWindow = parseDueWindow(record["dueWindow"]);
  if (dueWindow === undefined) {
    return undefined;
  }

  const sentAtMs = record["sentAtMs"];
  const dismissedAtMs = record["dismissedAtMs"];
  const snoozedUntilMs = record["snoozedUntilMs"];
  const expiredAtMs = record["expiredAtMs"];

  return {
    id,
    agentId,
    sessionKey,
    channel,
    kind,
    source,
    status,
    suggestedText,
    dedupeKey,
    confidence,
    dueWindow,
    createdAtMs,
    updatedAtMs,
    attempts,
    ...(typeof sentAtMs === "number" ? { sentAtMs } : {}),
    ...(typeof dismissedAtMs === "number" ? { dismissedAtMs } : {}),
    ...(typeof snoozedUntilMs === "number" ? { snoozedUntilMs } : {}),
    ...(typeof expiredAtMs === "number" ? { expiredAtMs } : {})
  };
}

function parseDueWindow(value: unknown): INeonCommitmentDueWindow | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const window = value as Record<string, unknown>;
  const earliestMs = window["earliestMs"];
  const latestMs = window["latestMs"];
  const timezone = window["timezone"];
  if (typeof earliestMs !== "number" || typeof latestMs !== "number" || typeof timezone !== "string") {
    return undefined;
  }
  return { earliestMs, latestMs, timezone };
}

function isCommitmentKind(value: unknown): value is TNeonCommitmentKind {
  return (
    value === "event_check_in" ||
    value === "deadline_check" ||
    value === "care_check_in" ||
    value === "open_loop"
  );
}

function isCommitmentSource(value: unknown): value is TNeonCommitmentSource {
  return value === "inferred_user_context" || value === "agent_promise";
}

function isCommitmentStatus(value: unknown): value is TNeonCommitmentStatus {
  return (
    value === "pending" ||
    value === "sent" ||
    value === "dismissed" ||
    value === "snoozed" ||
    value === "expired"
  );
}
