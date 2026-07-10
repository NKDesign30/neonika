import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendNeonMemoryEvent,
  buildNeonDreamCompletedEvent,
  buildNeonPromotionAppliedEvent,
  buildNeonRecallRecordedEvent,
  readNeonMemoryEvents
} from "../src/index.js";

const enabledGate = {
  enabled: true,
  reason: "write-enabled" as const,
  envKey: "NEON_MEMORY_WRITE_ENABLED" as const
};
const disabledGate = {
  enabled: false,
  reason: "write-disabled" as const,
  envKey: "NEON_MEMORY_WRITE_ENABLED" as const
};
const fixedNow = (): Date => new Date(Date.UTC(2026, 5, 3, 12, 0, 0));

describe("Neon memory event log", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neon-mem-events-"));
    storePath = join(dir, "memory-events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a recall event with a hashed query (no raw text)", () => {
    const event = buildNeonRecallRecordedEvent({ query: "Was war die Lösung", resultCount: 3, now: fixedNow });
    assert.equal(event.type, "memory.recall.recorded");
    assert.equal(event.resultCount, 3);
    assert.match(event.queryHash, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(JSON.stringify(event), /Lösung/i);
  });

  it("builds promotion + dream events", () => {
    const promo = buildNeonPromotionAppliedEvent({ applied: 2, candidateKeys: ["mem:a", "mem:b"], now: fixedNow });
    assert.equal(promo.type, "memory.promotion.applied");
    assert.equal(promo.applied, 2);
    assert.deepEqual(promo.candidateKeys, ["mem:a", "mem:b"]);

    const dream = buildNeonDreamCompletedEvent({ phase: "deep", lineCount: 12, storageMode: "inline", now: fixedNow });
    assert.equal(dream.type, "memory.dream.completed");
    assert.equal(dream.phase, "deep");
    assert.equal(dream.storageMode, "inline");
  });

  it("blocks the append by default (gate disabled, no file)", async () => {
    const result = await appendNeonMemoryEvent({
      event: buildNeonRecallRecordedEvent({ query: "q", resultCount: 1, now: fixedNow }),
      gate: disabledGate,
      storePath
    });
    assert.equal(result.state, "blocked");
    assert.equal((await readNeonMemoryEvents({ storePath })).length, 0);
  });

  it("appends typed events when gate + storePath are set, read honours limit", async () => {
    await appendNeonMemoryEvent({ event: buildNeonRecallRecordedEvent({ query: "alpha", resultCount: 2, now: fixedNow }), gate: enabledGate, storePath });
    await appendNeonMemoryEvent({ event: buildNeonPromotionAppliedEvent({ applied: 1, candidateKeys: ["mem:a"], now: fixedNow }), gate: enabledGate, storePath });
    await appendNeonMemoryEvent({ event: buildNeonDreamCompletedEvent({ phase: "light", lineCount: 5, storageMode: "both", now: fixedNow }), gate: enabledGate, storePath });

    const all = await readNeonMemoryEvents({ storePath });
    assert.equal(all.length, 3);
    assert.equal(all[0]?.type, "memory.recall.recorded");
    assert.equal(all[2]?.type, "memory.dream.completed");

    const last = await readNeonMemoryEvents({ storePath, limit: 1 });
    assert.equal(last.length, 1);
    assert.equal(last[0]?.type, "memory.dream.completed");
  });

  it("never stores a raw query in the JSONL file", async () => {
    await appendNeonMemoryEvent({ event: buildNeonRecallRecordedEvent({ query: "supersecret phrase", resultCount: 1, now: fixedNow }), gate: enabledGate, storePath });
    const raw = await readFile(storePath, "utf8");
    assert.doesNotMatch(raw, /supersecret phrase/);
    assert.match(raw, /memory\.recall\.recorded/);
  });
});
