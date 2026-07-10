import assert from "node:assert/strict";
import { test } from "node:test";

import {
  resolveNeonWebSearchProviders,
  renderNeonWebSearchResolution
} from "../src/index.js";

test("resolveNeonWebSearchProviders picks the first available provider by catalog priority", () => {
  const resolution = resolveNeonWebSearchProviders(
    new Set(["BRAVE_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY"])
  );
  assert.equal(resolution.chosen, "brave");
  assert.deepEqual(resolution.fallbackChain, ["brave", "tavily", "firecrawl"]);
  assert.equal(resolution.unavailable.length, 0);
});

test("resolveNeonWebSearchProviders falls through to the only configured provider", () => {
  const resolution = resolveNeonWebSearchProviders(new Set(["TAVILY_API_KEY"]));
  assert.equal(resolution.chosen, "tavily");
  assert.deepEqual(resolution.fallbackChain, ["tavily"]);
  const unavailableIds = resolution.unavailable.map((provider) => provider.id).sort();
  assert.deepEqual(unavailableIds, ["brave", "firecrawl"]);
  const brave = resolution.unavailable.find((provider) => provider.id === "brave");
  assert.deepEqual(brave?.missingEnvRefs, ["BRAVE_API_KEY"]);
});

test("resolveNeonWebSearchProviders reports none when no key is present", () => {
  const resolution = resolveNeonWebSearchProviders(new Set<string>());
  assert.equal(resolution.chosen, undefined);
  assert.deepEqual(resolution.fallbackChain, []);
  assert.equal(resolution.unavailable.length, 3);
  assert.match(resolution.reason, /No web-search provider configured/);
});

test("renderNeonWebSearchResolution is leak-safe and names the gate", () => {
  const report = renderNeonWebSearchResolution(resolveNeonWebSearchProviders(new Set(["TAVILY_API_KEY"])));
  assert.match(report, /tavily/);
  assert.match(report, /BRAVE_API_KEY/); // missing-ref NAME is fine; only values must never appear
  assert.match(report, /NEON_TOOLS_LIVE_ENABLED/);
});
