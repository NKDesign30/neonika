import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseNeonPluginManifest } from "../src/index.js";

describe("parseNeonPluginManifest", () => {
  it("projects a rich upstream manifest into typed contributions", () => {
    const manifest = parseNeonPluginManifest(
      {
        id: "codex",
        name: "Codex",
        description: "Codex app-server harness and model provider plugin.",
        version: "1.2.3",
        providers: ["codex"],
        channels: ["discord", "discord"],
        skills: ["./skills"],
        contracts: {
          tools: ["codex-run", "codex-review"],
          migrationProviders: ["codex"]
        },
        activation: { onStartup: false, onAgentHarnesses: ["codex"] },
        commandAliases: [{ name: "codex", kind: "runtime-slash", cliCommand: "plugins" }],
        configSchema: { type: "object" }
      },
      { fallbackId: "codex" }
    );

    assert.equal(manifest.id, "codex");
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.format, "openclaw");
    assert.equal(manifest.configSchemaPresent, true);
    assert.equal(manifest.autoLoadOnStartup, false);
    assert.deepEqual([...manifest.channels], ["discord"]);
    assert.deepEqual([...manifest.skills], ["./skills"]);
    assert.deepEqual([...manifest.tools], ["codex-run", "codex-review"]);
    assert.deepEqual([...manifest.activation], ["onAgentHarnesses"]);
    assert.deepEqual(manifest.commands, [{ name: "codex", kind: "runtime-slash", cliCommand: "plugins" }]);
    assert.deepEqual(manifest.capabilities, [
      { kind: "provider", id: "codex" },
      { kind: "contract:tools", id: "codex-run" },
      { kind: "contract:tools", id: "codex-review" },
      { kind: "contract:migrationProviders", id: "codex" }
    ]);
    assert.equal(manifest.parseError, undefined);
    assert.deepEqual([...manifest.warnings], []);
  });

  it("treats onStartup or enabledByDefault as auto-load intent", () => {
    const startup = parseNeonPluginManifest(
      { id: "acpx", activation: { onStartup: true } },
      { fallbackId: "acpx" }
    );
    const enabled = parseNeonPluginManifest(
      { id: "acpx", enabledByDefault: true, activation: { onStartup: false } },
      { fallbackId: "acpx" }
    );

    assert.equal(startup.autoLoadOnStartup, true);
    assert.equal(enabled.autoLoadOnStartup, true);
  });

  it("captures install constraints and flags a malformed minHostVersion", () => {
    const ok = parseNeonPluginManifest(
      {
        id: "x",
        install: { minHostVersion: ">=1.4.0" },
        dependencies: { "left-pad": "1.0.0" },
        peerDependencies: { "plain-crypto-js": "*" }
      },
      { fallbackId: "x" }
    );
    assert.equal(ok.install.minHostVersion, ">=1.4.0");
    assert.deepEqual([...ok.install.declaredDependencies], ["left-pad", "plain-crypto-js"]);
    assert.deepEqual([...ok.warnings], []);

    const bad = parseNeonPluginManifest(
      { id: "x", install: { minHostVersion: "1.4" } },
      { fallbackId: "x" }
    );
    assert.equal(bad.install.minHostVersion, undefined);
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0] ?? "", /minHostVersion/);
  });

  it("falls back to the directory id and warns when id is missing", () => {
    const manifest = parseNeonPluginManifest({ name: "No Id" }, { fallbackId: "dir-name" });
    assert.equal(manifest.id, "dir-name");
    assert.equal(manifest.name, "No Id");
    assert.equal(manifest.warnings.length, 1);
    assert.match(manifest.warnings[0] ?? "", /missing a string id/);
  });

  it("returns a parse error for non-object input instead of throwing", () => {
    for (const value of [null, 42, "manifest", ["array"]]) {
      const manifest = parseNeonPluginManifest(value, { fallbackId: "broken" });
      assert.equal(manifest.id, "broken");
      assert.equal(manifest.format, "unknown");
      assert.match(manifest.parseError ?? "", /not a JSON object/);
    }
  });
});
