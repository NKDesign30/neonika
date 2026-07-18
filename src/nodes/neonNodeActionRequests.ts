import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  createNeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSummary,
  type TNeonNodeDeviceSessionScope
} from "./neonNodeDeviceSessions.js";
import {
  createNeonNodeExecPolicySnapshot,
  type INeonNodeExecPolicySnapshot
} from "./neonNodeExecPolicy.js";

export type TNeonNodeActionRequestSnapshotState = "empty" | "ready" | "needs-approval" | "needs-preview" | "blocked";
export type TNeonNodeActionRequestKind =
  | "heartbeat"
  | "file.list"
  | "dir.list"
  | "file.fetch"
  | "dir.fetch"
  | "file.write"
  | "browser.tabs"
  | "browser.snapshot"
  | "browser.navigate"
  | "browser.act"
  | "phone.control";
export type TNeonNodeActionRequestState = "recorded" | "approval-required" | "blocked";
export type TNeonNodeActionApprovalPolicy = "not-required" | "required" | "disabled";
export type TNeonNodeActionExecutionState = "not-executed";
export type TNeonNodeActionBlockReason = "missing-scope" | "high-risk-action-disabled";
export type TNeonNodeActionApprovalDecision = "approve" | "reject";
export type TNeonNodeActionResultPreviewState = "ready" | "blocked";
export type TNeonNodeActionResultPreviewKind = "file-list" | "file-fetch" | "browser-snapshot";
export type TNeonNodeActionResultPreviewBlockReason =
  | "approval-not-approved"
  | "missing-target"
  | "unsafe-target"
  | "unsupported-action"
  | "read-error"
  | "target-too-large";

export interface INeonNodeActionRequestPaths {
  readonly requestPath: string;
  readonly approvalPath: string;
  readonly resultPreviewPath: string;
}

export interface INeonNodeActionRequestInput {
  readonly sessionId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly requestedBy: string;
  readonly targetPath?: string;
  readonly targetUrl?: string;
  readonly reason?: string;
}

export interface INeonNodeActionRequestTarget {
  readonly path?: string;
  readonly url?: string;
}

export interface INeonNodeActionRequestRecord {
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly state: TNeonNodeActionRequestState;
  readonly executionState: TNeonNodeActionExecutionState;
  readonly approvalPolicy: TNeonNodeActionApprovalPolicy;
  readonly blockReason?: TNeonNodeActionBlockReason;
  readonly requiredScope?: TNeonNodeDeviceSessionScope;
  readonly target: INeonNodeActionRequestTarget;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly reason?: string;
  readonly sourceSessionFingerprint: string;
  readonly rawOutputPersisted: false;
  readonly sideEffectExecuted: false;
}

