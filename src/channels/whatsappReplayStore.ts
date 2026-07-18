import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface INeonWhatsAppReplayStore {
  claim(messageId: string): Promise<boolean>;
}

export interface ICreateNeonWhatsAppReplayStoreOptions {
  readonly now?: () => Date;
  readonly maxEntries?: number;
  readonly retentionMs?: number;
}

interface INeonWhatsAppReplayEntry {
  readonly key: string;
  readonly seenAt: string;
}

interface INeonWhatsAppReplayFile {
  readonly version: 1;
  readonly entries: readonly INeonWhatsAppReplayEntry[];
}

const defaultMaxEntries = 2_000;
const defaultRetentionMs = 30 * 24 * 60 * 60 * 1_000;

/**
 * Persistent, bounded replay protection. Only a SHA-256 fingerprint of the
 * transport message id is stored, never the raw WhatsApp id or peer address.
 */
export async function createNeonWhatsAppReplayStore(
  path: string,
  options: ICreateNeonWhatsAppReplayStoreOptions = {}
): Promise<INeonWhatsAppReplayStore> {
  const now = options.now ?? (() => new Date());
  const maxEntries = options.maxEntries ?? defaultMaxEntries;
  const retentionMs = options.retentionMs ?? defaultRetentionMs;
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 20_000) {
    throw new Error("WhatsApp replay maxEntries must be between 1 and 20000");
  }
  if (!Number.isFinite(retentionMs) || retentionMs < 60_000) {
    throw new Error("WhatsApp replay retention must be at least one minute");
  }

  await ensurePrivateParent(dirname(path));
  let entries = await readReplayEntries(path);
  entries = pruneEntries(entries, now().getTime(), retentionMs, maxEntries);

  return {
    claim: async (messageId) => {
      const key = fingerprintMessageId(messageId);
      const currentMs = now().getTime();
      entries = pruneEntries(entries, currentMs, retentionMs, maxEntries);
      if (entries.some((entry) => entry.key === key)) {
        return false;
      }
      entries = [
        ...entries,
        { key, seenAt: new Date(currentMs).toISOString() }
      ].slice(-maxEntries);
      await writeReplayEntries(path, entries);
      return true;
    }
  };
}

async function readReplayEntries(path: string): Promise<readonly INeonWhatsAppReplayEntry[]> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("WhatsApp replay state must be a regular file");
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error("WhatsApp replay state permissions must be 0600");
    }
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseReplayFile(value).entries;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    if (error instanceof SyntaxError) {
      throw new Error("WhatsApp replay state is malformed");
    }
    throw error;
  }
}

function parseReplayFile(value: unknown): INeonWhatsAppReplayFile {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["entries"])) {
    throw new Error("WhatsApp replay state has an unsupported format");
  }
  if (Object.keys(value).some((key) => key !== "version" && key !== "entries")) {
    throw new Error("WhatsApp replay state contains unsupported fields");
  }
  const entries = value["entries"].map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "key" && key !== "seenAt")) {
      throw new Error("WhatsApp replay state contains an invalid entry");
    }
    const key = entry["key"];
    const seenAt = entry["seenAt"];
    if (
      typeof key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(key) ||
      typeof seenAt !== "string" ||
      Number.isNaN(Date.parse(seenAt)) ||
      new Date(Date.parse(seenAt)).toISOString() !== seenAt
    ) {
      throw new Error("WhatsApp replay state contains an invalid entry");
    }
    return { key, seenAt };
  });
  return { version: 1, entries };
}

function pruneEntries(
  entries: readonly INeonWhatsAppReplayEntry[],
  nowMs: number,
  retentionMs: number,
  maxEntries: number
): readonly INeonWhatsAppReplayEntry[] {
  const cutoff = nowMs - retentionMs;
  return entries
    .filter((entry) => Date.parse(entry.seenAt) >= cutoff)
    .slice(-maxEntries);
}

async function ensurePrivateParent(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("WhatsApp replay state parent must be a real directory");
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("WhatsApp replay state parent must be a real directory");
    }
  }
  await chmod(path, 0o700);
}

async function writeReplayEntries(
  path: string,
  entries: readonly INeonWhatsAppReplayEntry[]
): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const value: INeonWhatsAppReplayFile = { version: 1, entries };
  try {
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function fingerprintMessageId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512 || /[\r\n\0]/u.test(normalized)) {
    throw new Error("WhatsApp message id is invalid");
  }
  return createHash("sha256").update(normalized).digest("hex");
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
