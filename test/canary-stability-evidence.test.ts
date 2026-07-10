import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonCanaryStabilityReport,
  summarizeNeonCanaryStability,
  type INeonDeliveryApprovalRecord,
  type INeonDeliveryQueueCandidate
} from "../src/index.js";

function candidate(
  overrides: Partial<INeonDeliveryQueueCandidate> & { readonly id: string; readonly createdAt: string }
): INeonDeliveryQueueCandidate {
  return {
    runId: `run-${overrides.id}`,
    state: "queued-dry-run",
    reason: "primary-dry-run",
    target: { channel: "discord", accountId: "acct-1", channelId: "channel-123" },
    agentId: "main",
    sourceRunStatus: "completed",
    finalTextPreview: "leak-safe-preview",
    safety: { outboundSent: false, requiresApproval: true, cutoverStage: "shadow" },
    ackState: "queued",
    recoveryState: "none",
    ...overrides
  };
}

function approval(
  candidateId: string,
  decision: INeonDeliveryApprovalRecord["decision"]
): INeonDeliveryApprovalRecord {
  return {
    id: `approval-${candidateId}-${decision}`,
    candidateId,
    runId: `run-${candidateId}`,
    decision,
    operatorId: "operator-1",
    safety: { outboundSent: false, requiresCanaryGate: true, cutoverStage: "shadow" },
    createdAt: "2026-06-02T12:00:00.000Z"
  };
}

describe("Neon canary stability evidence", () => {
  it("returns an explicit empty-state with no candidates and primary blocked", () => {
    const snapshot = summarizeNeonCanaryStability([], []);
    assert.equal(snapshot.verdict, "no-evidence");
    assert.equal(snapshot.totals.total, 0);
    assert.equal(snapshot.primaryReadiness.ready, false);
    assert.equal(snapshot.primaryReadiness.reason, "primary-blocked-needs-operator");
    assert.match(renderNeonCanaryStabilityReport(snapshot), /empty evidence/);
  });

  it("reports dry-run-stable for clean candidates and tracks approval + ack", () => {
    const snapshot = summarizeNeonCanaryStability(
      [
        candidate({ id: "a", createdAt: "2026-06-02T10:00:00.000Z", ackState: "done" }),
        candidate({ id: "b", createdAt: "2026-06-02T11:00:00.000Z" })
      ],
      [approval("a", "approve-canary")]
    );
    assert.equal(snapshot.verdict, "dry-run-stable");
    assert.equal(snapshot.totals.total, 2);
    assert.equal(snapshot.totals.approved, 1);
    assert.equal(snapshot.totals.ackedDone, 1);
    assert.equal(snapshot.totals.suppressed, 2);
    const a = snapshot.records.find((r) => r.candidateId === "a");
    assert.ok(a && a.disposition === "acked-done" && a.approved);
    assert.ok(snapshot.records.every((r) => r.outboundSent === false));
  });

  it("reports unstable when any candidate is pending recovery", () => {
    const snapshot = summarizeNeonCanaryStability(
      [
        candidate({ id: "a", createdAt: "2026-06-02T10:00:00.000Z" }),
        candidate({ id: "b", createdAt: "2026-06-02T11:00:00.000Z", recoveryState: "pending-drain" })
      ],
      []
    );
    assert.equal(snapshot.verdict, "unstable");
    assert.equal(snapshot.totals.pendingRecovery, 1);
    const b = snapshot.records.find((r) => r.candidateId === "b");
    assert.ok(b && b.disposition === "pending-recovery");
  });

  it("marks a rejected candidate unless a later approval supersedes it", () => {
    const rejected = summarizeNeonCanaryStability(
      [candidate({ id: "a", createdAt: "2026-06-02T10:00:00.000Z" })],
      [approval("a", "reject")]
    );
    assert.equal(rejected.records[0]?.disposition, "rejected");

    const superseded = summarizeNeonCanaryStability(
      [candidate({ id: "a", createdAt: "2026-06-02T10:00:00.000Z" })],
      [approval("a", "reject"), approval("a", "approve-canary")]
    );
    assert.equal(superseded.records[0]?.disposition, "approved-pending");
    assert.equal(superseded.records[0]?.approved, true);
  });

  it("takes the newest N candidates by createdAt", () => {
    const snapshot = summarizeNeonCanaryStability(
      [
        candidate({ id: "old", createdAt: "2026-06-01T09:00:00.000Z" }),
        candidate({ id: "new", createdAt: "2026-06-02T09:00:00.000Z" }),
        candidate({ id: "mid", createdAt: "2026-06-01T18:00:00.000Z" })
      ],
      [],
      { limit: 2 }
    );
    assert.deepEqual(
      snapshot.records.map((r) => r.candidateId),
      ["new", "mid"]
    );
  });

  it("is leak-safe: channel label is an id, never the message preview", () => {
    const snapshot = summarizeNeonCanaryStability(
      [
        candidate({
          id: "a",
          createdAt: "2026-06-02T10:00:00.000Z",
          finalTextPreview: "super-secret-message-body"
        })
      ],
      []
    );
    const record = snapshot.records[0];
    assert.ok(record);
    assert.equal(record.channelLabel, "channel:channel-123");
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /super-secret-message-body/);
    assert.doesNotMatch(renderNeonCanaryStabilityReport(snapshot), /super-secret-message-body/);
  });
});
