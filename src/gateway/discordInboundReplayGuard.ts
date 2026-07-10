import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveGatewayStatePaths } from "./runStore.js";

/**
 * In-memory inbound replay guard for Discord (TTL claim cache).
 *
 * Rebuild-native after the upstream reference
 * extensions/discord/src/monitor/inbound-dedupe.ts (createDiscordInboundReplayGuard,
 * buildDiscordInboundReplayKey, claimDiscordInboundReplay, TTL 5min / 5000 entries).
 *
 * Why: a Discord gateway resume/reconnect can redeliver the same MessageCreate.
 * Without a dedupe claim the shadow tap would process and persist the same inbound
 * message twice. The sync `claim()` path stays in-memory for cheap tests and
 * injected guards. The async helper can add a best-effort persistent layer so a
 * restart/reconnect does not blindly re-process a still-live inbound message.
 */

export type TNeonInboundReplayClaim = "claimed" | "duplicate";

export interface INeonDiscordInboundReplayGuardOptions {
  /** Claim lifetime in ms. Default 5 minutes (upstream parity). */
  readonly ttlMs?: number;
  /** Max retained claims before the oldest are evicted. Default 5000 (upstream parity). */
  readonly maxEntries?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Optional restart-safe dedupe store. Best effort: failures disable persistence. */
  readonly persistentStore?: INeonDiscordInboundReplayPersistentStore;
  /** Optional sink for persistence failures; receives no secret values from this module. */
  readonly logPersistenceError?: (error: unknown) => void;
}

export interface INeonDiscordInboundReplayGuard {
  /**
   * Claims a key. Returns "claimed" for a first/expired key (caller should
   * process), "duplicate" for a still-live key (caller should drop).
   */
  claim(key: string): TNeonInboundReplayClaim;
  /**
   * Async claim that checks the optional persistent store before claiming memory.
   * Use `claimNeonInboundReplay` so sync-only guards remain compatible.
   */
  claimAsync?: (key: string) => Promise<TNeonInboundReplayClaim>;
  /** Live claim count after lazy expiry. Test/observability helper. */
  size(): number;
}

export interface INeonDiscordInboundReplayPersistentStore {
  readonly lookup: (key: string) => Promise<number | undefined>;
  readonly register: (key: string, expiresAtMs: number) => Promise<void>;
}

