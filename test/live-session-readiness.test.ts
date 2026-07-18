import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonLiveSessionReadinessSnapshot,
  renderNeonLiveSessionReadinessReport
} from "../src/index.js";
import type { INeonInFlightRunSnapshot } from "../src/index.js";

describe("Neon live-session runtime readiness", () => {
  it("reports all seven capabilities and never claims live runtime is ready", () => {
    const snapshot = createNeonLiveSessionReadinessSnapshot({ env: {} });
    assert.equal(snapshot.capabilities.length, 7);
    assert.equal(snapshot.liveRuntimeReady, false);
    assert.equal(snapshot.envGateEnabled, false);
    assert.equal(snapshot.runtime.activeRuns, 0);
    assert.ok(snapshot.capabilities.every((cap) => cap.executed === false));
  });

  it("classifies stop/abort as interrupt-ready and resume/branch/label/delete as plan-only", () => {
    const snapshot = createNeonLiveSessionReadinessSnapshot({ env: {} });
    const byCap = new Map(snapshot.capabilities.map((cap) => [cap.capability, cap]));

    for (const action of ["stop", "abort"] as const) {
      assert.equal(byCap.get(action)?.state, "interrupt-ready", `${action} interrupt-ready`);
      assert.match(byCap.get(action)?.missingRuntimePiece ?? "", /in-flight run/);
    }
    for (const action of ["resume", "branch", "label", "delete"] as const) {
      assert.equal(byCap.get(action)?.state, "plan-only", `${action} plan-only`);
      assert.match(byCap.get(action)?.reason ?? "", new RegExp(`${action}-needs-session-runtime`));
      assert.match(byCap.get(action)?.missingRuntimePiece ?? "", /session runtime/);
    }
  });

  it("marks checkpoint as not-modeled with its own missing piece", () => {
    const snapshot = createNeonLiveSessionReadinessSnapshot({ env: {} });
    const checkpoint = snapshot.capabilities.find((cap) => cap.capability === "checkpoint");
    assert.ok(checkpoint);
    assert.equal(checkpoint.state, "not-modeled");
    assert.match(checkpoint.missingRuntimePiece, /Checkpoint\/compaction events/);
  });

  it("dedupes the missing runtime pieces and totals the states", () => {
    const snapshot = createNeonLiveSessionReadinessSnapshot({ env: {} });
    assert.equal(snapshot.missingRuntimePieces.length, 3);
    assert.equal(snapshot.totals.total, 7);
    assert.equal(snapshot.totals.interruptReady, 2);
    assert.equal(snapshot.totals.planOnly, 4);
    assert.equal(snapshot.totals.notModeled, 1);
    assert.equal(snapshot.totals.blocked, 0);
  });

  it("reflects the live env gate without changing the architectural classification", () => {
    const gate = createNeonLiveSessionReadinessSnapshot({
      env: { NEON_LIVE_RUN_LIFECYCLE_ENABLED: "ready" }
    });
    assert.equal(gate.envGateEnabled, true);
    // Architectural classification is independent of the env flag (probe is on).
    assert.equal(gate.liveRuntimeReady, false);
    assert.equal(gate.capabilities.find((c) => c.capability === "stop")?.state, "interrupt-ready");
  });

  it("reports a real injected active runtime snapshot without leaking turn ids", () => {
    const runtimeSnapshot: INeonInFlightRunSnapshot = {
      activeRuns: 1,
      busy: true,
      lastRunActivityAt: "2026-06-04T10:00:01.000Z",
      running: [
        {
          runId: "run-live",
          threadId: "thread-secret-shape",
          turnId: "turn-secret-shape",
          sessionKey: "session-secret-shape",
          agentId: "chaty",
          channel: "discord",
          state: "running",
          startedAt: "2026-06-04T10:00:00.000Z",
          lastActivityAt: "2026-06-04T10:00:01.000Z"
        }
      ]
    };
    const snapshot = createNeonLiveSessionReadinessSnapshot({
      env: { NEON_LIVE_RUN_LIFECYCLE_ENABLED: "ready" },
      runtimeSnapshot
    });

    assert.equal(snapshot.liveRuntimeReady, true);
    assert.equal(snapshot.runtime.activeRuns, 1);
    assert.equal(snapshot.runtime.busy, true);
    assert.deepEqual(snapshot.runtime.runningRunIds, ["run-live"]);
    assert.equal(snapshot.capabilities.find((c) => c.capability === "stop")?.missingRuntimePiece, "none");
    assert.doesNotMatch(JSON.stringify(snapshot), /thread-secret-shape|turn-secret-shape|session-secret-shape/);
  });

  it("renders a readiness report", () => {
    const report = renderNeonLiveSessionReadinessReport(
      createNeonLiveSessionReadinessSnapshot({ env: {} })
    );
    assert.match(report, /Neonika Live-Session Runtime Readiness/);
    assert.match(report, /live-runtime-ready=false/);
    assert.match(report, /active-runs=0/);
    assert.match(report, /Missing runtime pieces:/);
  });
});