export interface INeonNodeActionApprovalInput {
  readonly requestId: string;
  readonly decision: TNeonNodeActionApprovalDecision;
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface INeonNodeActionApprovalSafety {
  readonly executionEnabled: false;
  readonly sideEffectExecuted: false;
  readonly requiresCanaryGate: true;
}

export interface INeonNodeActionApprovalRecord {
  readonly approvalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly decision: TNeonNodeActionApprovalDecision;
  readonly operatorId: string;
  readonly reason?: string;
  readonly safety: INeonNodeActionApprovalSafety;
  readonly createdAt: string;
}

export interface INeonNodeActionResultPreviewInput {
  readonly approvalId: string;
}

export interface INeonNodeActionResultPreviewSafety {
  readonly executionMode: "read-only-preview";
  readonly mutationExecuted: false;
  readonly rawOutputPersisted: false;
  readonly redacted: true;
  readonly bounded: true;
}

export interface INeonNodeActionFileListPreviewEntry {
  readonly name: string;
  readonly relativePath: string;
  readonly kind: "file" | "directory" | "other";
  readonly sizeBytes?: number;
  readonly modifiedAt?: string;
}

export interface INeonNodeActionFileListPreview {
  readonly rootRelativePath: string;
  readonly entries: readonly INeonNodeActionFileListPreviewEntry[];
  readonly totalEntries: number;
  readonly truncated: boolean;
}

export interface INeonNodeActionFileFetchPreview {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly previewText?: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

export interface INeonNodeActionBrowserSnapshotPreview {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly title?: string;
  readonly textPreview: string;
  readonly truncated: boolean;
}

export interface INeonNodeActionResultPreviewRecord {
  readonly resultPreviewId: string;
  readonly approvalId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly kind: TNeonNodeActionRequestKind;
  readonly state: TNeonNodeActionResultPreviewState;
  readonly resultKind?: TNeonNodeActionResultPreviewKind;
  readonly blockReason?: TNeonNodeActionResultPreviewBlockReason;
  readonly summary: string;
  readonly fileList?: INeonNodeActionFileListPreview;
  readonly fileFetch?: INeonNodeActionFileFetchPreview;
  readonly browserSnapshot?: INeonNodeActionBrowserSnapshotPreview;
  readonly safety: INeonNodeActionResultPreviewSafety;
  readonly createdAt: string;
}

export interface INeonNodeActionRequestPolicy {
  readonly execution: "disabled";
  readonly heartbeat: "record-only";
  readonly fileRead: "approval-required";
  readonly fileWrite: "disabled";
  readonly browserRead: "approval-required";
  readonly browserMutation: "disabled";
  readonly phoneControl: "disabled";
}

export interface INeonNodeActionRequestTotals {
  readonly requests: number;
  readonly recorded: number;
  readonly approvalRequired: number;
  readonly blocked: number;
  readonly activeSessions: number;
  readonly approvalRecords: number;
  readonly approved: number;
  readonly rejected: number;
  readonly pendingApproval: number;
  readonly resultPreviews: number;
  readonly readyResultPreviews: number;
  readonly blockedResultPreviews: number;
  readonly pendingResultPreviews: number;
}

export interface IReadNeonNodeActionRequestsOptions {
  readonly maxRequests?: number;
  readonly maxApprovals?: number;
  readonly maxResultPreviews?: number;
  readonly now?: () => Date;
  readonly deviceSessionSnapshot?: INeonNodeDeviceSessionSnapshot;
}

export interface INeonNodeActionRequestSnapshot {
  readonly state: TNeonNodeActionRequestSnapshotState;
  readonly generatedAt: string;
  readonly deviceSessions: INeonNodeDeviceSessionSnapshot;
  readonly policy: INeonNodeActionRequestPolicy;
  readonly execPolicy: INeonNodeExecPolicySnapshot;
  readonly requests: readonly INeonNodeActionRequestRecord[];
  readonly approvals: readonly INeonNodeActionApprovalRecord[];
  readonly resultPreviews: readonly INeonNodeActionResultPreviewRecord[];
  readonly totals: INeonNodeActionRequestTotals;
  readonly source: INeonNodeActionRequestPaths;
}

interface IActionDefinition {
  readonly approvalPolicy: TNeonNodeActionApprovalPolicy;
  readonly requiredScope?: TNeonNodeDeviceSessionScope;
  readonly blockReason?: TNeonNodeActionBlockReason;
}

const requestFile = "node-action-requests.jsonl";
const approvalFile = "node-action-approvals.jsonl";
const resultPreviewFile = "node-action-result-previews.jsonl";
const maxTextLength = 200;
const approvalReasonMaxLength = 500;
const maxPreviewEntries = 20;
const maxFilePreviewBytes = 4096;
const maxBrowserPreviewBytes = 8192;
const actionDefinitions: Record<TNeonNodeActionRequestKind, IActionDefinition> = {
  heartbeat: {
    approvalPolicy: "not-required"
  },
  "file.list": {
    approvalPolicy: "required",
    requiredScope: "file.read"
  },
  "dir.list": {
    approvalPolicy: "required",
    requiredScope: "file.read"
  },
  "file.fetch": {
    approvalPolicy: "required",
    requiredScope: "file.read"
  },
  "dir.fetch": {
    approvalPolicy: "required",
    requiredScope: "file.read"
  },
  "file.write": {
    approvalPolicy: "disabled",
    requiredScope: "file.read",
    blockReason: "high-risk-action-disabled"
  },
  "browser.tabs": {
    approvalPolicy: "required",
    requiredScope: "browser.read"
  },
  "browser.snapshot": {
    approvalPolicy: "required",
    requiredScope: "browser.read"
  },
  "browser.navigate": {
    approvalPolicy: "disabled",
    requiredScope: "browser.read",
    blockReason: "high-risk-action-disabled"
  },
  "browser.act": {
    approvalPolicy: "disabled",
    requiredScope: "browser.read",
    blockReason: "high-risk-action-disabled"
  },
  "phone.control": {
    approvalPolicy: "disabled",
    blockReason: "high-risk-action-disabled"
  }
};

export function resolveNeonNodeActionRequestPaths(projectRoot: string): INeonNodeActionRequestPaths {
  return {
    requestPath: resolve(projectRoot, "state", "nodes", requestFile),
    approvalPath: resolve(projectRoot, "state", "nodes", approvalFile),
    resultPreviewPath: resolve(projectRoot, "state", "nodes", resultPreviewFile)
  };
}

export async function recordNeonNodeActionRequest(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly deviceSessionSnapshot?: INeonNodeDeviceSessionSnapshot;
  } = {}
): Promise<INeonNodeActionRequestRecord> {
  const normalized = parseActionRequestInput(input);
  const now = options.now ?? (() => new Date());
  const deviceSessions =
    options.deviceSessionSnapshot ?? (await createNeonNodeDeviceSessionSnapshot(projectRoot, { now }));
  const session = deviceSessions.sessions.find(
    (candidate) => candidate.sessionId === normalized.sessionId && candidate.state === "active"
  );

  if (!session) {
    throw new Error("Active device session not found");
  }

  const decision = decideActionRequest(normalized.kind, session);
  const requestedAt = now().toISOString();
  const record: INeonNodeActionRequestRecord = {
    requestId: `node-action-${createShortFingerprint(`${normalized.sessionId}:${normalized.kind}:${requestedAt}:${randomUUID()}`)}`,
    sessionId: normalized.sessionId,
    deviceId: session.deviceId,
    kind: normalized.kind,
    state: decision.state,
    executionState: "not-executed",
    approvalPolicy: decision.approvalPolicy,
    ...(decision.blockReason ? { blockReason: decision.blockReason } : {}),
    ...(decision.requiredScope ? { requiredScope: decision.requiredScope } : {}),
    target: createActionTarget(normalized),
    requestedBy: normalized.requestedBy,
    requestedAt,
    ...(normalized.reason ? { reason: normalized.reason } : {}),
    sourceSessionFingerprint: session.sessionFingerprint,
    rawOutputPersisted: false,
    sideEffectExecuted: false
  };
  const paths = resolveNeonNodeActionRequestPaths(projectRoot);

  await mkdir(dirname(paths.requestPath), { recursive: true });
  await appendFile(paths.requestPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function createNeonNodeActionRequestSnapshot(
  projectRoot: string,
  options: IReadNeonNodeActionRequestsOptions = {}
): Promise<INeonNodeActionRequestSnapshot> {
  const now = options.now ?? (() => new Date());
  const [requests, approvals, resultPreviews, deviceSessions] = await Promise.all([
    readNeonNodeActionRequestRecords(projectRoot, options),
    readNeonNodeActionApprovalRecords(projectRoot, options),
    readNeonNodeActionResultPreviewRecords(projectRoot, options),
    options.deviceSessionSnapshot ?? createNeonNodeDeviceSessionSnapshot(projectRoot, { now })
  ]);
  const generatedAt = now();
  const totals = summarizeActionRequests(requests, approvals, resultPreviews, deviceSessions);

  return {
    state:
      totals.blocked > 0 || totals.blockedResultPreviews > 0
        ? "blocked"
        : totals.pendingApproval > 0
          ? "needs-approval"
          : totals.pendingResultPreviews > 0
            ? "needs-preview"
          : totals.requests > 0
            ? "ready"
            : "empty",
    generatedAt: generatedAt.toISOString(),
    deviceSessions,
    policy: createActionRequestPolicy(),
    execPolicy: createNeonNodeExecPolicySnapshot(),
    requests,
    approvals,
    resultPreviews,
    totals,
    source: resolveNeonNodeActionRequestPaths(projectRoot)
  };
}

export async function readNeonNodeActionRequestRecords(
  projectRoot: string,
  options: {
    readonly maxRequests?: number;
  } = {}
): Promise<readonly INeonNodeActionRequestRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodeActionRequestPaths(projectRoot).requestPath,
    parseActionRequestRecord
  );

  return options.maxRequests ? records.slice(-options.maxRequests) : records;
}

export async function recordNeonNodeActionApproval(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodeActionApprovalRecord> {
  const normalized = parseActionApprovalInput(input);
  const [requests, approvals] = await Promise.all([
    readNeonNodeActionRequestRecords(projectRoot),
    readNeonNodeActionApprovalRecords(projectRoot)
  ]);
  const request = requests.find((entry) => entry.requestId === normalized.requestId);

  if (!request) {
    throw new Error("Node action request not found");
  }

  if (request.state !== "approval-required") {
    throw new Error("Node action request is not queued for operator approval");
  }

  if (approvals.some((approval) => approval.requestId === request.requestId)) {
    throw new Error("Node action request already has an approval record");
  }

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const record: INeonNodeActionApprovalRecord = {
    approvalId: createActionApprovalId(request, normalized, createdAt),
    requestId: request.requestId,
    sessionId: request.sessionId,
    deviceId: request.deviceId,
    kind: request.kind,
    decision: normalized.decision,
    operatorId: normalized.operatorId ?? "operator",
    ...(normalized.reason ? { reason: normalized.reason } : {}),
    safety: {
      executionEnabled: false,
      sideEffectExecuted: false,
      requiresCanaryGate: true
    },
    createdAt
  };
  const paths = resolveNeonNodeActionRequestPaths(projectRoot);

  await mkdir(dirname(paths.approvalPath), { recursive: true });
  await appendFile(paths.approvalPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function readNeonNodeActionApprovalRecords(
  projectRoot: string,
  options: {
    readonly maxApprovals?: number;
  } = {}
): Promise<readonly INeonNodeActionApprovalRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodeActionRequestPaths(projectRoot).approvalPath,
    parseActionApprovalRecord
  );

  return options.maxApprovals ? records.slice(-options.maxApprovals) : records;
}

export async function createNeonNodeActionResultPreview(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodeActionResultPreviewRecord> {
  const normalized = parseActionResultPreviewInput(input);
  const [requests, approvals, resultPreviews] = await Promise.all([
    readNeonNodeActionRequestRecords(projectRoot),
    readNeonNodeActionApprovalRecords(projectRoot),
    readNeonNodeActionResultPreviewRecords(projectRoot)
  ]);
  const approval = approvals.find((entry) => entry.approvalId === normalized.approvalId);

  if (!approval) {
    throw new Error("Node action approval record not found");
  }

  if (resultPreviews.some((preview) => preview.approvalId === approval.approvalId)) {
    throw new Error("Node action approval already has a result preview");
  }

  const request = requests.find((entry) => entry.requestId === approval.requestId);

  if (!request) {
    throw new Error("Node action request not found");
  }

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const preview =
    approval.decision === "approve"
      ? await materializeReadOnlyResultPreview(projectRoot, request, approval, createdAt)
      : createBlockedResultPreviewRecord({
          approval,
          request,
          createdAt,
          blockReason: "approval-not-approved",
          summary: "Approval decision is reject; no read-only preview was created."
        });
  const paths = resolveNeonNodeActionRequestPaths(projectRoot);

  await mkdir(dirname(paths.resultPreviewPath), { recursive: true });
  await appendFile(paths.resultPreviewPath, `${JSON.stringify(preview)}\n`, "utf8");

  return preview;
}

export async function readNeonNodeActionResultPreviewRecords(
  projectRoot: string,
  options: {
    readonly maxResultPreviews?: number;
  } = {}
): Promise<readonly INeonNodeActionResultPreviewRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodeActionRequestPaths(projectRoot).resultPreviewPath,
    parseActionResultPreviewRecord
  );

  return options.maxResultPreviews ? records.slice(-options.maxResultPreviews) : records;
}

export function renderNeonNodeActionRequestReport(snapshot: INeonNodeActionRequestSnapshot): string {
  const requestLines =
    snapshot.requests.length > 0
      ? snapshot.requests.map(
          (request) =>
            `- ${request.requestId}: ${request.kind} / ${request.state} / execution=${request.executionState} / sideEffect=${request.sideEffectExecuted}`
        )
      : ["- none"];
  const approvalLines =
    snapshot.approvals.length > 0
      ? snapshot.approvals.map(
          (approval) =>
            `- ${approval.approvalId}: ${approval.kind} / ${approval.decision} / execution=${approval.safety.executionEnabled}`
        )
      : ["- none"];
  const resultPreviewLines =
    snapshot.resultPreviews.length > 0
      ? snapshot.resultPreviews.map(
          (preview) =>
            `- ${preview.resultPreviewId}: ${preview.kind} / ${preview.state} / ${preview.summary}`
        )
      : ["- none"];

  return [
    `Neonika Node Action Requests: ${snapshot.state}`,
    `Totals: requests=${snapshot.totals.requests} approval=${snapshot.totals.approvalRequired} pending=${snapshot.totals.pendingApproval} blocked=${snapshot.totals.blocked}`,
    `Approval records: ${snapshot.totals.approvalRecords}`,
    `Result previews: ${snapshot.totals.resultPreviews} ready=${snapshot.totals.readyResultPreviews} pending=${snapshot.totals.pendingResultPreviews} blocked=${snapshot.totals.blockedResultPreviews}`,
    `Policy: heartbeat=${snapshot.policy.heartbeat} fileRead=${snapshot.policy.fileRead} browserRead=${snapshot.policy.browserRead} execution=${snapshot.policy.execution}`,
    `Exec Policy: executionEnabled=${snapshot.execPolicy.executionEnabled} blockedKinds=${snapshot.execPolicy.decisions.map((decision) => decision.kind).join(",") || "none"}`,
    "Requests:",
    ...requestLines,
    "Approvals:",
    ...approvalLines,
    "Result Previews:",
    ...resultPreviewLines
  ].join("\n");
}

function parseActionRequestInput(input: unknown): INeonNodeActionRequestInput {
  if (!isRecord(input)) {
    throw new Error("Node action request input must be an object");
  }

  const sessionId = requiredText(input["sessionId"], "sessionId");
  const kind = parseActionKind(input["kind"]);
  const requestedBy = requiredText(input["requestedBy"], "requestedBy");
  const targetPath = optionalText(input["targetPath"], 300);
  const targetUrl = optionalText(input["targetUrl"], 300);
  const reason = optionalText(input["reason"], maxTextLength);

  return {
    sessionId,
    kind,
    requestedBy,
    ...(targetPath ? { targetPath } : {}),
    ...(targetUrl ? { targetUrl } : {}),
    ...(reason ? { reason } : {})
  };
}

function parseActionRequestRecord(value: unknown): INeonNodeActionRequestRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const requestId = optionalText(value["requestId"], maxTextLength);
  const sessionId = optionalText(value["sessionId"], maxTextLength);
  const deviceId = optionalText(value["deviceId"], maxTextLength);
  const kind = parsePersistedActionKind(value["kind"]);
  const state = parseActionState(value["state"]);
  const approvalPolicy = parseApprovalPolicy(value["approvalPolicy"]);
  const blockReason = parseBlockReason(value["blockReason"]);
  const requiredScope = parseSessionScope(value["requiredScope"]);
  const target = parseTarget(value["target"]);
  const requestedBy = optionalText(value["requestedBy"], maxTextLength);
  const requestedAt = optionalText(value["requestedAt"], maxTextLength);
  const sourceSessionFingerprint = optionalText(value["sourceSessionFingerprint"], 128);
  const reason = optionalText(value["reason"], maxTextLength);

