import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateNeonToolAvailability,
  resolveNeonToolsLiveGate,
  type TNeonToolAvailabilityExpression
} from "../src/index.js";

describe("Neon tool availability", () => {
  it("treats an always signal as available", () => {
    assert.deepEqual(evaluateNeonToolAvailability({ kind: "always" }, {}), []);
  });

  it("checks secret-ref presence by name only (never value)", () => {
    const expression: TNeonToolAvailabilityExpression = {
      kind: "secret-ref",
      providerId: "tavily",
      envRefs: ["TAVILY_API_KEY"]
    };

    assert.deepEqual(
      evaluateNeonToolAvailability(expression, { presentEnvRefs: new Set(["TAVILY_API_KEY"]) }),
      []
    );

    const missing = evaluateNeonToolAvailability(expression, { presentEnvRefs: new Set() });
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.reason, "secret-ref-missing");
    assert.equal(missing[0]?.providerId, "tavily");
  });

  it("satisfies anyOf when at least one branch is clean", () => {
    const expression: TNeonToolAvailabilityExpression = {
      anyOf: [
        { kind: "secret-ref", providerId: "brave", envRefs: ["BRAVE_API_KEY"] },
        { kind: "secret-ref", providerId: "tavily", envRefs: ["TAVILY_API_KEY"] }
      ]
    };

    assert.deepEqual(
      evaluateNeonToolAvailability(expression, { presentEnvRefs: new Set(["TAVILY_API_KEY"]) }),
      []
    );

    const none = evaluateNeonToolAvailability(expression, { presentEnvRefs: new Set() });
    assert.equal(none.length, 2);
  });

  it("requires every branch of allOf and flags empty groups", () => {
    const expression: TNeonToolAvailabilityExpression = {
      allOf: [
        { kind: "binary", binary: "ffmpeg" },
        { kind: "secret-ref", providerId: "elevenlabs", envRefs: ["ELEVENLABS_API_KEY"] }
      ]
    };

    assert.deepEqual(
      evaluateNeonToolAvailability(expression, {
        availableBinaries: new Set(["ffmpeg"]),
        presentEnvRefs: new Set(["ELEVENLABS_API_KEY"])
      }),
      []
    );

    const partial = evaluateNeonToolAvailability(expression, {
      availableBinaries: new Set(["ffmpeg"])
    });
    assert.equal(partial.length, 1);
    assert.equal(partial[0]?.reason, "secret-ref-missing");

    assert.equal(evaluateNeonToolAvailability({ allOf: [] }, {})[0]?.reason, "empty-group");
    assert.equal(evaluateNeonToolAvailability({ anyOf: [] }, {})[0]?.reason, "empty-group");
  });
});

describe("Neon tools live gate", () => {
  it("stays closed by default and arms only on ready-like flags", () => {
    const closed = resolveNeonToolsLiveGate({});
    assert.equal(closed.enabled, false);
    assert.equal(closed.reason, "tools-live-disabled");
    assert.equal(closed.envKey, "NEON_TOOLS_LIVE_ENABLED");

    for (const value of ["1", "ready", "true", "yes", "YES", "Ready"]) {
      assert.equal(resolveNeonToolsLiveGate({ NEON_TOOLS_LIVE_ENABLED: value }).enabled, true);
    }

    for (const value of ["0", "", "off", "no"]) {
      assert.equal(resolveNeonToolsLiveGate({ NEON_TOOLS_LIVE_ENABLED: value }).enabled, false);
    }
  });
});
