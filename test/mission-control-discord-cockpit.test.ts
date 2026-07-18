import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDeliveryPayloadHash,
  createNeonMissionControlDiscordCockpitSnapshot,
  executeNeonExactlyOnceDelivery,
  listenNeonGatewayHttpServer,
  parseNeonMissionControlDiscordCockpitSnapshot,
  readNeonMissionControlDiscordCockpitSnapshot,
  writeNeonDiscordRouteProbe,
  writeNeonGatewayRunLatest,
  type INeonDeliveryReceipt,
  type INeonDiscordRouteProbe,
  type INeonGatewayShadowRun,
  type INeonOutboundSendResult
} from "../src/index.js";

const correctChannelId = "900000000000000021";
const wrongChannelId = "900000000000000022";
// Anchored to the real wall clock: the HTTP entry point cannot inject `now`,
// so pinned calendar fixtures become time-bombs once real time passes them.
const baseMs = Date.now();
const nowIso = new Date(baseMs).toISOString();

function minutesAgoIso(minutes: number): string {
  return new Date(baseMs - minutes * 60_000).toISOString();
}

describe("Mission Control Discord/PDF cockpit", () => {
  it("projects live tap, active runs, controls, progress and receipts without raw run data", () => {
    const secret = "sk-cockpit-secret-must-not-render";
    const snapshot = createNeonMissionControlDiscordCockpitSnapshot(
      routeProbe(),
      [runningRun("run-allowed", correctChannelId, secret), runningRun("run-blocked", wrongChannelId, secret)],
      [receipt("run-allowed", correctChannelId, "delivered"), receipt("run-blocked", wrongChannelId, "uncertain")],
      {
        env: { NEON_CUTOVER_CANARY_CHANNELS: correctChannelId },
        now: () => new Date(nowIso)
      }
    );

    assert.equal(snapshot.state, "live");
    assert.equal(snapshot.activeRuns.length, 2);
    assert.equal(snapshot.staleRunningRuns, 0);
    assert.equal(snapshot.activeRuns[0]?.runtime?.model, "gpt-5.6-sol");
    assert.equal(snapshot.progress.cardsStarted, 3);
    assert.equal(snapshot.controls.lastState, "stopped");
    assert.equal(snapshot.recovery.cardsStarted, 1);
    assert.equal(snapshot.delivery.totals.delivered, 1);
    assert.equal(snapshot.delivery.totals.uncertain, 1);
    assert.equal(snapshot.scope.violations, 2);
    assert.equal(snapshot.activeRuns[1]?.scope, "blocked");
    assert.equal(snapshot.delivery.recentReceipts[1]?.scope, "blocked");
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret, "u"));
    assert.equal(parseNeonMissionControlDiscordCockpitSnapshot(snapshot)?.state, "live");
    assert.equal(
      parseNeonMissionControlDiscordCockpitSnapshot({ ...snapshot, activeRuns: [{}] }),
      undefined
    );
  });

  it("keeps abandoned persisted running rows out of the active-run count", () => {
    const stale = runningRun("run-stale", correctChannelId, "safe");
    const snapshot = createNeonMissionControlDiscordCockpitSnapshot(
      routeProbe(),
      [{ ...stale, startedAt: minutesAgoIso(120) }],
      [],
      {
        now: () => new Date(nowIso),
        activeRunMaxAgeMs: 60 * 60 * 1_000
      }
    );

    assert.equal(snapshot.activeRuns.length, 0);
    assert.equal(snapshot.staleRunningRuns, 1);
  });

  it("reads all cockpit planes from the persisted Gateway entry point", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-discord-cockpit-"));
    try {
      await seedPersistedCockpit(projectRoot);
      const snapshot = await readNeonMissionControlDiscordCockpitSnapshot(projectRoot, {
        env: { NEON_CUTOVER_CANARY_CHANNELS: correctChannelId },
        now: () => new Date(nowIso)
      });

      assert.equal(snapshot.state, "live");
      assert.equal(snapshot.sources.tap, "ready");
      assert.equal(snapshot.sources.runs, "ready");
      assert.equal(snapshot.sources.deliveryReceipts, "ready");
      assert.equal(snapshot.activeRuns.length, 1);
      assert.equal(snapshot.staleRunningRuns, 0);
      assert.equal(snapshot.activeRuns[0]?.runId, "run-live-entry");
      assert.equal(snapshot.delivery.totals.receipts, 1);
      assert.equal(snapshot.delivery.recentReceipts[0]?.state, "delivered");
      assert.equal(snapshot.scope.violations, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders an explicit unknown empty state when no Discord runtime state exists", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-discord-cockpit-empty-"));
    try {
      const snapshot = await readNeonMissionControlDiscordCockpitSnapshot(projectRoot, {
        env: {},
        now: () => new Date(nowIso)
      });

      assert.equal(snapshot.state, "unknown");
      assert.equal(snapshot.sources.tap, "unavailable");
      assert.equal(snapshot.activeRuns.length, 0);
      assert.equal(snapshot.staleRunningRuns, 0);
      assert.equal(snapshot.delivery.totals.receipts, 0);
      assert.equal(snapshot.scope.violations, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the persisted cockpit through the real HTTP API and Mission Control HTML", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-discord-cockpit-http-"));
    try {
      await seedPersistedCockpit(projectRoot);
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );
      try {
        const [apiResponse, htmlResponse] = await Promise.all([
          fetch(`${handle.url}/api/neon-mission-control/gateway`),
          fetch(`${handle.url}/mission-control/gateway`)
        ]);
        const payload: unknown = JSON.parse(await apiResponse.text());
        const html = await htmlResponse.text();

        assert.equal(apiResponse.status, 200);
        assert.equal(htmlResponse.status, 200);
        assert.ok(isRecord(payload));
        assert.ok(isRecord(payload["discordCockpit"]));
        assert.equal(payload["discordCockpit"]["state"], "live");
        assert.equal(
          Array.isArray(payload["discordCockpit"]["activeRuns"])
            ? payload["discordCockpit"]["activeRuns"].length
            : 0,
          1
        );
        assert.match(html, /Discord\/PDF Cockpit/u);
        assert.match(html, /id="discordCockpitState">live</u);
        assert.match(html, /run-live-entry/u);
        assert.match(html, /receipts 1 \/ delivered 1 \/ uncertain 0/u);
        assert.doesNotMatch(html, /sk-live-entry-secret/u);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function seedPersistedCockpit(projectRoot: string): Promise<void> {
  await writeNeonDiscordRouteProbe(projectRoot, routeProbe());
  const liveStartedAt = nowIso;
  const liveRun = runningRun("run-live-entry", correctChannelId, "sk-live-entry-secret");
  await writeNeonGatewayRunLatest(
    projectRoot,
    { ...liveRun, startedAt: liveStartedAt, completedAt: liveStartedAt }
  );
  await executeNeonExactlyOnceDelivery({
    projectRoot,
    intentId: "mission-control-discord-cockpit-live-receipt",
    runId: "run-live-entry",
    kind: "text",
    target: {
      channel: "discord",
      accountId: "default",
      channelId: correctChannelId
    },
    payloadHash: createNeonDeliveryPayloadHash(["cockpit live receipt"]),
    now: () => new Date(nowIso),
    send: async (target): Promise<INeonOutboundSendResult> => ({
      outboundSent: true,
      target,
      bodyPreview: "cockpit live receipt",
      cutoverStage: "canary",
      messageId: "receipt-message-1",
      sentAt: nowIso
    })
  });
}

function routeProbe(): INeonDiscordRouteProbe {
  return {
    channel: "discord",
    accountId: "default",
    allowedChannelIds: [correctChannelId],
    state: "running",
    running: true,
    startedAt: minutesAgoIso(30),
    lastProbeAt: nowIso,
    stats: {
      accepted: 9,
      dropped: 2,
      errors: 1,
      typingStarted: 8,
      reactionsSent: 7,
      progressCardsStarted: 3,
      progressCardUpdates: 6,
      progressCardErrors: 0,
      controlsAccepted: 2,
      controlsDropped: 1,
      lastControlState: "stopped",
      lastControlAt: minutesAgoIso(10),
      recoveryCardsStarted: 1,
      recoveryCardErrors: 0,
      lastProgressCardMessageId: "progress-message-1",
      lastRecoveryCardMessageId: "recovery-message-1"
    }
  };
}

function runningRun(runId: string, channelId: string, secret: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "live",
    status: "running",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId,
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/private/project",
      mode: "write",
      contentPreview: `raw prompt ${secret}`,
      receivedAt: minutesAgoIso(20)
    },
    harnessId: "codex-app-server",
    runtime: {
      provider: "openai",
      runtime: "codex",
      lane: "codex-app-server",
      model: "gpt-5.6-sol",
      effort: "xhigh"
    },
    harnessSessionKey: "session-1",
    memoryState: "attached",
    events: [{ kind: "tool-output", toolName: "shell", output: secret }],
    finalText: secret,
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: channelId,
      reason: "running",
      finalText: secret
    },
    startedAt: minutesAgoIso(20),
    completedAt: minutesAgoIso(20)
  };
}

function receipt(
  runId: string,
  channelId: string,
  state: INeonDeliveryReceipt["state"]
): INeonDeliveryReceipt {
  return {
    version: 1,
    intentKey: `${runId}-intent`,
    runId,
    kind: "text",
    channelId,
    payloadHash: "a".repeat(64),
    nonce: `${runId}-nonce`,
    state,
    attempts: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...(state === "delivered" ? { messageId: `${runId}-message` } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
