import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendNeonRecallEvent,
  hashNeonRecallQuery,
  readNeonRecallEvents,
  summarizeNeonRecallCounts
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

describe("Neon recall tracking", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "neon-recall-"));
    storePath = join(dir, "recall-events.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hashes the query stably and never exposes the raw text", () => {
    const a = hashNeonRecallQuery("Was war die Lösung");
    const b = hashNeonRecallQuery("was war die lösung");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(a, /lösung/i);
  });

  it("blocks the append when the gate is disabled (no file side effect)", async () => {
    const result = await appendNeonRecallEvent({
      request: { query: "q", hits: ["memory:a"] },
      gate: disabledGate,
      storePath,
      now: fixedNow
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.event, undefined);
    assert.equal((await readNeonRecallEvents(storePath)).length, 0);
  });

  it("blocks the append when no storePath is given", async () => {
    const result = await appendNeonRecallEvent({
      request: { query: "q", hits: ["memory:a"] },
      gate: enabledGate,
      now: fixedNow
    });
    assert.equal(result.state, "blocked");
  });

  it("blocks the append when there are no hits", async () => {
    const result = await appendNeonRecallEvent({
      request: { query: "q", hits: [] },
      gate: enabledGate,
      storePath,
      now: fixedNow
    });
    assert.equal(result.state, "blocked");
  });

  it("appends a JSONL event when gate + storePath are set", async () => {
    const result = await appendNeonRecallEvent({
      request: { query: "deploy plan", hits: ["memory:a", "run:b"] },
      gate: enabledGate,
      storePath,
      now: fixedNow
    });
    assert.equal(result.state, "appended");
    assert.equal(result.event?.hits.length, 2);
    assert.equal(result.event?.recordedAt, "2026-06-03T12:00:00.000Z");

    const events = await readNeonRecallEvents(storePath);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.hits, ["memory:a", "run:b"]);
  });

  it("summarizes recall counts + unique queries with a promotion flag", async () => {
    await appendNeonRecallEvent({ request: { query: "alpha one", hits: ["memory:a"] }, gate: enabledGate, storePath, now: fixedNow });
    await appendNeonRecallEvent({ request: { query: "alpha one", hits: ["memory:a"] }, gate: enabledGate, storePath, now: fixedNow });
    await appendNeonRecallEvent({ request: { query: "beta two", hits: ["memory:a", "run:c"] }, gate: enabledGate, storePath, now: fixedNow });

    const counts = summarizeNeonRecallCounts(await readNeonRecallEvents(storePath));
    const memA = counts.find((entry) => entry.source === "memory:a");
    assert.equal(memA?.recallCount, 3);
    assert.equal(memA?.uniqueQueries, 2);
    assert.equal(memA?.promotable, true);

    const runC = counts.find((entry) => entry.source === "run:c");
    assert.equal(runC?.recallCount, 1);
    assert.equal(runC?.uniqueQueries, 1);
    assert.equal(runC?.promotable, false);
  });
});
