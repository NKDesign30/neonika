import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyNeonWebFetchHost,
  classifyNeonWebFetchTarget,
  executeNeonWebFetch,
  resolveNeonToolsLiveGate,
  type INeonWebFetchResponse
} from "../src/index.js";

const closedGate = resolveNeonToolsLiveGate({});
const armedGate = resolveNeonToolsLiveGate({ NEON_TOOLS_LIVE_ENABLED: "1" });

test("classifyNeonWebFetchTarget allows public http/https and strips credentials", () => {
  const decision = classifyNeonWebFetchTarget("https://user:pass@example.com/path?q=1");
  assert.equal(decision.allowed, true);
  if (decision.allowed) {
    assert.equal(decision.host, "example.com");
    assert.doesNotMatch(decision.url, /user:pass/);
    assert.match(decision.url, /^https:\/\/example\.com\/path/);
  }

  const publicIp = classifyNeonWebFetchTarget("http://93.184.216.34/");
  assert.equal(publicIp.allowed, true);
});

test("classifyNeonWebFetchTarget rejects non-http(s) schemes and invalid URLs", () => {
  for (const bad of ["ftp://example.com/x", "file:///etc/passwd", "data:text/plain,hi"]) {
    const decision = classifyNeonWebFetchTarget(bad);
    assert.equal(decision.allowed, false, bad);
    if (!decision.allowed) {
      assert.equal(decision.reason, "unsupported-scheme");
    }
  }
  const invalid = classifyNeonWebFetchTarget("not a url");
  assert.equal(invalid.allowed, false);
  if (!invalid.allowed) {
    assert.equal(invalid.reason, "invalid-url");
  }
});

test("classifyNeonWebFetchTarget blocks loopback/private/link-local/CGNAT/unspecified hosts", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://app.localhost/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://0.0.0.0/",
    "http://100.64.0.1/"
  ];
  for (const url of blocked) {
    const decision = classifyNeonWebFetchTarget(url);
    assert.equal(decision.allowed, false, url);
    if (!decision.allowed) {
      assert.equal(decision.reason, "private-host", url);
    }
  }
});

test("classifyNeonWebFetchHost blocks IPv6 loopback/link-local/ULA/unspecified and IPv4-mapped", () => {
  assert.ok(classifyNeonWebFetchHost("::1"));
  assert.ok(classifyNeonWebFetchHost("::"));
  assert.ok(classifyNeonWebFetchHost("fe80::1"));
  assert.ok(classifyNeonWebFetchHost("fc00::1"));
  assert.ok(classifyNeonWebFetchHost("fd12:3456::1"));
  assert.ok(classifyNeonWebFetchHost("::ffff:127.0.0.1"));
  // Public hosts pass (undefined = allowed).
  assert.equal(classifyNeonWebFetchHost("example.com"), undefined);
  assert.equal(classifyNeonWebFetchHost("93.184.216.34"), undefined);
  assert.equal(classifyNeonWebFetchHost("2606:2800:220:1::1"), undefined);
});

test("executeNeonWebFetch is dry-run with no network when the gate is closed", async () => {
  let fetchCalls = 0;
  let lookupCalls = 0;
  const result = await executeNeonWebFetch({
    url: "https://example.com/",
    gate: closedGate,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { status: 200, text: async () => "" };
    },
    lookupImpl: async () => {
      lookupCalls += 1;
      return ["93.184.216.34"];
    }
  });

  assert.equal(result.kind, "dry-run");
  assert.equal(fetchCalls, 0);
  assert.equal(lookupCalls, 0);
});

test("executeNeonWebFetch blocks a private target before any gate/network work", async () => {
  let fetchCalls = 0;
  const result = await executeNeonWebFetch({
    url: "http://169.254.169.254/latest/meta-data/",
    gate: armedGate,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { status: 200, text: async () => "" };
    },
    lookupImpl: async () => ["169.254.169.254"]
  });

  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") {
    assert.equal(result.reason, "private-host");
  }
  assert.equal(fetchCalls, 0);
});

test("executeNeonWebFetch fetches a public target when armed and redacts the bounded result", async () => {
  let fetchedUrl = "";
  const fetchImpl = async (url: string): Promise<INeonWebFetchResponse> => {
    fetchedUrl = url;
    return { status: 200, text: async () => "<html><body>token sk-abcdef0123456789ABCDEF here</body></html>" };
  };
  const result = await executeNeonWebFetch({
    url: "https://example.com/page",
    gate: armedGate,
    fetchImpl,
    lookupImpl: async () => ["93.184.216.34"]
  });

  assert.equal(result.kind, "fetched");
  if (result.kind === "fetched") {
    assert.equal(result.status, 200);
    assert.equal(result.result.redacted, true);
    assert.doesNotMatch(result.result.preview, /sk-abcdef/);
  }
  assert.equal(fetchedUrl, "https://example.com/page");
});

test("executeNeonWebFetch blocks DNS rebinding: public host resolving to a private IP", async () => {
  let fetchCalls = 0;
  const result = await executeNeonWebFetch({
    url: "https://rebind.example/",
    gate: armedGate,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { status: 200, text: async () => "" };
    },
    lookupImpl: async () => ["10.0.0.5"]
  });

  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") {
    assert.equal(result.reason, "resolved-private");
  }
  assert.equal(fetchCalls, 0);
});
