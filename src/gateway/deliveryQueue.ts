import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import { resolveGatewayStatePaths } from "./runStore.js";
import type { INeonGatewayShadowRun } from "./types.js";

export type TNeonDeliveryQueueState = "queued-dry-run" | "blocked";
export type TNeonDeliveryQueueReason =
  | "primary-dry-run"
  | "empty-final-text"
  | "run-failed"
  | "run-cancelled";
export type TNeonDeliveryApprovalDecision = "approve-canary" | "reject";
export type TNeonDeliveryAckState = "queued" | "working" | "done";
export type TNeonDeliveryRecoveryState = "none" | "pending-drain";
export type TNeonDeliveryQueueVisibleChannel = Extract<
  INeonGatewayShadowRun["request"]["channel"],
  "discord" | "webchat"
>;

export interface INeonDeliveryQueuePaths {
  readonly queuePath: string;
  readonly approvalPath: string;
}

export interface INeonDeliveryQueueTarget {
  readonly channel: INeonGatewayShadowRun["request"]["channel"];
  readonly accountId: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId?: string;
  readonly replyToMessageId?: string;
  /** Stable opaque id used to derive Discord's enforced create-message nonce. */
  readonly deliveryIntentId?: string;
}

export interface INeonDeliveryQueueSafety {
  readonly outboundSent: false;
  readonly requiresApproval: true;
  readonly cutoverStage: "shadow";
}

export interface INeonDeliveryQueueCandidate {
  readonly id: string;
  readonly runId: string;
  readonly state: TNeonDeliveryQueueState;
  readonly reason: TNeonDeliveryQueueReason;
  readonly target: INeonDeliveryQueueTarget;
  readonly agentId: string;
  readonly sourceRunStatus: INeonGatewayShadowRun["status"];
  readonly finalTextPreview: string;
  readonly safety: INeonDeliveryQueueSafety;
  // Read-only ack-/reaction-status model. No real ack logic, no Discord reaction send.
  readonly ackState: TNeonDeliveryAckState;
  // Read-only marker for reconnect delivery-drain. No re-send codepath exists:
  // as long as outbound stays no-send, this is purely a marker.
  readonly recoveryState: TNeonDeliveryRecoveryState;
  readonly createdAt: string;
}

export interface INeonDeliveryQueueReadOptions {
  readonly maxCandidates?: number;
  readonly maxApprovals?: number;
}

export type TNeonDeliveryAckStateCounts = {
  readonly [ackState in TNeonDeliveryAckState]: number;
};

export interface INeonDeliveryQueueTotals {
  readonly candidates: number;
  readonly queuedDryRuns: number;
  readonly blocked: number;
  readonly approvalRecords: number;
  readonly ackStateCounts: TNeonDeliveryAckStateCounts;
  readonly pendingRecovery: number;
}