  if (
    !requestId ||
    !sessionId ||
    !deviceId ||
    !kind ||
    !state ||
    value["executionState"] !== "not-executed" ||
    !approvalPolicy ||
    !target ||
    !requestedBy ||
    !requestedAt ||
    !sourceSessionFingerprint ||
    value["rawOutputPersisted"] !== false ||
    value["sideEffectExecuted"] !== false
  ) {
    return undefined;
  }

  return {
    requestId,
    sessionId,
    deviceId,
    kind,
    state,
    executionState: "not-executed",
    approvalPolicy,
    ...(blockReason ? { blockReason } : {}),
    ...(requiredScope ? { requiredScope } : {}),
    target,
    requestedBy,
    requestedAt,
    ...(reason ? { reason } : {}),
    sourceSessionFingerprint,
    rawOutputPersisted: false,
    sideEffectExecuted: false
  };
}

function parseActionApprovalInput(input: unknown): INeonNodeActionApprovalInput {
  if (!isRecord(input)) {
    throw new Error("Node action approval input must be an object");
  }

  const requestId = requiredText(input["requestId"], "requestId");
  const decision = parseActionApprovalDecision(input["decision"]);
  const operatorId = optionalText(input["operatorId"], maxTextLength);
  const reason = optionalText(input["reason"], approvalReasonMaxLength);

  return {
    requestId,
    decision,
    ...(operatorId ? { operatorId } : {}),
    ...(reason ? { reason } : {})
  };
}

