import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonInFlightRunRegistry,
  planNeonRunLifecycleAction,
  renderNeonInFlightRunReport,
  resolveNeonInFlightRunGate,
  type INeonInFlightRunRecord,
  type INeonInFlightRunStart,
  type TNeonRunLifecycleAction
} from "../src/index.js";

const armedGate = resolveNeonInFlightRunGate({ NEON_LIVE_RUN_LIFECYCLE_ENABLED: "1" });
const closedGate = resolveNeonInFlightRunGate({});

function start(runId: string): INeonInFlightRunStart {
  return {
    runId,
    threadId: `thread-${runId}`,
    turnId: `turn-${runId}`,
    sessionKey: `session-${runId}`,
    agentId: "chaty",
    channel: "discord"
  };
}

// Deterministic monotonic clock so startedAt ordering is stable in tests.
function clock(startMs: number): () => Date {
  let tick = 0;
  return () => new Date(startMs + tick++ * 1000);
}

describe("Neon in-flight run lifecycle (DP-4)", () => {
  it("keeps the lifecycle off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonInFlightRunGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonInFlightRunGate({ NEON_LIVE_RUN_LIFECYCLE_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonInFlightRunGate({ NEON_LIVE_RUN_LIFECYCLE_ENABLED: "0" }).enabled, false);
  });

  it("is a no-op with the terminal-only view while the gate is closed", () => {
    const registry = createNeonInFlightRunRegistry({ gate: closedGate, now: clock(1_000) });
    assert.equal(registry.onRunStart(start("a")), null);

    const snapshot = registry.snapshot();
    assert.equal(snapshot.activeRuns, 0);
    assert.equal(snapshot.busy, false);
    assert.equal(snapshot.lastRunActivityAt, null);
    assert.deepEqual(snapshot.running, []);
  });

  it("tracks active runs and busy state while armed", () => {
    const registry = createNeonInFlightRunRegistry({ gate: armedGate, now: clock(1_000) });
    const record = registry.onRunStart(start("a"));
    registry.onRunStart(start("b"));

    assert.ok(record);
    assert.equal(record?.state, "running");

    const snapshot = registry.snapshot();
    assert.equal(snapshot.activeRuns, 2);
    assert.equal(snapshot.busy, true);
    assert.ok(snapshot.lastRunActivityAt);
  });

  it("caps tracked active runs with FIFO eviction while preserving the newest run", () => {
    const registry = createNeonInFlightRunRegistry({ gate: armedGate, now: clock(1_000), maxEntries: 3 });
    registry.onRunStart(start("a"));
    registry.onRunStart(start("b"));
    registry.onRunStart(start("c"));
    registry.onRunStart(start("d"));
    registry.onRunStart(start("e"));

    const snapshot = registry.snapshot();

    assert.equal(snapshot.activeRuns, 3);
    assert.deepEqual(
      snapshot.running.map((record) => record.runId),
      ["c", "d", "e"]
    );
  });

  it("falls back to the default cap for invalid maxEntries values", () => {
    const registry = createNeonInFlightRunRegistry({ gate: armedGate, now: clock(1_000), maxEntries: 0 });
    registry.onRunStart(start("a"));
    registry.onRunStart(start("b"));

    assert.equal(registry.snapshot().activeRuns, 2);
  });

  it("decrements active runs on end and goes idle at zero", () => {
    const registry = createNeonInFlightRunRegistry({ gate: armedGate, now: clock(1_000) });
    registry.onRunStart(start("a"));
    registry.onRunStart(start("b"));
    registry.onRunEnd("a");

    const afterOne = registry.snapshot();
    assert.equal(afterOne.activeRuns, 1);
    assert.equal(afterOne.busy, true);

    registry.onRunEnd("b");
    const idle = registry.snapshot();
    assert.equal(idle.activeRuns, 0);
    assert.equal(idle.busy, false);
  });

  it("marks a run interrupting and keeps deterministic order", () => {
    const registry = createNeonInFlightRunRegistry({ gate: armedGate, now: clock(1_000) });
    registry.onRunStart(start("a"));
    registry.onRunStart(start("b"));
    registry.markInterrupting("a");

    const snapshot = registry.snapshot();
    assert.deepEqual(
      snapshot.running.map((record) => `${record.runId}:${record.state}`),
      ["a:interrupting", "b:running"]
    );
  });

  it("routes stop/abort to interrupt-ready with the turn id and others to plan-only", () => {
    const record: INeonInFlightRunRecord = {
      runId: "a",
      threadId: "thread-a",
      turnId: "turn-a",
      sessionKey: "s",
      agentId: "chaty",
      channel: "discord",
      state: "running",
      startedAt: "2026-06-02T10:00:00.000Z",
      lastActivityAt: "2026-06-02T10:00:00.000Z"
    };

    for (const action of ["stop", "abort"] as const) {
      const decision = planNeonRunLifecycleAction({ action, runId: "a", gate: armedGate, record });
      assert.equal(decision.state, "interrupt-ready");
      assert.equal(decision.interruptThreadId, "thread-a");
      assert.equal(decision.interruptTurnId, "turn-a");
      assert.equal(decision.safety.executed, false);
      assert.equal(decision.safety.outboundSent, false);
    }

    for (const action of ["resume", "branch", "label", "delete"] as const) {
      const decision = planNeonRunLifecycleAction({ action, runId: "a", gate: armedGate, record });
      assert.equal(decision.state, "plan-only");
      assert.equal(decision.interruptThreadId, undefined);
      assert.equal(decision.interruptTurnId, undefined);
    }
  });

  it("blocks every action when the gate is closed or the run is unknown", () => {
    const actions: readonly TNeonRunLifecycleAction[] = ["stop", "abort", "resume", "delete"];
    for (const action of actions) {
      const closed = planNeonRunLifecycleAction({ action, runId: "a", gate: closedGate });
      assert.equal(closed.state, "blocked");
      assert.equal(closed.reason, "lifecycle-gate-disabled");

      const unknown = planNeonRunLifecycleAction({ action, runId: "a", gate: armedGate });
      assert.equal(unknown.state, "blocked");
      assert.equal(unknown.reason, "run-not-in-flight");
    }
  });

  it("renders a readable in-flight report", () => {
    const registry = createNeonInFlightRunRegistry({ gate: armedGate, now: clock(1_000) });
    registry.onRunStart(start("a"));
    const report = renderNeonInFlightRunReport(registry.snapshot());
    assert.match(report, /Active runs: 1/);
    assert.match(report, /Busy: true/);
    assert.match(report, /run=a thread=thread-a turn=turn-a/);
  });
});
