import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  createNeonNodeActionRequestSnapshot,
  type INeonNodeActionApprovalRecord,
  type INeonNodeActionRequestRecord,
  type INeonNodeActionRequestSnapshot,
  type TNeonNodeActionRequestKind
} from "./neonNodeActionRequests.js";
import {
  createNeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSummary
} from "./neonNodeDeviceSessions.js";

export type TNeonNodeTransportState = "empty" | "ready" | "partial" | "blocked";
export type TNeonNodeTransportDispatchState = "ready";
export type TNeonNodeTransportResultState = "received" | "blocked";
export type TNeonNodeTransportResultKind =
  | "file-list"
  | "file-fetch"
  | "dir-fetch"
  | "browser-tabs"
  | "browser-snapshot";
export type TNeonNodeTransportPollState = "accepted";
export type TNeonNodeTransportPollReplay = "replay" | "cursor-hit";
export type TNeonNodeTransportBlockerId =
  | "approved-action-missing-request"
  | "approved-action-without-active-session"
  | "unsupported-action-kind"
  | "unsafe-target";

export interface ICreateNeonNodeTransportSnapshotOptions {
  readonly now?: () => Date;
  readonly deviceSessionSnapshot?: INeonNodeDeviceSessionSnapshot;
  readonly actionRequestSnapshot?: INeonNodeActionRequestSnapshot;
  readonly maxResults?: number;
  readonly maxPolls?: number;
}

export interface INeonNodeTransportPolicy {
  readonly mode: "poll-only";
  readonly approval: "operator-approved-actions-only";
  readonly dispatchKinds: readonly TNeonNodeActionRequestKind[];
  readonly mutationAllowed: false;
  readonly rawTokenExposure: "disabled";
  readonly sessionSecretExposure: "disabled";
  readonly resultIngest: "bounded-audit";
}

export interface INeonNodeTransportTarget {
  readonly path?: string;
  readonly url?: string;
}

export interface INeonNodeTransportSafety {
  readonly readOnly: true;
  readonly mutationAllowed: false;
  readonly sideEffectExecuted: false;
  readonly rawOutputPersisted: false;
  readonly rawTokenExposed: false;
  readonly sessionSecretExposed: false;
}

export interface INeonNodeTransportDispatch {
  readonly dispatchId: string;
  readonly state: TNeonNodeTransportDispatchState;
  readonly approvalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly target: INeonNodeTransportTarget;
  readonly requestedAt: string;
  readonly approvedAt: string;
  readonly generatedAt: string;
  readonly delivery: "poll";
  readonly safety: INeonNodeTransportSafety;
}

export interface INeonNodeTransportBlocker {
  readonly id: TNeonNodeTransportBlockerId;
  readonly approvalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly summary: string;
  readonly recovery: string;
}

export interface INeonNodeTransportResultInput {
  readonly dispatchId: string;
  readonly state?: TNeonNodeTransportResultState;
  readonly summary?: string;
  readonly textPreview?: string;
  readonly entries?: readonly unknown[];
  readonly tabs?: readonly unknown[];
  readonly title?: string;
  readonly url?: string;
  readonly status?: number;
  readonly sizeBytes?: number;
  readonly totalEntries?: number;
  readonly binary?: boolean;
  readonly truncated?: boolean;
  readonly blockReason?: string;
}

export interface INeonNodeTransportFileListEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
  readonly relativePath?: string;
  readonly sizeBytes?: number;
}

export interface INeonNodeTransportFileListResult {
  readonly rootRelativePath: string;
  readonly entries: readonly INeonNodeTransportFileListEntry[];
  readonly totalEntries: number;
  readonly truncated: boolean;
}

export interface INeonNodeTransportFileFetchResult {
  readonly relativePath: string;
  readonly sizeBytes?: number;
  readonly binary: boolean;
  readonly textPreview?: string;
  readonly truncated: boolean;
}

export interface INeonNodeTransportDirFetchEntry {
  readonly relativePath: string;
  readonly sizeBytes?: number;
  readonly binary: boolean;
  readonly textPreview?: string;
  readonly truncated: boolean;
}

export interface INeonNodeTransportDirFetchResult {
  readonly rootRelativePath: string;
  readonly entries: readonly INeonNodeTransportDirFetchEntry[];
  readonly totalEntries: number;
  readonly truncated: boolean;
}

export interface INeonNodeTransportBrowserTabResult {
  readonly title?: string;
  readonly url?: string;
  readonly active: boolean;
}

export interface INeonNodeTransportBrowserTabsResult {
  readonly tabs: readonly INeonNodeTransportBrowserTabResult[];
  readonly totalTabs: number;
  readonly truncated: boolean;
}

export interface INeonNodeTransportBrowserSnapshotResult {
  readonly url: string;
  readonly status?: number;
  readonly title?: string;
  readonly textPreview?: string;
  readonly truncated: boolean;
}

export interface INeonNodeTransportResultSafety {
  readonly bounded: true;
  readonly redacted: true;
  readonly acceptedFromTransport: true;
  readonly mutationExecuted: false;
  readonly sideEffectExecuted: false;
  readonly rawOutputPersisted: false;
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
}

export interface INeonNodeTransportResultRecord {
  readonly transportResultId: string;
  readonly dispatchId: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly state: TNeonNodeTransportResultState;
  readonly resultKind: TNeonNodeTransportResultKind;
  readonly summary: string;
  readonly blockReason?: string;
  readonly fileList?: INeonNodeTransportFileListResult;
  readonly fileFetch?: INeonNodeTransportFileFetchResult;
  readonly dirFetch?: INeonNodeTransportDirFetchResult;
  readonly browserTabs?: INeonNodeTransportBrowserTabsResult;
  readonly browserSnapshot?: INeonNodeTransportBrowserSnapshotResult;
  readonly safety: INeonNodeTransportResultSafety;
  readonly createdAt: string;
}

