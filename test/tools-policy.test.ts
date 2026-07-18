import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  boundNeonToolResult,
  planNeonToolInvocation,
  resolveNeonToolsLiveGate,
  type INeonToolDescriptor
} from "../src/index.js";

const searchTool: INeonToolDescriptor = {
  name: "web.search.run",
  family: "web-search",
  title: "Web Search",
  description: "test",
  sideEffect: "network-write",
  owner: { kind: "core" },
  executor: { kind: "provider", providerId: "brave", capability: "web-search" },
  availability: { kind: "secret-ref", providerId: "brave", envRefs: ["BRAVE_API_KEY"] }
};

describe("Neon tool invocation planning", () => {
  it("blocks an unavailable tool regardless of the gate", () => {
    const plan = planNeonToolInvocation({
      descriptor: searchTool,
      gate: resolveNeonToolsLiveGate({ NEON_TOOLS_LIVE_ENABLED: "1" }),
      availability: { presentEnvRefs: new Set() }
    });
    assert.equal(plan.decision, "blocked-unavailable");
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.executed, false);
    assert.equal(plan.outboundPerformed, false);
  });

  it("defaults to dry-run when available but the gate is closed", () => {
    const plan = planNeonToolInvocation({
      descriptor: searchTool,
      gate: resolveNeonToolsLiveGate({}),
      availability: { presentEnvRefs: new Set(["BRAVE_API_KEY"]) }
    });
    assert.equal(plan.decision, "dry-run");
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.executed, false);
    assert.equal(plan.outboundPerformed, false);
  });

  it("permits live invocation only when available AND the gate is armed, still never executing", () => {
    const plan = planNeonToolInvocation({
      descriptor: searchTool,
      gate: resolveNeonToolsLiveGate({ NEON_TOOLS_LIVE_ENABLED: "ready" }),
      availability: { presentEnvRefs: new Set(["BRAVE_API_KEY"]) }
    });
    assert.equal(plan.decision, "live-allowed");
    assert.equal(plan.mode, "live");
    // Hard shadow-contract assertions: a plan is never an execution.
    assert.equal(plan.executed, false);
    assert.equal(plan.outboundPerformed, false);
  });
});

describe("Neon tool result bounding", () => {
  it("redacts secrets before bounding", () => {
    const result = boundNeonToolResult({
      tool: "web.fetch.url",
      text: "token sk-abcdef0123456789abcdef found in body"
    });
    assert.equal(result.redacted, true);
    assert.doesNotMatch(result.preview, /sk-abcdef0123456789abcdef/);
    assert.match(result.preview, /\[REDACTED_SECRET\]/);
  });

  it("truncates by item count", () => {
    const items = Array.from({ length: 30 }, (_, index) => `item-${index}`);
    const result = boundNeonToolResult({ tool: "web.search.run", items }, { maxItems: 5 });
    assert.equal(result.itemCount, 5);
    assert.equal(result.truncated, true);
  });

  it("truncates by byte length", () => {
    const result = boundNeonToolResult(
      { tool: "web.fetch.url", text: "x".repeat(5000) },
      { maxBytes: 64 }
    );
    assert.equal(result.truncated, true);
    assert.ok(result.byteCount <= 64);
  });

  it("keeps small results intact and untruncated", () => {
    const result = boundNeonToolResult({ tool: "web.fetch.url", text: "hello" });
    assert.equal(result.truncated, false);
    assert.equal(result.preview, "hello");
  });
});
