import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendNeonCronIntentLog,
  buildNeonCronIntentEntries,
  readNeonCronIntentLog,
  renderNeonCronIntentLog,
  type INeonCronDaemonTickResult,
  type INeonCronIntentLogEntry,
  type INeonCronTickResult
} from "../src/index.js";

const OPEN_GATE = {
  enabled: true,
  reason: "timer-enabled" as const,
  envKey: "NEON_CRON_TIMER_ENABLED" as const
};
const CLOSED_GATE = {
  enabled: false,
  reason: "timer-disabled" as const,
  envKey: "NEON_CRON_TIMER_ENABLED" as const
};

const fixedNow = (): Date => new Date(Date.UTC(2026, 5, 3, 12, 0, 0));

function makeTickResult(parts: {
  emitted: string[];
  nextEmitted: Record<string, string>;
  deduped: string[];
  catchup: { jobId: string; window: string }[];
}): INeonCronDaemonTickResult {
  const tick: INeonCronTickResult = {
    armed: true,
    gate: OPEN_GATE,
    evaluatedAt: "2026-06-03T12:00:00.000Z",
    intents: [],
    emitted: parts.emitted,
    deduped: parts.deduped,
    nextEmitted: parts.nextEmitted,
    safety: { executed: false, outboundSent: false },
    diagnostics: []
  };
  return {
    armed: true,
    gate: OPEN_GATE,
    tickAt: "2026-06-03T12:00:00.000Z",
    tick,
    catchup: parts.catchup,
    catchupTruncated: 0,
    cursor: { version: 1, emitted: parts.nextEmitted, ticks: 1 },
    cursorPath: join(tmpdir(), "unused-cursor.json"),
    cursorPersisted: true,
    safety: { executed: false, outboundSent: false, wroteRunStore: false, cursorOnlyWrite: false },
    diagnostics: []
  };
}

test("buildNeonCronIntentEntries maps emitted / catch-up / skipped", () => {
  const result = makeTickResult({
    emitted: ["wake-lane"],
    nextEmitted: { "wake-lane": "2026-06-03T12:00" },
    deduped: ["memory-summary"],
    catchup: [{ jobId: "wake-lane", window: "2026-06-03T11:45" }]
  });

  const entries = buildNeonCronIntentEntries(result, fixedNow);
  assert.equal(entries.length, 3);

  const emitted = entries.find((e) => e.status === "emitted");
  const catchUp = entries.find((e) => e.status === "catch-up");
  const skipped = entries.find((e) => e.status === "skipped");

  assert.equal(emitted?.jobId, "wake-lane");
  assert.equal(emitted?.window, "2026-06-03T12:00");
  assert.equal(catchUp?.window, "2026-06-03T11:45");
  assert.equal(skipped?.jobId, "memory-summary");
  assert.equal(skipped?.window, undefined);
  for (const entry of entries) {
    assert.equal(entry.recordedAt, "2026-06-03T12:00:00.000Z");
  }
});

test("buildNeonCronIntentEntries returns no rows for an empty tick (gate-closed -> 0 rows)", () => {
  const result = makeTickResult({ emitted: [], nextEmitted: {}, deduped: [], catchup: [] });
  assert.equal(buildNeonCronIntentEntries(result, fixedNow).length, 0);
});

test("appendNeonCronIntentLog is blocked by default (no gate, no store)", async () => {
  const entries: INeonCronIntentLogEntry[] = [
    { recordedAt: "2026-06-03T12:00:00.000Z", jobId: "wake-lane", status: "emitted", window: "w" }
  ];
  const result = await appendNeonCronIntentLog({ entries, gate: CLOSED_GATE });
  assert.equal(result.state, "blocked");
  assert.equal(result.count, 0);
  assert.match(result.diagnostics.join(" "), /NEON_CRON_TIMER_ENABLED/);
});

test("appendNeonCronIntentLog blocked even with gate open but no storePath", async () => {
  const entries: INeonCronIntentLogEntry[] = [
    { recordedAt: "2026-06-03T12:00:00.000Z", jobId: "wake-lane", status: "emitted" }
  ];
  const result = await appendNeonCronIntentLog({ entries, gate: OPEN_GATE });
  assert.equal(result.state, "blocked");
});

test("appendNeonCronIntentLog writes and round-trips when gate open + isolated store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-cron-intent-"));
  const storePath = join(dir, "cron-intents.jsonl");
  try {
    const entries: INeonCronIntentLogEntry[] = [
      { recordedAt: "2026-06-03T12:00:00.000Z", jobId: "wake-lane", status: "emitted", window: "w1" },
      { recordedAt: "2026-06-03T12:00:00.000Z", jobId: "memory-summary", status: "skipped" }
    ];
    const result = await appendNeonCronIntentLog({ entries, gate: OPEN_GATE, storePath });
    assert.equal(result.state, "appended");
    assert.equal(result.count, 2);

    const readBack = await readNeonCronIntentLog({ storePath });
    assert.equal(readBack.length, 2);
    assert.equal(readBack[0]?.jobId, "wake-lane");
    assert.equal(readBack[1]?.status, "skipped");

    const raw = await readFile(storePath, "utf8");
    assert.doesNotMatch(raw, /secret/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendNeonCronIntentLog with empty entries appends nothing but is not blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-cron-intent-"));
  const storePath = join(dir, "cron-intents.jsonl");
  try {
    const result = await appendNeonCronIntentLog({ entries: [], gate: OPEN_GATE, storePath });
    assert.equal(result.state, "appended");
    assert.equal(result.count, 0);
    assert.equal((await readNeonCronIntentLog({ storePath })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readNeonCronIntentLog honors a last-N limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-cron-intent-"));
  const storePath = join(dir, "cron-intents.jsonl");
  try {
    const entries: INeonCronIntentLogEntry[] = [1, 2, 3].map((n) => ({
      recordedAt: `2026-06-03T12:0${n}:00.000Z`,
      jobId: `job-${n}`,
      status: "emitted" as const,
      window: `w${n}`
    }));
    await appendNeonCronIntentLog({ entries, gate: OPEN_GATE, storePath });

    const limited = await readNeonCronIntentLog({ storePath, limit: 2 });
    assert.equal(limited.length, 2);
    assert.equal(limited[0]?.jobId, "job-2");
    assert.equal(limited[1]?.jobId, "job-3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderNeonCronIntentLog renders empty and populated logs", () => {
  assert.equal(renderNeonCronIntentLog([]), "Cron intent log: empty");
  const rendered = renderNeonCronIntentLog([
    { recordedAt: "2026-06-03T12:00:00.000Z", jobId: "wake-lane", status: "emitted", window: "w1" }
  ]);
  assert.match(rendered, /1 entry/);
  assert.match(rendered, /\[emitted\] wake-lane @ w1/);
});
