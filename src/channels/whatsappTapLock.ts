import { open, lstat, readFile, rm } from "node:fs/promises";

export interface INeonWhatsAppTapLock {
  release(): Promise<void>;
}

export interface IAcquireNeonWhatsAppTapLockOptions {
  readonly pid?: number;
  readonly now?: () => Date;
  readonly isProcessAlive?: (pid: number) => boolean;
}

interface INeonWhatsAppTapLockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly createdAt: string;
}

export async function acquireNeonWhatsAppTapLock(
  path: string,
  options: IAcquireNeonWhatsAppTapLockOptions = {}
): Promise<INeonWhatsAppTapLock> {
  const pid = options.pid ?? process.pid;
  const now = options.now?.() ?? new Date();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("WhatsApp tap lock pid is invalid");
  }
  const record: INeonWhatsAppTapLockRecord = {
    version: 1,
    pid,
    createdAt: now.toISOString()
  };

  try {
    await createLockFile(path, record);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await readLockFile(path);
    if (isProcessAlive(existing.pid)) {
      throw new Error("WhatsApp login or shadow tap is already running for this setup");
    }
    await rm(path);
    await createLockFile(path, record);
  }

  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      const current = await readLockFile(path);
      if (current.pid !== pid || current.createdAt !== record.createdAt) {
        throw new Error("WhatsApp tap lock ownership changed before release");
      }
      await rm(path);
    }
  };
}

async function createLockFile(path: string, record: INeonWhatsAppTapLockRecord): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readLockFile(path: string): Promise<INeonWhatsAppTapLockRecord> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
    throw new Error("WhatsApp tap lock is not a private regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("WhatsApp tap lock is malformed");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["version", "pid", "createdAt"].includes(key)) ||
    value["version"] !== 1 ||
    typeof value["pid"] !== "number" ||
    !Number.isSafeInteger(value["pid"]) ||
    value["pid"] < 1 ||
    typeof value["createdAt"] !== "string" ||
    Number.isNaN(Date.parse(value["createdAt"])) ||
    new Date(Date.parse(value["createdAt"])).toISOString() !== value["createdAt"]
  ) {
    throw new Error("WhatsApp tap lock is malformed");
  }
  return {
    version: 1,
    pid: value["pid"],
    createdAt: value["createdAt"]
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ESRCH")) {
      return false;
    }
    return true;
  }
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
