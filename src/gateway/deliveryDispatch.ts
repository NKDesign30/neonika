import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  INeonDeliveryApprovalRecord,
  INeonDeliveryQueueCandidate,
  TNeonDeliveryAckState,
  TNeonDeliveryRecoveryState
} from "./deliveryQueue.js";
import { resolveNeonDeliveryQueuePaths } from "./deliveryQueue.js";
import type { INeonOutboundSender } from "./outboundSender.js";
import {
  createNeonDeliveryIntentId,
  createNeonDeliveryPayloadHash,
  executeNeonExactlyOnceDelivery,
  type INeonExactlyOnceDeliveryResult
} from "./deliveryReceiptStore.js";

/**
 * Gated delivery dispatch: glues a DeliveryQueue candidate + operator approval to
 * the outbound sender (dry-run or canary). This is the single real path from
 * "approved candidate" to "send attempt", and it stays no-send by default — the
 * injected sender decides whether anything leaves the process.
 *
 * Ack lifecycle is source-backed from upstream `src/channels/status-reactions.ts`
 * (queued -> working -> done with terminal-state protection: once a candidate is
 * `done`, later attempts are ignored). The `recoveryState` `pending-drain` marker
 * mirrors a reconnect delivery-drain need when a transport attempt errors.
 *
 * Leak-safety: only the already-redacted `finalTextPreview` is forwarded; a
 * transport error is reduced to the fixed reason `transport-error` so a raw
 * Discord/network error string can never carry channel or token hints into logs
 * or state.
 */
export type TNeonDeliveryDispatchOutcome =
  | "delivered"
  | "suppressed"
  | "not-approved"
  | "already-terminal"
  | "already-sent"
  | "pending-drain"
  | "transport-error";

export interface INeonDeliveryDispatchResult {
  readonly candidateId: string;
  readonly runId: string;
  readonly outcome: TNeonDeliveryDispatchOutcome;
  readonly outboundSent: boolean;
  readonly ackState: TNeonDeliveryAckState;
  readonly recoveryState: TNeonDeliveryRecoveryState;
  readonly bodyPreview: string;
  readonly messageId?: string;
  readonly reason?: string;
  readonly attemptedAt: string;
}

export interface INeonDeliveryPlatformSendMarker {
  readonly candidateId: string;
  readonly runId: string;
  readonly outboundSent: true;
  readonly bodyPreview: string;
  readonly messageId?: string;
  readonly attemptedAt: string;
}

export interface IDeliverNeonApprovedCandidateOptions {
  readonly sender: INeonOutboundSender;
  readonly candidate: INeonDeliveryQueueCandidate;
  readonly approval?: INeonDeliveryApprovalRecord;
  readonly now?: () => Date;
}

export interface IDeliverAndRecordNeonApprovedCandidateOptions
  extends IDeliverNeonApprovedCandidateOptions {
  readonly projectRoot: string;
}

export type INeonDeliveryDispatchRecord = INeonDeliveryDispatchResult;

const deliveryDispatchFile = "delivery-dispatch.jsonl";
const deliveryPlatformSendsFile = "delivery-platform-sends.jsonl";

function isApprovedFor(
  candidate: INeonDeliveryQueueCandidate,
  approval: INeonDeliveryApprovalRecord | undefined
): boolean {
  return Boolean(
    approval &&
      approval.candidateId === candidate.id &&
      approval.decision === "approve-canary"
  );
}

export async function deliverAndRecordNeonApprovedCandidate(
  options: IDeliverAndRecordNeonApprovedCandidateOptions
): Promise<INeonDeliveryDispatchResult> {
  const [priorRecords, priorPlatformSends] = await Promise.all([
    readNeonDeliveryDispatchRecords(options.projectRoot),
    readNeonDeliveryPlatformSendMarkers(options.projectRoot)
  ]);
  const replayBlock = resolveDispatchReplayBlock(
    options.candidate,
    priorRecords,
    priorPlatformSends,
    options.now
  );

  if (replayBlock) {
    await recordNeonDeliveryDispatchResult(options.projectRoot, replayBlock);
    return replayBlock;
  }

  const preflight = await resolveDispatchPreflight(options);
  const result = preflight ?? await deliverApprovedCandidateExactlyOnce(options);
  if (result.outboundSent) {
    try {
      await recordNeonDeliveryPlatformSendMarker(options.projectRoot, result);
    } catch {
      // The full dispatch record remains the authoritative ack path.
    }
  }
  await recordNeonDeliveryDispatchResult(options.projectRoot, result);

  return result;
}

