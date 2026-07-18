import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectPresentToolSecretRefs,
  createNeonToolInventorySnapshot,
  renderNeonToolInventoryReport
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");

describe("Neon tool inventory snapshot", () => {
  it("reports the closed gate and dry-run posture by default", () => {
    const snapshot = createNeonToolInventorySnapshot({ now: () => fixedNow, env: {} });
    assert.equal(snapshot.title, "Neon Tools");
    assert.equal(snapshot.gate.enabled, false);
    assert.ok(snapshot.tools.length > 0);
    // No tool may be in live mode while the gate is closed.
    assert.equal(snapshot.tools.filter((tool) => tool.mode === "live").length, 0);
  });

  it("derives provider readiness from env-ref presence without leaking the value", () => {
    const secretValue = "tvly-supersecretvalue-0123456789";
    const snapshot = createNeonToolInventorySnapshot({
      now: () => fixedNow,
      env: { TAVILY_API_KEY: secretValue }
    });

    const tavily = snapshot.providers.find((provider) => provider.id === "tavily");
    assert.ok(tavily);
    assert.equal(tavily.readiness, "ready");
    assert.equal(tavily.refsPresent, 1);

    const brave = snapshot.providers.find((provider) => provider.id === "brave");
    assert.equal(brave?.readiness, "missing-secret");

    // Hard leak check: the resolved secret value never appears in the snapshot.
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secretValue));
  });

  it("flips available tools to live-allowed only when the gate is armed", () => {
    const snapshot = createNeonToolInventorySnapshot({
      now: () => fixedNow,
      env: { NEON_TOOLS_LIVE_ENABLED: "1", BRAVE_API_KEY: "bsa-x", FIRECRAWL_API_KEY: "fc-x" }
    });
    assert.equal(snapshot.gate.enabled, true);
    const search = snapshot.tools.find((tool) => tool.name === "web.search.run");
    assert.equal(search?.decision, "live-allowed");
    assert.equal(search?.mode, "live");
    // An unavailable local tool stays blocked even with the gate armed.
    const transcode = snapshot.tools.find((tool) => tool.name === "media.transcode");
    assert.equal(transcode?.decision, "blocked-unavailable");
  });

  it("marks local providers available only when binaries/transports are verified", () => {
    const snapshot = createNeonToolInventorySnapshot({
      now: () => fixedNow,
      env: {},
      availableBinaries: new Set(["ffmpeg"]),
      availableTransports: new Set(["chrome-cdp"])
    });
    assert.equal(snapshot.providers.find((provider) => provider.id === "ffmpeg")?.readiness, "ready");
    assert.equal(
      snapshot.providers.find((provider) => provider.id === "chrome-cdp")?.readiness,
      "ready"
    );
    assert.ok(snapshot.tools.find((tool) => tool.name === "browser.tabs")?.available);
  });

  it("renders a leak-safe operator report", () => {
    const snapshot = createNeonToolInventorySnapshot({
      now: () => fixedNow,
      env: { TAVILY_API_KEY: "tvly-leakcheck-value" }
    });
    const report = renderNeonToolInventoryReport(snapshot);
    assert.match(report, /Neon Tools/);
    assert.match(report, /Live gate: closed/);
    assert.match(report, /web-search/);
    assert.doesNotMatch(report, /tvly-leakcheck-value/);
  });
});

describe("collectPresentToolSecretRefs", () => {
  it("returns only names of non-empty refs", () => {
    const present = collectPresentToolSecretRefs({
      TAVILY_API_KEY: "set",
      BRAVE_API_KEY: "   ",
      FIRECRAWL_API_KEY: ""
    });
    assert.ok(present.has("TAVILY_API_KEY"));
    assert.ok(!present.has("BRAVE_API_KEY"));
    assert.ok(!present.has("FIRECRAWL_API_KEY"));
  });
});
