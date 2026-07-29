import type { Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type TNeonWhatsAppAuthState = "linked" | "missing" | "invalid";

export type TNeonWhatsAppAuthReason =
  | "verified"
  | "auth-directory-missing"
  | "session-marker-missing"
  | "credentials-missing"
  | "invalid-session-marker"
  | "invalid-credentials"
  | "unsafe-filesystem-state"
  | "unsafe-permissions";

export interface INeonWhatsAppAuthEvidence {
  readonly state: TNeonWhatsAppAuthState;
  readonly reason: TNeonWhatsAppAuthReason;
  readonly sessionMarkerPresent: boolean;
  readonly credentialsPresent: boolean;
}

/**
 * Reads linked-device evidence without returning auth contents or filesystem
 * paths. A marker alone is never enough: a regular, non-empty Baileys
 * `creds.json` and private permissions must exist beside it.
 *
 * The account identity in `creds.me.id` is the linked-device proof. Baileys
 * only fills it from the server's `pair-success` stanza, so it cannot exist
 * without a completed handshake. `creds.registered` is not a substitute: the
 * QR path never sets it, and the pairing-code path sets it locally before the
 * server has answered.
 */
export async function inspectNeonWhatsAppAuthState(
  authPath: string
): Promise<INeonWhatsAppAuthEvidence> {
  try {
    const authStats = await lstat(authPath);
    if (!authStats.isDirectory() || authStats.isSymbolicLink()) {
      return invalidEvidence("unsafe-filesystem-state", false, false);
    }
    if (permissionBits(authStats.mode) !== 0o700) {
      return invalidEvidence("unsafe-permissions", false, false);
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return missingEvidence("auth-directory-missing", false, false);
    }
    throw error;
  }

  const treeState = await inspectPrivateAuthTree(authPath, 0);
  if (treeState !== "safe") {
    return invalidEvidence(treeState, false, false);
  }

  const markerPath = join(authPath, "session.json");
  const credentialsPath = join(authPath, "creds.json");
  const [marker, credentials] = await Promise.all([
    readPrivateJsonFile(markerPath),
    readPrivateJsonFile(credentialsPath)
  ]);
  const markerPresent = marker.state !== "missing";
  const credentialsPresent = credentials.state !== "missing";

  if (marker.state === "missing") {
    return missingEvidence("session-marker-missing", false, credentialsPresent);
  }
  if (credentials.state === "missing") {
    return missingEvidence("credentials-missing", markerPresent, false);
  }
  if (marker.state === "invalid" || !isValidSessionMarker(marker.value)) {
    return invalidEvidence("invalid-session-marker", markerPresent, credentialsPresent);
  }
  if (credentials.state === "invalid" || !hasLinkedAccountIdentity(credentials.value)) {
    return invalidEvidence("invalid-credentials", markerPresent, credentialsPresent);
  }

  return {
    state: "linked",
    reason: "verified",
    sessionMarkerPresent: true,
    credentialsPresent: true
  };
}

export async function assertNeonWhatsAppAuthLinked(authPath: string): Promise<void> {
  const evidence = await inspectNeonWhatsAppAuthState(authPath);
  if (evidence.state !== "linked") {
    throw new Error(
      `WhatsApp linked-device auth is not verified (${evidence.reason}); run neonika whatsapp-login`
    );
  }
}

export async function assertNeonWhatsAppCredentialsPersisted(authPath: string): Promise<void> {
  const treeState = await inspectPrivateAuthTreeRoot(authPath);
  if (treeState !== "safe") {
    throw new Error(`WhatsApp credentials are not private (${treeState})`);
  }
  const credentials = await readPrivateJsonFile(join(authPath, "creds.json"));
  if (credentials.state !== "ready" || !hasLinkedAccountIdentity(credentials.value)) {
    throw new Error("WhatsApp credentials were not persisted");
  }
}

/**
 * Accepts credentials that carry a server-issued account identity. The JID must
 * name both a user and a domain; anything shorter is a partially written or
 * hand-crafted file rather than a completed pairing.
 */
function hasLinkedAccountIdentity(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const me = value["me"];
  if (!isRecord(me)) {
    return false;
  }
  const id = me["id"];
  if (typeof id !== "string") {
    return false;
  }
  const separator = id.indexOf("@");
  return separator > 0 && separator < id.length - 1;
}

type TPrivateJsonRead =
  | { readonly state: "ready"; readonly value: unknown }
  | { readonly state: "missing" }
  | { readonly state: "invalid" };

async function readPrivateJsonFile(path: string): Promise<TPrivateJsonRead> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || permissionBits(stats.mode) !== 0o600) {
      return { state: "invalid" };
    }
    const text = await readFile(path, "utf8");
    if (text.trim() === "") {
      return { state: "invalid" };
    }
    try {
      return { state: "ready", value: JSON.parse(text) as unknown };
    } catch {
      return { state: "invalid" };
    }
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { state: "missing" };
    }
    throw error;
  }
}