async function resolveDispatchPreflight(
  options: IDeliverAndRecordNeonApprovedCandidateOptions
): Promise<INeonDeliveryDispatchResult | undefined> {
  if (options.candidate.ackState !== "done" && isApprovedFor(options.candidate, options.approval)) {
    return undefined;
  }
  return await deliverNeonApprovedCandidate(options);
}

async function deliverApprovedCandidateExactlyOnce(
  options: IDeliverAndRecordNeonApprovedCandidateOptions
): Promise<INeonDeliveryDispatchResult> {
  const attemptedAt = (options.now?.() ?? new Date()).toISOString();
  const candidate = options.candidate;
  const intentId = createNeonDeliveryIntentId(candidate.id, candidate.target, "text");
  const result = await executeNeonExactlyOnceDelivery({
    projectRoot: options.projectRoot,
    intentId,
    runId: candidate.runId,
    kind: "text",
    target: candidate.target,
    payloadHash: createNeonDeliveryPayloadHash([
      candidate.target.accountId,
      candidate.target.channelId,
      candidate.target.threadId ?? "main",
      candidate.finalTextPreview
    ]),
    send: async (target) => await options.sender.sendText(target, candidate.finalTextPreview),
    ...(options.now ? { now: options.now } : {})
  });
  return projectExactlyOnceDispatchResult(candidate, attemptedAt, result);
}

function projectExactlyOnceDispatchResult(
  candidate: INeonDeliveryQueueCandidate,
  attemptedAt: string,
  result: INeonExactlyOnceDeliveryResult
): INeonDeliveryDispatchResult {
  const base = {
    candidateId: candidate.id,
    runId: candidate.runId,
    bodyPreview: candidate.finalTextPreview,
    attemptedAt
  } as const;

  if (result.state === "delivered") {
    return {
      ...base,
      outcome: "delivered",
      outboundSent: true,
      ackState: "done",
      recoveryState: "none",
      ...(result.messageId ? { messageId: result.messageId } : {})
    };
  }
  if (result.state === "already-delivered") {
    return {
      ...base,
      outcome: "already-sent",
      outboundSent: false,
      ackState: "done",
      recoveryState: "none",
      ...(result.messageId ? { messageId: result.messageId } : {}),
      reason: "delivery receipt already exists"
    };
  }
  if (result.state === "suppressed") {
    return {
      ...base,
      outcome: "suppressed",
      outboundSent: false,
      ackState: "queued",
      recoveryState: "none",
      reason: result.reason ?? "delivery suppressed"
    };
  }
  if (result.state === "transport-error") {
    return {
      ...base,
      outcome: "transport-error",
      outboundSent: false,
      ackState: "working",
      recoveryState: "pending-drain",
      reason: "transport-error"
    };
  }
  return {
    ...base,
    outcome: "pending-drain",
    outboundSent: false,
    ackState: "working",
    recoveryState: "pending-drain",
    ...(result.messageId ? { messageId: result.messageId } : {}),
    reason: result.reason ?? result.state
  };
}

