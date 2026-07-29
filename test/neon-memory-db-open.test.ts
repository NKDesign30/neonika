// Adapted from NK Design's Neon runtime tests for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  NEON_MEMORY_BUSY_TIMEOUT_MS,
  bootstrapNeonMemorySchema,
  openNeonMemoryDatabase
} from "../src/index.js";

describe("neon memory db open (WAL + busy timeout)", () => {
  let root = "";
  let dbPath = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-db-open-"));
    dbPath = join(root, "semantic-memory.db");
    const database = openNeonMemoryDatabase(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
    } finally {
      database.close();
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("puts a writable connection into WAL with a busy timeout", () => {
    const database = openNeonMemoryDatabase(dbPath);
    try {
      const journal = database.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const busy = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(journal.journal_mode, "wal");
      assert.equal(busy.timeout, NEON_MEMORY_BUSY_TIMEOUT_MS);
    } finally {
      database.close();
    }
  });

  it("gives read-only connections the busy timeout too", () => {
    const database = openNeonMemoryDatabase(dbPath, { readOnly: true });
    try {
      const busy = database.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(busy.timeout, NEON_MEMORY_BUSY_TIMEOUT_MS);
    } finally {
      database.close();
    }
  });

  it("makes a blocked second writer wait instead of failing instantly", () => {
    // The real failure this guards: the live indexer's BEGIN IMMEDIATE hit
    // SQLITE_BUSY while maintenance held the write lock, and the entry it was
    // persisting was lost. With busy_timeout at SQLite's default of 0 the second
    // writer gives up after 0ms; it must queue instead, so that the millisecond
    // the holder commits, the write lands.
    const holder = openNeonMemoryDatabase(dbPath);
    const second = openNeonMemoryDatabase(dbPath, { busyTimeoutMs: 250 });
    try {
      holder.exec("BEGIN IMMEDIATE");
      holder
        .prepare(
          `INSERT INTO memory_entries (source_file, content, agent, category, content_hash)
            VALUES (?, ?, ?, ?, ?)`
        )
        .run("held.md", "written under an open write lock", "neo", "discoveries", "h-held");

      // The holder never commits here, so the second writer is expected to give
      // up — but only after waiting out its timeout.
      const startedAt = Date.now();
      assert.throws(() => second.exec("BEGIN IMMEDIATE"), /locked|busy/i);
      const waited = Date.now() - startedAt;
      assert.ok(waited >= 200, `expected the second writer to wait, gave up after ${waited}ms`);

      holder.exec("COMMIT");
    } finally {
      second.close();
      holder.close();
    }
  });

  it("lets the queued writer through once the holder commits", () => {
    const holder = openNeonMemoryDatabase(dbPath);
    const second = openNeonMemoryDatabase(dbPath, { busyTimeoutMs: 250 });
    try {
      holder.exec("BEGIN IMMEDIATE");
      holder
        .prepare(
          `INSERT INTO memory_entries (source_file, content, agent, category, content_hash)
            VALUES (?, ?, ?, ?, ?)`
        )
        .run("first.md", "first writer", "neo", "discoveries", "h-first");
      holder.exec("COMMIT");

      second
        .prepare(
          `INSERT INTO memory_entries (source_file, content, agent, category, content_hash)
            VALUES (?, ?, ?, ?, ?)`
        )
        .run("second.md", "second writer", "neo", "discoveries", "h-second");

      const counted = second.prepare("SELECT COUNT(*) AS n FROM memory_entries").get() as { n: number };
      assert.equal(counted.n, 2);
    } finally {
      second.close();
      holder.close();
    }
  });

  it("keeps a plain DatabaseSync connection on the shared WAL file", () => {
    // Anything opening the file directly still benefits: WAL is a property of the
    // database, not of the connection that set it.
    const plain = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const journal = plain.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(journal.journal_mode, "wal");
    } finally {
      plain.close();
    }
  });
});
