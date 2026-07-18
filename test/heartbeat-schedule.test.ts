import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeNextHeartbeatPhaseDueMs,
  normalizeModulo,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
  seekNextActivePhaseDueMs
} from "../src/index.js";

const intervalMs = 900_000; // 15 min

describe("Neon heartbeat schedule (pure phase math)", () => {
  it("resolveHeartbeatPhaseMs is deterministic across repeated calls", () => {
    const a = resolveHeartbeatPhaseMs({ schedulerSeed: "seed", agentId: "neo", intervalMs });
    const b = resolveHeartbeatPhaseMs({ schedulerSeed: "seed", agentId: "neo", intervalMs });
    assert.equal(a, b);
  });

  it("resolveHeartbeatPhaseMs returns an offset within [0, intervalMs)", () => {
    const phase = resolveHeartbeatPhaseMs({ schedulerSeed: "seed", agentId: "neo", intervalMs });
    assert.ok(phase >= 0 && phase < intervalMs);
  });

  it("spreads different agents across (mostly) different phase slots", () => {
    const seed = "seed";
    const phases = ["a", "b", "c", "d", "e"].map((agentId) =>
      resolveHeartbeatPhaseMs({ schedulerSeed: seed, agentId, intervalMs })
    );
    const unique = new Set(phases);
    assert.ok(unique.size >= 4, `expected good spread, got ${unique.size} unique`);
  });

  it("computeNextHeartbeatPhaseDueMs is always strictly greater than now (no 0-delta)", () => {
    // phase aligns exactly with the cycle position -> delta forced to a full interval
    assert.equal(computeNextHeartbeatPhaseDueMs({ nowMs: 1000, intervalMs: 100, phaseMs: 0 }), 1100);
  });

  it("computeNextHeartbeatPhaseDueMs is phase-aligned", () => {
    const result = computeNextHeartbeatPhaseDueMs({ nowMs: 1050, intervalMs: 100, phaseMs: 30 });
    assert.equal(result % 100, 30);
    assert.ok(result > 1050);
  });

  it("computeNextHeartbeatPhaseDueMs clamps non-finite/zero/negative interval and non-finite now", () => {
    assert.equal(computeNextHeartbeatPhaseDueMs({ nowMs: 0, intervalMs: 0, phaseMs: 0 }), 1);
    assert.equal(computeNextHeartbeatPhaseDueMs({ nowMs: 0, intervalMs: -5, phaseMs: 0 }), 1);
    assert.equal(
      computeNextHeartbeatPhaseDueMs({ nowMs: Number.NaN, intervalMs: 100, phaseMs: 0 }),
      100
    );
  });

  it("resolveNextHeartbeatDueMs is idempotent with a still-future matching prev", () => {
    const prev = { intervalMs: 100, phaseMs: 30, nextDueMs: 1130 };
    assert.equal(resolveNextHeartbeatDueMs({ nowMs: 1000, intervalMs: 100, phaseMs: 30, prev }), 1130);
  });

  it("resolveNextHeartbeatDueMs recomputes when prev is stale or interval/phase differ", () => {
    const stale = { intervalMs: 100, phaseMs: 30, nextDueMs: 900 };
    // recompute: cyclePos=1000%100=0, delta=30 -> 1030
    assert.equal(
      resolveNextHeartbeatDueMs({ nowMs: 1000, intervalMs: 100, phaseMs: 30, prev: stale }),
      1030
    );
    const otherPhase = { intervalMs: 100, phaseMs: 10, nextDueMs: 1130 };
    assert.equal(
      resolveNextHeartbeatDueMs({ nowMs: 1000, intervalMs: 100, phaseMs: 30, prev: otherPhase }),
      1030
    );
  });

  it("seekNextActivePhaseDueMs without isActive returns startMs unchanged", () => {
    assert.equal(seekNextActivePhaseDueMs({ startMs: 1000, intervalMs: 100, phaseMs: 0 }), 1000);
  });

  it("seekNextActivePhaseDueMs steps forward to the first active slot", () => {
    const result = seekNextActivePhaseDueMs({
      startMs: 1000,
      intervalMs: 100,
      phaseMs: 0,
      isActive: (ms) => ms >= 1300
    });
    assert.equal(result, 1300);
  });

  it("seekNextActivePhaseDueMs returns startMs fallback when no active slot is found (bounded)", () => {
    const result = seekNextActivePhaseDueMs({
      startMs: 1000,
      intervalMs: 50, // sub-minute, exercises the iteration cap
      phaseMs: 0,
      isActive: () => false
    });
    assert.equal(result, 1000);
  });

  it("normalizeModulo behaves as euclidean modulo for negatives", () => {
    assert.equal(normalizeModulo(-20, 100), 80);
    assert.equal(normalizeModulo(20, 100), 20);
    assert.equal(normalizeModulo(-100, 100), 0);
  });
});