export async function deliverNeonApprovedCandidate(
  options: IDeliverNeonApprovedCandidateOptions
): Promise<INeonDeliveryDispatchResult> {
  const { sender, candidate, approval } = options;
  const attemptedAt = (options.now?.() ?? new Date()).toISOString();
  const base = {
    candidateId: candidate.id,
    runId: candidate.runId,
    bodyPreview: candidate.finalTextPreview,
    attemptedAt
  } as const;

  // Terminal-state protection: a delivered candidate is never re-sent.
  if (candidate.ackState === "done") {
    return {
      ...base,
      outcome: "already-terminal",
      outboundSent: false,
      ackState: "done",
      recoveryState: "none",
      reason: "candidate already delivered"
    };
  }

  // Approval gate: no approval -> no send attempt, ack stays where it was.
  if (!isApprovedFor(candidate, approval)) {
    return {
      ...base,
      outcome: "not-approved",
      outboundSent: false,
      ackState: candidate.ackState,
      recoveryState: candidate.recoveryState,
      reason: "delivery not approved for this candidate"
    };
  }

  try {
    const result = await sender.sendText(candidate.target, candidate.finalTextPreview);

    if (result.outboundSent) {
      return {
        ...base,
        outcome: "delivered",
        outboundSent: true,
        ackState: "done",
        recoveryState: "none",
        messageId: result.messageId
      };
    }

    // Gate closed / no transport: nothing left the process, ack stays queued.
    return {
      ...base,
      outcome: "suppressed",
      outboundSent: false,
      ackState: "queued",
      recoveryState: "none",
      reason: result.reason
    };
  } catch {
    // Transport raised after being authorized: in-flight + needs drain on
    // reconnect. The raw error is intentionally dropped (leak-safety).
    return {
      ...base,
      outcome: "transport-error",
      outboundSent: false,
      ackState: "working",
      recoveryState: "pending-drain",
      reason: "transport-error"
    };
  }
}

export async function recordNeonDeliveryDispatchResult(
  projectRoot: string,
  result: INeonDeliveryDispatchResult
): Promise<INeonDeliveryDispatchRecord> {
  const path = resolveNeonDeliveryDispatchPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(result)}\n`, "utf8");

  return result;
}

export async function recordNeonDeliveryPlatformSendMarker(
  projectRoot: string,
  result: INeonDeliveryDispatchResult
): Promise<INeonDeliveryPlatformSendMarker | undefined> {
  if (!result.outboundSent) {
    return undefined;
  }

  const marker: INeonDeliveryPlatformSendMarker = {
    candidateId: result.candidateId,
    runId: result.runId,
    outboundSent: true,
    bodyPreview: result.bodyPreview,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    attemptedAt: result.attemptedAt
  };
  const path = resolveNeonDeliveryPlatformSendsPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(marker)}\n`, "utf8");

  return marker;
}

export async function readNeonDeliveryDispatchRecords(
  projectRoot: string
): Promise<readonly INeonDeliveryDispatchRecord[]> {
  const path = resolveNeonDeliveryDispatchPath(projectRoot);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseNeonDeliveryDispatchRecordLine)
    .filter((record): record is INeonDeliveryDispatchRecord => record !== undefined);
}

export async function readNeonDeliveryPlatformSendMarkers(
  projectRoot: string
): Promise<readonly INeonDeliveryPlatformSendMarker[]> {
  const path = resolveNeonDeliveryPlatformSendsPath(projectRoot);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseNeonDeliveryPlatformSendMarkerLine)
    .filter((marker): marker is INeonDeliveryPlatformSendMarker => marker !== undefined);
}

export function renderNeonDeliveryDispatchReport(
  result: INeonDeliveryDispatchResult
): string {
  return [
    `Neonika Delivery dispatch: ${result.outcome}`,
    `Candidate: ${result.candidateId} (run ${result.runId})`,
    `Outbound sent: ${result.outboundSent}`,
    `Ack state: ${result.ackState}`,
    `Recovery: ${result.recoveryState}`,
    `Message id: ${result.messageId ?? "none"}`,
    `Reason: ${result.reason ?? "none"}`,
    `Body preview: ${result.bodyPreview || "empty"}`
  ].join("\n");
}

