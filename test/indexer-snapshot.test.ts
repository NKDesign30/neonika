import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonIndexerSnapshot,
  projectNeonIndexer,
  renderNeonIndexerReport,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neonika Indexer snapshot", () => {
  it("folds runs into per-session decision-signal digests + candidates", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createIndexerRun("run-1", "session-a"));
      await writeNeonGatewayRun(projectRoot, createIndexerRun("run-2", "session-a"));
      await writeNeonGatewayRun(projectRoot, createIndexerRun("run-3", "session-b"));

      const snapshot = await createNeonIndexerSnapshot(projectRoot, {
        now: () => new Date("2026-06-04T12:00:00.000Z")
      });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.generatedAt, "2026-06-04T12:00:00.000Z");
      assert.equal(snapshot.totals.sessions, 2);
      assert.equal(snapshot.totals.runs, 3);
      assert.equal(snapshot.totals.candidates, 2);
      // Each run has 1 file-write + 1 command-exit + 1 final = 3 signals.
      // session-a (2 runs) = 6, session-b (1 run) = 3 -> 9 total.
      assert.equal(snapshot.totals.decisionSignals, 9);

      const sessionA = snapshot.sessions.find((session) => session.sessionKey === "session-a");
      assert.ok(sessionA);
      assert.equal(sessionA?.runCount, 2);
      assert.equal(sessionA?.signals.fileWrites, 2);
      assert.equal(sessionA?.signals.commandExits, 2);
      assert.equal(sessionA?.signals.finals, 2);
      assert.equal(sessionA?.signals.decisionSignals, 6);

      // Candidates sorted by decisionSignals desc -> session-a first.
      assert.equal(snapshot.candidates[0]?.sessionKey, "session-a");
      assert.equal(snapshot.candidates[0]?.candidateId, "indexer:session-a");
      assert.equal(snapshot.candidates[0]?.category, "indexer:decision");
    } finally {
      await cleanup(projectRoot);
    }
  });

  it("reports an empty projection when no runs are persisted", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonIndexerSnapshot(projectRoot, {
        now: () => new Date("2026-06-04T12:00:00.000Z")
      });

      assert.equal(snapshot.state, "empty");
      assert.equal(snapshot.totals.sessions, 0);
      assert.equal(snapshot.totals.candidates, 0);
      assert.deepEqual(snapshot.candidates, []);
    } finally {
      await cleanup(projectRoot);
    }
  });

  it("strips paths and secrets from synthesized output (the indexer's own contribution)", () => {
    // writeNeonGatewayRun redacts the 9 secret patterns but NOT filesystem
    // paths, so feed projectNeonIndexer a run directly to prove the indexer's
    // path-stripping + re-redaction on the previews/summaries it synthesizes.
    const run = createIndexerRun("run-secret", "session-secret");
    const runWithLeak: INeonGatewayShadowRun = {
      ...run,
      request: {
        ...run.request,
        contentPreview: "token sk-test1234567890abcdefSECRET path /Users/operator/secret/project.txt"
      }
    };

    const projection = projectNeonIndexer([runWithLeak]);
    const serialized = JSON.stringify(projection);

    assert.doesNotMatch(serialized, /sk-test1234567890/);
    assert.doesNotMatch(serialized, /\/Users\//);
    assert.match(projection.sessions[0]?.latestPreview ?? "", /\[REDACTED_PATH\]/);
  });

  it("renders a human-readable report", () => {
    const projection = projectNeonIndexer([createIndexerRun("run-1", "session-a")]);
    const snapshot = {
      state: "ready" as const,
      generatedAt: "2026-06-04T12:00:00.000Z",
      source: {
        projectRoot: "/tmp/x",
        stateRoot: "/tmp/x/state",
        gatewayRoot: "/tmp/x/state/gateway",
        runsPath: "/tmp/x/state/gateway/runs.jsonl"
      },
      ...projection
    };

    const report = renderNeonIndexerReport(snapshot);

    assert.match(report, /Neonika Indexer: ready/);
    assert.match(report, /Sessions: 1/);
    assert.match(report, /Decision candidates: 1/);
  });
});

function createIndexerRun(runId: string, sessionKey: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/workspace",
      mode: "read-only",
      contentPreview: "Index this run",
      receivedAt: "2026-06-04T11:59:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: sessionKey,
    memoryState: "attached",
    events: [
      { kind: "file-write", path: "/tmp/workspace/output.txt" },
      { kind: "command-exit", command: "npm test", exitCode: 0 },
      { kind: "final", text: "done" }
    ],
    finalText: "done",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "done"
    },
    startedAt: "2026-06-04T11:59:00.000Z",
    completedAt: `2026-06-04T12:00:0${runId.length % 10}.000Z`
  };
}

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-indexer-test-"));
}

async function cleanup(projectRoot: string): Promise<void> {
  await rm(projectRoot, { force: true, recursive: true });
}