async function inspectPrivateAuthTree(
  path: string,
  depth: number
): Promise<"safe" | "unsafe-filesystem-state" | "unsafe-permissions"> {
  if (depth > 5) {
    return "unsafe-filesystem-state";
  }
  // Baileys rotates pre-key files while this walk runs. An entry that vanished
  // between listing and inspection cannot expose anything, so it is skipped
  // instead of being reported as an unsafe tree.
  let entries: readonly string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "safe";
    }
    throw error;
  }
  for (const entry of entries) {
    const childPath = join(path, entry);
    const stats = await lstatIfPresent(childPath);
    if (stats === undefined) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      return "unsafe-filesystem-state";
    }
    if (stats.isDirectory()) {
      if (permissionBits(stats.mode) !== 0o700) {
        return "unsafe-permissions";
      }
      const nested = await inspectPrivateAuthTree(childPath, depth + 1);
      if (nested !== "safe") {
        return nested;
      }
      continue;
    }
    if (!stats.isFile()) {
      return "unsafe-filesystem-state";
    }
    if (permissionBits(stats.mode) !== 0o600) {
      return "unsafe-permissions";
    }
  }
  return "safe";
}

async function inspectPrivateAuthTreeRoot(
  authPath: string
): Promise<"safe" | "unsafe-filesystem-state" | "unsafe-permissions"> {
  try {
    const stats = await lstat(authPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      return "unsafe-filesystem-state";
    }
    if (permissionBits(stats.mode) !== 0o700) {
      return "unsafe-permissions";
    }
    return await inspectPrivateAuthTree(authPath, 0);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "unsafe-filesystem-state";
    }
    throw error;
  }
}

function isValidSessionMarker(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(["accountId", "state", "verifiedAt", "version"])
  ) {
    return false;
  }
  const verifiedAt = value["verifiedAt"];
  return (
    value["version"] === 1 &&
    value["state"] === "linked" &&
    value["accountId"] === "default" &&
    typeof verifiedAt === "string" &&
    !Number.isNaN(Date.parse(verifiedAt)) &&
    new Date(Date.parse(verifiedAt)).toISOString() === verifiedAt
  );
}

function missingEvidence(
  reason: Extract<
    TNeonWhatsAppAuthReason,
    "auth-directory-missing" | "session-marker-missing" | "credentials-missing"
  >,
  sessionMarkerPresent: boolean,
  credentialsPresent: boolean
): INeonWhatsAppAuthEvidence {
  return { state: "missing", reason, sessionMarkerPresent, credentialsPresent };
}

function invalidEvidence(
  reason: Extract<
    TNeonWhatsAppAuthReason,
    | "invalid-session-marker"
    | "invalid-credentials"
    | "unsafe-filesystem-state"
    | "unsafe-permissions"
  >,
  sessionMarkerPresent: boolean,
  credentialsPresent: boolean
): INeonWhatsAppAuthEvidence {
  return { state: "invalid", reason, sessionMarkerPresent, credentialsPresent };
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function permissionBits(mode: number): number {
  return mode & 0o777;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