function resolveDispatchReplayBlock(
  candidate: INeonDeliveryQueueCandidate,
  records: readonly INeonDeliveryDispatchRecord[],
  platformSends: readonly INeonDeliveryPlatformSendMarker[],
  now: (() => Date) | undefined
): INeonDeliveryDispatchResult | undefined {
  const prior = [...records]
    .reverse()
    .find((record) => record.candidateId === candidate.id && record.outboundSent);
  const priorPlatformSend = [...platformSends]
    .reverse()
    .find((marker) => marker.candidateId === candidate.id);

  if (!prior && !priorPlatformSend) {
    return undefined;
  }

  const attemptedAt = (now?.() ?? new Date()).toISOString();
  const base = {
    candidateId: candidate.id,
    runId: candidate.runId,
    bodyPreview: candidate.finalTextPreview,
    attemptedAt
  } as const;

  const messageId = prior?.messageId ?? priorPlatformSend?.messageId;
  return {
    ...base,
    outcome: "already-sent",
    outboundSent: false,
    ackState: "done",
    recoveryState: "none",
    ...(messageId ? { messageId } : {}),
    reason: "prior outbound send recorded"
  };
}

function resolveNeonDeliveryDispatchPath(projectRoot: string): string {
  return join(dirname(resolveNeonDeliveryQueuePaths(projectRoot).queuePath), deliveryDispatchFile);
}

function resolveNeonDeliveryPlatformSendsPath(projectRoot: string): string {
  return join(dirname(resolveNeonDeliveryQueuePaths(projectRoot).queuePath), deliveryPlatformSendsFile);
}

function parseNeonDeliveryDispatchRecordLine(
  line: string
): INeonDeliveryDispatchRecord | undefined {
  try {
    return parseNeonDeliveryDispatchRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function parseNeonDeliveryPlatformSendMarkerLine(
  line: string
): INeonDeliveryPlatformSendMarker | undefined {
  try {
    return parseNeonDeliveryPlatformSendMarker(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function parseNeonDeliveryDispatchRecord(value: unknown): INeonDeliveryDispatchRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value["candidateId"] !== "string" ||
    typeof value["runId"] !== "string" ||
    !isNeonDeliveryDispatchOutcome(value["outcome"]) ||
    typeof value["outboundSent"] !== "boolean" ||
    !isDeliveryAckState(value["ackState"]) ||
    !isDeliveryRecoveryState(value["recoveryState"]) ||
    typeof value["bodyPreview"] !== "string" ||
    (value["messageId"] !== undefined && typeof value["messageId"] !== "string") ||
    (value["reason"] !== undefined && typeof value["reason"] !== "string") ||
    typeof value["attemptedAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    candidateId: value["candidateId"],
    runId: value["runId"],
    outcome: value["outcome"],
    outboundSent: value["outboundSent"],
    ackState: value["ackState"],
    recoveryState: value["recoveryState"],
    bodyPreview: value["bodyPreview"],
    ...(typeof value["messageId"] === "string" ? { messageId: value["messageId"] } : {}),
    ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
    attemptedAt: value["attemptedAt"]
  };
}

function parseNeonDeliveryPlatformSendMarker(
  value: unknown
): INeonDeliveryPlatformSendMarker | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value["candidateId"] !== "string" ||
    typeof value["runId"] !== "string" ||
    value["outboundSent"] !== true ||
    typeof value["bodyPreview"] !== "string" ||
    (value["messageId"] !== undefined && typeof value["messageId"] !== "string") ||
    typeof value["attemptedAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    candidateId: value["candidateId"],
    runId: value["runId"],
    outboundSent: true,
    bodyPreview: value["bodyPreview"],
    ...(typeof value["messageId"] === "string" ? { messageId: value["messageId"] } : {}),
    attemptedAt: value["attemptedAt"]
  };
}

function isNeonDeliveryDispatchOutcome(value: unknown): value is TNeonDeliveryDispatchOutcome {
  return (
    value === "delivered" ||
    value === "suppressed" ||
    value === "not-approved" ||
    value === "already-terminal" ||
    value === "already-sent" ||
    value === "pending-drain" ||
    value === "transport-error"
  );
}

function isDeliveryAckState(value: unknown): value is TNeonDeliveryAckState {
  return value === "queued" || value === "working" || value === "done";
}

function isDeliveryRecoveryState(value: unknown): value is TNeonDeliveryRecoveryState {
  return value === "none" || value === "pending-drain";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
