import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createNeonNodePairingTokenGateSnapshot,
  type INeonNodePairingTokenGateApproval,
  type INeonNodePairingTokenGateSnapshot
} from "./neonNodePairingTokenGate.js";

export type TNeonNodePairingCanaryTokenSnapshotState = "locked" | "ready" | "issued";
export type TNeonNodePairingCanaryTokenIssueState = "issued-canary";
export type TNeonNodePairingTokenDeliveryMethod = "mission-control-once" | "operator-out-of-band";
export type TNeonNodePairingTokenDeliveryState = "operator-handoff-required";

export interface INeonNodePairingCanaryTokenPaths {
  readonly tokenIssuePath: string;
}

export interface INeonNodePairingCanaryTokenIssueInput {
  readonly requestId: string;
  readonly approvalId: string;
  readonly issuedBy: string;
  readonly deliveryMethod: TNeonNodePairingTokenDeliveryMethod;
  readonly deliveryNote?: string;
  readonly ttlMinutes?: number;
}

export interface INeonNodePairingCanaryTokenIssueRecord {
  readonly tokenIssueId: string;
  readonly requestId: string;
  readonly approvalId: string;
  readonly deviceId: string;
  readonly displayName?: string;
  readonly requestedRole: string;
  readonly requestedScopes: readonly string[];
  readonly tokenFingerprint: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuedBy: string;
  readonly deliveryMethod: TNeonNodePairingTokenDeliveryMethod;
  readonly deliveryState: TNeonNodePairingTokenDeliveryState;
  readonly deliveryNote?: string;
  readonly secretPersisted: false;
  readonly tokenMaterialPersisted: false;
}

export interface INeonNodePairingCanaryTokenOneTimeSecret {
  readonly token: string;
  readonly visibleOnce: true;
  readonly persisted: false;
  readonly expiresAt: string;
  readonly warning: string;
}

export interface INeonNodePairingCanaryTokenIssueResult {
  readonly state: TNeonNodePairingCanaryTokenIssueState;
  readonly record: INeonNodePairingCanaryTokenIssueRecord;
  readonly oneTimeSecret: INeonNodePairingCanaryTokenOneTimeSecret;
}

export interface INeonNodePairingCanaryTokenDeliveryPolicy {
  readonly rawTokenPersistence: "disabled";
  readonly rawTokenHttpExposure: "disabled";
  readonly rawTokenCliEcho: "disabled";
  readonly requiredHandoff: "in-process-one-time";
}

export interface INeonNodePairingCanaryTokenTotals {
  readonly issued: number;
  readonly active: number;
  readonly expired: number;
  readonly eligibleApprovals: number;
  readonly gateBlockers: number;
}

export interface IReadNeonNodePairingCanaryTokensOptions {
  readonly maxIssues?: number;
  readonly now?: () => Date;
  readonly tokenGateSnapshot?: INeonNodePairingTokenGateSnapshot;
}

export interface INeonNodePairingCanaryTokenSnapshot {
  readonly state: TNeonNodePairingCanaryTokenSnapshotState;
  readonly generatedAt: string;
  readonly tokenGate: INeonNodePairingTokenGateSnapshot;
  readonly deliveryPolicy: INeonNodePairingCanaryTokenDeliveryPolicy;
  readonly issues: readonly INeonNodePairingCanaryTokenIssueRecord[];
  readonly totals: INeonNodePairingCanaryTokenTotals;
  readonly source: INeonNodePairingCanaryTokenPaths;
}

const tokenIssueFile = "node-pairing-canary-tokens.jsonl";
const defaultCanaryTokenTtlMs = 15 * 60 * 1000;
const maxTextLength = 160;
const tokenPrefix = "neon_node_canary";

export function resolveNeonNodePairingCanaryTokenPaths(projectRoot: string): INeonNodePairingCanaryTokenPaths {
  return {
    tokenIssuePath: resolve(projectRoot, "state", "nodes", tokenIssueFile)
  };
}