function parseActionApprovalRecord(value: unknown): INeonNodeActionApprovalRecord | undefined {
  if (!isRecord(value) || !isRecord(value["safety"])) {
    return undefined;
  }

  const safety = value["safety"];
  const approvalId = optionalText(value["approvalId"], maxTextLength);
  const requestId = optionalText(value["requestId"], maxTextLength);
  const sessionId = optionalText(value["sessionId"], maxTextLength);
  const deviceId = optionalText(value["deviceId"], maxTextLength);
  const kind = parsePersistedActionKind(value["kind"]);
  const decision = parsePersistedActionApprovalDecision(value["decision"]);
  const operatorId = optionalText(value["operatorId"], maxTextLength);
  const reason = optionalText(value["reason"], approvalReasonMaxLength);
  const createdAt = optionalText(value["createdAt"], maxTextLength);

  if (
    !approvalId ||
    !requestId ||
    !sessionId ||
    !deviceId ||
    !kind ||
    !decision ||
    !operatorId ||
    !createdAt ||
    safety["executionEnabled"] !== false ||
    safety["sideEffectExecuted"] !== false ||
    safety["requiresCanaryGate"] !== true
  ) {
    return undefined;
  }

  return {
    approvalId,
    requestId,
    sessionId,
    deviceId,
    kind,
    decision,
    operatorId,
    ...(reason ? { reason } : {}),
    safety: {
      executionEnabled: false,
      sideEffectExecuted: false,
      requiresCanaryGate: true
    },
    createdAt
  };
}

function parseActionResultPreviewInput(input: unknown): INeonNodeActionResultPreviewInput {
  if (!isRecord(input)) {
    throw new Error("Node action result preview input must be an object");
  }

  return {
    approvalId: requiredText(input["approvalId"], "approvalId")
  };
}

