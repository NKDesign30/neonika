import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDefaultNeonPluginTrustPolicy,
  evaluateNeonPluginTrust,
  parseNeonPluginManifest,
  satisfiesMinHostVersion
} from "../src/index.js";

function manifest(raw: Record<string, unknown>): ReturnType<typeof parseNeonPluginManifest> {
  return parseNeonPluginManifest(raw, { fallbackId: String(raw["id"] ?? "unknown") });
}

describe("evaluateNeonPluginTrust", () => {
  it("defaults a clean manifest to reference-only and never auto-loadable", () => {
    const policy = createDefaultNeonPluginTrustPolicy();
    const decision = evaluateNeonPluginTrust(manifest({ id: "discord" }), policy);

    assert.equal(decision.level, "reference-only");
    assert.equal(decision.autoLoadable, false);
  });

  it("keeps autoLoadable false even for allowlisted plugins that ask for startup load", () => {
    const policy = createDefaultNeonPluginTrustPolicy({ allowlist: ["acpx"] });
    const decision = evaluateNeonPluginTrust(
      manifest({ id: "acpx", enabledByDefault: true, activation: { onStartup: true } }),
      policy
    );

    assert.equal(decision.level, "allowlisted");
    assert.equal(decision.autoLoadable, false);
    assert.ok(decision.reasons.some((reason) => /Neon ignores it/.test(reason)));
    assert.ok(decision.reasons.some((reason) => /gated install plan/.test(reason)));
  });

  it("blocks plugins on the denylist", () => {
    const policy = createDefaultNeonPluginTrustPolicy({ denylist: ["evil"] });
    const decision = evaluateNeonPluginTrust(manifest({ id: "evil" }), policy);

    assert.equal(decision.level, "blocked");
    assert.ok(decision.reasons.some((reason) => /denylist/.test(reason)));
  });

  it("blocks plugins declaring a denylisted dependency", () => {
    const policy = createDefaultNeonPluginTrustPolicy();
    const decision = evaluateNeonPluginTrust(
      manifest({ id: "x", dependencies: { "plain-crypto-js": "*" } }),
      policy
    );

    assert.equal(decision.level, "blocked");
    assert.ok(decision.reasons.some((reason) => /plain-crypto-js/.test(reason)));
  });

  it("blocks plugins whose minHostVersion floor exceeds the host version", () => {
    const policy = createDefaultNeonPluginTrustPolicy({ hostVersion: "0.1.0" });
    const tooNew = evaluateNeonPluginTrust(
      manifest({ id: "x", install: { minHostVersion: ">=1.0.0" } }),
      policy
    );
    const compatible = evaluateNeonPluginTrust(
      manifest({ id: "x", install: { minHostVersion: ">=0.1.0" } }),
      policy
    );

    assert.equal(tooNew.level, "blocked");
    assert.ok(tooNew.reasons.some((reason) => /does not satisfy/.test(reason)));
    assert.equal(compatible.level, "reference-only");
  });

  it("blocks manifests that failed to parse", () => {
    const policy = createDefaultNeonPluginTrustPolicy();
    const decision = evaluateNeonPluginTrust(manifest({}), policy);
    // empty record parses fine (fallback id), so force a real parse error:
    assert.equal(decision.level, "reference-only");

    const broken = parseNeonPluginManifest(null, { fallbackId: "broken" });
    const brokenDecision = evaluateNeonPluginTrust(broken, policy);
    assert.equal(brokenDecision.level, "blocked");
    assert.ok(brokenDecision.reasons.some((reason) => /could not be parsed/.test(reason)));
  });
});

describe("satisfiesMinHostVersion", () => {
  it("compares numeric core versions", () => {
    assert.equal(satisfiesMinHostVersion("1.2.3", ">=1.2.3"), true);
    assert.equal(satisfiesMinHostVersion("1.2.4", ">=1.2.3"), true);
    assert.equal(satisfiesMinHostVersion("2.0.0", ">=1.9.9"), true);
    assert.equal(satisfiesMinHostVersion("1.2.2", ">=1.2.3"), false);
    assert.equal(satisfiesMinHostVersion("0.9.9", ">=1.0.0"), false);
  });

  it("ignores pre-release and build metadata for the floor check", () => {
    assert.equal(satisfiesMinHostVersion("1.2.3-rc.1", ">=1.2.3"), true);
    assert.equal(satisfiesMinHostVersion("1.2.3+build.5", ">=1.2.3"), true);
  });

  it("fails closed on unparsable input", () => {
    assert.equal(satisfiesMinHostVersion("not-a-version", ">=1.0.0"), false);
    assert.equal(satisfiesMinHostVersion("1.0.0", ">=garbage"), false);
  });
});