export interface INeonDeliveryApprovalInput {
  readonly candidateId: string;
  readonly decision: TNeonDeliveryApprovalDecision;
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface INeonDeliveryApprovalSafety {
  readonly outboundSent: false;
  readonly requiresCanaryGate: true;
  readonly cutoverStage: "shadow";
}

export interface INeonDeliveryApprovalRecord {
  readonly id: string;
  readonly candidateId: string;
  readonly runId: string;
  readonly decision: TNeonDeliveryApprovalDecision;
  readonly operatorId: string;
  readonly reason?: string;
  readonly safety: INeonDeliveryApprovalSafety;
  readonly createdAt: string;
}

export interface INeonDeliveryQueueSnapshot {
  readonly state: "ready";
  readonly source: INeonDeliveryQueuePaths;
  readonly totals: INeonDeliveryQueueTotals;
  readonly candidates: readonly INeonDeliveryQueueCandidate[];
  readonly approvals: readonly INeonDeliveryApprovalRecord[];
}

const DELIVERY_QUEUE_FILE = "delivery-queue.jsonl";
const DELIVERY_APPROVALS_FILE = "delivery-approvals.jsonl";
const finalTextPreviewMaxLength = 500;
const deliveryApprovalReasonMaxLength = 500;

export function isNeonDeliveryQueueVisibleChannel(
  value: unknown
): value is TNeonDeliveryQueueVisibleChannel {
  return value === "discord" || value === "webchat";
}

export function resolveNeonDeliveryQueuePaths(projectRoot: string): INeonDeliveryQueuePaths {
  const paths = resolveGatewayStatePaths(projectRoot);

  return {
    queuePath: join(paths.gatewayRoot, DELIVERY_QUEUE_FILE),
    approvalPath: join(paths.gatewayRoot, DELIVERY_APPROVALS_FILE)
  };
}

export async function enqueueNeonDeliveryDryRunCandidate(
  projectRoot: string,
  run: INeonGatewayShadowRun,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonDeliveryQueueCandidate> {
  const candidate = createNeonDeliveryDryRunCandidate(run, options);
  const paths = resolveNeonDeliveryQueuePaths(projectRoot);

  await mkdir(dirname(paths.queuePath), { recursive: true });
  await appendFile(paths.queuePath, `${JSON.stringify(candidate)}\n`, "utf8");

  return candidate;
}

export function createNeonDeliveryDryRunCandidate(
  run: INeonGatewayShadowRun,
  options: {
    readonly now?: () => Date;
  } = {}
): INeonDeliveryQueueCandidate {
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const finalTextPreview = createFinalTextPreview(run.finalText);
  const state = resolveCandidateState(run, finalTextPreview);
  const reason = resolveCandidateReason(run, finalTextPreview);

  return {
    id: createDeliveryCandidateId(run, createdAt),
    runId: run.runId,
    state,
    reason,
    target: {
      channel: run.request.channel,
      accountId: run.request.accountId,
      channelId: run.request.channelId,
      ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
      ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
      ...(run.request.messageId ? { replyToMessageId: run.request.messageId } : {})
    },
    agentId: run.request.agentId,
    sourceRunStatus: run.status,
    finalTextPreview,
    safety: {
      outboundSent: false,
      requiresApproval: true,
      cutoverStage: "shadow"
    },
    ackState: "queued",
    recoveryState: "none",
    createdAt
  };
}

export async function readNeonDeliveryQueueCandidates(
  projectRoot: string,
  options: INeonDeliveryQueueReadOptions = {}
): Promise<readonly INeonDeliveryQueueCandidate[]> {
  const paths = resolveNeonDeliveryQueuePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.queuePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const candidates = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseDeliveryCandidateLine)
    .filter((candidate): candidate is INeonDeliveryQueueCandidate => candidate !== undefined);

  return options.maxCandidates ? candidates.slice(-options.maxCandidates) : candidates;
}

export async function createNeonDeliveryQueueSnapshot(
  projectRoot: string,
  options: INeonDeliveryQueueReadOptions = {}
): Promise<INeonDeliveryQueueSnapshot> {
  const [candidates, approvals] = await Promise.all([
    readNeonDeliveryQueueCandidates(projectRoot, options),
    readNeonDeliveryApprovalRecords(projectRoot, options)
  ]);

  // Read-time ack producer: a candidate that has been operator-decided (an
  // approval record exists, approve-canary or reject) has reached a terminal
  // disposition, so its effective ackState is "done". This derives from real
  // approval data only — no state write, and "working"/"pending-drain" stay
  // unproduced because Neon's suppressed shadow model has no real delivery
  // worker or reconnect-drain signal (upstream's `deliverPending`/drain in
  // `src/infra/approval-handler-runtime.ts` is tied to actual sending).
  const resolvedCandidateIds = new Set(approvals.map((approval) => approval.candidateId));
  const projectedCandidates = candidates.map((candidate) =>
    resolvedCandidateIds.has(candidate.id) && candidate.ackState !== "done"
      ? { ...candidate, ackState: "done" as const }
      : candidate
  );

  return {
    state: "ready",
    source: resolveNeonDeliveryQueuePaths(projectRoot),
    totals: {
      candidates: projectedCandidates.length,
      queuedDryRuns: projectedCandidates.filter((candidate) => candidate.state === "queued-dry-run")
        .length,
      blocked: projectedCandidates.filter((candidate) => candidate.state === "blocked").length,
      approvalRecords: approvals.length,
      ackStateCounts: countDeliveryAckStates(projectedCandidates),
      pendingRecovery: projectedCandidates.filter(
        (candidate) => candidate.recoveryState === "pending-drain"
      ).length
    },
    candidates: projectedCandidates,
    approvals
  };
}

export async function recordNeonDeliveryApproval(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonDeliveryApprovalRecord> {
  const approvalInput = parseDeliveryApprovalInput(input);
  const candidates = await readNeonDeliveryQueueCandidates(projectRoot);
  const candidate = candidates.find((entry) => entry.id === approvalInput.candidateId);

  if (!candidate) {
    throw new Error("Delivery candidate not found");
  }

  if (candidate.state !== "queued-dry-run") {
    throw new Error("Delivery candidate is not queued for canary approval");
  }

  const record = createNeonDeliveryApprovalRecord(candidate, approvalInput, options);
  const paths = resolveNeonDeliveryQueuePaths(projectRoot);

  await mkdir(dirname(paths.approvalPath), { recursive: true });
  await appendFile(paths.approvalPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function readNeonDeliveryApprovalRecords(
  projectRoot: string,
  options: INeonDeliveryQueueReadOptions = {}
): Promise<readonly INeonDeliveryApprovalRecord[]> {
  const paths = resolveNeonDeliveryQueuePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.approvalPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const approvals = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseDeliveryApprovalLine)
    .filter((record): record is INeonDeliveryApprovalRecord => record !== undefined);

  return options.maxApprovals ? approvals.slice(-options.maxApprovals) : approvals;
}

export function renderNeonDeliveryQueueReport(snapshot: INeonDeliveryQueueSnapshot): string {
  const rows = snapshot.candidates.map((candidate) =>
    [
      `- ${candidate.id}`,
      `  run: ${candidate.runId}`,
      `  state: ${candidate.state}`,
      `  ack: ${candidate.ackState}`,
      `  recovery: ${candidate.recoveryState}`,
      `  target: ${candidate.target.channel}/${candidate.target.channelId}`,
      `  safety: outboundSent=${candidate.safety.outboundSent} approval=${candidate.safety.requiresApproval}`,
      `  preview: ${candidate.finalTextPreview || "empty"}`
    ].join("\n")
  );
  const approvalRows = snapshot.approvals.map((approval) =>
    [
      `- ${approval.id}`,
      `  candidate: ${approval.candidateId}`,
      `  decision: ${approval.decision}`,
      `  safety: outboundSent=${approval.safety.outboundSent} canaryGate=${approval.safety.requiresCanaryGate}`
    ].join("\n")
  );

  return [
    "Neonika Delivery Queue",
    `State: ${snapshot.state}`,
    `Candidates: ${snapshot.totals.candidates}`,
    `Queued dry-runs: ${snapshot.totals.queuedDryRuns}`,
    `Blocked: ${snapshot.totals.blocked}`,
    `Ack states: queued=${snapshot.totals.ackStateCounts.queued} working=${snapshot.totals.ackStateCounts.working} done=${snapshot.totals.ackStateCounts.done}`,
    `Pending recovery: ${snapshot.totals.pendingRecovery}`,
    `Approval records: ${snapshot.totals.approvalRecords}`,
    `Source: ${snapshot.source.queuePath}`,
    ...rows,
    ...approvalRows
  ].join("\n");
}

function resolveCandidateState(
  run: INeonGatewayShadowRun,
  finalTextPreview: string
): TNeonDeliveryQueueState {
  if (run.status === "failed" || run.status === "cancelled" || finalTextPreview.length === 0) {
    return "blocked";
  }

  return "queued-dry-run";
}

function resolveCandidateReason(
  run: INeonGatewayShadowRun,
  finalTextPreview: string
): TNeonDeliveryQueueReason {
  if (run.status === "failed") {
    return "run-failed";
  }

  if (run.status === "cancelled") {
    return "run-cancelled";
  }

  if (finalTextPreview.length === 0) {
    return "empty-final-text";
  }

  return "primary-dry-run";
}

function createFinalTextPreview(finalText: string): string {
  const redacted = redactText(finalText).replace(/\s+/g, " ").trim();

  if (redacted.length <= finalTextPreviewMaxLength) {
    return redacted;
  }

  return `${truncateUtf16Safe(redacted, finalTextPreviewMaxLength - 1)}…`;
}

function createDeliveryCandidateId(run: INeonGatewayShadowRun, createdAt: string): string {
  const hash = createHash("sha256")
    .update([run.runId, run.request.channel, run.request.channelId, createdAt].join("\u001f"))
    .digest("hex")
    .slice(0, 16);

  return `neon-delivery-${hash}`;
}

function createNeonDeliveryApprovalRecord(
  candidate: INeonDeliveryQueueCandidate,
  input: INeonDeliveryApprovalInput,
  options: {
    readonly now?: () => Date;
  }
): INeonDeliveryApprovalRecord {
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const reason = normalizeOptionalText(input.reason, deliveryApprovalReasonMaxLength);
  const record: INeonDeliveryApprovalRecord = {
    id: createDeliveryApprovalId(candidate, input, createdAt),
    candidateId: candidate.id,
    runId: candidate.runId,
    decision: input.decision,
    operatorId: normalizeRequiredText(input.operatorId, "operator"),
    ...(reason ? { reason } : {}),
    safety: {
      outboundSent: false,
      requiresCanaryGate: true,
      cutoverStage: "shadow"
    },
    createdAt
  };

  return record;
}

function createDeliveryApprovalId(
  candidate: INeonDeliveryQueueCandidate,
  input: INeonDeliveryApprovalInput,
  createdAt: string
): string {
  const hash = createHash("sha256")
    .update([candidate.id, input.decision, input.operatorId ?? "operator", createdAt].join("\u001f"))
    .digest("hex")
    .slice(0, 16);

  return `neon-approval-${hash}`;
}

function parseDeliveryCandidateLine(line: string): INeonDeliveryQueueCandidate | undefined {
  try {
    return parseDeliveryCandidate(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function parseDeliveryApprovalLine(line: string): INeonDeliveryApprovalRecord | undefined {
  try {
    return parseDeliveryApprovalRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function parseDeliveryApprovalRecord(value: unknown): INeonDeliveryApprovalRecord | undefined {
  if (!isRecord(value) || !isRecord(value["safety"])) {
    return undefined;
  }

  const safety = value["safety"];

  if (
    typeof value["id"] !== "string" ||
    typeof value["candidateId"] !== "string" ||
    typeof value["runId"] !== "string" ||
    !isDeliveryApprovalDecision(value["decision"]) ||
    typeof value["operatorId"] !== "string" ||
    (value["reason"] !== undefined && typeof value["reason"] !== "string") ||
    safety["outboundSent"] !== false ||
    safety["requiresCanaryGate"] !== true ||
    safety["cutoverStage"] !== "shadow" ||
    typeof value["createdAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    id: value["id"],
    candidateId: value["candidateId"],
    runId: value["runId"],
    decision: value["decision"],
    operatorId: value["operatorId"],
    ...(typeof value["reason"] === "string" ? { reason: redactText(value["reason"]) } : {}),
    safety: {
      outboundSent: false,
      requiresCanaryGate: true,
      cutoverStage: "shadow"
    },
    createdAt: value["createdAt"]
  };
}

function parseDeliveryCandidate(value: unknown): INeonDeliveryQueueCandidate | undefined {
  if (!isRecord(value) || !isRecord(value["target"]) || !isRecord(value["safety"])) {
    return undefined;
  }

  const target = value["target"];
  const safety = value["safety"];

  if (
    typeof value["id"] !== "string" ||
    typeof value["runId"] !== "string" ||
    !isDeliveryQueueState(value["state"]) ||
    !isDeliveryQueueReason(value["reason"]) ||
    !isNeonDeliveryQueueVisibleChannel(target["channel"]) ||
    typeof target["accountId"] !== "string" ||
    typeof target["channelId"] !== "string" ||
    typeof value["agentId"] !== "string" ||
    (value["sourceRunStatus"] !== "completed" && value["sourceRunStatus"] !== "failed") ||
    typeof value["finalTextPreview"] !== "string" ||
    safety["outboundSent"] !== false ||
    safety["requiresApproval"] !== true ||
    safety["cutoverStage"] !== "shadow" ||
    // Additive status fields: absent -> default. Present -> must be a valid literal.
    // Legacy persisted rows without these fields stay valid (resolve to defaults).
    (value["ackState"] !== undefined && !isDeliveryAckState(value["ackState"])) ||
    (value["recoveryState"] !== undefined && !isDeliveryRecoveryState(value["recoveryState"])) ||
    typeof value["createdAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    id: value["id"],
    runId: value["runId"],
    state: value["state"],
    reason: value["reason"],
    target: {
      channel: target["channel"],
      accountId: target["accountId"],
      channelId: target["channelId"],
      ...(typeof target["guildId"] === "string" ? { guildId: target["guildId"] } : {}),
      ...(typeof target["threadId"] === "string" ? { threadId: target["threadId"] } : {}),
      ...(typeof target["replyToMessageId"] === "string"
        ? { replyToMessageId: target["replyToMessageId"] }
        : {})
    },
    agentId: value["agentId"],
    sourceRunStatus: value["sourceRunStatus"],
    finalTextPreview: redactText(value["finalTextPreview"]),
    safety: {
      outboundSent: false,
      requiresApproval: true,
      cutoverStage: "shadow"
    },
    ackState: resolveDeliveryAckState(value["ackState"]),
    recoveryState: resolveDeliveryRecoveryState(value["recoveryState"]),
    createdAt: value["createdAt"]
  };
}

function isDeliveryQueueState(value: unknown): value is TNeonDeliveryQueueState {
  return value === "queued-dry-run" || value === "blocked";
}

function isDeliveryQueueReason(value: unknown): value is TNeonDeliveryQueueReason {
  return value === "primary-dry-run" || value === "empty-final-text" || value === "run-failed";
}

function isDeliveryAckState(value: unknown): value is TNeonDeliveryAckState {
  return value === "queued" || value === "working" || value === "done";
}

function isDeliveryRecoveryState(value: unknown): value is TNeonDeliveryRecoveryState {
  return value === "none" || value === "pending-drain";
}

function resolveDeliveryAckState(value: unknown): TNeonDeliveryAckState {
  return isDeliveryAckState(value) ? value : "queued";
}

function resolveDeliveryRecoveryState(value: unknown): TNeonDeliveryRecoveryState {
  return isDeliveryRecoveryState(value) ? value : "none";
}

function countDeliveryAckStates(
  candidates: readonly INeonDeliveryQueueCandidate[]
): TNeonDeliveryAckStateCounts {
  return candidates.reduce<{ queued: number; working: number; done: number }>(
    (counts, candidate) => {
      counts[candidate.ackState] += 1;

      return counts;
    },
    { queued: 0, working: 0, done: 0 }
  );
}

function parseDeliveryApprovalInput(input: unknown): INeonDeliveryApprovalInput {
  if (!isRecord(input)) {
    throw new Error("Delivery approval params must be an object");
  }

  const candidateId = readRequiredText(input["candidateId"], "candidateId");
  const decision = input["decision"];

  if (!isDeliveryApprovalDecision(decision)) {
    throw new Error("Delivery approval decision must be approve-canary or reject");
  }

  const reason = normalizeOptionalText(input["reason"], deliveryApprovalReasonMaxLength);

  return {
    candidateId,
    decision,
    operatorId: normalizeRequiredText(input["operatorId"], "operator"),
    ...(reason ? { reason } : {})
  };
}

function isDeliveryApprovalDecision(value: unknown): value is TNeonDeliveryApprovalDecision {
  return value === "approve-canary" || value === "reject";
}

function normalizeRequiredText(input: unknown, fallback: string): string {
  if (typeof input !== "string") {
    return fallback;
  }

  const trimmed = input.trim();

  return trimmed.length > 0 ? redactText(trimmed) : fallback;
}

function readRequiredText(input: unknown, fieldName: string): string {
  if (typeof input !== "string") {
    throw new Error(`Delivery approval ${fieldName} must be a string`);
  }

  const value = redactText(input.trim());

  if (value.length === 0) {
    throw new Error(`Delivery approval ${fieldName} must not be empty`);
  }

  return value;
}

function normalizeOptionalText(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const redacted = redactText(input).replace(/\s+/g, " ").trim();

  if (redacted.length === 0) {
    return undefined;
  }

  return redacted.length <= maxLength ? redacted : `${truncateUtf16Safe(redacted, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
