import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createNeonNodePairingCanaryTokenSnapshot,
  readNeonNodePairingCanaryTokenIssues,
  type INeonNodePairingCanaryTokenIssueRecord,
  type INeonNodePairingCanaryTokenSnapshot
} from "./neonNodePairingCanaryTokens.js";
import { safeEqualSecret } from "../security/secretEqual.js";

export type TNeonNodeDeviceSessionSnapshotState = "locked" | "ready" | "active";
export type TNeonNodeDeviceSessionHandshakeState = "accepted-canary";
export type TNeonNodeDeviceSessionState = "active" | "expired";
export type TNeonNodeDeviceSessionScope =
  | "operator.pairing"
  | "node.heartbeat"
  | "node.status"
  | "file.read"
  | "browser.read";
export type TNeonNodeDeviceSessionBlockedScopeReason = "approval-required" | "unsupported";

export interface INeonNodeDeviceSessionPaths {
  readonly sessionPath: string;
}

export interface INeonNodeDeviceSessionHandshakeInput {
  readonly tokenIssueId: string;
  readonly token: string;
  readonly acceptedBy: string;
  readonly deviceNonce?: string;
  readonly requestedScopes?: readonly string[];
  readonly ttlMinutes?: number;
}

export interface INeonNodeDeviceSessionBlockedScope {
  readonly scope: string;
  readonly reason: TNeonNodeDeviceSessionBlockedScopeReason;
}

export interface INeonNodeDeviceSessionActionPolicy {
  readonly fileTransfer: "approval-required";
  readonly browser: "approval-required";
  readonly phoneControl: "disabled";
  readonly commandExecution: "disabled";
}

export interface INeonNodeDeviceSessionRecord {
  readonly sessionId: string;
  readonly tokenIssueId: string;
  readonly requestId: string;
  readonly approvalId: string;
  readonly deviceId: string;
  readonly displayName?: string;
  readonly requestedRole: string;
  readonly grantedScopes: readonly TNeonNodeDeviceSessionScope[];
  readonly blockedScopes: readonly INeonNodeDeviceSessionBlockedScope[];
  readonly sessionFingerprint: string;
  readonly tokenFingerprint: string;
  readonly deviceNonceFingerprint?: string;
  readonly acceptedAt: string;
  readonly expiresAt: string;
  readonly acceptedBy: string;
  readonly state: "active";
  readonly actionPolicy: INeonNodeDeviceSessionActionPolicy;
  readonly rawTokenPersisted: false;
  readonly tokenMaterialPersisted: false;
  readonly sessionSecretPersisted: false;
}

export interface INeonNodeDeviceSessionSummary extends Omit<INeonNodeDeviceSessionRecord, "state"> {
  readonly state: TNeonNodeDeviceSessionState;
}

export interface INeonNodeDeviceSessionOneTimeSecret {
  readonly sessionSecret: string;
  readonly visibleOnce: true;
  readonly persisted: false;
  readonly expiresAt: string;
  readonly warning: string;
}

export interface INeonNodeDeviceSessionHandshakeResult {
  readonly state: TNeonNodeDeviceSessionHandshakeState;
  readonly record: INeonNodeDeviceSessionRecord;
  readonly oneTimeSessionSecret: INeonNodeDeviceSessionOneTimeSecret;
}

export interface INeonNodeDeviceSessionPolicy {
  readonly rawTokenPersistence: "disabled";
  readonly rawTokenHttpExposure: "disabled";
  readonly rawTokenCliEcho: "disabled";
  readonly sessionSecretPersistence: "disabled";
  readonly sessionSecretHttpExposure: "disabled";
  readonly sessionSecretCliEcho: "disabled";
  readonly requiredHandoff: "in-process-one-time";
  readonly actionPolicy: INeonNodeDeviceSessionActionPolicy;
}

export interface INeonNodeDeviceSessionTotals {
  readonly sessions: number;
  readonly active: number;
  readonly expired: number;
  readonly activeCanaryTokens: number;
  readonly blockedScopes: number;
}

export interface IReadNeonNodeDeviceSessionsOptions {
  readonly maxSessions?: number;
  readonly now?: () => Date;
  readonly canaryTokenSnapshot?: INeonNodePairingCanaryTokenSnapshot;
}

