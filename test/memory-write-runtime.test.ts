import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readNeonMemoryStore,
  resolveNeonMemoryWriteGate,
  writeNeonMemoryEntry,
  type INeonMemoryWriteGate
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");
const armedGate: INeonMemoryWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};
const closedGate: INeonMemoryWriteGate = {
  enabled: false,
  reason: "write-disabled",
  envKey: "NEON_MEMORY_WRITE_ENABLED"
};

describe("Neon productive memory-write runtime (DP-11)", () => {
  it("keeps the write gate off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonMemoryWriteGate({}).enabled, false);
    assert.equal(resolveNeonMemoryWriteGate({}).reason, "write-disabled");
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: "0" }).enabled, false);
  });

  it("plans a dry-run without writing any file by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-mwr-"));
    const storePath = join(dir, "store.json");
    try {
      const result = await writeNeonMemoryEntry({
        request: { content: "remember this" },
        gate: armedGate,
        storePath,
        now: () => fixedNow
      });

      assert.equal(result.mode, "dry-run");
      assert.equal(result.state, "planned");
      assert.equal(result.entryId, undefined);
      await assert.rejects(() => access(storePath), "no store file should be written on dry-run");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("blocks a productive write while the gate is closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-mwr-"));
    const storePath = join(dir, "store.json");
    try {
      const result = await writeNeonMemoryEntry({
        request: { content: "remember this" },
        gate: closedGate,
        mode: "productive",
        storePath,
        now: () => fixedNow
      });

      assert.equal(result.state, "blocked");
      await assert.rejects(() => access(storePath));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("blocks a productive write when no isolated storePath is given", async () => {
    const result = await writeNeonMemoryEntry({
      request: { content: "remember this" },
      gate: armedGate,
      mode: "productive",
      now: () => fixedNow
    });

    assert.equal(result.state, "blocked");
    assert.equal(result.safety.targetedRealMemoryDb, false);
  });

  it("writes to the isolated store and round-trips the entry when fully gated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-mwr-"));
    const storePath = join(dir, "store.json");
    try {
      const result = await writeNeonMemoryEntry({
        request: { content: "Operator prefers Umlaute", category: "preference" },
        gate: armedGate,
        mode: "productive",
        storePath,
        now: () => fixedNow
      });

      assert.equal(result.state, "written");
      assert.ok(result.entryId);
      assert.equal(result.safety.isolatedStore, true);
      assert.equal(result.safety.targetedRealMemoryDb, false);

      const roundtrip = await readNeonMemoryStore(storePath);
      assert.equal(roundtrip.length, 1);
      assert.equal(roundtrip[0]?.id, result.entryId);
      assert.equal(roundtrip[0]?.content, "Operator prefers Umlaute");
      assert.equal(roundtrip[0]?.category, "preference");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("appends successive productive writes to the same isolated store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-mwr-"));
    const storePath = join(dir, "store.json");
    try {
      await writeNeonMemoryEntry({
        request: { content: "first" },
        gate: armedGate,
        mode: "productive",
        storePath,
        now: () => fixedNow
      });
      await writeNeonMemoryEntry({
        request: { content: "second" },
        gate: armedGate,
        mode: "productive",
        storePath,
        now: () => new Date(fixedNow.getTime() + 1_000)
      });

      const roundtrip = await readNeonMemoryStore(storePath);
      assert.equal(roundtrip.length, 2);
      assert.deepEqual(roundtrip.map((entry) => entry.content), ["first", "second"]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("blocks empty content", async () => {
    const result = await writeNeonMemoryEntry({
      request: { content: "   " },
      gate: armedGate,
      mode: "productive",
      storePath: "/tmp/should-not-be-written.json",
      now: () => fixedNow
    });

    assert.equal(result.state, "blocked");
  });

  it("redacts a secret before it reaches the isolated store on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-mwr-"));
    const storePath = join(dir, "store.json");
    try {
      const result = await writeNeonMemoryEntry({
        request: { content: "key sk-abcdef0123456789ABCDEF stored" },
        gate: armedGate,
        mode: "productive",
        storePath,
        now: () => fixedNow
      });

      assert.doesNotMatch(result.redactedContent, /sk-abcdef/);
      const roundtrip = await readNeonMemoryStore(storePath);
      assert.doesNotMatch(JSON.stringify(roundtrip), /sk-abcdef/);
      assert.match(roundtrip[0]?.content ?? "", /\[REDACTED_SECRET\]/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