function parseActionResultPreviewRecord(value: unknown): INeonNodeActionResultPreviewRecord | undefined {
  if (!isRecord(value) || !isRecord(value["safety"])) {
    return undefined;
  }

  const safety = value["safety"];
  const resultPreviewId = optionalText(value["resultPreviewId"], maxTextLength);
  const approvalId = optionalText(value["approvalId"], maxTextLength);
  const requestId = optionalText(value["requestId"], maxTextLength);
  const sessionId = optionalText(value["sessionId"], maxTextLength);
  const deviceId = optionalText(value["deviceId"], maxTextLength);
  const kind = parsePersistedActionKind(value["kind"]);
  const state = parseResultPreviewState(value["state"]);
  const resultKind = parseResultPreviewKind(value["resultKind"]);
  const blockReason = parseResultPreviewBlockReason(value["blockReason"]);
  const summary = optionalText(value["summary"], maxTextLength);
  const createdAt = optionalText(value["createdAt"], maxTextLength);
  const fileList = parseFileListPreview(value["fileList"]);
  const fileFetch = parseFileFetchPreview(value["fileFetch"]);
  const browserSnapshot = parseBrowserSnapshotPreview(value["browserSnapshot"]);

  if (
    !resultPreviewId ||
    !approvalId ||
    !requestId ||
    !sessionId ||
    !deviceId ||
    !kind ||
    !state ||
    !summary ||
    !createdAt ||
    safety["executionMode"] !== "read-only-preview" ||
    safety["mutationExecuted"] !== false ||
    safety["rawOutputPersisted"] !== false ||
    safety["redacted"] !== true ||
    safety["bounded"] !== true
  ) {
    return undefined;
  }

  return {
    resultPreviewId,
    approvalId,
    requestId,
    sessionId,
    deviceId,
    kind,
    state,
    ...(resultKind ? { resultKind } : {}),
    ...(blockReason ? { blockReason } : {}),
    summary,
    ...(fileList ? { fileList } : {}),
    ...(fileFetch ? { fileFetch } : {}),
    ...(browserSnapshot ? { browserSnapshot } : {}),
    safety: createResultPreviewSafety(),
    createdAt
  };
}

async function materializeReadOnlyResultPreview(
  projectRoot: string,
  request: INeonNodeActionRequestRecord,
  approval: INeonNodeActionApprovalRecord,
  createdAt: string
): Promise<INeonNodeActionResultPreviewRecord> {
  if (request.state !== "approval-required") {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "unsupported-action",
      summary: "Request is not queued for read-only preview."
    });
  }

  if (request.kind === "file.list" || request.kind === "dir.list") {
    return await materializeFileListPreview(projectRoot, request, approval, createdAt);
  }

  if (request.kind === "file.fetch") {
    return await materializeFileFetchPreview(projectRoot, request, approval, createdAt);
  }

  if (request.kind === "browser.snapshot") {
    return await materializeBrowserSnapshotPreview(request, approval, createdAt);
  }

  return createBlockedResultPreviewRecord({
    approval,
    request,
    createdAt,
    blockReason: "unsupported-action",
    summary: `${request.kind} has no Neon read-only preview materializer yet.`
  });
}

async function materializeFileListPreview(
  projectRoot: string,
  request: INeonNodeActionRequestRecord,
  approval: INeonNodeActionApprovalRecord,
  createdAt: string
): Promise<INeonNodeActionResultPreviewRecord> {
  const targetPath = request.target.path ?? projectRoot;
  const safeTarget = await resolveSafeExistingProjectPath(projectRoot, targetPath);

  if (!safeTarget) {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "unsafe-target",
      summary: "File list target is outside the Neonika project root."
    });
  }

  try {
    const targetStat = await stat(safeTarget.absolutePath);

    if (!targetStat.isDirectory()) {
      return createBlockedResultPreviewRecord({
        approval,
        request,
        createdAt,
        blockReason: "unsafe-target",
        summary: "File list target is not a directory."
      });
    }

    const dirEntries = await readdir(safeTarget.absolutePath, { withFileTypes: true });
    const sortedEntries = [...dirEntries].sort((left, right) => left.name.localeCompare(right.name));
    const entries: INeonNodeActionFileListPreviewEntry[] = [];

    for (const entry of sortedEntries.slice(0, maxPreviewEntries)) {
      const entryPath = resolve(safeTarget.absolutePath, entry.name);
      const entryStat = await lstat(entryPath).catch(() => undefined);
      const modifiedAt = entryStat ? entryStat.mtime.toISOString() : undefined;
      const sizeBytes = entry.isFile() && entryStat ? entryStat.size : undefined;

      entries.push({
        name: redactText(entry.name).slice(0, maxTextLength),
        relativePath: createRootRelativePath(projectRoot, entryPath),
        kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(modifiedAt ? { modifiedAt } : {})
      });
    }

    const fileList: INeonNodeActionFileListPreview = {
      rootRelativePath: safeTarget.relativePath,
      entries,
      totalEntries: sortedEntries.length,
      truncated: sortedEntries.length > maxPreviewEntries
    };

    return createReadyResultPreviewRecord({
      approval,
      request,
      createdAt,
      resultKind: "file-list",
      summary: `Listed ${entries.length}/${sortedEntries.length} project-root entr${sortedEntries.length === 1 ? "y" : "ies"}.`,
      fileList
    });
  } catch {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "read-error",
      summary: "File list preview failed during read."
    });
  }
}