export interface INeonNodeDeviceSessionSnapshot {
  readonly state: TNeonNodeDeviceSessionSnapshotState;
  readonly generatedAt: string;
  readonly canaryTokens: INeonNodePairingCanaryTokenSnapshot;
  readonly policy: INeonNodeDeviceSessionPolicy;
  readonly sessions: readonly INeonNodeDeviceSessionSummary[];
  readonly totals: INeonNodeDeviceSessionTotals;
  readonly source: INeonNodeDeviceSessionPaths;
}

const sessionFile = "node-device-sessions.jsonl";
const defaultSessionTtlMs = 30 * 60 * 1000;
const maxTextLength = 160;
const maxScopes = 16;
const sessionSecretPrefix = "neon_node_session";
const safeSessionScopes: readonly TNeonNodeDeviceSessionScope[] = [
  "operator.pairing",
  "node.heartbeat",
  "node.status",
  "file.read",
  "browser.read"
];
const baselineSessionScopes: readonly TNeonNodeDeviceSessionScope[] = ["node.heartbeat", "node.status"];
const approvalRequiredScopes = new Set(["file.write", "browser.control", "phone.control"]);

export function resolveNeonNodeDeviceSessionPaths(projectRoot: string): INeonNodeDeviceSessionPaths {
  return {
    sessionPath: resolve(projectRoot, "state", "nodes", sessionFile)
  };
}

export async function openNeonNodeDeviceSession(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly canaryTokenSnapshot?: INeonNodePairingCanaryTokenSnapshot;
    readonly createSessionSecret?: () => string;
  } = {}
): Promise<INeonNodeDeviceSessionHandshakeResult> {
  const normalized = parseDeviceSessionHandshakeInput(input);
  const now = options.now ?? (() => new Date());
  const acceptedAt = now();
  const issues =
    options.canaryTokenSnapshot?.issues ?? (await readNeonNodePairingCanaryTokenIssues(projectRoot));
  const issue = findActiveCanaryTokenIssue(issues, normalized.tokenIssueId, acceptedAt);

  if (!issue) {
    throw new Error("Active canary token issue not found");
  }

  if (!safeEqualSecret(fingerprintText(normalized.token), issue.tokenFingerprint)) {
    throw new Error("Canary token fingerprint mismatch");
  }

  const existingRecords = await readNeonNodeDeviceSessionRecords(projectRoot);

  if (
    existingRecords.some(
      (record) => record.tokenIssueId === issue.tokenIssueId && Date.parse(record.expiresAt) > acceptedAt.getTime()
    )
  ) {
    throw new Error("Active device session already exists for this canary token");
  }

  const ttlMs = normalized.ttlMinutes ? normalized.ttlMinutes * 60 * 1000 : defaultSessionTtlMs;
  const expiresAt = new Date(acceptedAt.getTime() + ttlMs);
  const scopeDecision = createSessionScopeDecision(issue.requestedScopes, normalized.requestedScopes);
  const sessionSecret = options.createSessionSecret?.() ?? createSessionSecretMaterial();
  const record: INeonNodeDeviceSessionRecord = {
    sessionId: `device-session-${createShortFingerprint(`${issue.tokenIssueId}:${acceptedAt.toISOString()}`)}`,
    tokenIssueId: issue.tokenIssueId,
    requestId: issue.requestId,
    approvalId: issue.approvalId,
    deviceId: issue.deviceId,
    ...(issue.displayName ? { displayName: issue.displayName } : {}),
    requestedRole: issue.requestedRole,
    grantedScopes: scopeDecision.grantedScopes,
    blockedScopes: scopeDecision.blockedScopes,
    sessionFingerprint: fingerprintText(sessionSecret),
    tokenFingerprint: issue.tokenFingerprint,
    ...(normalized.deviceNonce ? { deviceNonceFingerprint: fingerprintText(normalized.deviceNonce) } : {}),
    acceptedAt: acceptedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    acceptedBy: normalized.acceptedBy,
    state: "active",
    actionPolicy: createActionPolicy(),
    rawTokenPersisted: false,
    tokenMaterialPersisted: false,
    sessionSecretPersisted: false
  };
  const paths = resolveNeonNodeDeviceSessionPaths(projectRoot);

  await mkdir(dirname(paths.sessionPath), { recursive: true });
  await appendFile(paths.sessionPath, `${JSON.stringify(record)}\n`, "utf8");

  return {
    state: "accepted-canary",
    record,
    oneTimeSessionSecret: {
      sessionSecret,
      visibleOnce: true,
      persisted: false,
      expiresAt: record.expiresAt,
      warning: "Deliver this session secret only to the paired device. Neonika does not persist it."
    }
  };
}

