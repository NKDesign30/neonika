import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultNeonPluginTrustPolicy,
  evaluateNeonPluginTrust,
  neonPluginInstallGateFlag,
  parseNeonPluginManifest,
  planNeonPluginAction,
  resolveNeonPluginInstallGate,
  type INeonPluginCatalogEntry,
  type INeonPluginInstallGate
} from "../src/index.js";

function entry(raw: Record<string, unknown>, allowlist: readonly string[] = []): INeonPluginCatalogEntry {
  const manifest = parseNeonPluginManifest(raw, { fallbackId: String(raw["id"] ?? "x") });
  const trust = evaluateNeonPluginTrust(manifest, createDefaultNeonPluginTrustPolicy({ allowlist }));
  return {
    directoryName: manifest.id,
    manifestPath: `/tmp/${manifest.id}/openclaw.plugin.json`,
    rootDir: `/tmp/${manifest.id}`,
    manifest,
    trust
  };
}

const enabledGate: INeonPluginInstallGate = { enabled: true, source: "env", flag: neonPluginInstallGateFlag };
const disabledGate: INeonPluginInstallGate = { enabled: false, source: "default", flag: neonPluginInstallGateFlag };

describe("resolveNeonPluginInstallGate", () => {
  it("is disabled by default and enabled only by an explicit truthy flag", () => {
    assert.equal(resolveNeonPluginInstallGate({}).enabled, false);
    assert.equal(resolveNeonPluginInstallGate({ [neonPluginInstallGateFlag]: "true" }).enabled, true);
    assert.equal(resolveNeonPluginInstallGate({ [neonPluginInstallGateFlag]: "1" }).enabled, true);
    assert.equal(resolveNeonPluginInstallGate({ [neonPluginInstallGateFlag]: "false" }).enabled, false);
    assert.equal(resolveNeonPluginInstallGate({ [neonPluginInstallGateFlag]: "yes" }).enabled, false);
  });
});

describe("planNeonPluginAction", () => {
  it("always reports executed:false and autoLoadHonored:false", () => {
    const plugin = entry({ id: "acpx", enabledByDefault: true }, ["acpx"]);
    for (const action of ["install", "enable", "load"] as const) {
      for (const gate of [enabledGate, disabledGate]) {
        const plan = planNeonPluginAction(plugin, action, gate);
        assert.equal(plan.executed, false);
        assert.equal(plan.autoLoadHonored, false);
      }
    }
  });

  it("blocks denylisted/blocked plugins regardless of the flag", () => {
    const plugin = entry({ id: "x", dependencies: { "plain-crypto-js": "*" } });
    const plan = planNeonPluginAction(plugin, "install", enabledGate);
    assert.equal(plan.decision, "blocked");
    assert.equal(plan.steps.length, 0);
    assert.ok(plan.reasons.some((reason) => /plain-crypto-js/.test(reason)));
  });

  it("gates a clean but non-allowlisted plugin when the flag is off", () => {
    const plugin = entry({ id: "discord", channels: ["discord"] });
    const plan = planNeonPluginAction(plugin, "install", disabledGate);
    assert.equal(plan.decision, "gated");
    assert.ok(plan.reasons.some((reason) => new RegExp(neonPluginInstallGateFlag).test(reason)));
    assert.ok(plan.steps.length > 0);
  });

  it("still gates an allowlisted plugin when the flag is off", () => {
    const plugin = entry({ id: "acpx" }, ["acpx"]);
    const plan = planNeonPluginAction(plugin, "install", disabledGate);
    assert.equal(plan.decision, "gated");
  });

  it("requires allowlisting even when the flag is on", () => {
    const plugin = entry({ id: "discord" });
    const plan = planNeonPluginAction(plugin, "install", enabledGate);
    assert.equal(plan.decision, "gated");
    assert.ok(plan.reasons.some((reason) => /allowlisted/.test(reason)));
  });

  it("emits a plan-only audit when allowlisted and the flag is on, never executing", () => {
    const plugin = entry({ id: "acpx", commandAliases: [{ name: "acpx" }], channels: ["x"] }, ["acpx"]);
    const plan = planNeonPluginAction(plugin, "enable", enabledGate);
    assert.equal(plan.decision, "plan-only");
    assert.equal(plan.executed, false);
    assert.ok(plan.steps.some((step) => /activation is suppressed/.test(step.description)));
    assert.ok(plan.reasons.some((reason) => /primary-cutover product decision/.test(reason)));
  });
});