async function materializeFileFetchPreview(
  projectRoot: string,
  request: INeonNodeActionRequestRecord,
  approval: INeonNodeActionApprovalRecord,
  createdAt: string
): Promise<INeonNodeActionResultPreviewRecord> {
  if (!request.target.path) {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "missing-target",
      summary: "File fetch preview needs a target path."
    });
  }

  const safeTarget = await resolveSafeExistingProjectPath(projectRoot, request.target.path);

  if (!safeTarget) {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "unsafe-target",
      summary: "File fetch target is outside the Neonika project root."
    });
  }

  try {
    const targetStat = await stat(safeTarget.absolutePath);

    if (!targetStat.isFile()) {
      return createBlockedResultPreviewRecord({
        approval,
        request,
        createdAt,
        blockReason: "unsafe-target",
        summary: "File fetch target is not a file."
      });
    }

    const handle = await open(safeTarget.absolutePath, "r");

    try {
      const buffer = Buffer.alloc(Math.min(maxFilePreviewBytes, targetStat.size));
      const readResult = await handle.read(buffer, 0, buffer.byteLength, 0);
      const previewBuffer = buffer.subarray(0, readResult.bytesRead);
      const binary = !isLikelyTextBuffer(previewBuffer);
      const previewText = binary ? undefined : redactText(new TextDecoder("utf-8").decode(previewBuffer));
      const fileFetch: INeonNodeActionFileFetchPreview = {
        relativePath: safeTarget.relativePath,
        sizeBytes: targetStat.size,
        ...(previewText ? { previewText: previewText.slice(0, maxFilePreviewBytes) } : {}),
        binary,
        truncated: targetStat.size > readResult.bytesRead
      };

      return createReadyResultPreviewRecord({
        approval,
        request,
        createdAt,
        resultKind: "file-fetch",
        summary: binary
          ? `Read metadata for binary file ${safeTarget.relativePath}.`
          : `Read ${readResult.bytesRead}/${targetStat.size} bytes from ${safeTarget.relativePath}.`,
        fileFetch
      });
    } finally {
      await handle.close();
    }
  } catch {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "read-error",
      summary: "File fetch preview failed during read."
    });
  }
}

async function materializeBrowserSnapshotPreview(
  request: INeonNodeActionRequestRecord,
  approval: INeonNodeActionApprovalRecord,
  createdAt: string
): Promise<INeonNodeActionResultPreviewRecord> {
  if (!request.target.url) {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "missing-target",
      summary: "Browser snapshot preview needs a target URL."
    });
  }

  const url = parseSafeLoopbackUrl(request.target.url);

  if (!url) {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "unsafe-target",
      summary: "Browser snapshot preview only allows loopback HTTP URLs in this slice."
    });
  }

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_500)
    });
    const rawText = await response.text();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const boundedText = rawText.slice(0, maxBrowserPreviewBytes);
    const redactedText = redactText(stripHtmlForPreview(boundedText)).slice(0, maxBrowserPreviewBytes);
    const textPreview = redactedText.length > 0 ? redactedText : "[empty]";
    const title = extractHtmlTitle(boundedText);
    const browserSnapshot: INeonNodeActionBrowserSnapshotPreview = {
      url,
      status: response.status,
      contentType: redactText(contentType).slice(0, maxTextLength),
      ...(title ? { title } : {}),
      textPreview,
      truncated: rawText.length > boundedText.length
    };

    return createReadyResultPreviewRecord({
      approval,
      request,
      createdAt,
      resultKind: "browser-snapshot",
      summary: `Fetched loopback snapshot ${response.status} from ${new URL(url).pathname || "/"}.`,
      browserSnapshot
    });
  } catch {
    return createBlockedResultPreviewRecord({
      approval,
      request,
      createdAt,
      blockReason: "read-error",
      summary: "Browser snapshot preview failed during loopback fetch."
    });
  }
}

function decideActionRequest(
  kind: TNeonNodeActionRequestKind,
  session: INeonNodeDeviceSessionSummary
): {
  readonly state: TNeonNodeActionRequestState;
  readonly approvalPolicy: TNeonNodeActionApprovalPolicy;
  readonly blockReason?: TNeonNodeActionBlockReason;
  readonly requiredScope?: TNeonNodeDeviceSessionScope;
} {
  const definition = actionDefinitions[kind];

  if (definition.requiredScope && !session.grantedScopes.includes(definition.requiredScope)) {
    return {
      state: "blocked",
      approvalPolicy: "disabled",
      blockReason: "missing-scope",
      requiredScope: definition.requiredScope
    };
  }

  if (definition.approvalPolicy === "disabled") {
    return {
      state: "blocked",
      approvalPolicy: "disabled",
      blockReason: definition.blockReason ?? "high-risk-action-disabled",
      ...(definition.requiredScope ? { requiredScope: definition.requiredScope } : {})
    };
  }

  if (definition.approvalPolicy === "required") {
    return {
      state: "approval-required",
      approvalPolicy: "required",
      ...(definition.requiredScope ? { requiredScope: definition.requiredScope } : {})
    };
  }

  return {
    state: "recorded",
    approvalPolicy: "not-required"
  };
}

function summarizeActionRequests(
  requests: readonly INeonNodeActionRequestRecord[],
  approvals: readonly INeonNodeActionApprovalRecord[],
  resultPreviews: readonly INeonNodeActionResultPreviewRecord[],
  deviceSessions: INeonNodeDeviceSessionSnapshot
): INeonNodeActionRequestTotals {
  const approvedRequestIds = new Set(approvals.map((approval) => approval.requestId));
  const previewedApprovalIds = new Set(resultPreviews.map((preview) => preview.approvalId));
  const approvalRequired = requests.filter((request) => request.state === "approval-required").length;
  const approvedPreviewApprovals = approvals.filter((approval) => approval.decision === "approve");

  return {
    requests: requests.length,
    recorded: requests.filter((request) => request.state === "recorded").length,
    approvalRequired,
    blocked: requests.filter((request) => request.state === "blocked").length,
    activeSessions: deviceSessions.totals.active,
    approvalRecords: approvals.length,
    approved: approvals.filter((approval) => approval.decision === "approve").length,
    rejected: approvals.filter((approval) => approval.decision === "reject").length,
    pendingApproval: requests.filter(
      (request) => request.state === "approval-required" && !approvedRequestIds.has(request.requestId)
    ).length,
    resultPreviews: resultPreviews.length,
    readyResultPreviews: resultPreviews.filter((preview) => preview.state === "ready").length,
    blockedResultPreviews: resultPreviews.filter((preview) => preview.state === "blocked").length,
    pendingResultPreviews: approvedPreviewApprovals.filter((approval) => !previewedApprovalIds.has(approval.approvalId))
      .length
  };
}

