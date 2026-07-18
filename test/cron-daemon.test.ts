import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonAutomationSnapshot,
  readNeonCronDaemonCursor,
  runNeonCronDaemonTick,
  writeNeonCronDaemonCursor,
  type INeonAutomationJob,
  type INeonAutomationSnapshot,
  type INeonCronTimerGate
} from "../src/index.js";

const tickNow = new Date("2026-06-02T12:00:00.000Z");
const armedGate: INeonCronTimerGate = {
  enabled: true,
  reason: "timer-enabled",
  envKey: "NEON_CRON_TIMER_ENABLED"
};
const disabledGate: INeonCronTimerGate = {
  enabled: false,
  reason: "timer-disabled",
  envKey: "NEON_CRON_TIMER_ENABLED"
};

describe("Neon Cron daemon tick driver", () => {
  it("does nothing and writes no cursor when the gate is closed (default-off)", async () => {
    const cursorPath = await tempCursorPath();

    try {
      const result = await runNeonCronDaemonTick({
        cursorPath,
        gate: disabledGate,
        now: () => tickNow,
        snapshot: snapshotWithReadyJob(tickNow.toISOString())
      });

      assert.equal(result.armed, false);
      assert.equal(result.tick.emitted.length, 0);
      assert.equal(result.catchup.length, 0);
      assert.equal(result.cursorPersisted, false);
      assert.equal(result.safety.cursorOnlyWrite, false);
      assert.equal(result.safety.executed, false);
      assert.equal(result.safety.outboundSent, false);
      assert.equal(result.safety.wroteRunStore, false);
      assert.equal(await fileExists(cursorPath), false, "closed gate must not write a cursor file");
    } finally {
      await rm(cursorPath, { force: true });
    }
  });

  it("emits a current window, persists the cursor, and dedups it on the next tick", async () => {
    const cursorPath = await tempCursorPath();
    const window = tickNow.toISOString();
    const snapshot = snapshotWithReadyJob(window);

    try {
      const first = await runNeonCronDaemonTick({
        cursorPath,
        gate: armedGate,
        now: () => tickNow,
        snapshot
      });

      assert.equal(first.armed, true);
      assert.deepEqual(first.tick.emitted, ["heartbeat-review"]);
      assert.equal(first.catchup.length, 0, "no catch-up without a prior cursor");
      assert.equal(first.cursorPersisted, true);
      assert.equal(first.cursor.ticks, 1);
      assert.equal(first.cursor.emitted["heartbeat-review"], window);
      assert.equal(await fileExists(cursorPath), true);

      const second = await runNeonCronDaemonTick({
        cursorPath,
        gate: armedGate,
        now: () => tickNow,
        snapshot
      });

      assert.deepEqual(second.tick.emitted, [], "same window must not re-emit across ticks");
      assert.deepEqual(second.tick.deduped, ["heartbeat-review"]);
      assert.equal(second.cursor.ticks, 2, "tick counter advances even when deduped");

      // Cursor survives a fresh read (restart-safe dedup).
      const persisted = await readNeonCronDaemonCursor(cursorPath);
      assert.equal(persisted.emitted["heartbeat-review"], window);
      assert.equal(persisted.ticks, 2);
    } finally {
      await rm(cursorPath, { force: true });
    }
  });

  it("back-fills missed interval windows bounded by maxCatchupPerJob", async () => {
    const cursorPath = await tempCursorPath();
    // Daemon was down: cursor sits 100 minutes (interval 15m) behind the current window.
    const lastWindow = new Date(tickNow.getTime() - 100 * 60_000).toISOString();
    await writeNeonCronDaemonCursor(cursorPath, {
      version: 1,
      emitted: { "heartbeat-review": lastWindow },
      lastTickAt: lastWindow,
      ticks: 1
    });

    try {
      const result = await runNeonCronDaemonTick({
        cursorPath,
        gate: armedGate,
        now: () => tickNow,
        snapshot: snapshotWithReadyJob(tickNow.toISOString()),
        maxCatchupPerJob: 5
      });

      // Windows in (now-100m, now): now-15..now-90 = 6 candidates; capped at 5, 1 dropped.
      assert.deepEqual(result.tick.emitted, ["heartbeat-review"], "current window still emitted");
      assert.equal(result.catchup.length, 5);
      assert.equal(result.catchupTruncated, 1);
      for (const emission of result.catchup) {
        assert.equal(emission.jobId, "heartbeat-review");
      }
      // Chronological order, all strictly between the cursor and the current window.
      const windows = result.catchup.map((entry) => Date.parse(entry.window));
      const sorted = [...windows].sort((a, b) => a - b);
      assert.deepEqual(windows, sorted, "catch-up windows emitted oldest-first");
      assert.ok(windows[0]! > Date.parse(lastWindow));
      assert.ok(windows[windows.length - 1]! < tickNow.getTime());

      // Cursor advances to the current window (bounded: dropped windows are not retried).
      assert.equal(result.cursor.emitted["heartbeat-review"], tickNow.toISOString());
    } finally {
      await rm(cursorPath, { force: true });
    }
  });

  it("emits nothing for the default all-disabled automation snapshot even when armed", async () => {
    const cursorPath = await tempCursorPath();

    try {
      const result = await runNeonCronDaemonTick({
        cursorPath,
        gate: armedGate,
        now: () => tickNow,
        snapshot: createNeonAutomationSnapshot({ generatedAt: tickNow })
      });

      assert.equal(result.armed, true);
      assert.equal(result.tick.emitted.length, 0, "disabled jobs produce no run intent");
      assert.equal(result.catchup.length, 0);
      // Armed tick still persists its own cursor state (its ticks/lastTickAt), no run store.
      assert.equal(result.cursorPersisted, true);
      assert.equal(result.safety.wroteRunStore, false);
    } finally {
      await rm(cursorPath, { force: true });
    }
  });
});

function snapshotWithReadyJob(nextRunAt: string): INeonAutomationSnapshot {
  const base = createNeonAutomationSnapshot({ generatedAt: tickNow });
  const readyJob: INeonAutomationJob = {
    id: "heartbeat-review",
    kind: "cron",
    label: "Heartbeat Review",
    state: "ready",
    policy: "operator-approval-required",
    schedule: "every-15m",
    intervalMinutes: 15,
    nextRunAt,
    source: "test",
    summary: "ready interval cron job for daemon tests"
  };
  return { ...base, jobs: [readyJob] };
}

async function tempCursorPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-cron-daemon-"));
  return join(dir, "cron-daemon-cursor.json");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
