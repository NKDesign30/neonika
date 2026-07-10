import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readNeonHeartbeatDaemonCursor,
  renderNeonHeartbeatDaemonTickReport,
  resolveNeonHeartbeatTimerGate,
  runNeonHeartbeatDaemonTick,
  writeNeonHeartbeatDaemonCursor,
  type INeonHeartbeatAgentState
} from "../src/index.js";

const tickNow = new Date("2026-06-02T12:00:00.000Z");
const armedGate = resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "1" });
const offGate = resolveNeonHeartbeatTimerGate({});
const intervalMs = 900_000;
const agents: readonly INeonHeartbeatAgentState[] = [{ agentId: "neo", intervalMs }];

async function tempCursorPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neon-core-heartbeat-daemon-test-"));
  return join(dir, "heartbeat-daemon-cursor.json");
}

describe("Neon heartbeat daemon tick driver", () => {
  it("does nothing and writes no cursor when the gate is closed", async () => {
    const cursorPath = await tempCursorPath();
    try {
      const result = await runNeonHeartbeatDaemonTick({
        cursorPath,
        schedulerSeed: "neon-core",
        agents,
        gate: offGate,
        now: () => tickNow
      });
      assert.equal(result.armed, false);
      assert.equal(result.cursorPersisted, false);
      assert.equal(result.safety.cursorOnlyWrite, false);
      assert.equal(result.safety.executed, false);
      assert.equal(result.safety.outboundSent, false);
      assert.equal(result.safety.wroteRunStore, false);
      await assert.rejects(access(cursorPath), "no cursor file should be written");
    } finally {
      await rm(cursorPath, { force: true, recursive: true });
    }
  });

  it("persists the cursor on the armed path", async () => {
    const cursorPath = await tempCursorPath();
    try {
      const result = await runNeonHeartbeatDaemonTick({
        cursorPath,
        schedulerSeed: "neon-core",
        agents,
        gate: armedGate,
        now: () => tickNow
      });
      assert.equal(result.armed, true);
      assert.equal(result.cursorPersisted, true);
      assert.equal(result.safety.cursorOnlyWrite, true);
      const persisted = await readNeonHeartbeatDaemonCursor(cursorPath);
      assert.equal(persisted.version, 1);
      assert.equal(persisted.ticks, 1);
      assert.ok(persisted.emitted["neo"], "neo window persisted");
    } finally {
      await rm(cursorPath, { force: true, recursive: true });
    }
  });

  it("back-fills bounded catch-up windows from a behind cursor", async () => {
    const cursorPath = await tempCursorPath();
    try {
      // First armed tick to learn the current window key.
      const seedTick = await runNeonHeartbeatDaemonTick({
        cursorPath,
        schedulerSeed: "neon-core",
        agents,
        gate: armedGate,
        now: () => tickNow
      });
      const currentWindow = seedTick.cursor.emitted["neo"];
      assert.ok(currentWindow);

      // Rewind the cursor 8 intervals back so 7 windows fall between it and now.
      const behindWindow = new Date(Date.parse(currentWindow) - 8 * intervalMs).toISOString();
      await writeNeonHeartbeatDaemonCursor(cursorPath, {
        version: 1,
        emitted: { neo: behindWindow },
        ticks: 1
      });

      const result = await runNeonHeartbeatDaemonTick({
        cursorPath,
        schedulerSeed: "neon-core",
        agents,
        gate: armedGate,
        now: () => tickNow,
        maxCatchupPerJob: 5
      });
      assert.equal(result.catchup.length, 5, "kept the newest 5 missed windows");
      assert.equal(result.catchupTruncated, 2, "dropped the 2 oldest beyond the bound");
    } finally {
      await rm(cursorPath, { force: true, recursive: true });
    }
  });

  it("returns the empty cursor on a missing file (tolerant)", async () => {
    const cursor = await readNeonHeartbeatDaemonCursor(join(tmpdir(), "neon-core-no-such-cursor.json"));
    assert.deepEqual(cursor, { version: 1, emitted: {}, ticks: 0 });
  });

  it("renders wroteRunStore=false and cursorOnlyWrite=true on the armed report", async () => {
    const cursorPath = await tempCursorPath();
    try {
      const result = await runNeonHeartbeatDaemonTick({
        cursorPath,
        schedulerSeed: "neon-core",
        agents,
        gate: armedGate,
        now: () => tickNow
      });
      const report = renderNeonHeartbeatDaemonTickReport(result);
      assert.match(report, /wroteRunStore=false/u);
      assert.match(report, /cursorOnlyWrite=true/u);
      assert.doesNotMatch(JSON.stringify(result), /secret/iu);
    } finally {
      await rm(cursorPath, { force: true, recursive: true });
    }
  });
});