export interface INeonNodeTransportPollInput {
  readonly sessionId: string;
  readonly cursor?: string;
}

export interface INeonNodeTransportPollSafety {
  readonly dispatchPayloadOnly: true;
  readonly mutationExecuted: false;
  readonly sideEffectExecuted: false;
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
}

export interface INeonNodeTransportPollRecord {
  readonly pollId: string;
  readonly state: TNeonNodeTransportPollState;
  readonly replay: TNeonNodeTransportPollReplay;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly cursor?: string;
  readonly nextCursor: string;
  readonly dispatchIds: readonly string[];
  readonly dispatches: number;
  readonly heartbeatAt: string;
  readonly safety: INeonNodeTransportPollSafety;
}

export interface INeonNodeTransportPollResponse {
  readonly state: TNeonNodeTransportPollState;
  readonly replay: TNeonNodeTransportPollReplay;
  readonly cursor: string;
  readonly previousCursor?: string;
  readonly heartbeatAt: string;
  readonly dispatches: readonly INeonNodeTransportDispatch[];
  readonly poll: INeonNodeTransportPollRecord;
}

export interface INeonNodeTransportPaths {
  readonly resultPath: string;
  readonly pollPath: string;
}

export interface INeonNodeTransportSource {
  readonly projectRoot: string;
  readonly requestPath: string;
  readonly approvalPath: string;
  readonly resultPreviewPath: string;
  readonly transportResultPath: string;
  readonly transportPollPath: string;
  readonly sessionPath: string;
}

export interface INeonNodeTransportTotals {
  readonly approvedActions: number;
  readonly dispatches: number;
  readonly blockers: number;
  readonly results: number;
  readonly receivedResults: number;
  readonly blockedResults: number;
  readonly polls: number;
  readonly activePollingSessions: number;
  readonly pendingDispatches: number;
  readonly previewedApprovals: number;
  readonly ingestedApprovals: number;
  readonly unsupportedActions: number;
  readonly unsafeTargets: number;
}

export interface INeonNodeTransportSnapshot {
  readonly state: TNeonNodeTransportState;
  readonly generatedAt: string;
  readonly policy: INeonNodeTransportPolicy;
  readonly dispatches: readonly INeonNodeTransportDispatch[];
  readonly blockers: readonly INeonNodeTransportBlocker[];
  readonly results: readonly INeonNodeTransportResultRecord[];
  readonly polls: readonly INeonNodeTransportPollRecord[];
  readonly totals: INeonNodeTransportTotals;
  readonly source: INeonNodeTransportSource;
}

const transportDispatchKinds: readonly TNeonNodeActionRequestKind[] = [
  "file.list",
  "dir.list",
  "file.fetch",
  "dir.fetch",
  "browser.tabs",
  "browser.snapshot"
];
const transportResultFile = "node-transport-results.jsonl";
const transportPollFile = "node-transport-polls.jsonl";
const maxTransportTargetLength = 320;
const maxTransportSummaryLength = 600;
const maxTransportTextPreviewLength = 4096;
const maxTransportEntries = 100;
const maxTransportPollCursorLength = 120;

export function resolveNeonNodeTransportPaths(projectRoot: string): INeonNodeTransportPaths {
  return {
    resultPath: resolve(projectRoot, "state", "nodes", transportResultFile),
    pollPath: resolve(projectRoot, "state", "nodes", transportPollFile)
  };
}

export async function readNeonNodeTransportResultRecords(
  projectRoot: string,
  options: {
    readonly maxResults?: number;
  } = {}
): Promise<readonly INeonNodeTransportResultRecord[]> {
  const paths = resolveNeonNodeTransportPaths(projectRoot);
  const content = await readFile(paths.resultPath, "utf8").catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "";
    }

    throw error;
  });
  const records = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJsonLine(line))
    .filter((value): value is Record<string, unknown> => isRecord(value))
    .map((value) => parseTransportResultRecord(value))
    .filter((record): record is INeonNodeTransportResultRecord => Boolean(record));

  return options.maxResults ? records.slice(-options.maxResults) : records;
}

export async function readNeonNodeTransportPollRecords(
  projectRoot: string,
  options: {
    readonly maxPolls?: number;
  } = {}
): Promise<readonly INeonNodeTransportPollRecord[]> {
  const paths = resolveNeonNodeTransportPaths(projectRoot);
  const content = await readFile(paths.pollPath, "utf8").catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "";
    }

    throw error;
  });
  const records = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => parseJsonLine(line))
    .filter((value): value is Record<string, unknown> => isRecord(value))
    .map((value) => parseTransportPollRecord(value))
    .filter((record): record is INeonNodeTransportPollRecord => Boolean(record));

  return options.maxPolls ? records.slice(-options.maxPolls) : records;
}