export async function createNeonNodeDeviceSessionSnapshot(
  projectRoot: string,
  options: IReadNeonNodeDeviceSessionsOptions = {}
): Promise<INeonNodeDeviceSessionSnapshot> {
  const now = options.now ?? (() => new Date());
  const [records, canaryTokens] = await Promise.all([
    readNeonNodeDeviceSessionRecords(projectRoot, options),
    options.canaryTokenSnapshot ?? createNeonNodePairingCanaryTokenSnapshot(projectRoot, { now })
  ]);
  const generatedAt = now();
  const sessions = summarizeDeviceSessions(records, generatedAt);
  const totals = summarizeDeviceSessionTotals(sessions, canaryTokens);

  return {
    state: totals.active > 0 ? "active" : canaryTokens.totals.active > 0 ? "ready" : "locked",
    generatedAt: generatedAt.toISOString(),
    canaryTokens,
    policy: createDeviceSessionPolicy(),
    sessions,
    totals,
    source: resolveNeonNodeDeviceSessionPaths(projectRoot)
  };
}

export async function readNeonNodeDeviceSessionRecords(
  projectRoot: string,
  options: {
    readonly maxSessions?: number;
  } = {}
): Promise<readonly INeonNodeDeviceSessionRecord[]> {
  const records = await readJsonlFile(
    resolveNeonNodeDeviceSessionPaths(projectRoot).sessionPath,
    parseDeviceSessionRecord
  );

  return options.maxSessions ? records.slice(-options.maxSessions) : records;
}

export function verifyNeonNodeDeviceSessionSecret(
  session: Pick<INeonNodeDeviceSessionSummary, "sessionFingerprint">,
  sessionSecret: string
): boolean {
  return safeEqualSecret(fingerprintText(sessionSecret), session.sessionFingerprint);
}

export function renderNeonNodeDeviceSessionReport(snapshot: INeonNodeDeviceSessionSnapshot): string {
  const sessionLines =
    snapshot.sessions.length > 0
      ? snapshot.sessions.map(
          (session) =>
            `- ${session.sessionId}: ${session.state} / ${session.deviceId} / scopes=${session.grantedScopes.join(",")} / secretPersisted=${session.sessionSecretPersisted}`
        )
      : ["- none"];
  const blockedScopeLines = snapshot.sessions.flatMap((session) =>
    session.blockedScopes.map((scope) => `- ${session.sessionId}: ${scope.scope} / ${scope.reason}`)
  );

  return [
    `Neonika Node Device Sessions: ${snapshot.state}`,
    `Totals: sessions=${snapshot.totals.sessions} active=${snapshot.totals.active} expired=${snapshot.totals.expired}`,
    `Policy: rawToken=${snapshot.policy.rawTokenPersistence} sessionSecret=${snapshot.policy.sessionSecretPersistence} file=${snapshot.policy.actionPolicy.fileTransfer} browser=${snapshot.policy.actionPolicy.browser} command=${snapshot.policy.actionPolicy.commandExecution}`,
    "Sessions:",
    ...sessionLines,
    "Blocked scopes:",
    ...(blockedScopeLines.length > 0 ? blockedScopeLines : ["- none"])
  ].join("\n");
}

