import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildNeonPluginCatalog, createDefaultNeonPluginTrustPolicy } from "../src/index.js";

let workspace: string;
let extensionRoot: string;

async function writeManifest(directoryName: string, contents: string): Promise<void> {
  const dir = join(extensionRoot, directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "openclaw.plugin.json"), contents, "utf8");
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "neon-plugin-catalog-"));
  extensionRoot = join(workspace, "extensions");
  await mkdir(extensionRoot, { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("buildNeonPluginCatalog", () => {
  it("projects manifests into descriptors with trust decisions", async () => {
    await writeManifest("discord", JSON.stringify({ id: "discord", channels: ["discord"] }));
    await writeManifest(
      "acpx",
      JSON.stringify({
        id: "acpx",
        enabledByDefault: true,
        activation: { onStartup: true },
        skills: ["./skills"],
        commandAliases: [{ name: "acpx" }]
      })
    );
    await writeManifest("baddep", JSON.stringify({ id: "baddep", dependencies: { "plain-crypto-js": "*" } }));
    await writeManifest("broken", "{ not valid json");
    // A directory without a manifest must be skipped, not crash the scan.
    await mkdir(join(extensionRoot, "empty"), { recursive: true });

    const policy = createDefaultNeonPluginTrustPolicy({ allowlist: ["acpx"] });
    const catalog = await buildNeonPluginCatalog(extensionRoot, policy);

    assert.deepEqual(
      catalog.entries.map((entry) => entry.directoryName),
      ["acpx", "baddep", "broken", "discord"]
    );

    const byId = new Map(catalog.entries.map((entry) => [entry.directoryName, entry]));
    assert.equal(byId.get("acpx")?.trust.level, "allowlisted");
    assert.equal(byId.get("acpx")?.manifest.autoLoadOnStartup, true);
    assert.equal(byId.get("baddep")?.trust.level, "blocked");
    assert.equal(byId.get("broken")?.trust.level, "blocked");
    assert.equal(byId.get("discord")?.trust.level, "reference-only");

    assert.deepEqual(catalog.totals, {
      plugins: 4,
      referenceOnly: 1,
      allowlisted: 1,
      blocked: 2,
      autoLoadDeclared: 1,
      autoLoadHonored: 0,
      withCommands: 1,
      withChannels: 1,
      invalidManifests: 1
    });

    assert.equal(catalog.hostVersion, policy.hostVersion);
    assert.ok(catalog.issues.some((issue) => /broken/.test(issue)));
  });

  it("reports an unavailable extension root as an issue without throwing", async () => {
    const policy = createDefaultNeonPluginTrustPolicy();
    const catalog = await buildNeonPluginCatalog(join(workspace, "does-not-exist"), policy);

    assert.equal(catalog.entries.length, 0);
    assert.equal(catalog.totals.plugins, 0);
    assert.ok(catalog.issues.some((issue) => /unavailable/.test(issue)));
  });

  it("never marks any catalogued plugin as auto-loadable", async () => {
    await writeManifest("a", JSON.stringify({ id: "a", enabledByDefault: true }));
    await writeManifest("b", JSON.stringify({ id: "b" }));

    const catalog = await buildNeonPluginCatalog(extensionRoot, createDefaultNeonPluginTrustPolicy());
    for (const entry of catalog.entries) {
      assert.equal(entry.trust.autoLoadable, false);
    }
    assert.equal(catalog.totals.autoLoadHonored, 0);
  });
});
