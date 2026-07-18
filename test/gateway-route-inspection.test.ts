import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonGatewayRouteInspectionSnapshot,
  renderNeonGatewayRouteInspectionReport,
  writeNeonDiscordRouteProbe,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neonika Gateway route inspection", () => {
  it("reports missing Discord route config without exposing secrets", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
        env: {},
        now: () => new Date("2026-05-31T17:00:00.000Z")
      });
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "needs-config");
      assert.equal(snapshot.discord.agentId, "chaty");
      assert.equal(snapshot.discord.botUserIdPresent, false);
      assert.equal(snapshot.allowlist.guilds.count, 0);
      assert.equal(snapshot.allowlist.channels.count, 0);
      assert.equal(snapshot.routes[0]?.guildScope, "missing");
      assert.equal(snapshot.routes[0]?.channelScope, "missing");
      assert.equal(snapshot.routes[0]?.authState, "needs-config");
      assert.equal(snapshot.routes[0]?.probeState, "unknown");
      assert.equal(snapshot.discordProbe.state, "unknown");
      assert.equal(snapshot.authStatus[0]?.state, "needs-config");
      assert.equal(snapshot.authStatus[0]?.botIdentity, "missing");
      assert.ok(snapshot.recovery.some((step) => step.includes("NEON_DISCORD_BOT_USER_ID")));
      assert.doesNotMatch(serialized, /token/i);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a ready route snapshot from bounded Discord env", async () => {
    const projectRoot = await createTempProjectRoot();
    const secretToken = "discord-secret-value";
    const env: Readonly<Record<string, string | undefined>> = {
      NEON_DISCORD_ACCOUNT_ID: "default",
      NEON_DISCORD_AGENT_ID: "chaty",
      NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005,900000000000000003",
      NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
      NEON_DISCORD_BOT_TOKEN: secretToken,
      NEON_DISCORD_BOT_USER_ID: "900000000000000010",
      NEON_DISCORD_MENTION_POLICY: "always",
      NEON_DISCORD_TAP_HARNESS: "codex"
    };

    try {
      await writeNeonGatewayRun(projectRoot, createRouteRun("route-run-1"));

      const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
        env,
        now: () => new Date("2026-05-31T17:05:00.000Z")
      });
      const report = renderNeonGatewayRouteInspectionReport(snapshot);
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.discord.accountId, "default");
      assert.equal(snapshot.discord.botUserIdPresent, true);
      assert.equal(snapshot.discord.mentionPolicy, "always");
      assert.equal(snapshot.discord.harnessMode, "codex");
      assert.equal(snapshot.authStatus[0]?.state, "ready");
      assert.equal(snapshot.authStatus[0]?.guildScope, "configured");
      assert.equal(snapshot.authStatus[0]?.channelScope, "configured");
      assert.equal(snapshot.allowlist.guilds.count, 1);
      assert.equal(snapshot.allowlist.channels.count, 2);
      assert.equal(snapshot.routes[0]?.authState, "ready");
      assert.equal(snapshot.routes[0]?.latestRunId, "route-run-1");
      assert.match(report, /Neonika Gateway Routes: ready/);
      assert.match(report, /Auth: discord=ready bot=present guild=configured channel=configured/);
      assert.match(report, /Allowlist: guilds=1 channels=2/);
      assert.doesNotMatch(serialized, new RegExp(secretToken));
      assert.doesNotMatch(report, new RegExp(secretToken));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("surfaces Discord tap probe stats without changing route auth state", async () => {
    const projectRoot = await createTempProjectRoot();
    const env: Readonly<Record<string, string | undefined>> = {
      NEON_DISCORD_ACCOUNT_ID: "default",
      NEON_DISCORD_AGENT_ID: "chaty",
      NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005",
      NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
      NEON_DISCORD_BOT_USER_ID: "900000000000000010"
    };

    try {
      await writeNeonDiscordRouteProbe(projectRoot, {
        channel: "discord",
        accountId: "default",
        state: "running",
        running: true,
        startedAt: "2026-05-31T18:00:00.000Z",
        lastProbeAt: "2026-05-31T18:01:00.000Z",
        stats: {
          accepted: 2,
          dropped: 1,
          errors: 1,
          lastRunId: "route-probe-run",
          lastDropReason: "mention-required",
          lastErrorMessage: "gateway closed"
        }
      });

      const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
        env,
        now: () => new Date("2026-05-31T18:02:00.000Z")
      });
      const report = renderNeonGatewayRouteInspectionReport(snapshot);
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.routes[0]?.authState, "ready");
      assert.equal(snapshot.routes[0]?.probeState, "running");
      assert.equal(snapshot.routes[0]?.lastProbeAt, "2026-05-31T18:01:00.000Z");
      assert.equal(snapshot.discordProbe.stats.accepted, 2);
      assert.equal(snapshot.discordProbe.stats.dropped, 1);
      assert.equal(snapshot.discordProbe.stats.errors, 1);
      assert.match(report, /Probe: running accepted=2 dropped=1 errors=1 last=2026-05-31T18:01:00.000Z/);
      assert.doesNotMatch(serialized, /discord-secret-value/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("flags wildcard Discord scopes as unsafe", async () => {
    const projectRoot = await createTempProjectRoot();
    const env: Readonly<Record<string, string | undefined>> = {
      NEON_DISCORD_ALLOWED_CHANNELS: "*",
      NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
      NEON_DISCORD_BOT_USER_ID: "900000000000000010"
    };

    try {
      const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
        env,
        now: () => new Date("2026-05-31T17:10:00.000Z")
      });

      assert.equal(snapshot.state, "unsafe");
      assert.equal(snapshot.authStatus[0]?.state, "unsafe");
      assert.equal(snapshot.authStatus[0]?.channelScope, "wildcard");
      assert.equal(snapshot.routes[0]?.channelScope, "wildcard");
      assert.ok(snapshot.recovery.some((step) => step.includes("wildcard")));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-routes-"));
}

function createRouteRun(runId: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Route inspection",
      receivedAt: "2026-05-31T17:04:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:channel:main:hash:read-only",
    memoryState: "attached",
    events: [
      {
        kind: "final",
        text: "ok"
      }
    ],
    finalText: "ok",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "ok"
    },
    startedAt: "2026-05-31T17:04:00.000Z",
    completedAt: "2026-05-31T17:04:01.000Z"
  };
}