function createReadyResultPreviewRecord(params: {
  readonly approval: INeonNodeActionApprovalRecord;
  readonly request: INeonNodeActionRequestRecord;
  readonly createdAt: string;
  readonly resultKind: TNeonNodeActionResultPreviewKind;
  readonly summary: string;
  readonly fileList?: INeonNodeActionFileListPreview;
  readonly fileFetch?: INeonNodeActionFileFetchPreview;
  readonly browserSnapshot?: INeonNodeActionBrowserSnapshotPreview;
}): INeonNodeActionResultPreviewRecord {
  return {
    resultPreviewId: createActionResultPreviewId(params.approval, params.createdAt),
    approvalId: params.approval.approvalId,
    requestId: params.request.requestId,
    sessionId: params.request.sessionId,
    deviceId: params.request.deviceId,
    kind: params.request.kind,
    state: "ready",
    resultKind: params.resultKind,
    summary: redactText(params.summary).slice(0, maxTextLength),
    ...(params.fileList ? { fileList: params.fileList } : {}),
    ...(params.fileFetch ? { fileFetch: params.fileFetch } : {}),
    ...(params.browserSnapshot ? { browserSnapshot: params.browserSnapshot } : {}),
    safety: createResultPreviewSafety(),
    createdAt: params.createdAt
  };
}

function createBlockedResultPreviewRecord(params: {
  readonly approval: INeonNodeActionApprovalRecord;
  readonly request: INeonNodeActionRequestRecord;
  readonly createdAt: string;
  readonly blockReason: TNeonNodeActionResultPreviewBlockReason;
  readonly summary: string;
}): INeonNodeActionResultPreviewRecord {
  return {
    resultPreviewId: createActionResultPreviewId(params.approval, params.createdAt),
    approvalId: params.approval.approvalId,
    requestId: params.request.requestId,
    sessionId: params.request.sessionId,
    deviceId: params.request.deviceId,
    kind: params.request.kind,
    state: "blocked",
    blockReason: params.blockReason,
    summary: redactText(params.summary).slice(0, maxTextLength),
    safety: createResultPreviewSafety(),
    createdAt: params.createdAt
  };
}

function createResultPreviewSafety(): INeonNodeActionResultPreviewSafety {
  return {
    executionMode: "read-only-preview",
    mutationExecuted: false,
    rawOutputPersisted: false,
    redacted: true,
    bounded: true
  };
}

async function readJsonlFile<T>(path: string, parseRecord: (value: unknown) => T | undefined): Promise<readonly T[]> {
  const raw = await readFile(path, "utf8").catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "";
    }

    throw error;
  });

  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => parseJsonLine(line, parseRecord))
    .filter((record): record is T => record !== undefined);
}

function parseJsonLine<T>(line: string, parseRecord: (value: unknown) => T | undefined): T | undefined {
  try {
    return parseRecord(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function createActionRequestPolicy(): INeonNodeActionRequestPolicy {
  return {
    execution: "disabled",
    heartbeat: "record-only",
    fileRead: "approval-required",
    fileWrite: "disabled",
    browserRead: "approval-required",
    browserMutation: "disabled",
    phoneControl: "disabled"
  };
}

function createActionTarget(input: INeonNodeActionRequestInput): INeonNodeActionRequestTarget {
  return {
    ...(input.targetPath ? { path: input.targetPath } : {}),
    ...(input.targetUrl ? { url: input.targetUrl } : {})
  };
}

function parseTarget(input: unknown): INeonNodeActionRequestTarget | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const path = optionalText(input["path"], 300);
  const url = optionalText(input["url"], 300);

  return {
    ...(path ? { path } : {}),
    ...(url ? { url } : {})
  };
}

function parseActionKind(input: unknown): TNeonNodeActionRequestKind {
  const kind = parsePersistedActionKind(input);

  if (!kind) {
    throw new Error("Unsupported node action request kind");
  }

  return kind;
}

function parsePersistedActionKind(input: unknown): TNeonNodeActionRequestKind | undefined {
  const value = optionalText(input, maxTextLength);

  if (
    value === "heartbeat" ||
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
  ) {
    return value;
  }

  return undefined;
}

function parseActionState(input: unknown): TNeonNodeActionRequestState | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "recorded" || value === "approval-required" || value === "blocked") {
    return value;
  }

  return undefined;
}

function parseApprovalPolicy(input: unknown): TNeonNodeActionApprovalPolicy | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "not-required" || value === "required" || value === "disabled") {
    return value;
  }

  return undefined;
}

function parseActionApprovalDecision(input: unknown): TNeonNodeActionApprovalDecision {
  const decision = parsePersistedActionApprovalDecision(input);

  if (!decision) {
    throw new Error("Node action approval decision must be approve or reject");
  }

  return decision;
}

function parsePersistedActionApprovalDecision(input: unknown): TNeonNodeActionApprovalDecision | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "approve" || value === "reject") {
    return value;
  }

  return undefined;
}

function parseBlockReason(input: unknown): TNeonNodeActionBlockReason | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "missing-scope" || value === "high-risk-action-disabled") {
    return value;
  }

  return undefined;
}

function parseSessionScope(input: unknown): TNeonNodeDeviceSessionScope | undefined {
  const value = optionalText(input, maxTextLength);

  if (
    value === "operator.pairing" ||
    value === "node.heartbeat" ||
    value === "node.status" ||
    value === "file.read" ||
    value === "browser.read"
  ) {
    return value;
  }

  return undefined;
}

function requiredText(input: unknown, fieldName: string): string {
  const value = optionalText(input, maxTextLength);

  if (!value) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function optionalText(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const value = redactText(input).trim();

  return value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function parseResultPreviewState(input: unknown): TNeonNodeActionResultPreviewState | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "ready" || value === "blocked") {
    return value;
  }

  return undefined;
}

function parseResultPreviewKind(input: unknown): TNeonNodeActionResultPreviewKind | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "file-list" || value === "file-fetch" || value === "browser-snapshot") {
    return value;
  }

  return undefined;
}