export async function issueNeonNodePairingCanaryToken(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly tokenGateSnapshot?: INeonNodePairingTokenGateSnapshot;
    readonly createTokenMaterial?: () => string;
  } = {}
): Promise<INeonNodePairingCanaryTokenIssueResult> {
  const normalized = parseCanaryTokenIssueInput(input);
  const now = options.now ?? (() => new Date());
  const tokenGateSnapshot =
    options.tokenGateSnapshot ?? (await createNeonNodePairingTokenGateSnapshot(projectRoot, { now }));

  if (tokenGateSnapshot.state !== "ready-for-canary") {
    throw new Error(`Canary token gate is not ready: ${tokenGateSnapshot.state}`);
  }

  const eligibleApproval = findEligibleApproval(tokenGateSnapshot.eligibleApprovals, normalized);

  if (!eligibleApproval) {
    throw new Error("Approved pairing is not eligible for canary token issue");
  }

  const existingIssues = await readNeonNodePairingCanaryTokenIssues(projectRoot);

  if (
    existingIssues.some(
      (issue) => issue.approvalId === normalized.approvalId || issue.requestId === normalized.requestId
    )
  ) {
    throw new Error("Canary token already issued for this pairing approval");
  }

  const issuedAt = now();
  const ttlMs = normalized.ttlMinutes ? normalized.ttlMinutes * 60 * 1000 : defaultCanaryTokenTtlMs;
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);
  const tokenMaterial = options.createTokenMaterial?.() ?? createCanaryTokenMaterial();
  const record: INeonNodePairingCanaryTokenIssueRecord = {
    tokenIssueId: `canary-token-${createShortFingerprint(`${normalized.requestId}:${issuedAt.toISOString()}`)}`,
    requestId: normalized.requestId,
    approvalId: normalized.approvalId,
    deviceId: eligibleApproval.deviceId,
    ...(eligibleApproval.displayName ? { displayName: eligibleApproval.displayName } : {}),
    requestedRole: eligibleApproval.requestedRole,
    requestedScopes: eligibleApproval.requestedScopes,
    tokenFingerprint: fingerprintText(tokenMaterial),
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuedBy: normalized.issuedBy,
    deliveryMethod: normalized.deliveryMethod,
    deliveryState: "operator-handoff-required",
    ...(normalized.deliveryNote ? { deliveryNote: normalized.deliveryNote } : {}),
    secretPersisted: false,
    tokenMaterialPersisted: false
  };
  const paths = resolveNeonNodePairingCanaryTokenPaths(projectRoot);

  await mkdir(dirname(paths.tokenIssuePath), { recursive: true });
  await appendFile(paths.tokenIssuePath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    state: "issued-canary",
    record,
    oneTimeSecret: {
      token: tokenMaterial,
      visibleOnce: true,
      persisted: false,
      expiresAt: record.expiresAt,
      warning: "Deliver this token through a secure operator handoff. Neonika does not persist it."
    }
  };
}

export async function createNeonNodePairingCanaryTokenSnapshot(
  projectRoot: string,
  options: IReadNeonNodePairingCanaryTokensOptions = {}
): Promise<INeonNodePairingCanaryTokenSnapshot> {
  const now = options.now ?? (() => new Date());
  const [issues, tokenGate] = await Promise.all([
    readNeonNodePairingCanaryTokenIssues(projectRoot, options),
    options.tokenGateSnapshot ?? createNeonNodePairingTokenGateSnapshot(projectRoot, { now })
  ]);
  const generatedAt = now();
  const totals = summarizeCanaryTokenIssues(issues, tokenGate, generatedAt);

  return {
    state: totals.issued > 0 ? "issued" : tokenGate.state === "ready-for-canary" ? "ready" : "locked",
    generatedAt: generatedAt.toISOString(),
    tokenGate,
    deliveryPolicy: createDeliveryPolicy(),
    issues,
    totals,
    source: resolveNeonNodePairingCanaryTokenPaths(projectRoot)
  };
}

export async function readNeonNodePairingCanaryTokenIssues(
  projectRoot: string,
  options: {
    readonly maxIssues?: number;
  } = {}
): Promise<readonly INeonNodePairingCanaryTokenIssueRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodePairingCanaryTokenPaths(projectRoot).tokenIssuePath,
    parseCanaryTokenIssueRecord
  );
  const limit = options.maxIssues ?? records.length;

  return records.slice(-limit);
}

export function renderNeonNodePairingCanaryTokenReport(
  snapshot: INeonNodePairingCanaryTokenSnapshot
): string {
  const issueLines =
    snapshot.issues.length > 0
      ? snapshot.issues.map(
          (issue) =>
            `- ${issue.tokenIssueId}: ${issue.deviceId} / ${issue.deliveryState} / secretPersisted=${issue.secretPersisted}`
        )
      : ["- none"];
  const blockerLines =
    snapshot.tokenGate.blockers.length > 0
      ? snapshot.tokenGate.blockers.map((blocker) => `- ${blocker.id}: ${blocker.summary}`)
      : ["- none"];

  return [
    `Neon Node Canary Tokens: ${snapshot.state}`,
    `Gate: ${snapshot.tokenGate.state} / blockers=${snapshot.tokenGate.totals.blockers}`,
    `Totals: issued=${snapshot.totals.issued} active=${snapshot.totals.active} expired=${snapshot.totals.expired}`,
    `Delivery: rawPersistence=${snapshot.deliveryPolicy.rawTokenPersistence} http=${snapshot.deliveryPolicy.rawTokenHttpExposure} cli=${snapshot.deliveryPolicy.rawTokenCliEcho}`,
    "Issues:",
    ...issueLines,
    "Gate blockers:",
    ...blockerLines
  ].join("\n");
}

function parseCanaryTokenIssueInput(input: unknown): INeonNodePairingCanaryTokenIssueInput {
  if (!isRecord(input)) {
    throw new Error("Canary token issue input must be an object");
  }

  const requestId = requiredText(input["requestId"], "requestId");
  const approvalId = requiredText(input["approvalId"], "approvalId");
  const issuedBy = requiredText(input["issuedBy"], "issuedBy");
  const deliveryMethod = parseDeliveryMethod(input["deliveryMethod"]);
  const deliveryNote = optionalText(input["deliveryNote"], 240);
  const ttlMinutes = optionalPositiveInteger(input["ttlMinutes"], "ttlMinutes");

  return {
    requestId,
    approvalId,
    issuedBy,
    deliveryMethod,
    ...(deliveryNote ? { deliveryNote } : {}),
    ...(ttlMinutes ? { ttlMinutes } : {})
  };
}