export async function recordNeonNodeTransportResult(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly transportSnapshot?: INeonNodeTransportSnapshot;
  } = {}
): Promise<INeonNodeTransportResultRecord> {
  const normalized = parseTransportResultInput(input);
  const existingResults = await readNeonNodeTransportResultRecords(projectRoot);

  if (existingResults.some((result) => result.dispatchId === normalized.dispatchId)) {
    throw new Error("Node transport dispatch already has an ingested result");
  }

  const now = options.now ?? (() => new Date());
  const transport =
    options.transportSnapshot ??
    (await createNeonNodeTransportSnapshot(projectRoot, {
      now
    }));
  const dispatch = transport.dispatches.find((candidate) => candidate.dispatchId === normalized.dispatchId);

  if (!dispatch) {
    throw new Error("Ready node transport dispatch not found");
  }

  const createdAt = now().toISOString();
  const record = createTransportResultRecord(dispatch, normalized, createdAt);
  const paths = resolveNeonNodeTransportPaths(projectRoot);

  await mkdir(dirname(paths.resultPath), { recursive: true });
  await appendFile(paths.resultPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function recordNeonNodeTransportPoll(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly session?: INeonNodeDeviceSessionSummary;
    readonly deviceSessionSnapshot?: INeonNodeDeviceSessionSnapshot;
    readonly transportSnapshot?: INeonNodeTransportSnapshot;
  } = {}
): Promise<INeonNodeTransportPollResponse> {
  const normalized = parseTransportPollInput(input);
  const now = options.now ?? (() => new Date());
  const heartbeatAt = now().toISOString();
  const deviceSessions =
    options.deviceSessionSnapshot ?? (await createNeonNodeDeviceSessionSnapshot(projectRoot, { now }));
  const session =
    options.session ??
    deviceSessions.sessions.find((candidate) => candidate.sessionId === normalized.sessionId);

  if (!session || session.state !== "active") {
    throw new Error("Active node transport poll session not found");
  }

  const transport =
    options.transportSnapshot ??
    (await createNeonNodeTransportSnapshot(projectRoot, {
      deviceSessionSnapshot: deviceSessions,
      now
    }));
  const readyDispatches = transport.dispatches.filter(
    (dispatch) => dispatch.sessionId === session.sessionId && dispatch.deviceId === session.deviceId
  );
  const nextCursor = createTransportPollCursor(session.sessionId, readyDispatches, transport.results);
  const replay: TNeonNodeTransportPollReplay = normalized.cursor === nextCursor ? "cursor-hit" : "replay";
  const dispatches = replay === "replay" ? readyDispatches : [];
  const poll = createTransportPollRecord(session, normalized, dispatches, nextCursor, replay, heartbeatAt);
  const paths = resolveNeonNodeTransportPaths(projectRoot);

  await mkdir(dirname(paths.pollPath), { recursive: true });
  await appendFile(paths.pollPath, `${JSON.stringify(poll)}\n`, "utf8");

  return {
    state: "accepted",
    replay,
    cursor: nextCursor,
    ...(normalized.cursor ? { previousCursor: normalized.cursor } : {}),
    heartbeatAt,
    dispatches,
    poll
  };
}

export async function createNeonNodeTransportSnapshot(
  projectRoot: string,
  options: ICreateNeonNodeTransportSnapshotOptions = {}
): Promise<INeonNodeTransportSnapshot> {
  const now = options.now ?? (() => new Date());
  const deviceSessions =
    options.deviceSessionSnapshot ?? (await createNeonNodeDeviceSessionSnapshot(projectRoot, { now }));
  const actionRequests =
    options.actionRequestSnapshot ??
    (await createNeonNodeActionRequestSnapshot(projectRoot, {
      deviceSessionSnapshot: deviceSessions,
      now
    }));
  const transportResults = await readNeonNodeTransportResultRecords(
    projectRoot,
    options.maxResults === undefined ? {} : { maxResults: options.maxResults }
  );
  const transportPolls = await readNeonNodeTransportPollRecords(
    projectRoot,
    options.maxPolls === undefined ? {} : { maxPolls: options.maxPolls }
  );
  const generatedAt = now().toISOString();
  const activeSessions = new Map(
    deviceSessions.sessions
      .filter((session) => session.state === "active")
      .map((session) => [session.sessionId, session])
  );
  const requestsById = new Map(actionRequests.requests.map((request) => [request.requestId, request]));
  const previewedApprovalIds = new Set(
    actionRequests.resultPreviews.map((preview) => preview.approvalId)
  );
  const resultDispatchIds = new Set(transportResults.map((result) => result.dispatchId));
  const dispatches: INeonNodeTransportDispatch[] = [];
  const blockers: INeonNodeTransportBlocker[] = [];
  let approvedActions = 0;
  let previewedApprovals = 0;
  let ingestedApprovals = 0;
  let unsupportedActions = 0;
  let unsafeTargets = 0;

  for (const approval of actionRequests.approvals) {
    if (approval.decision !== "approve") {
      continue;
    }

    approvedActions += 1;

    if (previewedApprovalIds.has(approval.approvalId)) {
      previewedApprovals += 1;
      continue;
    }

    const request = requestsById.get(approval.requestId);

    if (!request) {
      blockers.push(
        createTransportBlocker(
          "approved-action-missing-request",
          approval,
          {
            requestId: approval.requestId,
            sessionId: approval.sessionId,
            deviceId: approval.deviceId,
            kind: approval.kind
          },
          "Approved action cannot be dispatched because its request record is missing.",
          "Recreate the action request and approval audit from the active device session."
        )
      );
      continue;
    }

    if (!isTransportDispatchKind(request.kind)) {
      unsupportedActions += 1;
      blockers.push(
        createTransportBlocker(
          "unsupported-action-kind",
          approval,
          request,
          "Approved action is not part of the read-only transport allowlist.",
          "Use file.list, dir.list, file.fetch, browser.tabs, or browser.snapshot until high-risk gates exist."
        )
      );
      continue;
    }

    const session = activeSessions.get(request.sessionId);

    if (!session || session.deviceId !== request.deviceId) {
      blockers.push(
        createTransportBlocker(
          "approved-action-without-active-session",
          approval,
          request,
          "Approved action has no matching active paired device session.",
          "Open a fresh scoped device session before dispatching the approved action."
        )
      );
      continue;
    }

    const target = createTransportTarget(projectRoot, request);

    if (!target) {
      unsafeTargets += 1;
      blockers.push(
        createTransportBlocker(
          "unsafe-target",
          approval,
          request,
          "Approved action target is outside the workspace transport boundary.",
          "Record the action again with a workspace-relative file target or a redacted browser target."
        )
      );
      continue;
    }

    const dispatch = createTransportDispatch(approval, request, session, target, generatedAt);

    if (resultDispatchIds.has(dispatch.dispatchId)) {
      ingestedApprovals += 1;
      continue;
    }

    dispatches.push(dispatch);
  }

  return {
    state: createTransportState(dispatches, blockers, transportResults),
    generatedAt,
    policy: createTransportPolicy(),
    dispatches,
    blockers,
    results: transportResults,
    polls: transportPolls,
    totals: {
      approvedActions,
      dispatches: dispatches.length,
      blockers: blockers.length,
      results: transportResults.length,
      receivedResults: transportResults.filter((result) => result.state === "received").length,
      blockedResults: transportResults.filter((result) => result.state === "blocked").length,
      polls: transportPolls.length,
      activePollingSessions: new Set(transportPolls.map((poll) => poll.sessionId)).size,
      pendingDispatches: dispatches.length,
      previewedApprovals,
      ingestedApprovals,
      unsupportedActions,
      unsafeTargets
    },
    source: {
      projectRoot: resolve(projectRoot),
      requestPath: actionRequests.source.requestPath,
      approvalPath: actionRequests.source.approvalPath,
      resultPreviewPath: actionRequests.source.resultPreviewPath,
      transportResultPath: resolveNeonNodeTransportPaths(projectRoot).resultPath,
      transportPollPath: resolveNeonNodeTransportPaths(projectRoot).pollPath,
      sessionPath: deviceSessions.source.sessionPath
    }
  };
}

export function renderNeonNodeTransportReport(snapshot: INeonNodeTransportSnapshot): string {
  const dispatchLines =
    snapshot.dispatches.length > 0
      ? snapshot.dispatches.map(
          (dispatch) =>
            `- ${dispatch.dispatchId}: ${dispatch.kind} / ${dispatch.deviceId} / ${formatTransportTarget(dispatch.target)}`
        )
      : ["- none"];
  const blockerLines =
    snapshot.blockers.length > 0
      ? snapshot.blockers.map((blocker) => `- ${blocker.id}: ${blocker.summary}`)
      : ["- none"];
  const resultLines =
    snapshot.results.length > 0
      ? snapshot.results.map(
          (result) => `- ${result.transportResultId}: ${result.resultKind} / ${result.state} / ${result.summary}`
        )
      : ["- none"];
  const pollLines =
    snapshot.polls.length > 0
      ? snapshot.polls.map(
          (poll) => `- ${poll.pollId}: ${poll.deviceId} / ${poll.replay} / dispatches=${poll.dispatches}`
        )
      : ["- none"];

  return [
    `Neonika Node Transport: ${snapshot.state}`,
    `Policy: ${snapshot.policy.mode} / ${snapshot.policy.approval} / mutation=${snapshot.policy.mutationAllowed}`,
    `Dispatches: ${snapshot.totals.dispatches}`,
    `Blockers: ${snapshot.totals.blockers}`,
    `Results: ${snapshot.totals.results} received=${snapshot.totals.receivedResults} blocked=${snapshot.totals.blockedResults}`,
    `Polls: ${snapshot.totals.polls} sessions=${snapshot.totals.activePollingSessions}`,
    `Previewed approvals: ${snapshot.totals.previewedApprovals}`,
    "Ready dispatches:",
    ...dispatchLines,
    "Transport blockers:",
    ...blockerLines,
    "Transport results:",
    ...resultLines,
    "Transport polls:",
    ...pollLines
  ].join("\n");
}

function createTransportPolicy(): INeonNodeTransportPolicy {
  return {
    mode: "poll-only",
    approval: "operator-approved-actions-only",
    dispatchKinds: transportDispatchKinds,
    mutationAllowed: false,
    rawTokenExposure: "disabled",
    sessionSecretExposure: "disabled",
    resultIngest: "bounded-audit"
  };
}

function isTransportDispatchKind(kind: TNeonNodeActionRequestKind): boolean {
  return transportDispatchKinds.includes(kind);
}

function createTransportState(
  dispatches: readonly INeonNodeTransportDispatch[],
  blockers: readonly INeonNodeTransportBlocker[],
  results: readonly INeonNodeTransportResultRecord[]
): TNeonNodeTransportState {
  if (dispatches.length > 0 && blockers.length > 0) {
    return "partial";
  }

  if (dispatches.length > 0) {
    return "ready";
  }

  if (blockers.length > 0) {
    return "blocked";
  }

  if (results.length > 0) {
    return "ready";
  }

  return "empty";
}

function createTransportDispatch(
  approval: INeonNodeActionApprovalRecord,
  request: INeonNodeActionRequestRecord,
  session: INeonNodeDeviceSessionSummary,
  target: INeonNodeTransportTarget,
  generatedAt: string
): INeonNodeTransportDispatch {
  return {
    dispatchId: `node-dispatch-${fingerprintText(
      `${approval.approvalId}:${request.requestId}:${session.sessionFingerprint}:${request.kind}`
    )}`,
    state: "ready",
    approvalId: approval.approvalId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    deviceId: request.deviceId,
    kind: request.kind,
    target,
    requestedAt: request.requestedAt,
    approvedAt: approval.createdAt,
    generatedAt,
    delivery: "poll",
    safety: {
      readOnly: true,
      mutationAllowed: false,
      sideEffectExecuted: false,
      rawOutputPersisted: false,
      rawTokenExposed: false,
      sessionSecretExposed: false
    }
  };
}

function createTransportResultRecord(
  dispatch: INeonNodeTransportDispatch,
  input: INeonNodeTransportResultInput,
  createdAt: string
): INeonNodeTransportResultRecord {
  const resultKind = createTransportResultKind(dispatch.kind);
  const state = input.state ?? "received";
  const summary =
    input.summary ??
    (state === "received"
      ? `Received bounded ${dispatch.kind} result from ${dispatch.deviceId}.`
      : `Remote node blocked ${dispatch.kind} result.`);
  const base = {
    transportResultId: `node-transport-result-${fingerprintText(`${dispatch.dispatchId}:${createdAt}`)}`,
    dispatchId: dispatch.dispatchId,
    approvalId: dispatch.approvalId,
    requestId: dispatch.requestId,
    sessionId: dispatch.sessionId,
    deviceId: dispatch.deviceId,
    kind: dispatch.kind,
    state,
    resultKind,
    summary: normalizeText(summary, maxTransportSummaryLength),
    ...(input.blockReason ? { blockReason: normalizeText(input.blockReason, maxTransportSummaryLength) } : {}),
    safety: createTransportResultSafety(),
    createdAt
  };

  switch (resultKind) {
    case "file-list":
      return {
        ...base,
        fileList: createFileListResult(dispatch, input)
      };
    case "file-fetch":
      return {
        ...base,
        fileFetch: createFileFetchResult(dispatch, input)
      };
    case "dir-fetch":
      return {
        ...base,
        dirFetch: createDirFetchResult(dispatch, input)
      };
    case "browser-tabs":
      return {
        ...base,
        browserTabs: createBrowserTabsResult(input)
      };
    case "browser-snapshot":
      return {
        ...base,
        browserSnapshot: createBrowserSnapshotResult(dispatch, input)
      };
  }
}

function createTransportResultSafety(): INeonNodeTransportResultSafety {
  return {
    bounded: true,
    redacted: true,
    acceptedFromTransport: true,
    mutationExecuted: false,
    sideEffectExecuted: false,
    rawOutputPersisted: false,
    rawTokenPersisted: false,
    sessionSecretPersisted: false
  };
}

function createTransportPollRecord(
  session: INeonNodeDeviceSessionSummary,
  input: INeonNodeTransportPollInput,
  dispatches: readonly INeonNodeTransportDispatch[],
  nextCursor: string,
  replay: TNeonNodeTransportPollReplay,
  heartbeatAt: string
): INeonNodeTransportPollRecord {
  return {
    pollId: `node-transport-poll-${fingerprintText(`${session.sessionId}:${heartbeatAt}:${nextCursor}`)}`,
    state: "accepted",
    replay,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    nextCursor,
    dispatchIds: dispatches.map((dispatch) => dispatch.dispatchId),
    dispatches: dispatches.length,
    heartbeatAt,
    safety: createTransportPollSafety()
  };
}

function createTransportPollSafety(): INeonNodeTransportPollSafety {
  return {
    dispatchPayloadOnly: true,
    mutationExecuted: false,
    sideEffectExecuted: false,
    rawTokenPersisted: false,
    sessionSecretPersisted: false
  };
}

function createTransportPollCursor(
  sessionId: string,
  dispatches: readonly INeonNodeTransportDispatch[],
  results: readonly INeonNodeTransportResultRecord[]
): string {
  const dispatchPart = dispatches.map((dispatch) => dispatch.dispatchId).sort().join(",");
  const resultPart = results
    .filter((result) => result.sessionId === sessionId)
    .map((result) => result.dispatchId)
    .sort()
    .join(",");

  return `node-cursor-${fingerprintText(`${sessionId}:${dispatchPart}:${resultPart}`)}`;
}

function createFileListResult(
  dispatch: INeonNodeTransportDispatch,
  input: INeonNodeTransportResultInput
): INeonNodeTransportFileListResult {
  const entries = (input.entries ?? [])
    .slice(0, maxTransportEntries)
    .map((entry) => parseFileListEntry(entry))
    .filter((entry): entry is INeonNodeTransportFileListEntry => Boolean(entry));

  return {
    rootRelativePath: dispatch.target.path ?? ".",
    entries,
    totalEntries: input.totalEntries ?? entries.length,
    truncated: input.truncated ?? (input.entries?.length ?? 0) > entries.length
  };
}

function createFileFetchResult(
  dispatch: INeonNodeTransportDispatch,
  input: INeonNodeTransportResultInput
): INeonNodeTransportFileFetchResult {
  return {
    relativePath: dispatch.target.path ?? ".",
    ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
    binary: input.binary ?? false,
    ...(input.textPreview ? { textPreview: normalizeText(input.textPreview, maxTransportTextPreviewLength) } : {}),
    truncated: input.truncated ?? false
  };
}

function createDirFetchResult(
  dispatch: INeonNodeTransportDispatch,
  input: INeonNodeTransportResultInput
): INeonNodeTransportDirFetchResult {
  const entries = (input.entries ?? [])
    .slice(0, maxTransportEntries)
    .map((entry) => parseDirFetchEntry(entry))
    .filter((entry): entry is INeonNodeTransportDirFetchEntry => Boolean(entry));

  return {
    rootRelativePath: dispatch.target.path ?? ".",
    entries,
    totalEntries: input.totalEntries ?? entries.length,
    truncated: input.truncated ?? (input.entries?.length ?? 0) > entries.length
  };
}

function createBrowserTabsResult(input: INeonNodeTransportResultInput): INeonNodeTransportBrowserTabsResult {
  const tabs = (input.tabs ?? [])
    .slice(0, maxTransportEntries)
    .map((tab) => parseBrowserTabResult(tab))
    .filter((tab): tab is INeonNodeTransportBrowserTabResult => Boolean(tab));

  return {
    tabs,
    totalTabs: input.totalEntries ?? tabs.length,
    truncated: input.truncated ?? (input.tabs?.length ?? 0) > tabs.length
  };
}

function createBrowserSnapshotResult(
  dispatch: INeonNodeTransportDispatch,
  input: INeonNodeTransportResultInput
): INeonNodeTransportBrowserSnapshotResult {
  return {
    url: normalizeText(input.url ?? dispatch.target.url ?? "", maxTransportTargetLength),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.title ? { title: normalizeText(input.title, maxTransportSummaryLength) } : {}),
    ...(input.textPreview ? { textPreview: normalizeText(input.textPreview, maxTransportTextPreviewLength) } : {}),
    truncated: input.truncated ?? false
  };
}

