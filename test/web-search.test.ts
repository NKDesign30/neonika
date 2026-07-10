import assert from "node:assert/strict";
import { test } from "node:test";

import {
  executeNeonWebSearch,
  extractNeonWebSearchHits,
  renderNeonWebSearchResult,
  type TNeonWebSearchImpl
} from "../src/index.js";

const CLOSED_GATE = {
  enabled: false,
  reason: "tools-live-disabled",
  envKey: "NEON_TOOLS_LIVE_ENABLED"
} as const;
const OPEN_GATE = {
  enabled: true,
  reason: "tools-live-enabled",
  envKey: "NEON_TOOLS_LIVE_ENABLED"
} as const;
const TAVILY_REFS: ReadonlySet<string> = new Set(["TAVILY_API_KEY"]);

test("extractNeonWebSearchHits parses valid results and tolerates garbage", () => {
  const hits = extractNeonWebSearchHits({
    results: [
      { title: "A", url: "https://a.example", content: "alpha" },
      { title: 123, url: null },
      "not-an-object"
    ]
  });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { title: "A", url: "https://a.example", snippet: "alpha" });
  assert.deepEqual(hits[1], { title: "", url: "", snippet: "" });
  assert.deepEqual(extractNeonWebSearchHits(null), []);
  assert.deepEqual(extractNeonWebSearchHits({ results: "nope" }), []);
});

test("executeNeonWebSearch blocks an empty query before any provider work", async () => {
  let called = 0;
  const impl: TNeonWebSearchImpl = async () => {
    called += 1;
    return [];
  };
  const result = await executeNeonWebSearch({
    query: "   ",
    gate: OPEN_GATE,
    presentEnvRefs: TAVILY_REFS,
    providerKey: "tvly-fake",
    searchImpl: impl
  });
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") {
    assert.equal(result.reason, "empty-query");
  }
  assert.equal(called, 0);
});

test("executeNeonWebSearch reports no-provider when no key ref is present", async () => {
  const result = await executeNeonWebSearch({
    query: "neon",
    gate: OPEN_GATE,
    presentEnvRefs: new Set<string>(),
    providerKey: "tvly-fake"
  });
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") {
    assert.equal(result.reason, "no-provider");
  }
});

test("executeNeonWebSearch stays dry-run with NO provider call when the gate is closed", async () => {
  let called = 0;
  const impl: TNeonWebSearchImpl = async () => {
    called += 1;
    return [{ title: "x", url: "https://x.example", snippet: "z" }];
  };
  const result = await executeNeonWebSearch({
    query: "neon",
    gate: CLOSED_GATE,
    presentEnvRefs: TAVILY_REFS,
    providerKey: "tvly-fake",
    searchImpl: impl
  });
  assert.equal(result.kind, "dry-run");
  if (result.kind === "dry-run") {
    assert.equal(result.provider, "tavily");
  }
  assert.equal(called, 0, "gate closed must never call the provider");
});

test("executeNeonWebSearch blocks an armed search when no key value is supplied", async () => {
  let called = 0;
  const impl: TNeonWebSearchImpl = async () => {
    called += 1;
    return [];
  };
  const result = await executeNeonWebSearch({
    query: "neon",
    gate: OPEN_GATE,
    presentEnvRefs: TAVILY_REFS,
    searchImpl: impl
  });
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") {
    assert.equal(result.reason, "no-key");
  }
  assert.equal(called, 0);
});

test("executeNeonWebSearch runs the injected provider when armed + keyed", async () => {
  let seenQuery = "";
  const impl: TNeonWebSearchImpl = async (request) => {
    seenQuery = request.query;
    assert.equal(request.provider, "tavily");
    assert.equal(request.apiKey, "tvly-fake");
    return [
      { title: "Neon Core", url: "https://example.com/neon", snippet: "shadow agent os" },
      { title: "Second", url: "https://example.com/2", snippet: "more" }
    ];
  };
  const result = await executeNeonWebSearch({
    query: "neon core",
    gate: OPEN_GATE,
    presentEnvRefs: TAVILY_REFS,
    providerKey: "tvly-fake",
    searchImpl: impl,
    maxResults: 3
  });
  assert.equal(result.kind, "searched");
  if (result.kind === "searched") {
    assert.equal(result.hitCount, 2);
    assert.equal(result.provider, "tavily");
    assert.equal(result.result.redacted, true);
    assert.match(result.result.preview, /Neon Core/);
  }
  assert.equal(seenQuery, "neon core");
});

test("executeNeonWebSearch result is leak-safe: redacts secret-shaped provider content", async () => {
  const impl: TNeonWebSearchImpl = async () => [
    { title: "leak", url: "https://example.com", snippet: "token sk-livedeadbeef0123456789 here" }
  ];
  const result = await executeNeonWebSearch({
    query: "x",
    gate: OPEN_GATE,
    presentEnvRefs: TAVILY_REFS,
    providerKey: "tvly-fake",
    searchImpl: impl
  });
  assert.equal(result.kind, "searched");
  if (result.kind === "searched") {
    assert.doesNotMatch(result.result.preview, /sk-livedeadbeef0123456789/);
    assert.match(result.result.preview, /\[REDACTED_SECRET\]/);
  }
});

test("renderNeonWebSearchResult renders each kind without throwing", () => {
  assert.match(
    renderNeonWebSearchResult({ kind: "blocked", reason: "no-provider", detail: "none" }),
    /BLOCKED \(no-provider\)/
  );
  assert.match(
    renderNeonWebSearchResult({
      kind: "dry-run",
      provider: "tavily",
      query: "q",
      gateEnvKey: "NEON_TOOLS_LIVE_ENABLED"
    }),
    /dry-run/
  );
});
