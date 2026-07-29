import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  return mkdtemp(join(tmpdir(), "neonika-channel-registry-test-"));
}

describe("Neon channel registry", () => {
  it("folds the manifest catalog into a read-only snapshot with two live shadow transports", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonChannelRegistrySnapshot(projectRoot, {
        env: {},
        now: () => new Date("2026-06-02T09:00:00.000Z")
      });

      assert.equal(snapshot.entries.length, 6);
      assert.equal(snapshot.totals.total, 6);
      assert.equal(snapshot.totals.live, 2);
      assert.equal(snapshot.totals.gated, 4);
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
      const whatsapp = snapshot.entries.find((entry) => entry.manifest.id === "whatsapp");
      assert.ok(whatsapp);
      assert.equal(whatsapp.runtime.liveStatus, "live");
      assert.equal(whatsapp.runtime.inbound, "disabled");
      assert.equal(whatsapp.runtime.delivery, "suppressed");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps every platform without a wired transport gated, no-login, and outbound-suppressed", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonChannelRegistrySnapshot(projectRoot, { env: {} });
      const gated = snapshot.entries.filter(
        (entry) => entry.manifest.id !== "discord" && entry.manifest.id !== "whatsapp"
      );

      assert.equal(gated.length, 4);
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

      assert.match(report, /Neonika Channel Registry: ready/);
      assert.match(report, /discord: live/);
      assert.match(report, /whatsapp: live/);
      assert.match(report, /telegram: gated/);
      assert.doesNotMatch(report, new RegExp(secretToken));
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secretToken));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reports WhatsApp ready only after enabled owner config has private credentials and a marker", async () => {
    const projectRoot = await createTempProjectRoot();
    const authPath = join(projectRoot, "private-whatsapp-auth");
    try {
      await mkdir(authPath, { recursive: true, mode: 0o700 });
      await writeFile(
        join(authPath, "session.json"),
        `${JSON.stringify({
          version: 1,
          state: "linked",
          accountId: "default",
          verifiedAt: "2026-07-18T18:00:00.000Z"
        })}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      await writeFile(join(authPath, "creds.json"), '{"registered":false,"me":{"id":"15551234567:9@s.whatsapp.net"}}\n', {
        encoding: "utf8",
        mode: 0o600
      });
      const snapshot = await createNeonChannelRegistrySnapshot(projectRoot, {
        env: {
          NEON_WHATSAPP_ENABLED: "ready",
          NEON_WHATSAPP_AUTH_DIR: authPath,
          NEON_WHATSAPP_OWNER_PEER: "+15551234567"
        }
      });
      const whatsapp = snapshot.entries.find((entry) => entry.manifest.id === "whatsapp");

      assert.equal(whatsapp?.runtime.authState, "ready");
      assert.equal(whatsapp?.runtime.inbound, "live-tap");
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
