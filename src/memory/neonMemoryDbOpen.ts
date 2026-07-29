// Adapted from NK Design's Neon runtime for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { DatabaseSync } from "node:sqlite";

/**
 * The single seam every memory-DB connection goes through.
 *
 * SQLite's default rollback journal takes a database-wide write lock, and
 * `busy_timeout` defaults to 0 — so a second writer does not wait, it fails
 * immediately with SQLITE_BUSY. In this system that is silent data loss: the
 * live indexer's `writeNeonMemoryDbEntry` throws while maintenance holds the
 * write lock, and the entry it was persisting is simply gone.
 *
 * WAL lets readers run concurrently with a writer and confines writer-writer
 * contention to a real queue, which `busy_timeout` then waits out instead of
 * erroring. `journal_mode` is a persistent property of the file (set once,
 * survives reopen) and cannot be set on a read-only connection; `busy_timeout`
 * is per-connection and applies to both.
 */

export const NEON_MEMORY_BUSY_TIMEOUT_MS = 5_000;

export interface INeonMemoryDbOpenOptions {
  readonly readOnly?: boolean;
  /** Overrides the busy timeout. Exists so tests can assert the wait cheaply. */
  readonly busyTimeoutMs?: number;
}

export function openNeonMemoryDatabase(
  dbPath: string,
  options: INeonMemoryDbOpenOptions = {}
): DatabaseSync {
  const readOnly = options.readOnly === true;
  const busyTimeoutMs =
    typeof options.busyTimeoutMs === "number" && options.busyTimeoutMs >= 0
      ? Math.floor(options.busyTimeoutMs)
      : NEON_MEMORY_BUSY_TIMEOUT_MS;
  const database = new DatabaseSync(dbPath, { readOnly });
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  if (!readOnly) {
    // Idempotent: a DB already in WAL stays in WAL. NORMAL is the documented
    // companion for WAL — durable across process crashes, only a power loss can
    // cost the last commits, which is the right trade for a recall store.
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
  }
  return database;
}