function parseDeviceSessionHandshakeInput(input: unknown): INeonNodeDeviceSessionHandshakeInput {
  if (!isRecord(input)) {
    throw new Error("Device session handshake input must be an object");
  }

  const tokenIssueId = requiredText(input["tokenIssueId"], "tokenIssueId");
  const token = requiredText(input["token"], "token");
  const acceptedBy = requiredText(input["acceptedBy"], "acceptedBy");
  const deviceNonce = optionalText(input["deviceNonce"], maxTextLength);
  const requestedScopes = optionalScopeList(input["requestedScopes"]);
  const ttlMinutes = optionalPositiveInteger(input["ttlMinutes"], "ttlMinutes");

  return {
    tokenIssueId,
    token,
    acceptedBy,
    ...(deviceNonce ? { deviceNonce } : {}),
    ...(requestedScopes ? { requestedScopes } : {}),
    ...(ttlMinutes ? { ttlMinutes } : {})
  };
}

function parseDeviceSessionRecord(value: unknown): INeonNodeDeviceSessionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const sessionId = optionalText(value["sessionId"], maxTextLength);
  const tokenIssueId = optionalText(value["tokenIssueId"], maxTextLength);
  const requestId = optionalText(value["requestId"], maxTextLength);
  const approvalId = optionalText(value["approvalId"], maxTextLength);
  const deviceId = optionalText(value["deviceId"], maxTextLength);
  const requestedRole = optionalText(value["requestedRole"], maxTextLength);
  const sessionFingerprint = optionalText(value["sessionFingerprint"], 128);
  const tokenFingerprint = optionalText(value["tokenFingerprint"], 128);
  const acceptedAt = optionalText(value["acceptedAt"], maxTextLength);
  const expiresAt = optionalText(value["expiresAt"], maxTextLength);
  const acceptedBy = optionalText(value["acceptedBy"], maxTextLength);
  const grantedScopesInput = value["grantedScopes"];
  const blockedScopesInput = value["blockedScopes"];
  const actionPolicy = parseActionPolicy(value["actionPolicy"]);

  if (
    !sessionId ||
    !tokenIssueId ||
    !requestId ||
    !approvalId ||
    !deviceId ||
    !requestedRole ||
    !sessionFingerprint ||
    !tokenFingerprint ||
    !acceptedAt ||
    !expiresAt ||
    !acceptedBy ||
    !Array.isArray(grantedScopesInput) ||
    !Array.isArray(blockedScopesInput) ||
    value["state"] !== "active" ||
    !actionPolicy ||
    value["rawTokenPersisted"] !== false ||
    value["tokenMaterialPersisted"] !== false ||
    value["sessionSecretPersisted"] !== false
  ) {
    return undefined;
  }

  const grantedScopes = grantedScopesInput
    .map((scope) => parseSessionScope(scope))
    .filter((scope): scope is TNeonNodeDeviceSessionScope => scope !== undefined);
  const blockedScopes = blockedScopesInput
    .map((scope) => parseBlockedScope(scope))
    .filter((scope): scope is INeonNodeDeviceSessionBlockedScope => scope !== undefined);
  const displayName = optionalText(value["displayName"], maxTextLength);
  const deviceNonceFingerprint = optionalText(value["deviceNonceFingerprint"], 128);

  return {
    sessionId,
    tokenIssueId,
    requestId,
    approvalId,
    deviceId,
    ...(displayName ? { displayName } : {}),
    requestedRole,
    grantedScopes,
    blockedScopes,
    sessionFingerprint,
    tokenFingerprint,
    ...(deviceNonceFingerprint ? { deviceNonceFingerprint } : {}),
    acceptedAt,
    expiresAt,
    acceptedBy,
    state: "active",
    actionPolicy,
    rawTokenPersisted: false,
    tokenMaterialPersisted: false,
    sessionSecretPersisted: false
  };
}

function findActiveCanaryTokenIssue(
  issues: readonly INeonNodePairingCanaryTokenIssueRecord[],
  tokenIssueId: string,
  now: Date
): INeonNodePairingCanaryTokenIssueRecord | undefined {
  return issues.find((issue) => issue.tokenIssueId === tokenIssueId && Date.parse(issue.expiresAt) > now.getTime());
}

