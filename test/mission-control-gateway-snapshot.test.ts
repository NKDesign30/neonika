import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonMissionControlGatewaySnapshot,
  fetchNeonMissionControlGatewaySnapshot,
  listenNeonGatewayHttpServer,
  parseNeonMissionControlGatewaySnapshot,
  writeNeonCutoverPromotion,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun,
  type INeonGatewayStatus
} from "../src/index.js";

describe("Neonika Mission Control Gateway snapshot", () => {
  it("builds a dashboard-ready snapshot from gateway status and runs", () => {
    const status = createStatus();
    const runs = [createSnapshotRun("run-1", "completed"), createSnapshotRun("run-2", "failed")];
    const snapshot = createNeonMissionControlGatewaySnapshot(status, runs, {
      now: () => new Date("2026-05-31T16:00:00.000Z")
    });

    assert.equal(snapshot.title, "Neonika Gateway");
    assert.equal(snapshot.generatedAt, "2026-05-31T16:00:00.000Z");
    assert.equal(snapshot.totals.runs, 2);
    assert.equal(snapshot.totals.failed, 1);
    assert.equal(snapshot.totals.running, 0);
    assert.equal(snapshot.latestRun?.runId, "run-2");
    assert.equal(snapshot.recentRuns.length, 2);
    assert.equal(snapshot.recentRuns[1]?.deliveryState, "suppressed");
    assert.equal(snapshot.source.gatewayStatusPath, "/api/neon-gateway/status");
  });

  it("derives a leak-safe recent-events overview across the returned runs", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createSnapshotRun("run-1", "completed"), createSnapshotRun("run-2", "failed")],
      { now: () => new Date("2026-05-31T16:00:00.000Z") }
    );

    assert.deepEqual(snapshot.recentEvents, [
      { runId: "run-1", kind: "final", label: "final" },
      { runId: "run-2", kind: "failed", label: "failed" }
    ]);
  });

  it("bounds the recent-events overview to 20 entries", () => {
    const noisyRun: INeonGatewayShadowRun = {
      ...createSnapshotRun("run-noisy", "completed"),
      events: Array.from({ length: 25 }, () => ({ kind: "tool-start", toolName: "codex" }) as const)
    };

    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [noisyRun]);

    assert.equal(snapshot.recentEvents.length, 20);
    assert.ok(snapshot.recentEvents.every((event) => event.label === "tool:codex"));
  });

  it("never leaks tool output, command text, or final text into event labels", () => {
    const secret = "sk-leak-secret-123";
    const flaggedRun: INeonGatewayShadowRun = {
      ...createSnapshotRun("run-secret", "completed"),
      events: [
        { kind: "tool-start", toolName: "codex" },
        { kind: "tool-output", toolName: "codex", output: `result ${secret}` },
        { kind: "command-exit", command: `deploy --token ${secret}`, exitCode: 0 },
        { kind: "final", text: `done ${secret}` }
      ]
    };

    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [flaggedRun]);
    const serialized = JSON.stringify(snapshot);

    assert.deepEqual(
      snapshot.recentEvents.map((event) => event.label),
      ["tool:codex", "tool:codex", "exit:0", "final"]
    );
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    assert.doesNotMatch(serialized, /deploy --token/u);
  });

  it("omits hidden channel progress events from the recent-events overview", () => {
    const flaggedRun: INeonGatewayShadowRun = {
      ...createSnapshotRun("run-hidden-progress", "completed"),
      events: [
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: "turn.completed turn-1 status=completed",
          hideFromChannelProgress: true
        },
        {
          kind: "tool-output",
          toolName: "codex",
          output: "visible"
        },
        {
          kind: "final",
          text: "ok"
        }
      ]
    };

    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [flaggedRun]);

    assert.deepEqual(snapshot.recentEvents, [
      { runId: "run-hidden-progress", kind: "tool-output", label: "tool:codex" },
      { runId: "run-hidden-progress", kind: "final", label: "final" }
    ]);
  });

  it("parses valid snapshots and rejects malformed ones", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createSnapshotRun("run-1", "completed")],
      {
        now: () => new Date("2026-05-31T16:01:00.000Z")
      }
    );

    assert.equal(parseNeonMissionControlGatewaySnapshot(snapshot)?.totals.runs, 2);
    assert.equal(parseNeonMissionControlGatewaySnapshot({ ...snapshot, title: "Fake" }), undefined);
    assert.equal(parseNeonMissionControlGatewaySnapshot({ ...snapshot, recentRuns: [{}] }), undefined);
  });

  it("preserves a live/delivered run through the snapshot parse round-trip", () => {
    const liveRun: INeonGatewayShadowRun = {
      ...createSnapshotRun("run-live", "completed"),
      mode: "live",
      delivery: {
        state: "delivered",
        targetChannel: "discord",
        targetChannelId: "900000000000000005",
        reason: "canary-reply",
        finalText: "live reply",
        messageId: "900000000000000014"
      }
    };

    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [liveRun], {
      now: () => new Date("2026-05-31T16:02:00.000Z")
    });
    // A live run must survive the parse (a single non-shadow run previously
    // collapsed the entire recent-runs list to undefined).
    const parsed = parseNeonMissionControlGatewaySnapshot(snapshot);

    assert.equal(parsed?.recentRuns.length, 1);
    assert.equal(parsed?.recentRuns[0]?.mode, "live");
    assert.equal(parsed?.recentRuns[0]?.deliveryState, "delivered");
  });

  it("parses legacy snapshots without running totals as zero", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createSnapshotRun("run-1", "completed")]
    );
    const legacyTotals = {
      runs: snapshot.totals.runs,
      shadowRuns: snapshot.totals.shadowRuns,
      completed: snapshot.totals.completed,
      failed: snapshot.totals.failed,
      deliverySuppressed: snapshot.totals.deliverySuppressed
    };
    const parsed = parseNeonMissionControlGatewaySnapshot({
      ...snapshot,
      totals: legacyTotals
    });

    assert.equal(parsed?.totals.running, 0);
  });

  it("serves and fetches the Mission Control Gateway snapshot over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createSnapshotRun("run-1", "completed"));
      await writeNeonGatewayRun(projectRoot, createSnapshotRun("run-2", "failed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const snapshot = await fetchNeonMissionControlGatewaySnapshot(handle.url, {
          recentRunsLimit: 1
        });

        assert.equal(snapshot.totals.runs, 2);
        assert.equal(snapshot.totals.failed, 1);
        assert.equal(snapshot.latestRun?.runId, "run-2");
        assert.equal(snapshot.recentRuns.length, 1);
        assert.equal(snapshot.recentRuns[0]?.runId, "run-2");
        assert.deepEqual(snapshot.recentEvents, [
          { runId: "run-2", kind: "failed", label: "failed" }
        ]);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reloads the authoritative persisted outbound arm without restarting the HTTP server", async () => {
    const projectRoot = await createTempProjectRoot();
    const cutoverKeys = [
      "NEON_CUTOVER_STAGE",
      "NEON_CUTOVER_CANARY_APPROVED",
      "NEON_CUTOVER_OUTBOUND_ENABLED",
      "NEON_CUTOVER_CANARY_CHANNELS",
      "NEON_DISCORD_BOT_TOKEN"
    ] as const;
    const previous = Object.fromEntries(
      cutoverKeys.map((key) => [key, process.env[key]])
    ) as Record<(typeof cutoverKeys)[number], string | undefined>;
    const token = "mission-control-token-must-not-leak";

    try {
      process.env["NEON_CUTOVER_STAGE"] = "canary";
      process.env["NEON_CUTOVER_CANARY_APPROVED"] = "ready";
      process.env["NEON_CUTOVER_OUTBOUND_ENABLED"] = "disabled";
      process.env["NEON_CUTOVER_CANARY_CHANNELS"] = "900000000000000005";
      process.env["NEON_DISCORD_BOT_TOKEN"] = token;
      await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
        NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005"
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );

      try {
        const armed = await fetchNeonMissionControlGatewaySnapshot(handle.url);
        assert.equal(armed.canaryPosture.outboundEnabled, true);
        assert.equal(armed.canaryPosture.ready, true);
        assert.doesNotMatch(JSON.stringify(armed), new RegExp(token, "u"));

        process.env["NEON_CUTOVER_OUTBOUND_ENABLED"] = "ready";
        await writeNeonCutoverPromotion(projectRoot, {
          NEON_CUTOVER_STAGE: "canary",
          NEON_CUTOVER_CANARY_APPROVED: "ready",
          NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005"
        });

        const disarmed = await fetchNeonMissionControlGatewaySnapshot(handle.url);
        assert.equal(disarmed.canaryPosture.outboundEnabled, false);
        assert.equal(disarmed.canaryPosture.ready, false);
      } finally {
        await handle.close();
      }
    } finally {
      for (const key of cutoverKeys) {
        const value = previous[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createStatus(): INeonGatewayStatus {
  return {
    state: "ready",
    projectRoot: "/Users/operator/neon-projects/neonika",
    runsPath: "/Users/operator/neon-projects/neonika/state/gateway/runs.jsonl",
    runCount: 2,
    shadowRunCount: 2,
    completedCount: 1,
    failedCount: 1,
    runningCount: 0,
    cancelledCount: 0,
    deliverySuppressedCount: 2,
    latestRun: {
      runId: "run-2",
      mode: "shadow",
      status: "failed",
      channel: "discord",
      channelId: "900000000000000005",
      agentId: "chaty",
      memoryState: "skipped",
      deliveryState: "suppressed",
      startedAt: "2026-05-31T15:00:00.000Z",
      completedAt: "2026-05-31T15:00:01.000Z"
    }
  };
}

function createSnapshotRun(
  runId: string,
  status: INeonGatewayShadowRun["status"]
): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status,
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Mission Control snapshot",
      receivedAt: "2026-05-31T14:30:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:channel:main:hash:read-only",
    memoryState: "skipped",
    events:
      status === "failed"
        ? [
            {
              kind: "failed",
              message: "failed"
            }
          ]
        : [
            {
              kind: "final",
              text: "ok"
            }
          ],
    finalText: status === "failed" ? "failed" : "ok",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: status === "failed" ? "failed" : "ok"
    },
    startedAt: "2026-05-31T15:00:00.000Z",
    completedAt: "2026-05-31T15:00:01.000Z"
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-mission-control-"));
}