function createTransportResultKind(kind: TNeonNodeActionRequestKind): TNeonNodeTransportResultKind {
  if (kind === "file.list" || kind === "dir.list") {
    return "file-list";
  }

  if (kind === "file.fetch") {
    return "file-fetch";
  }

  if (kind === "dir.fetch") {
    return "dir-fetch";
  }

  if (kind === "browser.tabs") {
    return "browser-tabs";
  }

  return "browser-snapshot";
}

function parseTransportResultInput(value: unknown): INeonNodeTransportResultInput {
  const input = isRecord(value) ? value : {};
  const dispatchId = requiredText(input["dispatchId"]);
  const state = parseTransportResultState(input["state"]);
  const summary = optionalText(input["summary"], maxTransportSummaryLength);
  const textPreview = optionalText(input["textPreview"], maxTransportTextPreviewLength);
  const entries = parseUnknownArray(input["entries"]);
  const tabs = parseUnknownArray(input["tabs"]);
  const title = optionalText(input["title"], maxTransportSummaryLength);
  const url = optionalText(input["url"], maxTransportTargetLength);
  const status = parseNonNegativeNumber(input["status"]);
  const sizeBytes = parseNonNegativeNumber(input["sizeBytes"]);
  const totalEntries = parseNonNegativeNumber(input["totalEntries"]);
  const binary = parseBoolean(input["binary"]);
  const truncated = parseBoolean(input["truncated"]);
  const blockReason = optionalText(input["blockReason"], maxTransportSummaryLength);

  return {
    dispatchId,
    ...(state ? { state } : {}),
    ...(summary ? { summary } : {}),
    ...(textPreview ? { textPreview } : {}),
    ...(entries ? { entries } : {}),
    ...(tabs ? { tabs } : {}),
    ...(title ? { title } : {}),
    ...(url ? { url: normalizeText(url, maxTransportTargetLength) } : {}),
    ...(status === undefined ? {} : { status }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    ...(totalEntries === undefined ? {} : { totalEntries }),
    ...(binary === undefined ? {} : { binary }),
    ...(truncated === undefined ? {} : { truncated }),
    ...(blockReason ? { blockReason } : {})
  };
}

function parseTransportResultRecord(
  value: Record<string, unknown>
): INeonNodeTransportResultRecord | undefined {
  const transportResultId = optionalText(value["transportResultId"]);
  const dispatchId = optionalText(value["dispatchId"]);
  const approvalId = optionalText(value["approvalId"]);
  const requestId = optionalText(value["requestId"]);
  const sessionId = optionalText(value["sessionId"]);
  const deviceId = optionalText(value["deviceId"]);
  const kind = parsePersistedActionKind(value["kind"]);
  const state = parsePersistedTransportResultState(value["state"]);
  const resultKind = parsePersistedTransportResultKind(value["resultKind"]);
  const summary = optionalText(value["summary"]);
  const safety = parseTransportResultSafety(value["safety"]);
  const createdAt = optionalText(value["createdAt"]);
  const blockReason = optionalText(value["blockReason"]);
  const fileList = parseFileListResult(value["fileList"]);
  const fileFetch = parseFileFetchResult(value["fileFetch"]);
  const dirFetch = parseDirFetchResult(value["dirFetch"]);
  const browserTabs = parseBrowserTabsResult(value["browserTabs"]);
  const browserSnapshot = parseBrowserSnapshotResult(value["browserSnapshot"]);

  if (
    !transportResultId ||
    !dispatchId ||
    !approvalId ||
    !requestId ||
    !sessionId ||
    !deviceId ||
    !kind ||
    !state ||
    !resultKind ||
    !summary ||
    !safety ||
    !createdAt
  ) {
    return undefined;
  }

  return {
    transportResultId,
    dispatchId,
    approvalId,
    requestId,
    sessionId,
    deviceId,
    kind,
    state,
    resultKind,
    summary,
    ...(blockReason ? { blockReason } : {}),
    ...(fileList ? { fileList } : {}),
    ...(fileFetch ? { fileFetch } : {}),
    ...(dirFetch ? { dirFetch } : {}),
    ...(browserTabs ? { browserTabs } : {}),
    ...(browserSnapshot ? { browserSnapshot } : {}),
    safety,
    createdAt
  };
}

function parseTransportPollInput(value: unknown): INeonNodeTransportPollInput {
  const input = isRecord(value) ? value : {};
  const sessionId = requiredText(input["sessionId"], maxTransportSummaryLength);
  const cursor = optionalText(input["cursor"], maxTransportPollCursorLength);

  return {
    sessionId,
    ...(cursor ? { cursor } : {})
  };
}

function parseTransportPollRecord(value: Record<string, unknown>): INeonNodeTransportPollRecord | undefined {
  const pollId = optionalText(value["pollId"]);
  const state = parsePersistedTransportPollState(value["state"]);
  const replay = parsePersistedTransportPollReplay(value["replay"]);
  const sessionId = optionalText(value["sessionId"]);
  const deviceId = optionalText(value["deviceId"]);
  const cursor = optionalText(value["cursor"], maxTransportPollCursorLength);
  const nextCursor = optionalText(value["nextCursor"], maxTransportPollCursorLength);
  const dispatchIds = parseStringArray(value["dispatchIds"]);
  const dispatches = parseNonNegativeNumber(value["dispatches"]);
  const heartbeatAt = optionalText(value["heartbeatAt"]);
  const safety = parseTransportPollSafety(value["safety"]);

  if (
    !pollId ||
    !state ||
    !replay ||
    !sessionId ||
    !deviceId ||
    !nextCursor ||
    !dispatchIds ||
    dispatches === undefined ||
    !heartbeatAt ||
    !safety
  ) {
    return undefined;
  }

  return {
    pollId,
    state,
    replay,
    sessionId,
    deviceId,
    ...(cursor ? { cursor } : {}),
    nextCursor,
    dispatchIds,
    dispatches,
    heartbeatAt,
    safety
  };
}

function parseDirFetchEntry(value: unknown): INeonNodeTransportDirFetchEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const relativePath = optionalText(value["relativePath"]);
  const binary = parseBoolean(value["binary"]);
  const truncated = parseBoolean(value["truncated"]);
  const sizeBytes = parseNonNegativeNumber(value["sizeBytes"]);
  const textPreview = optionalText(value["textPreview"], maxTransportTextPreviewLength);

  if (!relativePath || binary === undefined || truncated === undefined) {
    return undefined;
  }

  return {
    relativePath,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    binary,
    ...(textPreview ? { textPreview } : {}),
    truncated
  };
}

