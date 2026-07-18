import { createHash, createPublicKey, randomBytes, randomUUID, verify, type KeyObject } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  resolveNeonNodePairingForbiddenApprovalScope,
  resolveNeonNodePairingRequiredApprovalScopes,
  type TNeonNodeApprovalScope
} from "./neonNodePairingApprovalScopes.js";

export type TNeonNodePairingRequestState = "pending" | "expired" | "approved-shadow" | "denied";
export type TNeonNodePairingApprovalDecision = "approve" | "deny";
export type TNeonNodePairingChallengeVerifyState =
  | "verified"
  | "signature-mismatch"
  | "invalid-public-key"
  | "invalid-signature"
  | "missing-input";

export interface INeonNodePairingPaths {
  readonly requestPath: string;
  readonly approvalPath: string;
}

export interface INeonNodePairingRequestInput {
  readonly requestId?: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly displayName?: string;
  readonly platform?: string;
  readonly requestedRole?: string;
  readonly requestedScopes?: readonly string[];
}

export interface INeonNodePairingRequestRecord {
  readonly requestId: string;
  readonly deviceId: string;
  readonly publicKeyFingerprint: string;
  /** Public random nonce the device signs to prove possession of its private key. */
  readonly challenge: string;
  readonly displayName?: string;
  readonly platform?: string;
  readonly requestedRole: string;
  readonly requestedScopes: readonly string[];
  readonly state: "pending";
  readonly tokenIssued: false;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface INeonNodePairingChallengeVerifyInput {
  readonly publicKey: string;
  readonly challenge: string;
  readonly signature: string;
}

export interface INeonNodePairingChallengeVerifyResult {
  readonly state: TNeonNodePairingChallengeVerifyState;
  readonly verified: boolean;
}

export interface INeonNodePairingRequestSummary extends Omit<INeonNodePairingRequestRecord, "state"> {
  readonly state: TNeonNodePairingRequestState;
  readonly approvalId?: string;
}

export interface INeonNodePairingApprovalInput {
  readonly requestId: string;
  readonly decision: TNeonNodePairingApprovalDecision;
  readonly decidedBy: string;
  readonly reason?: string;
  /**
   * Operator scopes the approver holds. When present, the approval enforces
   * privilege delegation (an approver cannot grant more than they hold) and
   * refuses out-of-baseline approvals. When omitted, the local operator is
   * trusted (audit-only), matching the shadow CLI.
   */
  readonly approverScopes?: readonly string[];
}

export interface INeonNodePairingApprovalRecord {
  readonly approvalId: string;
  readonly requestId: string;
  readonly decision: TNeonNodePairingApprovalDecision;
  readonly decidedBy: string;
  readonly tokenIssued: false;
  readonly stateAfterDecision: "approved-shadow" | "denied";
  readonly decidedAt: string;
  /** Operator approval scopes this request demanded (derived from its capabilities). */
  readonly requiredApprovalScopes: readonly TNeonNodeApprovalScope[];
  readonly reason?: string;
}

export interface INeonNodePairingSnapshotTotals {
  readonly requests: number;
  readonly pending: number;
  readonly expired: number;
  readonly approvedShadow: number;
  readonly denied: number;
  readonly approvals: number;
}

export interface INeonNodePairingSnapshot {
  readonly state: "ready";
  readonly generatedAt: string;
  readonly source: INeonNodePairingPaths;
  readonly requests: readonly INeonNodePairingRequestSummary[];
  readonly approvals: readonly INeonNodePairingApprovalRecord[];
  readonly totals: INeonNodePairingSnapshotTotals;
}

export interface IReadNeonNodePairingOptions {
  readonly maxRequests?: number;
  readonly maxApprovals?: number;
}

const pairingRequestFile = "node-pairing-requests.jsonl";
const pairingApprovalFile = "node-pairing-approvals.jsonl";
const defaultPairingTtlMs = 5 * 60 * 1000;
const maxTextLength = 120;
const maxScopes = 12;

export function resolveNeonNodePairingPaths(projectRoot: string): INeonNodePairingPaths {
  const stateRoot = resolve(projectRoot, "state", "nodes");

  return {
    requestPath: join(stateRoot, pairingRequestFile),
    approvalPath: join(stateRoot, pairingApprovalFile)
  };
}

export async function createNeonNodePairingRequest(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly ttlMs?: number;
  } = {}
): Promise<INeonNodePairingRequestRecord> {
  const normalized = parsePairingRequestInput(input);
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const ttlMs = options.ttlMs ?? defaultPairingTtlMs;
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  const record: INeonNodePairingRequestRecord = {
    requestId: normalized.requestId ?? `pair-${randomUUID()}`,
    deviceId: normalized.deviceId,
    publicKeyFingerprint: fingerprintText(normalized.publicKey),
    challenge: randomBytes(32).toString("hex"),
    ...(normalized.displayName ? { displayName: normalized.displayName } : {}),
    ...(normalized.platform ? { platform: normalized.platform } : {}),
    requestedRole: normalized.requestedRole ?? "operator",
    requestedScopes: normalized.requestedScopes ?? ["operator.pairing"],
    state: "pending",
    tokenIssued: false,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString()
  };
  const paths = resolveNeonNodePairingPaths(projectRoot);

  await mkdir(dirname(paths.requestPath), { recursive: true });
  await appendFile(paths.requestPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

/**
 * Verify that a device signed its pairing challenge with the private key matching
 * the supplied ed25519 public key. Pure: no I/O, no token issuance. The public key
 * is accepted as PEM (SPKI) or base64-encoded DER SPKI; the signature is base64 over
 * the challenge's UTF-8 bytes. Any malformed input resolves to a non-verified state
 * rather than throwing.
 */
export function verifyNeonNodePairingChallenge(
  input: INeonNodePairingChallengeVerifyInput
): INeonNodePairingChallengeVerifyResult {
  if (!input.publicKey || !input.challenge || !input.signature) {
    return { state: "missing-input", verified: false };
  }

  let key: KeyObject;
  try {
    key = loadEd25519PublicKey(input.publicKey);
  } catch {
    return { state: "invalid-public-key", verified: false };
  }

  const signature = Buffer.from(input.signature, "base64");
  if (signature.byteLength === 0) {
    return { state: "invalid-signature", verified: false };
  }

  let matched: boolean;
  try {
    matched = verify(null, Buffer.from(input.challenge, "utf8"), key, signature);
  } catch {
    return { state: "invalid-signature", verified: false };
  }

  return matched ? { state: "verified", verified: true } : { state: "signature-mismatch", verified: false };
}

export async function recordNeonNodePairingApproval(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodePairingApprovalRecord> {
  const normalized = parsePairingApprovalInput(input);
  const snapshot = await createNeonNodePairingSnapshot(
    projectRoot,
    options.now ? { now: options.now } : {}
  );
  const request = snapshot.requests.find((candidate) => candidate.requestId === normalized.requestId);

  if (!request) {
    throw new Error("Pairing request not found");
  }

  if (request.state !== "pending") {
    throw new Error(`Pairing request is not pending: ${request.state}`);
  }

  const requiredApprovalScopes = resolveNeonNodePairingRequiredApprovalScopes(request.requestedScopes);

  // Privilege delegation: an approver can never grant more than they hold. When
  // the caller supplies their own operator scopes, refuse an approval that would
  // grant a capability the approver lacks. Absent approver scopes the local
  // operator is trusted (audit-only), matching the shadow CLI's implicit trust.
  if (normalized.decision === "approve" && normalized.approverScopes !== undefined) {
    const forbiddenScope = resolveNeonNodePairingForbiddenApprovalScope({
      requestedScopes: request.requestedScopes,
      approverScopes: normalized.approverScopes
    });
    if (forbiddenScope) {
      throw new Error(`Pairing approval forbidden: approver is missing operator scope "${forbiddenScope}"`);
    }
  }

  const decidedAt = (options.now ?? (() => new Date()))().toISOString();
  const record: INeonNodePairingApprovalRecord = {
    approvalId: `pair-approval-${randomUUID()}`,
    requestId: normalized.requestId,
    decision: normalized.decision,
    decidedBy: normalized.decidedBy,
    tokenIssued: false,
    stateAfterDecision: normalized.decision === "approve" ? "approved-shadow" : "denied",
    decidedAt,
    requiredApprovalScopes,
    ...(normalized.reason ? { reason: normalized.reason } : {})
  };
  const paths = resolveNeonNodePairingPaths(projectRoot);

  await mkdir(dirname(paths.approvalPath), { recursive: true });
  await appendFile(paths.approvalPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function createNeonNodePairingSnapshot(
  projectRoot: string,
  options: IReadNeonNodePairingOptions & {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodePairingSnapshot> {
  const now = options.now ?? (() => new Date());
  const [requestRecords, approvalRecords] = await Promise.all([
    readNeonNodePairingRequests(projectRoot, options),
    readNeonNodePairingApprovals(projectRoot, options)
  ]);
  const requests = summarizePairingRequests(requestRecords, approvalRecords, now());

  return {
    state: "ready",
    generatedAt: now().toISOString(),
    source: resolveNeonNodePairingPaths(projectRoot),
    requests,
    approvals: approvalRecords,
    totals: summarizePairingSnapshot(requests, approvalRecords)
  };
}

export async function readNeonNodePairingRequests(
  projectRoot: string,
  options: IReadNeonNodePairingOptions = {}
): Promise<readonly INeonNodePairingRequestRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodePairingPaths(projectRoot).requestPath,
    parsePairingRequestRecord
  );

  return options.maxRequests ? records.slice(-options.maxRequests) : records;
}

export async function readNeonNodePairingApprovals(
  projectRoot: string,
  options: IReadNeonNodePairingOptions = {}
): Promise<readonly INeonNodePairingApprovalRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodePairingPaths(projectRoot).approvalPath,
    parsePairingApprovalRecord
  );

  return options.maxApprovals ? records.slice(-options.maxApprovals) : records;
}

export function renderNeonNodePairingReport(snapshot: INeonNodePairingSnapshot): string {
  const requestLines =
    snapshot.requests.length > 0
      ? snapshot.requests.map(
          (request) =>
            `- ${request.requestId}: ${request.state} / ${request.deviceId} / tokenIssued=${request.tokenIssued}`
        )
      : ["- none"];
  const approvalLines =
    snapshot.approvals.length > 0
      ? snapshot.approvals.map(
          (approval) =>
            `- ${approval.approvalId}: ${approval.decision} / ${approval.requestId} / tokenIssued=${approval.tokenIssued} / requires=${approval.requiredApprovalScopes.join("+") || "none"}`
        )
      : ["- none"];

  return [
    `Neon Node Pairing: ${snapshot.state}`,
    `Totals: pending=${snapshot.totals.pending} approvedShadow=${snapshot.totals.approvedShadow} denied=${snapshot.totals.denied} expired=${snapshot.totals.expired}`,
    "Requests:",
    ...requestLines,
    "Approvals:",
    ...approvalLines
  ].join("\n");
}

function summarizePairingRequests(
  requests: readonly INeonNodePairingRequestRecord[],
  approvals: readonly INeonNodePairingApprovalRecord[],
  now: Date
): readonly INeonNodePairingRequestSummary[] {
  const approvalByRequestId = new Map<string, INeonNodePairingApprovalRecord>();

  for (const approval of approvals) {
    approvalByRequestId.set(approval.requestId, approval);
  }

  return requests.map((request) => {
    const approval = approvalByRequestId.get(request.requestId);
    const state = approval
      ? approval.stateAfterDecision
      : Date.parse(request.expiresAt) <= now.getTime()
        ? "expired"
        : "pending";

    return {
      ...request,
      state,
      ...(approval ? { approvalId: approval.approvalId } : {})
    };
  });
}

function summarizePairingSnapshot(
  requests: readonly INeonNodePairingRequestSummary[],
  approvals: readonly INeonNodePairingApprovalRecord[]
): INeonNodePairingSnapshotTotals {
  return {
    requests: requests.length,
    pending: requests.filter((request) => request.state === "pending").length,
    expired: requests.filter((request) => request.state === "expired").length,
    approvedShadow: requests.filter((request) => request.state === "approved-shadow").length,
    denied: requests.filter((request) => request.state === "denied").length,
    approvals: approvals.length
  };
}

async function readJsonlFile<T>(
  path: string,
  parseRecord: (value: unknown) => T | undefined
): Promise<readonly T[]> {
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

function parsePairingRequestInput(input: unknown): INeonNodePairingRequestInput {
  if (!isRecord(input)) {
    throw new Error("Pairing request input must be an object");
  }

  const requestId = optionalText(input["requestId"], 80);
  const displayName = optionalText(input["displayName"], maxTextLength);
  const platform = optionalText(input["platform"], maxTextLength);
  const requestedRole = optionalText(input["requestedRole"], maxTextLength);
  const requestedScopes = normalizeStringList(input["requestedScopes"]);

  return {
    ...(requestId ? { requestId } : {}),
    deviceId: requiredText(input["deviceId"], "deviceId"),
    publicKey: requiredText(input["publicKey"], "publicKey"),
    ...(displayName ? { displayName } : {}),
    ...(platform ? { platform } : {}),
    ...(requestedRole ? { requestedRole } : {}),
    ...(requestedScopes ? { requestedScopes } : {})
  };
}

function parsePairingApprovalInput(input: unknown): INeonNodePairingApprovalInput {
  if (!isRecord(input)) {
    throw new Error("Pairing approval input must be an object");
  }

  const decision = input["decision"];

  if (decision !== "approve" && decision !== "deny") {
    throw new Error("Pairing approval decision must be approve or deny");
  }

  const reason = optionalText(input["reason"], 240);
  const approverScopes = normalizeStringList(input["approverScopes"]);

  return {
    requestId: requiredText(input["requestId"], "requestId"),
    decision,
    decidedBy: requiredText(input["decidedBy"], "decidedBy"),
    ...(reason ? { reason } : {}),
    ...(approverScopes ? { approverScopes } : {})
  };
}

function parsePairingRequestRecord(value: unknown): INeonNodePairingRequestRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value["requestedScopes"])) {
    return undefined;
  }

  if (
    typeof value["requestId"] !== "string" ||
    typeof value["deviceId"] !== "string" ||
    typeof value["publicKeyFingerprint"] !== "string" ||
    typeof value["requestedRole"] !== "string" ||
    value["state"] !== "pending" ||
    value["tokenIssued"] !== false ||
    typeof value["createdAt"] !== "string" ||
    typeof value["expiresAt"] !== "string"
  ) {
    return undefined;
  }

  const requestedScopes = value["requestedScopes"].filter((scope): scope is string => typeof scope === "string");

  return {
    requestId: value["requestId"],
    deviceId: value["deviceId"],
    publicKeyFingerprint: value["publicKeyFingerprint"],
    challenge: typeof value["challenge"] === "string" ? value["challenge"] : "",
    ...(typeof value["displayName"] === "string" ? { displayName: value["displayName"] } : {}),
    ...(typeof value["platform"] === "string" ? { platform: value["platform"] } : {}),
    requestedRole: value["requestedRole"],
    requestedScopes,
    state: "pending",
    tokenIssued: false,
    createdAt: value["createdAt"],
    expiresAt: value["expiresAt"]
  };
}

function parsePairingApprovalRecord(value: unknown): INeonNodePairingApprovalRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value["approvalId"] !== "string" ||
    typeof value["requestId"] !== "string" ||
    (value["decision"] !== "approve" && value["decision"] !== "deny") ||
    typeof value["decidedBy"] !== "string" ||
    value["tokenIssued"] !== false ||
    (value["stateAfterDecision"] !== "approved-shadow" && value["stateAfterDecision"] !== "denied") ||
    typeof value["decidedAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    approvalId: value["approvalId"],
    requestId: value["requestId"],
    decision: value["decision"],
    decidedBy: value["decidedBy"],
    tokenIssued: false,
    stateAfterDecision: value["stateAfterDecision"],
    decidedAt: value["decidedAt"],
    requiredApprovalScopes: parseApprovalScopeList(value["requiredApprovalScopes"]),
    ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {})
  };
}

