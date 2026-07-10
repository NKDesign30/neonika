import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  planNeonDeliveryDrain,
  renderNeonDeliveryDrainPlanReport,
  resolveNeonDeliveryDrainGate,
  type INeonDeliveryQueueCandidate,
  type INeonDeliveryQueueSnapshot,
  type TNeonDeliveryAckState,
  type TNeonDeliveryRecoveryState
} from "../src/index.js";

const base = Date.now();
const ttlMs = 60 * 60 * 1000; // 1h drain window for the test

function candidate(overrides: {
  readonly id: string;
  readonly ageMs: number;
  readonly recoveryState: TNeonDeliveryRecoveryState;
  readonly ackState?: TNeonDeliveryAckState;
  readonly finalTextPreview?: string;
}): INeonDeliveryQueueCandidate {
  return {
    id: overrides.id,
    runId: `run-${overrides.id}`,
    state: "queued-dry-run",
    reason: "primary-dry-run",
    target: { channel: "discord", accountId: "acc-1", channelId: "chan-1" },
    agentId: "chaty",
    sourceRunStatus: "completed",
    finalTextPreview: overrides.finalTextPreview ?? "ready",
    safety: { outboundSent: false, requiresApproval: true, cutoverStage: "shadow" },
    ackState: overrides.ackState ?? "queued",
    recoveryState: overrides.recoveryState,
    createdAt: new Date(base - overrides.ageMs).toISOString()
  };
}

function snapshot(candidates: readonly INeonDeliveryQueueCandidate[]): INeonDeliveryQueueSnapshot {
  return {
    state: "ready",
    source: { queuePath: "/tmp/q.jsonl", approvalPath: "/tmp/a.jsonl" },
    totals: {
      candidates: candidates.length,
      queuedDryRuns: candidates.filter((entry) => entry.state === "queued-dry-run").length,
      blocked: candidates.filter((entry) => entry.state === "blocked").length,
      approvalRecords: 0,
      ackStateCounts: { queued: 0, working: 0, done: 0 },
      pendingRecovery: candidates.filter((entry) => entry.recoveryState === "pending-drain").length
    },
    candidates,
    approvals: []
  };
}

const closedGate = resolveNeonDeliveryDrainGate({});
const armedGate = resolveNeonDeliveryDrainGate({ NEON_DELIVERY_DRAIN_ENABLED: "1" });

describe("Neon reconnect delivery-drain plan (Z118)", () => {
  it("keeps the drain off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonDeliveryDrainGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonDeliveryDrainGate({ NEON_DELIVERY_DRAIN_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonDeliveryDrainGate({ NEON_DELIVERY_DRAIN_ENABLED: "0" }).enabled, false);
  });

  it("only considers pending-drain candidates", () => {
    const plan = planNeonDeliveryDrain(
      snapshot([
        candidate({ id: "a", ageMs: 1000, recoveryState: "pending-drain" }),
        candidate({ id: "b", ageMs: 1000, recoveryState: "none" })
      ]),
      { gate: armedGate, now: () => new Date(base), ttlMs }
    );

    assert.equal(plan.totals.pendingDrain, 1);
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0]?.candidateId, "a");
  });

  it("classifies eligible, expired (TTL), and already-done (ack) dispositions", () => {
    const plan = planNeonDeliveryDrain(
      snapshot([
        candidate({ id: "fresh", ageMs: 60_000, recoveryState: "pending-drain" }),
        candidate({ id: "old", ageMs: ttlMs + 60_000, recoveryState: "pending-drain" }),
        candidate({ id: "acked", ageMs: 60_000, recoveryState: "pending-drain", ackState: "done" })
      ]),
      { gate: armedGate, now: () => new Date(base), ttlMs }
    );

    const byId = new Map(plan.entries.map((entry) => [entry.candidateId, entry.disposition]));
    assert.equal(byId.get("fresh"), "eligible");
    assert.equal(byId.get("old"), "expired");
    assert.equal(byId.get("acked"), "already-done");
    assert.deepEqual(plan.totals, { pendingDrain: 3, eligible: 1, expired: 1, alreadyDone: 1 });
  });

  it("blocks the drain by default and never claims a send in either state", () => {
    const entries = [candidate({ id: "a", ageMs: 1000, recoveryState: "pending-drain" })];

    const blocked = planNeonDeliveryDrain(snapshot(entries), {
      gate: closedGate,
      now: () => new Date(base),
      ttlMs
    });
    assert.equal(blocked.state, "blocked");
    assert.equal(blocked.reason, "drain-disabled");

    const dryRun = planNeonDeliveryDrain(snapshot(entries), {
      gate: armedGate,
      now: () => new Date(base),
      ttlMs
    });
    assert.equal(dryRun.state, "drained-dry-run");

    // The safety invariants are literal false in BOTH states: even an armed drain
    // re-attempt routes through the separate canary sender gate, never sends here.
    for (const plan of [blocked, dryRun]) {
      assert.equal(plan.safety.outboundSent, false);
      assert.equal(plan.safety.reSent, false);
      assert.equal(plan.safety.requiresCanaryGate, true);
    }
  });

  it("orders the plan oldest-first with a stable tie-break", () => {
    const plan = planNeonDeliveryDrain(
      snapshot([
        candidate({ id: "newest", ageMs: 10_000, recoveryState: "pending-drain" }),
        candidate({ id: "oldest", ageMs: 50_000, recoveryState: "pending-drain" }),
        candidate({ id: "mid", ageMs: 30_000, recoveryState: "pending-drain" })
      ]),
      { gate: armedGate, now: () => new Date(base), ttlMs }
    );

    assert.deepEqual(
      plan.entries.map((entry) => entry.candidateId),
      ["oldest", "mid", "newest"]
    );
  });

  it("keeps message content out of the plan and report", () => {
    const plan = planNeonDeliveryDrain(
      snapshot([
        candidate({
          id: "a",
          ageMs: 1000,
          recoveryState: "pending-drain",
          finalTextPreview: "secret sk-abcdef0123456789ABCDEF body"
        })
      ]),
      { gate: armedGate, now: () => new Date(base), ttlMs }
    );

    assert.doesNotMatch(JSON.stringify(plan), /sk-abcdef/);
    assert.doesNotMatch(renderNeonDeliveryDrainPlanReport(plan), /sk-abcdef/);
    assert.match(renderNeonDeliveryDrainPlanReport(plan), /Outbound sent: false/);
  });
});