function parseDirFetchResult(value: unknown): INeonNodeTransportDirFetchResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rootRelativePath = optionalText(value["rootRelativePath"]);
  const rawEntries = parseUnknownArray(value["entries"]) ?? [];
  const entries = rawEntries
    .slice(0, maxTransportEntries)
    .map((entry) => parseDirFetchEntry(entry))
    .filter((entry): entry is INeonNodeTransportDirFetchEntry => Boolean(entry));
  const totalEntries = parseNonNegativeNumber(value["totalEntries"]);
  const truncated = parseBoolean(value["truncated"]);

  if (!rootRelativePath || totalEntries === undefined || truncated === undefined) {
    return undefined;
  }

  return {
    rootRelativePath,
    entries,
    totalEntries,
    truncated
  };
}

function parseFileListResult(value: unknown): INeonNodeTransportFileListResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rootRelativePath = optionalText(value["rootRelativePath"]);
  const rawEntries = parseUnknownArray(value["entries"]) ?? [];
  const entries = rawEntries
    .slice(0, maxTransportEntries)
    .map((entry) => parseFileListEntry(entry))
    .filter((entry): entry is INeonNodeTransportFileListEntry => Boolean(entry));
  const totalEntries = parseNonNegativeNumber(value["totalEntries"]);
  const truncated = parseBoolean(value["truncated"]);

  if (!rootRelativePath || totalEntries === undefined || truncated === undefined) {
    return undefined;
  }

  return {
    rootRelativePath,
    entries,
    totalEntries,
    truncated
  };
}