function parseResultPreviewBlockReason(input: unknown): TNeonNodeActionResultPreviewBlockReason | undefined {
  const value = optionalText(input, maxTextLength);

  if (
    value === "approval-not-approved" ||
    value === "missing-target" ||
    value === "unsafe-target" ||
    value === "unsupported-action" ||
    value === "read-error" ||
    value === "target-too-large"
  ) {
    return value;
  }

  return undefined;
}

function parseFileListPreview(input: unknown): INeonNodeActionFileListPreview | undefined {
  if (!isRecord(input) || !Array.isArray(input["entries"])) {
    return undefined;
  }

  const rootRelativePath = optionalText(input["rootRelativePath"], maxTextLength);
  const totalEntries = parseNonNegativeNumber(input["totalEntries"]);
  const entries = input["entries"].map(parseFileListPreviewEntry).filter(isDefined);

  if (!rootRelativePath || totalEntries === undefined || typeof input["truncated"] !== "boolean") {
    return undefined;
  }

  return {
    rootRelativePath,
    entries,
    totalEntries,
    truncated: input["truncated"]
  };
}

function parseFileListPreviewEntry(input: unknown): INeonNodeActionFileListPreviewEntry | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const name = optionalText(input["name"], maxTextLength);
  const relativePath = optionalText(input["relativePath"], 300);
  const kind = input["kind"];
  const sizeBytes = parseNonNegativeNumber(input["sizeBytes"]);
  const modifiedAt = optionalText(input["modifiedAt"], maxTextLength);

  if (!name || !relativePath || (kind !== "file" && kind !== "directory" && kind !== "other")) {
    return undefined;
  }

  return {
    name,
    relativePath,
    kind,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(modifiedAt ? { modifiedAt } : {})
  };
}

function parseFileFetchPreview(input: unknown): INeonNodeActionFileFetchPreview | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const relativePath = optionalText(input["relativePath"], 300);
  const sizeBytes = parseNonNegativeNumber(input["sizeBytes"]);
  const previewText = optionalText(input["previewText"], maxFilePreviewBytes);

  if (
    !relativePath ||
    sizeBytes === undefined ||
    typeof input["binary"] !== "boolean" ||
    typeof input["truncated"] !== "boolean"
  ) {
    return undefined;
  }

  return {
    relativePath,
    sizeBytes,
    ...(previewText ? { previewText } : {}),
    binary: input["binary"],
    truncated: input["truncated"]
  };
}

function parseBrowserSnapshotPreview(input: unknown): INeonNodeActionBrowserSnapshotPreview | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const url = optionalText(input["url"], 500);
  const status = parseNonNegativeNumber(input["status"]);
  const contentType = optionalText(input["contentType"], maxTextLength);
  const title = optionalText(input["title"], maxTextLength);
  const textPreview = optionalText(input["textPreview"], maxBrowserPreviewBytes);

  if (
    !url ||
    status === undefined ||
    !contentType ||
    textPreview === undefined ||
    typeof input["truncated"] !== "boolean"
  ) {
    return undefined;
  }

  return {
    url,
    status,
    contentType,
    ...(title ? { title } : {}),
    textPreview,
    truncated: input["truncated"]
  };
}

function parseNonNegativeNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : undefined;
}

function resolveSafeProjectPath(
  projectRoot: string,
  targetPath: string
): { readonly absolutePath: string; readonly relativePath: string } | undefined {
  const rootPath = resolve(projectRoot);
  const absolutePath = resolve(rootPath, targetPath);
  const relativePath = relative(rootPath, absolutePath);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    return undefined;
  }

  return {
    absolutePath,
    relativePath: relativePath === "" ? "." : redactText(relativePath).slice(0, 300)
  };
}

async function resolveSafeExistingProjectPath(
  projectRoot: string,
  targetPath: string
): Promise<{ readonly absolutePath: string; readonly relativePath: string } | undefined> {
  const requestedPath = resolveSafeProjectPath(projectRoot, targetPath);

  if (!requestedPath) {
    return undefined;
  }

  const rootPath = await realpath(resolve(projectRoot)).catch(() => undefined);
  const targetRealPath = await realpath(requestedPath.absolutePath).catch(() => undefined);

  if (!rootPath || !targetRealPath) {
    return undefined;
  }

  const relativePath = relative(rootPath, targetRealPath);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.startsWith(sep)) {
    return undefined;
  }

  return {
    absolutePath: targetRealPath,
    relativePath: relativePath === "" ? "." : redactText(relativePath).slice(0, 300)
  };
}

function createRootRelativePath(projectRoot: string, targetPath: string): string {
  const safePath = resolveSafeProjectPath(projectRoot, targetPath);

  return safePath?.relativePath ?? "[outside-project-root]";
}

function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) {
    return true;
  }

  if (buffer.includes(0)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }

  let controlBytes = 0;

  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      controlBytes += 1;
    }
  }

  return controlBytes / buffer.byteLength < 0.01;
}

function parseSafeLoopbackUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase();

    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(hostname)) {
      return undefined;
    }

    url.username = "";
    url.password = "";

    return url.toString();
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function stripHtmlForPreview(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractHtmlTitle(input: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(input);
  const title = match ? redactText(stripHtmlForPreview(match[1] ?? "")).slice(0, maxTextLength) : "";

  return title.length > 0 ? title : undefined;
}

function isDefined<T>(input: T | undefined): input is T {
  return input !== undefined;
}

function createActionApprovalId(
  request: INeonNodeActionRequestRecord,
  input: INeonNodeActionApprovalInput,
  createdAt: string
): string {
  return `node-action-approval-${createShortFingerprint(
    [request.requestId, input.decision, input.operatorId ?? "operator", createdAt].join("\u001f")
  )}`;
}

function createActionResultPreviewId(approval: INeonNodeActionApprovalRecord, createdAt: string): string {
  return `node-action-result-${createShortFingerprint([approval.approvalId, approval.requestId, createdAt].join("\u001f"))}`;
}

function createShortFingerprint(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  const maybeError = error as { readonly code?: unknown };

  return maybeError.code === code;
}
