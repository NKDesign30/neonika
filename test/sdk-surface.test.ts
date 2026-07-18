import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as neonSdk from "../src/sdk/index.js";
import {
  NEON_SDK_VERSION,
  createNeonSdkManifest,
  neonSdkSurfaces,
  renderNeonSdkManifest
} from "../src/index.js";

const sdkExports = neonSdk as unknown as Record<string, unknown>;

function resolveNamespace(name: string): Record<string, unknown> {
  const namespace = sdkExports[name];
  assert.ok(
    namespace !== null && typeof namespace === "object",
    `umbrella is missing namespace sdk.${name}`
  );
  return namespace as Record<string, unknown>;
}

// Anchor symbols per namespace. The umbrella bundles fast-moving domain modules
// (channels, tools, plugin-sdk) via `export *`; asserting one stable anchor per
// surface keeps the public import shape pinned without enumerating every symbol.
const surfaceAnchors: Record<string, readonly string[]> = {
  "gateway-client": ["NEON_GATEWAY_PROTOCOL_VERSION", "createNeonGatewayRequestFrame"],
  channel: ["neonChannelManifests", "createNeonDryRunOutboundSender"],
  tool: ["buildNeonToolPlan", "deriveNeonSkillInvocation"],
  plugin: ["parseNeonPluginManifest", "resolveAgentSkillPolicy", "scanNeonSkillSource"]
};

describe("Neonika SDK umbrella surface", () => {
  it("exposes exactly the four namespaced contract surfaces", () => {
    for (const surface of neonSdkSurfaces) {
      resolveNamespace(surface.namespace);
    }
  });

  it("binds each manifest surface to a namespace that exports its anchor symbols", () => {
    for (const surface of neonSdkSurfaces) {
      const anchors = surfaceAnchors[surface.id];
      assert.ok(anchors, `no anchors declared for surface ${surface.id}`);

      const namespace = resolveNamespace(surface.namespace);
      for (const anchor of anchors) {
        assert.ok(
          anchor in namespace,
          `sdk.${surface.namespace} must export ${anchor}`
        );
      }
    }
  });

  it("keeps the manifest version and surface ids stable", () => {
    assert.equal(NEON_SDK_VERSION, "0.1.0");
    assert.deepEqual(
      neonSdkSurfaces.map((surface) => surface.id),
      ["gateway-client", "channel", "tool", "plugin"]
    );

    const manifest = createNeonSdkManifest();
    assert.equal(manifest.version, NEON_SDK_VERSION);
    assert.equal(manifest.surfaces.length, 4);
    for (const surface of manifest.surfaces) {
      // The namespace must be a valid JS identifier (no hyphen) and must resolve
      // to a real namespace object on the umbrella.
      assert.doesNotMatch(surface.namespace, /-/, `namespace ${surface.namespace} is not a valid identifier`);
      resolveNamespace(surface.namespace);
      assert.ok(surface.sourceModules.length > 0);
      assert.ok(surface.referenceImplementation.length > 0);
    }
  });

  it("renders a manifest report naming every surface and its namespace", () => {
    const report = renderNeonSdkManifest();
    assert.match(report, /Neonika SDK v0\.1\.0/);
    for (const surface of neonSdkSurfaces) {
      assert.ok(report.includes(surface.title), `report missing title ${surface.title}`);
      assert.ok(
        report.includes(`sdk.${surface.namespace}`),
        `report missing namespace sdk.${surface.namespace}`
      );
    }
  });

  it("re-exports the SDK manifest from the main index barrel", () => {
    assert.equal(typeof renderNeonSdkManifest, "function");
    assert.equal(typeof createNeonSdkManifest, "function");
    assert.ok(Array.isArray(neonSdkSurfaces));
  });
});