function parseFileFetchResult(value: unknown): INeonNodeTransportFileFetchResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const relativePath = optionalText(value["relativePath"]);
  const binary = parseBoolean(value["binary"]);
  const truncated = parseBoolean(value["truncated"]);
  const sizeBytes = parseNonNegativeNumber(value["sizeBytes"]);
  const textPreview = optionalText(value["textPreview"], maxTransportTextPreviewLength);

  if (!relativePath || binary === undefined || truncated === undefined) {
    return undefined;
  }

  return {
    relativePath,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    binary,
    ...(textPreview ? { textPreview } : {}),
    truncated
  };
}

function parseBrowserTabsResult(value: unknown): INeonNodeTransportBrowserTabsResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawTabs = parseUnknownArray(value["tabs"]) ?? [];
  const tabs = rawTabs
    .slice(0, maxTransportEntries)
    .map((tab) => parseBrowserTabResult(tab))
    .filter((tab): tab is INeonNodeTransportBrowserTabResult => Boolean(tab));
  const totalTabs = parseNonNegativeNumber(value["totalTabs"]);
  const truncated = parseBoolean(value["truncated"]);

  if (totalTabs === undefined || truncated === undefined) {
    return undefined;
  }

  return {
    tabs,
    totalTabs,
    truncated
  };
}