function parseCanaryTokenIssueRecord(value: unknown): INeonNodePairingCanaryTokenIssueRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const tokenIssueId = optionalText(value["tokenIssueId"], maxTextLength);
  const requestId = optionalText(value["requestId"], maxTextLength);
  const approvalId = optionalText(value["approvalId"], maxTextLength);
  const deviceId = optionalText(value["deviceId"], maxTextLength);
  const requestedRole = optionalText(value["requestedRole"], maxTextLength);
  const requestedScopesInput = value["requestedScopes"];
  const tokenFingerprint = optionalText(value["tokenFingerprint"], 128);
  const issuedAt = optionalText(value["issuedAt"], maxTextLength);
  const expiresAt = optionalText(value["expiresAt"], maxTextLength);
  const issuedBy = optionalText(value["issuedBy"], maxTextLength);
  const deliveryState = value["deliveryState"];
  const deliveryMethod = parsePersistedDeliveryMethod(value["deliveryMethod"]);

  if (
    !tokenIssueId ||
    !requestId ||
    !approvalId ||
    !deviceId ||
    !requestedRole ||
    !Array.isArray(requestedScopesInput) ||
    !tokenFingerprint ||
    !issuedAt ||
    !expiresAt ||
    !issuedBy ||
    !deliveryMethod ||
    deliveryState !== "operator-handoff-required" ||
    value["secretPersisted"] !== false ||
    value["tokenMaterialPersisted"] !== false
  ) {
    return undefined;
  }

  const requestedScopes = requestedScopesInput.filter((scope): scope is string => typeof scope === "string");
  const displayName = optionalText(value["displayName"], maxTextLength);
  const deliveryNote = optionalText(value["deliveryNote"], 240);

  return {
    tokenIssueId,
    requestId,
    approvalId,
    deviceId,
    ...(displayName ? { displayName } : {}),
    requestedRole,
    requestedScopes,
    tokenFingerprint,
    issuedAt,
    expiresAt,
    issuedBy,
    deliveryMethod,
    deliveryState,
    ...(deliveryNote ? { deliveryNote } : {}),
    secretPersisted: false,
    tokenMaterialPersisted: false
  };
}

function findEligibleApproval(
  approvals: readonly INeonNodePairingTokenGateApproval[],
  input: INeonNodePairingCanaryTokenIssueInput
): INeonNodePairingTokenGateApproval | undefined {
  return approvals.find(
    (approval) => approval.approvalId === input.approvalId && approval.requestId === input.requestId
  );
}

function summarizeCanaryTokenIssues(
  issues: readonly INeonNodePairingCanaryTokenIssueRecord[],
  tokenGate: INeonNodePairingTokenGateSnapshot,
  now: Date
): INeonNodePairingCanaryTokenTotals {
  const active = issues.filter((issue) => new Date(issue.expiresAt).getTime() > now.getTime()).length;

  return {
    issued: issues.length,
    active,
    expired: issues.length - active,
    eligibleApprovals: tokenGate.totals.eligibleApprovals,
    gateBlockers: tokenGate.totals.blockers
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

function createDeliveryPolicy(): INeonNodePairingCanaryTokenDeliveryPolicy {
  return {
    rawTokenPersistence: "disabled",
    rawTokenHttpExposure: "disabled",
    rawTokenCliEcho: "disabled",
    requiredHandoff: "in-process-one-time"
  };
}

function parseDeliveryMethod(input: unknown): TNeonNodePairingTokenDeliveryMethod {
  const value = optionalText(input, maxTextLength);

  if (value === "operator-out-of-band") {
    return "operator-out-of-band";
  }

  return "mission-control-once";
}

function parsePersistedDeliveryMethod(input: unknown): TNeonNodePairingTokenDeliveryMethod | undefined {
  const value = optionalText(input, maxTextLength);

  if (value === "mission-control-once" || value === "operator-out-of-band") {
    return value;
  }

  return undefined;
}

function optionalPositiveInteger(input: unknown, fieldName: string): number | undefined {
  if (input === undefined || input === null || input === "") {
    return undefined;
  }

  const value = typeof input === "number" ? input : typeof input === "string" ? Number(input) : Number.NaN;

  if (!Number.isInteger(value) || value <= 0 || value > 24 * 60) {
    throw new Error(`${fieldName} must be a positive integer up to 1440`);
  }

  return value;
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

  const value = input.trim();

  return value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function createCanaryTokenMaterial(): string {
  return `${tokenPrefix}_${randomBytes(32).toString("base64url")}`;
}

function fingerprintText(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function createShortFingerprint(input: string): string {
  return fingerprintText(input).slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  const maybeError = error as { readonly code?: unknown };

  return maybeError.code === code;
}