function parseApprovalScopeList(input: unknown): readonly TNeonNodeApprovalScope[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const known: readonly TNeonNodeApprovalScope[] = ["operator.pairing", "operator.write", "operator.admin"];

  return input.filter((value): value is TNeonNodeApprovalScope =>
    typeof value === "string" && known.includes(value as TNeonNodeApprovalScope)
  );
}

function normalizeStringList(input: unknown): readonly string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const values = input
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, maxScopes);

  return values.length > 0 ? [...new Set(values)] : undefined;
}

function requiredText(input: unknown, fieldName: string): string {
  const value = optionalText(input, maxTextLength);

  if (!value) {
    throw new Error(`Pairing request missing ${fieldName}`);
  }

  return value;
}

function optionalText(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const value = input.trim();

  return value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function fingerprintText(input: string): string {
  return createHash("sha256")
    .update(input)
    .digest("hex");
}

function loadEd25519PublicKey(publicKey: string): KeyObject {
  const trimmed = publicKey.trim();
  const key = trimmed.startsWith("-----BEGIN")
    ? createPublicKey(trimmed)
    : createPublicKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "spki" });

  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Pairing challenge public key must be ed25519");
  }

  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  const maybeError = error as { readonly code?: unknown };

  return (
    error instanceof Error &&
    typeof maybeError.code === "string" &&
    maybeError.code === code
  );
}