function parseBrowserSnapshotResult(value: unknown): INeonNodeTransportBrowserSnapshotResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const url = optionalText(value["url"], maxTransportTargetLength);
  const truncated = parseBoolean(value["truncated"]);
  const status = parseNonNegativeNumber(value["status"]);
  const title = optionalText(value["title"], maxTransportSummaryLength);
  const textPreview = optionalText(value["textPreview"], maxTransportTextPreviewLength);

  if (!url || truncated === undefined) {
    return undefined;
  }

  return {
    url,
    ...(status === undefined ? {} : { status }),
    ...(title ? { title } : {}),
    ...(textPreview ? { textPreview } : {}),
    truncated
  };
}

function parseFileListEntry(value: unknown): INeonNodeTransportFileListEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = optionalText(value["name"], maxTransportSummaryLength);
  const relativePath = optionalText(value["relativePath"], maxTransportTargetLength);
  const sizeBytes = parseNonNegativeNumber(value["sizeBytes"]);

  if (!name) {
    return undefined;
  }

  return {
    name: normalizeText(name, maxTransportSummaryLength),
    kind: parseFileListEntryKind(value["kind"]),
    ...(relativePath ? { relativePath: normalizeText(relativePath, maxTransportTargetLength) } : {}),
    ...(sizeBytes === undefined ? {} : { sizeBytes })
  };
}