export interface INeonDiscordInboundReplayFileStoreOptions {
  /** Max records retained in the state file. Default mirrors the in-memory cap. */
  readonly maxRecords?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 5000;
const DISCORD_INBOUND_REPLAY_FILE = "discord-inbound-replay.jsonl";

export function buildNeonInboundReplayKey(params: {
  readonly accountId: string;
  readonly channelId: string;
  readonly messageId: string;
}): string {
  return `${params.accountId}:${params.channelId}:${params.messageId}`;
}

export function createNeonDiscordInboundReplayGuard(
  options: INeonDiscordInboundReplayGuardOptions = {}
): INeonDiscordInboundReplayGuard {
  const ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const maxEntries =
    options.maxEntries && options.maxEntries > 0 ? options.maxEntries : DEFAULT_MAX_ENTRIES;
  const now = options.now ?? ((): number => Date.now());
  let persistentDisabled = false;

  // Insertion-ordered: Map keeps insertion order, so the first key is the oldest.
  const expiry = new Map<string, number>();

  const dropExpired = (currentMs: number): void => {
    for (const [key, expiresAt] of expiry) {
      if (expiresAt <= currentMs) {
        expiry.delete(key);
      }
    }
  };

  const remember = (key: string, currentMs: number, expiresAtMs?: number): void => {
    // First sight or expired: (re)claim and refresh insertion order.
    expiry.delete(key);
    expiry.set(key, expiresAtMs ?? currentMs + ttlMs);

    // Bound memory: evict oldest while over the cap. Expired keys are handled
    // lazily on lookup and exactly on size().
    while (expiry.size > maxEntries) {
      const oldest = expiry.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      expiry.delete(oldest);
    }
  };

  const isMemoryDuplicate = (key: string, currentMs: number): boolean => {
    const existing = expiry.get(key);
    return existing !== undefined && existing > currentMs;
  };

  const disablePersistence = (error: unknown): void => {
    persistentDisabled = true;
    options.logPersistenceError?.(error);
  };

  const claim = (key: string): TNeonInboundReplayClaim => {
    const currentMs = now();
    if (isMemoryDuplicate(key, currentMs)) {
      return "duplicate";
    }
    remember(key, currentMs);
    return "claimed";
  };

  const claimAsync = options.persistentStore
    ? async (key: string): Promise<TNeonInboundReplayClaim> => {
        const currentMs = now();
        if (isMemoryDuplicate(key, currentMs)) {
          return "duplicate";
        }

        if (!persistentDisabled) {
          try {
            const persistedExpiresAtMs = await options.persistentStore?.lookup(key);
            if (
              typeof persistedExpiresAtMs === "number" &&
              Number.isFinite(persistedExpiresAtMs) &&
              persistedExpiresAtMs > currentMs
            ) {
              remember(key, currentMs, persistedExpiresAtMs);
              return "duplicate";
            }
          } catch (error) {
            disablePersistence(error);
          }
        }

        const expiresAtMs = currentMs + ttlMs;
        remember(key, currentMs, expiresAtMs);
        if (!persistentDisabled) {
          try {
            await options.persistentStore?.register(key, expiresAtMs);
          } catch (error) {
            disablePersistence(error);
          }
        }
        return "claimed";
      }
    : undefined;

  return {
    claim,
    ...(claimAsync ? { claimAsync } : {}),
    size(): number {
      dropExpired(now());
      return expiry.size;
    }
  };
}

export async function claimNeonInboundReplay(
  guard: INeonDiscordInboundReplayGuard,
  key: string
): Promise<TNeonInboundReplayClaim> {
  return guard.claimAsync ? await guard.claimAsync(key) : guard.claim(key);
}

export function resolveNeonDiscordInboundReplayPath(projectRoot: string): string {
  return join(resolveGatewayStatePaths(projectRoot).gatewayRoot, DISCORD_INBOUND_REPLAY_FILE);
}

export function createNeonDiscordInboundReplayFileStore(
  filePath: string,
  options: INeonDiscordInboundReplayFileStoreOptions = {}
): INeonDiscordInboundReplayPersistentStore {
  const maxRecords = options.maxRecords && options.maxRecords > 0 ? Math.floor(options.maxRecords) : DEFAULT_MAX_ENTRIES;

  return {
    async lookup(key: string): Promise<number | undefined> {
      let latest: number | undefined;
      for (const record of await readReplayRecords(filePath)) {
        if (record?.key === key) {
          latest = record.expiresAtMs;
        }
      }
      return latest;
    },
    async register(key: string, expiresAtMs: number): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const recordsByKey = new Map<string, INeonDiscordInboundReplayRecord>();
      for (const record of await readReplayRecords(filePath)) {
        recordsByKey.set(record.key, record);
      }
      recordsByKey.set(key, { key, expiresAtMs });
      const records = [...recordsByKey.values()]
        .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
        .slice(-maxRecords);
      await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    }
  };
}

interface INeonDiscordInboundReplayRecord {
  readonly key: string;
  readonly expiresAtMs: number;
}

function parseReplayRecord(line: string): INeonDiscordInboundReplayRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!isRecord(value)) {
      return undefined;
    }
    const key = value["key"];
    const expiresAtMs = value["expiresAtMs"];
    if (
      typeof key !== "string" ||
      typeof expiresAtMs !== "number" ||
      !Number.isFinite(expiresAtMs)
    ) {
      return undefined;
    }
    return { key, expiresAtMs };
  } catch {
    return undefined;
  }
}

async function readReplayRecords(filePath: string): Promise<readonly INeonDiscordInboundReplayRecord[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  return raw
    .split("\n")
    .map(parseReplayRecord)
    .filter((record): record is INeonDiscordInboundReplayRecord => record !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
