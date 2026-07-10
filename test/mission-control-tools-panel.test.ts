import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonToolInventorySnapshot,
  renderNeonMissionControlToolsPanel
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");

describe("Mission Control tools panel", () => {
  it("renders the gate posture, families and providers leak-safe", () => {
    const snapshot = createNeonToolInventorySnapshot({
      now: () => fixedNow,
      env: { TAVILY_API_KEY: "tvly-panel-secret-value" }
    });
    const html = renderNeonMissionControlToolsPanel(snapshot);

    assert.match(html, /id="toolsPanel"/);
    assert.match(html, /gate closed/);
    assert.match(html, /web-search/);
    assert.match(html, /tavily/);
    // The resolved secret value must never reach the rendered HTML.
    assert.doesNotMatch(html, /tvly-panel-secret-value/);
  });

  it("reflects an armed gate in the panel tag", () => {
    const snapshot = createNeonToolInventorySnapshot({
      now: () => fixedNow,
      env: { NEON_TOOLS_LIVE_ENABLED: "1" }
    });
    const html = renderNeonMissionControlToolsPanel(snapshot);
    assert.match(html, /gate ARMED/);
  });

  it("escapes dynamic text to avoid HTML injection", () => {
    const snapshot = createNeonToolInventorySnapshot({ now: () => fixedNow, env: {} });
    const html = renderNeonMissionControlToolsPanel(snapshot);
    // No unescaped angle brackets from provider/family identifiers.
    assert.doesNotMatch(html, /<script/i);
  });
});
