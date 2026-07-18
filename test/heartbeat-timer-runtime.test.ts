import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateNeonHeartbeatTick,
  renderNeonHeartbeatTickReport,
  resolveNeonHeartbeatTimerGate,
  type INeonHeartbeatAgentState
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");
const nowMs = fixedNow.getTime();
const schedulerSeed = "neonika";
const armedGate = resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "1" });
const offGate = resolveNeonHeartbeatTimerGate({});

function neo(overrides: Partial<INeonHeartbeatAgentState> = {}): INeonHeartbeatAgentState {
  return { agentId: "neo", intervalMs: 900_000, ...overrides };
}

describe("Neon heartbeat timer runtime (gated)", () => {
  it("keeps the gate off by default and arms only on a ready flag", () => {
    assert.equal(resolveNeonHeartbeatTimerGate({}).enabled, false);
    assert.equal(resolveNeonHeartbeatTimerGate({}).reason, "timer-disabled");
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(
        resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: value }).enabled,
        true,
        `value ${value} should arm`
      );
    }
    assert.equal(resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "0" }).enabled, false);
  });

  it("evaluates nothing while the gate is closed", () => {
    const result = evaluateNeonHeartbeatTick({
      gate: offGate,
      schedulerSeed,
      agents: [neo()],
      now: () => fixedNow,
      alreadyEmitted: { neo: "seed-window" }
    });
    assert.equal(result.armed, false);
    assert.equal(result.emissions.length, 0);
    assert.equal(result.emitted.length, 0);
    assert.deepEqual(result.nextEmitted, { neo: "seed-window" });
    assert.equal(result.safety.executed, false);
    assert.equal(result.safety.outboundSent, false);
    assert.equal(result.diagnostics.length, 2);
  });

  it("emits a phase-aligned wake intent for a due agent", () => {
    const result = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      now: () => fixedNow
    });
    assert.equal(result.armed, true);
    assert.deepEqual(result.emitted, ["neo"]);
    assert.equal(result.emissions.length, 1);
    const emission = result.emissions[0];
    assert.ok(emission);
    assert.equal(emission.agentId, "neo");
    assert.equal(emission.source, "interval");
    assert.equal(emission.intent, "scheduled");
    assert.ok(emission.dueMs <= nowMs, "the reached window is <= now");
    assert.equal(result.nextEmitted["neo"], emission.windowKey);
  });

  it("defers an agent inside the min-spacing cooldown", () => {
    const result = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo({ lastRunStartedAtMs: nowMs - 5000 })],
      now: () => fixedNow
    });
    assert.equal(result.emitted.length, 0);
    assert.deepEqual(result.deferred, [{ agentId: "neo", reason: "min-spacing" }]);
  });

  it("skips an agent outside its active-hours window", () => {
    const result = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo({ activeHours: { start: "22:00", end: "23:00" } })],
      now: () => fixedNow
    });
    assert.equal(result.emitted.length, 0);
    assert.deepEqual(result.outsideActiveHours, ["neo"]);
  });

  it("dedups an agent whose window was already emitted", () => {
    const first = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      now: () => fixedNow
    });
    const second = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      now: () => fixedNow,
      alreadyEmitted: first.nextEmitted
    });
    assert.equal(second.emitted.length, 0);
    assert.deepEqual(second.deduped, ["neo"]);
  });

  it("emits and dedups due commitment wake intents with a separate cursor key", () => {
    const scheduled = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      now: () => fixedNow
    });
    const first = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      commitmentWakes: [{ agentId: "neo", commitmentId: "c1", dueMs: nowMs - 60_000 }],
      now: () => fixedNow,
      alreadyEmitted: scheduled.nextEmitted
    });

    assert.deepEqual(first.emitted, ["commitment:neo:c1"]);
    assert.equal(first.emissions.length, 1);
    assert.equal(first.emissions[0]?.source, "commitment");
    assert.deepEqual(first.emissions[0]?.commitmentIds, ["c1"]);
    assert.equal(first.nextEmitted["commitment:neo:c1"], new Date(nowMs - 60_000).toISOString());

    const second = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      commitmentWakes: [{ agentId: "neo", commitmentId: "c1", dueMs: nowMs - 60_000 }],
      now: () => fixedNow,
      alreadyEmitted: first.nextEmitted
    });
    assert.equal(second.emissions.length, 0);
    assert.deepEqual(second.deduped, ["neo", "commitment:neo:c1"]);
  });

  it("applies cooldown policy to commitment wake intents", () => {
    const result = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo({ lastRunStartedAtMs: nowMs - 5000 })],
      commitmentWakes: [{ agentId: "neo", commitmentId: "c1", dueMs: nowMs - 60_000 }],
      now: () => fixedNow
    });

    assert.equal(result.emissions.length, 0);
    assert.deepEqual(result.deferred, [
      { agentId: "neo", reason: "min-spacing" },
      { agentId: "neo", reason: "min-spacing" }
    ]);
  });

  it("renders a leak-safe report with the safety line and env key", () => {
    const result = evaluateNeonHeartbeatTick({
      gate: armedGate,
      schedulerSeed,
      agents: [neo()],
      now: () => fixedNow
    });
    const report = renderNeonHeartbeatTickReport(result);
    assert.match(report, /Safety: executed=false outboundSent=false/u);
    assert.match(report, /NEON_HEARTBEAT_TIMER_ENABLED/u);
    assert.doesNotMatch(JSON.stringify(result), /secret/iu);
  });
});
