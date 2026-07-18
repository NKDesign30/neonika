import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNeonToolPlan,
  neonToolDescriptorCatalog,
  neonToolProviderCatalog,
  NeonToolPlanContractError,
  type INeonToolDescriptor,
  type TNeonToolFamily
} from "../src/index.js";

const allFamilies: readonly TNeonToolFamily[] = [
  "web-search",
  "web-fetch",
  "browser",
  "media",
  "voice"
];

describe("Neon tool catalog", () => {
  it("covers every target family with at least one descriptor", () => {
    for (const family of allFamilies) {
      const tools = neonToolDescriptorCatalog.filter((tool) => tool.family === family);
      assert.ok(tools.length > 0, `family ${family} has no tool`);
    }
  });

  it("references only known providers from descriptor executors", () => {
    const providerIds = new Set(neonToolProviderCatalog.map((provider) => provider.id));
    for (const descriptor of neonToolDescriptorCatalog) {
      if (descriptor.executor.kind === "provider") {
        assert.ok(
          providerIds.has(descriptor.executor.providerId),
          `unknown provider ${descriptor.executor.providerId} on ${descriptor.name}`
        );
      }
    }
  });

  it("keeps provider secret refs as env-var NAMES, never values", () => {
    for (const provider of neonToolProviderCatalog) {
      for (const ref of provider.envRefs) {
        // Env-var identifiers are upper snake case; a value would not match.
        assert.match(ref, /^[A-Z][A-Z0-9_]*$/, `ref ${ref} does not look like an env name`);
      }
      if (provider.kind === "loopback") {
        assert.equal(provider.envRefs.length, 0);
        assert.ok(provider.transport);
      }
      if (provider.kind === "binary") {
        assert.equal(provider.envRefs.length, 0);
        assert.ok(provider.binary);
      }
    }
  });

  it("hides tools whose availability is unmet and reveals them when satisfied", () => {
    const empty = buildNeonToolPlan({ availability: {} });
    const visibleNames = new Set(empty.visible.map((entry) => entry.descriptor.name));
    // web.fetch.url is always available; web.search.run needs a provider secret.
    assert.ok(visibleNames.has("web.fetch.url"));
    assert.ok(!visibleNames.has("web.search.run"));

    const withBrave = buildNeonToolPlan({
      availability: { presentEnvRefs: new Set(["BRAVE_API_KEY"]) }
    });
    assert.ok(withBrave.visible.some((entry) => entry.descriptor.name === "web.search.run"));

    const hiddenSearch = empty.hidden.find((entry) => entry.descriptor.name === "web.search.run");
    assert.ok(hiddenSearch);
    assert.ok(hiddenSearch.diagnostics.length > 0);
  });

  it("rejects duplicate tool names as a contract violation", () => {
    const duplicate: INeonToolDescriptor = {
      ...neonToolDescriptorCatalog[0]!
    };
    assert.throws(
      () => buildNeonToolPlan({ descriptors: [duplicate, duplicate] }),
      (error: unknown) => {
        assert.ok(error instanceof NeonToolPlanContractError);
        assert.equal(error.code, "duplicate-tool-name");
        return true;
      }
    );
  });
});
