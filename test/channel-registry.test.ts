import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonChannelRegistrySnapshot,
  listenNeonGatewayHttpServer,
  renderNeonChannelRegistryReport,
  type INeonChannelRegistrySnapshot
} from "../src/index.js";

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-channel-registry-test-"));
}

describe("Neon channel registry", () => {
  it("folds the manifest catalog into a read-only snapshot with Discord live", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonChannelRegistrySnapshot(projectRoot, {
        env: {},
        now: () => new Date("2026-06-02T09:00:00.000Z")
      });

      assert.equal(snapshot.entries.length, 6);
      assert.equal(snapshot.totals.total, 6);
      assert.equal(snapshot.totals.live, 1);
      assert.equal(snapshot.totals.gated, 5);
      assert.equal(snapshot.totals.suppressed, 6);
      assert.equal(snapshot.referenceImplementation, "src/channels/registry.ts");

      const discord = snapshot.entries.find((entry) => entry.manifest.id === "discord");
      assert.ok(discord);
      assert.equal(discord.runtime.liveStatus, "live");
      assert.equal(discord.runtime.inbound, "live-tap");
      assert.equal(discord.runtime.delivery, "suppressed");
      // Empty env => Discord route is unconfigured but still the live channel.
      assert.equal(discord.runtime.authState, "needs-config");
      assert.equal(discord.runtime.probeState, "unknown");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps every non-Discord platform gated, no-login, and outbound-suppressed", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonChannelRegistrySnapshot(projectRoot, { env: {} });
      const gated = snapshot.entries.filter((entry) => entry.manifest.id !== "discord");

      assert.equal(gated.length, 5);
      for (const entry of gated) {
        assert.equal(entry.runtime.liveStatus, "gated");
        assert.equal(entry.runtime.inbound, "gated");
        assert.equal(entry.runtime.delivery, "suppressed");
        assert.equal(entry.manifest.loginPolicy, "no-new-login");
        assert.equal(entry.runtime.authState, undefined);
        assert.equal(entry.runtime.probeState, undefined);
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a leak-safe report and never serializes a configured bot token", async () => {
    const projectRoot = await createTempProjectRoot();
    const secretToken = "channel-registry-secret-token";

    try {
      const snapshot = await createNeonChannelRegistrySnapshot(projectRoot, {
        env: {
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005",
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_BOT_TOKEN: secretToken,
          NEON_DISCORD_BOT_USER_ID: "900000000000000010",
          NEON_DISCORD_MENTION_POLICY: "always"
        }
      });
      const report = renderNeonChannelRegistryReport(snapshot);

      assert.match(report, /Neon Channel Registry: ready/);
      assert.match(report, /discord: live/);
      assert.match(report, /telegram: gated/);
      assert.doesNotMatch(report, new RegExp(secretToken));
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secretToken));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the registry over /api/neon-channels without leaking secrets", async () => {
    const projectRoot = await createTempProjectRoot();
    const handle = await listenNeonGatewayHttpServer(
      { projectRoot },
      { host: "127.0.0.1", port: 0 }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-channels`);
      const payload = (await response.json()) as INeonChannelRegistrySnapshot;

      assert.equal(response.ok, true);
      assert.equal(payload.entries.length, 6);
      assert.equal(payload.entries[0]?.manifest.id, "discord");
      assert.equal(payload.entries[0]?.runtime.liveStatus, "live");
      assert.ok(payload.entries.every((entry) => entry.runtime.delivery === "suppressed"));
    } finally {
      await handle.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