function parseBrowserTabResult(value: unknown): INeonNodeTransportBrowserTabResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const title = optionalText(value["title"], maxTransportSummaryLength);
  const url = optionalText(value["url"], maxTransportTargetLength);

  if (!title && !url) {
    return undefined;
  }

  return {
    ...(title ? { title: normalizeText(title, maxTransportSummaryLength) } : {}),
    ...(url ? { url: normalizeText(url, maxTransportTargetLength) } : {}),
    active: parseBoolean(value["active"]) ?? false
  };
}

function parseTransportResultSafety(value: unknown): INeonNodeTransportResultSafety | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value["bounded"] === true &&
    value["redacted"] === true &&
    value["acceptedFromTransport"] === true &&
    value["mutationExecuted"] === false &&
    value["sideEffectExecuted"] === false &&
    value["rawOutputPersisted"] === false &&
    value["rawTokenPersisted"] === false &&
    value["sessionSecretPersisted"] === false
    ? createTransportResultSafety()
    : undefined;
}

function parseTransportPollSafety(value: unknown): INeonNodeTransportPollSafety | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value["dispatchPayloadOnly"] === true &&
    value["mutationExecuted"] === false &&
    value["sideEffectExecuted"] === false &&
    value["rawTokenPersisted"] === false &&
    value["sessionSecretPersisted"] === false
    ? createTransportPollSafety()
    : undefined;
}

function createTransportBlocker(
  id: TNeonNodeTransportBlockerId,
  approval: INeonNodeActionApprovalRecord,
  request: {
    readonly requestId: string;
    readonly sessionId: string;
    readonly deviceId: string;
    readonly kind: TNeonNodeActionRequestKind;
  },
  summary: string,
  recovery: string
): INeonNodeTransportBlocker {
  return {
    id,
    approvalId: approval.approvalId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    deviceId: request.deviceId,
    kind: request.kind,
    summary,
    recovery
  };
}

function createTransportTarget(
  projectRoot: string,
  request: INeonNodeActionRequestRecord
): INeonNodeTransportTarget | undefined {
  if (request.kind === "file.list" || request.kind === "dir.list" || request.kind === "file.fetch") {
    if (!request.target.path) {
      return undefined;
    }

    const path = createWorkspaceRelativeTarget(projectRoot, request.target.path);

    return path ? { path } : undefined;
  }

  if (request.kind === "browser.snapshot" && request.target.url) {
    return {
      url: createRedactedUrlTarget(request.target.url)
    };
  }

  return {};
}

function createWorkspaceRelativeTarget(projectRoot: string, targetPath: string): string | undefined {
  const resolvedRoot = resolve(projectRoot);
  const resolvedTarget = resolve(resolvedRoot, targetPath);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);

  if (relativeTarget === "") {
    return ".";
  }

  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
    return undefined;
  }

  return redactText(relativeTarget.split(sep).join("/")).slice(0, maxTransportTargetLength);
}

function createRedactedUrlTarget(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);

    return redactText(`${parsed.origin}${parsed.pathname}`).slice(0, maxTransportTargetLength);
  } catch {
    return redactText(targetUrl).slice(0, maxTransportTargetLength);
  }
}

function formatTransportTarget(target: INeonNodeTransportTarget): string {
  if (target.path) {
    return `path=${target.path}`;
  }

  if (target.url) {
    return `url=${target.url}`;
  }

  return "target=none";
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredText(value: unknown, maxLength = maxTransportSummaryLength): string {
  const parsed = optionalText(value, maxLength);

  if (!parsed) {
    throw new Error("Required node transport text value is missing");
  }

  return parsed;
}

function optionalText(value: unknown, maxLength = maxTransportSummaryLength): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? normalizeText(trimmed, maxLength) : undefined;
}

function normalizeText(value: string, maxLength: number): string {
  return redactText(value).slice(0, maxLength);
}

function parseUnknownArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value
    .map((entry) => optionalText(entry, maxTransportSummaryLength))
    .filter((entry): entry is string => Boolean(entry));

  return strings.length === value.length ? strings : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.floor(value);
}

function parseTransportResultState(value: unknown): TNeonNodeTransportResultState | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "received" || value === "blocked") {
    return value;
  }

  throw new Error("Invalid node transport result state");
}

function parsePersistedTransportResultState(value: unknown): TNeonNodeTransportResultState | undefined {
  return value === "received" || value === "blocked" ? value : undefined;
}

function parsePersistedTransportPollState(value: unknown): TNeonNodeTransportPollState | undefined {
  return value === "accepted" ? value : undefined;
}

function parsePersistedTransportPollReplay(value: unknown): TNeonNodeTransportPollReplay | undefined {
  return value === "replay" || value === "cursor-hit" ? value : undefined;
}

function parsePersistedTransportResultKind(value: unknown): TNeonNodeTransportResultKind | undefined {
  return value === "file-list" ||
    value === "file-fetch" ||
    value === "dir-fetch" ||
    value === "browser-tabs" ||
    value === "browser-snapshot"
    ? value
    : undefined;
}

function parsePersistedActionKind(value: unknown): TNeonNodeActionRequestKind | undefined {
  return value === "heartbeat" ||
    value === "file.list" ||
    value === "dir.list" ||
    value === "file.fetch" ||
    value === "dir.fetch" ||
    value === "file.write" ||
    value === "browser.tabs" ||
    value === "browser.snapshot" ||
    value === "browser.navigate" ||
    value === "browser.act" ||
    value === "phone.control"
    ? value
    : undefined;
}

function parseFileListEntryKind(value: unknown): INeonNodeTransportFileListEntry["kind"] {
  return value === "file" || value === "directory" || value === "other" ? value : "other";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error["code"] === code;
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
