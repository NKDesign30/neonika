import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  appendNeonCronStoreEvent,
  createNeonCronDaemonService,
  createNeonWorkspaceSnapshot,
  readNeonCronDaemonCursor,
  readNeonCronDaemonLiveState,
  readNeonGatewayRuns,
  resolveNeonCronDaemonCursorPath,
  resolveNeonCronDaemonLivePath,
  resolveNeonCronMutation,
  resolveNeonCronStoreGate,
  resolveNeonCronTimerGate,
  resolveNeonWorkspaceNotesGate
} from "../src/index.js";

describe("Neon Cron daemon service", () => {
  it("reads store-backed jobs, dedups same windows, and writes terminal shadow run records", async () => {
    const projectRoot = await tempProjectRoot();
    let clockMs = Date.parse("2026-06-02T12:00:00.000Z");
    const now = (): Date => new Date(clockMs);

    try {
      await addDemoCronJob(projectRoot, clockMs);
      const service = createNeonCronDaemonService({
        projectRoot,
        intervalMs: 900_000,
        gate: resolveNeonCronTimerGate({ NEON_CRON_TIMER_ENABLED: "ready" }),
        now
      });

      const first = await service.tickOnce();
      assert.equal(first.execution.createdRunCount, 1);
      assert.equal(first.tick.tick.emitted.length, 1);
      assert.equal(first.state.tickCount, 1);
      assert.equal(first.state.dueIntentsLastTick, 1);
      assert.equal(first.state.createdRunsTotal, 1);
      assert.equal(first.state.createdWorkspaceNotesTotal, 0);

      const sameWindow = await service.tickOnce();
      assert.equal(sameWindow.execution.createdRunCount, 0);
      assert.equal(sameWindow.tick.tick.emitted.length, 0);
      assert.equal(sameWindow.state.createdRunsTotal, 1);

      clockMs += 16 * 60_000;
      const nextWindow = await service.tickOnce();
      assert.equal(nextWindow.execution.createdRunCount, 1);
      assert.equal(nextWindow.tick.tick.emitted.length, 1);
      assert.equal(nextWindow.state.createdRunsTotal, 2);

      const runs = await readNeonGatewayRuns(projectRoot);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.runId.startsWith("cron-demo-")));
      assert.ok(runs.every((run) => run.mode === "shadow"));
      assert.ok(runs.every((run) => run.status === "completed"));
      assert.ok(runs.every((run) => run.delivery.state === "suppressed"));

      const cursor = await readNeonCronDaemonCursor(resolveNeonCronDaemonCursorPath(projectRoot));
      assert.equal(cursor.ticks, 3);
      assert.equal(cursor.emitted["demo"], "2026-06-02T12:15:00.000Z");

      const live = await readNeonCronDaemonLiveState(resolveNeonCronDaemonLivePath(projectRoot));
      assert.equal(live?.alive, false);
      assert.equal(live?.tickCount, 3);
      assert.equal(live?.createdRunsTotal, 2);
      assert.equal(live?.createdWorkspaceNotesTotal, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("ticks liveness but writes no cursor or run when the timer gate is closed", async () => {
    const projectRoot = await tempProjectRoot();
    const now = (): Date => new Date("2026-06-02T12:00:00.000Z");

    try {
      await addDemoCronJob(projectRoot, now().getTime());
      const service = createNeonCronDaemonService({
        projectRoot,
        intervalMs: 900_000,
        gate: resolveNeonCronTimerGate({}),
        now
      });

      const outcome = await service.tickOnce();
      const runs = await readNeonGatewayRuns(projectRoot);
      const cursor = await readNeonCronDaemonCursor(resolveNeonCronDaemonCursorPath(projectRoot));

      assert.equal(outcome.tick.armed, false);
      assert.equal(outcome.execution.createdRunCount, 0);
      assert.equal(outcome.state.tickCount, 1);
      assert.equal(runs.length, 0);
      assert.equal(cursor.ticks, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("increments workspace note liveness totals when cron workspace notes are armed", async () => {
    const projectRoot = await tempProjectRoot();
    const now = (): Date => new Date("2026-06-02T12:00:00.000Z");

    try {
      await addDemoCronJob(projectRoot, now().getTime());
      const service = createNeonCronDaemonService({
        projectRoot,
        intervalMs: 900_000,
        gate: resolveNeonCronTimerGate({ NEON_CRON_TIMER_ENABLED: "ready" }),
        workspaceNotesGate: resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" }),
        now
      });

      const outcome = await service.tickOnce();
      const snapshot = await createNeonWorkspaceSnapshot(projectRoot, { now });

      assert.equal(outcome.execution.createdRunCount, 1);
      assert.equal(outcome.execution.createdWorkspaceNoteCount, 1);
      assert.equal(outcome.state.createdWorkspaceNotesTotal, 1);
      assert.equal(snapshot.files.notes.noteCount, 1);
      assert.equal(snapshot.files.dailyMemory.noteCount, 1);
      assert.equal(snapshot.safety.semanticMemoryWritten, false);
      assert.equal(snapshot.safety.outboundSent, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function addDemoCronJob(projectRoot: string, atMs: number): Promise<void> {
  const resolved = resolveNeonCronMutation([], {
    id: "demo",
    mutation: "add",
    atMs,
    schedule: "every-15m",
    label: "demo cron"
  });
  if (!resolved.ok) {
    throw new Error(resolved.reason);
  }
  await appendNeonCronStoreEvent(
    projectRoot,
    resolveNeonCronStoreGate({ NEON_CRON_STORE_ENABLED: "ready" }),
    resolved.event
  );
}

async function tempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-cron-service-"));
}
