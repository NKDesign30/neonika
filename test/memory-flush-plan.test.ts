import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNeonMemoryFlushPlan,
  formatNeonMemoryFlushDateStamp,
  planNeonMemoryFlush,
  resolveNeonMemoryFlushGate,
  NEON_MEMORY_FLUSH_DEFAULT_SOFT_THRESHOLD_TOKENS,
  NEON_MEMORY_FLUSH_DEFAULT_FORCE_TRANSCRIPT_BYTES,
  NEON_MEMORY_FLUSH_ENV_VAR
} from "../src/index.js";

const FIXED_NOW = Date.UTC(2026, 5, 3, 12, 0, 0); // 2026-06-03T12:00:00Z

describe("Neon memory flush plan", () => {
  it("formats a UTC date stamp", () => {
    assert.equal(formatNeonMemoryFlushDateStamp(FIXED_NOW), "2026-06-03");
  });

  it("builds a canonical append-only plan for the given day", () => {
    const plan = buildNeonMemoryFlushPlan({ nowMs: FIXED_NOW });

    assert.equal(plan.dateStamp, "2026-06-03");
    assert.equal(plan.relativePath, "memory/2026-06-03.md");
    assert.equal(plan.softThresholdTokens, NEON_MEMORY_FLUSH_DEFAULT_SOFT_THRESHOLD_TOKENS);
    assert.equal(plan.forceFlushTranscriptBytes, NEON_MEMORY_FLUSH_DEFAULT_FORCE_TRANSCRIPT_BYTES);
  });

  it("bakes safety hints into the prompts and resolves the date placeholder", () => {
    const plan = buildNeonMemoryFlushPlan({ nowMs: FIXED_NOW });

    assert.match(plan.prompt, /memory\/2026-06-03\.md/);
    assert.doesNotMatch(plan.prompt, /YYYY-MM-DD/);
    assert.match(plan.prompt, /APPEND new content only/);
    assert.match(plan.prompt, /MEMORY\.md, SOUL\.md, AGENTS\.md, CLAUDE\.md.*read-only/);
    assert.match(plan.systemPrompt, /APPEND new content only/);
    assert.doesNotMatch(plan.systemPrompt, /YYYY-MM-DD/);
  });

  it("honours custom thresholds and clamps invalid input to defaults", () => {
    const custom = buildNeonMemoryFlushPlan({
      nowMs: FIXED_NOW,
      softThresholdTokens: 1000,
      forceFlushTranscriptBytes: 512
    });
    assert.equal(custom.softThresholdTokens, 1000);
    assert.equal(custom.forceFlushTranscriptBytes, 512);

    const clamped = buildNeonMemoryFlushPlan({ nowMs: FIXED_NOW, softThresholdTokens: -5 });
    assert.equal(clamped.softThresholdTokens, NEON_MEMORY_FLUSH_DEFAULT_SOFT_THRESHOLD_TOKENS);
  });

  it("resolves the flush gate off by default and on for truthy env values", () => {
    assert.equal(resolveNeonMemoryFlushGate({}).enabled, false);
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "1" }).enabled, true);
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "true" }).enabled, true);
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "ready" }).enabled, true);
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "yes" }).enabled, true);
    // "on" was a parser divergence (accepted here, rejected by the DB write gate) - unified away.
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "on" }).enabled, false);
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "0" }).enabled, false);
    assert.equal(resolveNeonMemoryFlushGate({ [NEON_MEMORY_FLUSH_ENV_VAR]: "nonsense" }).enabled, false);
  });

  it("plans without writing — wouldWrite tracks the gate, default-off", () => {
    const dry = planNeonMemoryFlush({ nowMs: FIXED_NOW, env: {} });
    assert.equal(dry.wouldWrite, false);
    assert.equal(dry.gate.enabled, false);
    assert.equal(dry.gate.envVar, NEON_MEMORY_FLUSH_ENV_VAR);
    assert.equal(dry.plan.relativePath, "memory/2026-06-03.md");

    const armed = planNeonMemoryFlush({
      nowMs: FIXED_NOW,
      env: { [NEON_MEMORY_FLUSH_ENV_VAR]: "1" }
    });
    assert.equal(armed.wouldWrite, true);
  });
});
