import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getNeonChannelManifest,
  isNeonChannelPlatform,
  listNeonChannelManifests,
  neonChannelManifests,
  neonChannelPlatforms,
  renderNeonChannelManifestLine,
  summarizeNeonChannelManifests
} from "../src/index.js";

describe("Neon channel manifest catalog", () => {
  it("inventories the six upstream messaging platforms with Discord first", () => {
    assert.deepEqual(neonChannelPlatforms, [
      "discord",
      "matrix",
      "msteams",
      "slack",
      "telegram",
      "whatsapp"
    ]);
    assert.equal(neonChannelManifests[0]?.id, "discord");
  });

  it("keeps Discord and WhatsApp live for shadow ingress and gates the rest", () => {
    const totals = summarizeNeonChannelManifests();

    assert.equal(totals.total, 6);
    assert.equal(totals.live, 2);
    assert.equal(totals.gated, 4);

    const live = neonChannelManifests.filter((manifest) => manifest.liveStatus === "live");
    assert.deepEqual(
      live.map((manifest) => manifest.id),
      ["discord", "whatsapp"]
    );
  });

  it("allows only the two wired login policies; every gated platform is no-new-login", () => {
    for (const manifest of neonChannelManifests) {
      if (manifest.id === "discord") {
        assert.equal(manifest.loginPolicy, "existing-discord-session");
        assert.equal(manifest.transport, "discord.js");
      } else if (manifest.id === "whatsapp") {
        assert.equal(manifest.loginPolicy, "linked-device-qr");
        assert.equal(manifest.transport, "baileys");
        assert.equal(manifest.liveStatus, "live");
      } else {
        assert.equal(
          manifest.loginPolicy,
          "no-new-login",
          `${manifest.id} must not open a new login`
        );
        assert.equal(manifest.transport, "manifest-only");
        assert.equal(manifest.liveStatus, "gated");
      }
    }
  });

  it("models per-platform capability facts (WhatsApp lacks slash commands and markdown)", () => {
    const whatsapp = getNeonChannelManifest("whatsapp");
    assert.ok(whatsapp);
    assert.equal(whatsapp.inbound.slashCommands, false);
    assert.equal(whatsapp.markdownCapable, false);
    assert.equal(whatsapp.outbound.threads, false);

    const telegram = getNeonChannelManifest("telegram");
    assert.ok(telegram);
    assert.equal(telegram.inbound.slashCommands, true);
    assert.equal(telegram.inbound.threads, false);

    const discord = getNeonChannelManifest("discord");
    assert.ok(discord);
    assert.equal(discord.inbound.slashCommands, true);
    assert.equal(discord.inbound.threads, true);
  });

  it("carries a concrete upstream reference per manifest and keeps ids unique", () => {
    const ids = new Set<string>();
    for (const manifest of neonChannelManifests) {
      assert.equal(ids.has(manifest.id), false, `duplicate id ${manifest.id}`);
      ids.add(manifest.id);
      assert.match(manifest.referenceImplementation, /^extensions\/.+\/openclaw\.plugin\.json$/);
    }
    assert.equal(ids.size, 6);
  });

  it("resolves manifests by id and rejects unknown platforms", () => {
    assert.equal(listNeonChannelManifests().length, 6);
    assert.equal(getNeonChannelManifest("slack")?.label, "Slack");
    assert.equal(isNeonChannelPlatform("discord"), true);
    assert.equal(isNeonChannelPlatform("signal"), false);
    assert.equal(isNeonChannelPlatform(42), false);
  });

  it("renders a leak-safe one-line manifest summary", () => {
    const line = renderNeonChannelManifestLine(getNeonChannelManifest("matrix")!);

    assert.equal(
      line,
      "matrix=gated transport=manifest-only scope=homeserver login=no-new-login markdown=yes"
    );
  });
});
