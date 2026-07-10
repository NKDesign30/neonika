import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  appendNeonWorkspaceNote,
  createNeonWorkspaceSnapshot,
  resolveNeonWorkspaceNotePaths,
  resolveNeonWorkspaceNotesGate
} from "../src/index.js";

describe("Neon workspace notes", () => {
  it("blocks local note writes by default and leaves the workspace absent", async () => {
    const projectRoot = await tempProjectRoot();
    const now = new Date("2026-06-05T14:30:00.000Z");

    try {
      const result = await appendNeonWorkspaceNote({
        projectRoot,
        gate: resolveNeonWorkspaceNotesGate({}),
        now: () => now,
        note: {
          kind: "cron",
          title: "memory digest",
          source: "cron:memory-digest",
          body: "Would summarize local memory."
        }
      });
      const snapshot = await createNeonWorkspaceSnapshot(projectRoot, { now: () => now });

      assert.equal(result.state, "blocked");
      assert.equal(result.safety.localWorkspaceWrite, false);
      assert.equal(result.writtenPaths.length, 0);
      assert.equal(snapshot.totals.filesPresent, 0);
      assert.equal(snapshot.totals.noteCount, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("writes redacted append-only notes to generic, daily, heartbeat, and dream files when armed", async () => {
    const projectRoot = await tempProjectRoot();
    const now = new Date("2026-06-05T14:30:00.000Z");
    const gate = resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" });

    try {
      const heartbeat = await appendNeonWorkspaceNote({
        projectRoot,
        gate,
        now: () => now,
        note: {
          kind: "heartbeat",
          title: "heartbeat review",
          source: "cron:heartbeat-review",
          body: "Heartbeat saw API_KEY=sk-1234567890abcdef and wrote a shadow run."
        }
      });
      const dream = await appendNeonWorkspaceNote({
        projectRoot,
        gate,
        now: () => now,
        note: {
          kind: "dream",
          title: "dream review",
          source: "cron:dream-review",
          body: "Dream proposal stayed local."
        }
      });
      const paths = resolveNeonWorkspaceNotePaths(projectRoot, now);
      const snapshot = await createNeonWorkspaceSnapshot(projectRoot, { now: () => now });
      const notes = await readFile(paths.notesPath, "utf8");
      const daily = await readFile(paths.dailyMemoryPath, "utf8");
      const heartbeatFile = await readFile(paths.heartbeatPath, "utf8");
      const dreamsFile = await readFile(paths.dreamsPath, "utf8");

      assert.equal(heartbeat.state, "appended");
      assert.equal(dream.state, "appended");
      assert.equal(heartbeat.safety.localWorkspaceWrite, true);
      assert.equal(dream.safety.semanticMemoryWritten, false);
      assert.equal(dream.safety.outboundSent, false);
      assert.equal(snapshot.totals.filesPresent, 4);
      assert.equal(snapshot.totals.noteCount, 6);
      assert.match(notes, /heartbeat review/u);
      assert.match(notes, /dream review/u);
      assert.match(daily, /heartbeat review/u);
      assert.match(daily, /dream review/u);
      assert.match(heartbeatFile, /heartbeat review/u);
      assert.doesNotMatch(heartbeatFile, /dream review/u);
      assert.match(dreamsFile, /dream review/u);
      assert.doesNotMatch(dreamsFile, /heartbeat review/u);
      assert.doesNotMatch(notes, /sk-1234567890abcdef/u);
      assert.match(notes, /API_KEY=\[REDACTED\]/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function tempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-workspace-notes-test-"));
}