function createSessionScopeDecision(
  issueScopes: readonly string[],
  requestedScopes: readonly string[] | undefined
): {
  readonly grantedScopes: readonly TNeonNodeDeviceSessionScope[];
  readonly blockedScopes: readonly INeonNodeDeviceSessionBlockedScope[];
} {
  const requested = normalizeScopeList(requestedScopes && requestedScopes.length > 0 ? requestedScopes : issueScopes);
  const issueScopeSet = new Set(normalizeScopeList(issueScopes));
  const granted = new Set<TNeonNodeDeviceSessionScope>(baselineSessionScopes);
  const blocked = new Map<string, TNeonNodeDeviceSessionBlockedScopeReason>();

  for (const scope of requested) {
    const safeScope = parseSessionScope(scope);

    if (safeScope) {
      if (issueScopeSet.has(safeScope) || baselineSessionScopes.includes(safeScope)) {
        granted.add(safeScope);
      } else {
        blocked.set(scope, "unsupported");
      }
      continue;
    }

    blocked.set(scope, approvalRequiredScopes.has(scope) ? "approval-required" : "unsupported");
  }

  return {
    grantedScopes: [...granted],
    blockedScopes: [...blocked].map(([scope, reason]) => ({
      scope,
      reason
    }))
  };
}

function summarizeDeviceSessions(
  records: readonly INeonNodeDeviceSessionRecord[],
  now: Date
): readonly INeonNodeDeviceSessionSummary[] {
  return records.map((record) => ({
    ...record,
    state: Date.parse(record.expiresAt) > now.getTime() ? "active" : "expired"
  }));
}

function summarizeDeviceSessionTotals(
  sessions: readonly INeonNodeDeviceSessionSummary[],
  canaryTokens: INeonNodePairingCanaryTokenSnapshot
): INeonNodeDeviceSessionTotals {
  return {
    sessions: sessions.length,
    active: sessions.filter((session) => session.state === "active").length,
    expired: sessions.filter((session) => session.state === "expired").length,
    activeCanaryTokens: canaryTokens.totals.active,
    blockedScopes: sessions.reduce((total, session) => total + session.blockedScopes.length, 0)
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

function createDeviceSessionPolicy(): INeonNodeDeviceSessionPolicy {
  return {
    rawTokenPersistence: "disabled",
    rawTokenHttpExposure: "disabled",
    rawTokenCliEcho: "disabled",
    sessionSecretPersistence: "disabled",
    sessionSecretHttpExposure: "disabled",
    sessionSecretCliEcho: "disabled",
    requiredHandoff: "in-process-one-time",
    actionPolicy: createActionPolicy()
  };
}

function createActionPolicy(): INeonNodeDeviceSessionActionPolicy {
  return {
    fileTransfer: "approval-required",
    browser: "approval-required",
    phoneControl: "disabled",
    commandExecution: "disabled"
  };
}

function parseActionPolicy(input: unknown): INeonNodeDeviceSessionActionPolicy | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  if (
    input["fileTransfer"] !== "approval-required" ||
    input["browser"] !== "approval-required" ||
    input["phoneControl"] !== "disabled" ||
    input["commandExecution"] !== "disabled"
  ) {
    return undefined;
  }

  return createActionPolicy();
}

function optionalScopeList(input: unknown): readonly string[] | undefined {
  if (input === undefined || input === null) {
    return undefined;
  }

  if (!Array.isArray(input)) {
    throw new Error("requestedScopes must be an array");
  }

  return normalizeScopeList(input.filter((scope): scope is string => typeof scope === "string"));
}

function normalizeScopeList(scopes: readonly string[]): readonly string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter((scope) => scope.length > 0))].slice(0, maxScopes);
}

function parseSessionScope(input: unknown): TNeonNodeDeviceSessionScope | undefined {
  const value = optionalText(input, maxTextLength);

  return safeSessionScopes.includes(value as TNeonNodeDeviceSessionScope)
    ? (value as TNeonNodeDeviceSessionScope)
    : undefined;
}

function parseBlockedScope(input: unknown): INeonNodeDeviceSessionBlockedScope | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const scope = optionalText(input["scope"], maxTextLength);
  const reason = input["reason"];

  if (!scope || (reason !== "approval-required" && reason !== "unsupported")) {
    return undefined;
  }

  return {
    scope,
    reason
  };
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

function createSessionSecretMaterial(): string {
  return `${sessionSecretPrefix}_${randomBytes(32).toString("base64url")}`;
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
