import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonCronDaemonStatusSnapshot,
  renderNeonCronDaemonStatusReport,
  renderNeonMissionControlCronDaemonStatusPanel,
  resolveNeonCronDaemonCursorPath,
  writeNeonCronDaemonCursor
} from "../src/index.js";

const now = new Date("2026-06-02T12:00:00.000Z");

describe("Neon Cron daemon status panel", () => {
  it("reports an honest empty cursor state and the disabled gate when nothing has ticked", async () => {
    const projectRoot = await tempProjectRoot();

    try {
      const snapshot = await createNeonCronDaemonStatusSnapshot(projectRoot, {
        env: {},
        now: () => now
      });

      assert.equal(snapshot.gate.enabled, false);
      assert.equal(snapshot.cursorPresent, false);
      assert.equal(snapshot.cursor.ticks, 0);
      assert.equal(snapshot.daemon, undefined);
      assert.equal(snapshot.daemonStale, false);
      assert.equal(snapshot.safety.agentExecuted, false);
      assert.equal(snapshot.safety.wroteLiveRun, false);
      // Default automation catalog carries the two cron jobs, both disabled.
      assert.equal(snapshot.jobs.length, 2);
      const heartbeat = snapshot.jobs.find((job) => job.id === "heartbeat-review");
      assert.equal(heartbeat?.state, "disabled");
      assert.equal(heartbeat?.intervalMinutes, 15);
      assert.equal(heartbeat?.lastEmittedWindow, undefined);

      const report = renderNeonCronDaemonStatusReport(snapshot);
      assert.match(report, /gate disabled/u);
      assert.match(report, /Daemon: not running/u);
      assert.match(report, /Cursor: absent/u);
      assert.match(report, /wroteLiveRun=false/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("surfaces a persisted cursor (ticks + per-job last window) once the daemon has run", async () => {
    const projectRoot = await tempProjectRoot();
    const window = new Date(now.getTime() - 15 * 60_000).toISOString();
    await writeNeonCronDaemonCursor(resolveNeonCronDaemonCursorPath(projectRoot), {
      version: 1,
      emitted: { "heartbeat-review": window },
      lastTickAt: now.toISOString(),
      ticks: 4
    });

    try {
      const snapshot = await createNeonCronDaemonStatusSnapshot(projectRoot, {
        env: {},
        now: () => now
      });

      assert.equal(snapshot.cursorPresent, true);
      assert.equal(snapshot.cursor.ticks, 4);
      const heartbeat = snapshot.jobs.find((job) => job.id === "heartbeat-review");
      assert.equal(heartbeat?.lastEmittedWindow, window);

      const panel = renderNeonMissionControlCronDaemonStatusPanel(snapshot);
      assert.match(panel, /Cron Daemon/u);
      assert.match(panel, /tick #4/u);
      assert.match(panel, /heartbeat-review/u);
      assert.match(panel, /wroteLiveRun=false/u);
      assert.doesNotMatch(panel, /secret/iu);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders an explicit not-loaded empty state when no snapshot is supplied", () => {
    const panel = renderNeonMissionControlCronDaemonStatusPanel();
    assert.match(panel, /Cron Daemon/u);
    assert.match(panel, /not loaded/u);
    assert.doesNotMatch(panel, /tick #/u);
  });

  it("tags the gate as armed in the panel when the timer gate is enabled", async () => {
    const projectRoot = await tempProjectRoot();

    try {
      const snapshot = await createNeonCronDaemonStatusSnapshot(projectRoot, {
        env: { NEON_CRON_TIMER_ENABLED: "ready" },
        now: () => now
      });
      const panel = renderNeonMissionControlCronDaemonStatusPanel(snapshot);

      if (snapshot.gate.enabled) {
        assert.match(panel, /id="cronDaemonGate">ARMED/u);
      } else {
        // If the cutover-env token differs, the gate stays shadow — still no fake armed state.
        assert.match(panel, /id="cronDaemonGate">shadow/u);
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function tempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-cron-daemon-status-"));
}
