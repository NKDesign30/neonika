import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonWorkspaceSnapshot,
  executeNeonCronRunIntents,
  resolveNeonWorkspaceNotePaths,
  resolveNeonWorkspaceNotesGate,
  type INeonCronDaemonTickResult,
  type INeonCronTimerGate,
  type INeonGatewayShadowRun
} from "../src/index.js";

const gate: INeonCronTimerGate = {
  enabled: true,
  reason: "timer-enabled",
  envKey: "NEON_CRON_TIMER_ENABLED"
};

describe("Neon Cron run executor", () => {
  it("writes terminal shadow run records for catch-up and current windows without outbound", async () => {
    const written: INeonGatewayShadowRun[] = [];
    const tick = cronTickFixture();

    const result = await executeNeonCronRunIntents({
      projectRoot: "/tmp/neon-cron-executor",
      tick,
      writeRun: async (_projectRoot, run) => {
        written.push(run);
      }
    });

    assert.equal(result.createdRunCount, 2);
    assert.equal(result.createdWorkspaceNoteCount, 0);
    assert.equal(result.safety.executed, false);
    assert.equal(result.safety.outboundSent, false);
    assert.equal(result.safety.sentDiscord, false);
    assert.equal(result.safety.wroteRunStore, true);
    assert.equal(result.safety.wroteWorkspaceNotes, false);
    assert.deepEqual(
      written.map((run) => run.delivery.state),
      ["suppressed", "suppressed"]
    );
    assert.deepEqual(
      written.map((run) => run.mode),
      ["shadow", "shadow"]
    );
    assert.deepEqual(
      written.map((run) => run.status),
      ["completed", "completed"]
    );
    assert.match(written[0]?.runId ?? "", /^cron-demo-/u);
    assert.match(written[1]?.request.contentPreview ?? "", /current/u);
  });

  it("does not write when the daemon tick emitted no run intents", async () => {
    const result = await executeNeonCronRunIntents({
      projectRoot: "/tmp/neon-cron-executor-empty",
      tick: {
        ...cronTickFixture(),
        catchup: [],
        tick: {
          ...cronTickFixture().tick,
          emitted: [],
          nextEmitted: {}
        }
      },
      writeRun: async () => {
        throw new Error("empty cron tick must not write");
      }
    });

    assert.equal(result.createdRunCount, 0);
    assert.equal(result.createdWorkspaceNoteCount, 0);
    assert.equal(result.safety.wroteRunStore, false);
    assert.equal(result.safety.wroteWorkspaceNotes, false);
  });

  it("can append local workspace notes for cron emissions when the workspace gate is armed", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-cron-executor-notes-"));
    const written: INeonGatewayShadowRun[] = [];

    try {
      const result = await executeNeonCronRunIntents({
        projectRoot,
        tick: cronTickFixture(),
        workspaceNotesGate: resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" }),
        writeRun: async (_projectRoot, run) => {
          written.push(run);
        }
      });
      const snapshot = await createNeonWorkspaceSnapshot(projectRoot, {
        now: () => new Date("2026-06-02T12:15:00.000Z")
      });
      const paths = resolveNeonWorkspaceNotePaths(projectRoot, new Date("2026-06-02T12:15:00.000Z"));
      const notes = await readFile(paths.notesPath, "utf8");

      assert.equal(written.length, 2);
      assert.equal(result.createdWorkspaceNoteCount, 2);
      assert.equal(result.safety.wroteWorkspaceNotes, true);
      assert.equal(snapshot.files.notes.noteCount, 2);
      assert.equal(snapshot.files.dailyMemory.noteCount, 2);
      assert.match(notes, /Cron demo catch-up/u);
      assert.match(notes, /Cron demo current/u);
      assert.doesNotMatch(notes, /outboundSent=true/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function cronTickFixture(): INeonCronDaemonTickResult {
  return {
    armed: true,
    gate,
    tickAt: "2026-06-02T12:15:00.000Z",
    tick: {
      armed: true,
      gate,
      evaluatedAt: "2026-06-02T12:15:00.000Z",
      intents: [],
      emitted: ["demo"],
      deduped: [],
      nextEmitted: { demo: "2026-06-02T12:15:00.000Z" },
      safety: { executed: false, outboundSent: false },
      diagnostics: []
    },
    catchup: [{ jobId: "demo", window: "2026-06-02T12:00:00.000Z" }],
    catchupTruncated: 0,
    cursor: {
      version: 1,
      emitted: { demo: "2026-06-02T12:15:00.000Z" },
      lastTickAt: "2026-06-02T12:15:00.000Z",
      ticks: 1
    },
    cursorPath: "/tmp/neon-cron-executor/cron-daemon-cursor.json",
    cursorPersisted: true,
    safety: { executed: false, outboundSent: false, wroteRunStore: false, cursorOnlyWrite: true },
    diagnostics: []
  };
}
