import {
  readNeonDeliveryApprovalRecords,
  readNeonDeliveryQueueCandidates,
  type INeonDeliveryApprovalRecord,
  type INeonDeliveryQueueCandidate,
  type TNeonDeliveryAckState,
  type TNeonDeliveryRecoveryState
} from "./deliveryQueue.js";

/**
 * Read-only canary stability evidence over the persisted delivery store
 * (`delivery-queue.jsonl` + `delivery-approvals.jsonl`).
 *
 * This is the evidence an operator (and the canary->primary decision) needs:
 * the last N delivery candidates with their approval/ack/recovery disposition
 * and a stability verdict. It never sends, never arms, never mutates the store.
 *
 * Honesty under the shadow contract: every candidate carries `outboundSent:false`,
 * so this is dry-run pipeline evidence (was the queue->approval->ack->drain path
 * exercised cleanly), not proof of live sends. Primary therefore stays blocked
 * regardless of how clean the evidence looks; unblocking it is an operator decision.
 *
 * Leak-safe: the record exposes a `channel:<id>` route label (an operator-
 * configured id, like the canary posture panel already shows) and never the
 * message content (`finalTextPreview` is deliberately omitted) or any raw error.
 */

export type TNeonCanaryStabilityVerdict = "no-evidence" | "dry-run-stable" | "unstable";

export type TNeonCanaryStabilityDisposition =
  | "queued"
  | "approved-pending"
  | "acked-done"
  | "rejected"
  | "pending-recovery";

export interface INeonCanaryStabilityRecord {
  readonly candidateId: string;
  readonly runId: string;
  readonly channelLabel: string;
  readonly ackState: TNeonDeliveryAckState;
  readonly recoveryState: TNeonDeliveryRecoveryState;
  readonly disposition: TNeonCanaryStabilityDisposition;
  readonly approved: boolean;
  readonly outboundSent: false;
  readonly createdAt: string;
}

export interface INeonCanaryStabilityTotals {
  readonly total: number;
  readonly approved: number;
  readonly ackedDone: number;
  readonly rejected: number;
  readonly pendingRecovery: number;
  readonly suppressed: number;
}

export interface INeonCanaryStabilityPrimaryReadiness {
  readonly ready: false;
  readonly reason: "primary-blocked-needs-operator";
}

export interface INeonCanaryStabilitySnapshot {
  readonly verdict: TNeonCanaryStabilityVerdict;
  readonly limit: number;
  readonly records: readonly INeonCanaryStabilityRecord[];
  readonly totals: INeonCanaryStabilityTotals;
  readonly primaryReadiness: INeonCanaryStabilityPrimaryReadiness;
}

const DEFAULT_LIMIT = 20;

interface INeonCandidateApprovalState {
  readonly approved: boolean;
  readonly rejected: boolean;
}

function resolveApprovalStates(
  approvals: readonly INeonDeliveryApprovalRecord[]
): Map<string, INeonCandidateApprovalState> {
  const byCandidate = new Map<string, INeonCandidateApprovalState>();
  for (const approval of approvals) {
    const prior = byCandidate.get(approval.candidateId) ?? { approved: false, rejected: false };
    byCandidate.set(approval.candidateId, {
      approved: prior.approved || approval.decision === "approve-canary",
      rejected: prior.rejected || approval.decision === "reject"
    });
  }
  return byCandidate;
}

function resolveDisposition(
  candidate: INeonDeliveryQueueCandidate,
  approval: INeonCandidateApprovalState
): TNeonCanaryStabilityDisposition {
  if (candidate.recoveryState === "pending-drain") {
    return "pending-recovery";
  }
  // Rejection only counts when it was not later superseded by an approval.
  if (approval.rejected && !approval.approved) {
    return "rejected";
  }
  if (candidate.ackState === "done") {
    return "acked-done";
  }
  if (approval.approved) {
    return "approved-pending";
  }
  return "queued";
}

/**
 * Pure stability summary over already-read candidates + approvals. Candidates are
 * taken newest-first (ISO `createdAt` sorts chronologically) up to `limit`.
 */
export function summarizeNeonCanaryStability(
  candidates: readonly INeonDeliveryQueueCandidate[],
  approvals: readonly INeonDeliveryApprovalRecord[],
  options: { readonly limit?: number } = {}
): INeonCanaryStabilitySnapshot {
  const limit =
    typeof options.limit === "number" && options.limit > 0 ? Math.floor(options.limit) : DEFAULT_LIMIT;
  const approvalStates = resolveApprovalStates(approvals);

  const ordered = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);

  const records: INeonCanaryStabilityRecord[] = ordered.map((candidate) => {
    const approval = approvalStates.get(candidate.id) ?? { approved: false, rejected: false };
    return {
      candidateId: candidate.id,
      runId: candidate.runId,
      channelLabel: `channel:${candidate.target.channelId}`,
      ackState: candidate.ackState,
      recoveryState: candidate.recoveryState,
      disposition: resolveDisposition(candidate, approval),
      approved: approval.approved,
      outboundSent: false,
      createdAt: candidate.createdAt
    };
  });

  const totals: INeonCanaryStabilityTotals = {
    total: records.length,
    approved: records.filter((record) => record.approved).length,
    ackedDone: records.filter((record) => record.disposition === "acked-done").length,
    rejected: records.filter((record) => record.disposition === "rejected").length,
    pendingRecovery: records.filter((record) => record.disposition === "pending-recovery").length,
    suppressed: records.length
  };

  const verdict: TNeonCanaryStabilityVerdict =
    records.length === 0 ? "no-evidence" : totals.pendingRecovery > 0 ? "unstable" : "dry-run-stable";

  return {
    verdict,
    limit,
    records,
    totals,
    primaryReadiness: { ready: false, reason: "primary-blocked-needs-operator" }
  };
}

/** Reads the persisted delivery store and summarizes canary stability. */
export async function readNeonCanaryStabilityEvidence(
  projectRoot: string,
  options: { readonly limit?: number } = {}
): Promise<INeonCanaryStabilitySnapshot> {
  const [candidates, approvals] = await Promise.all([
    readNeonDeliveryQueueCandidates(projectRoot),
    readNeonDeliveryApprovalRecords(projectRoot)
  ]);
  return summarizeNeonCanaryStability(candidates, approvals, options);
}

export function renderNeonCanaryStabilityReport(snapshot: INeonCanaryStabilitySnapshot): string {
  const lines: string[] = [
    "Neon Canary Stability Evidence",
    `verdict=${snapshot.verdict} runs=${snapshot.totals.total} approved=${snapshot.totals.approved} acked-done=${snapshot.totals.ackedDone} rejected=${snapshot.totals.rejected} pending-recovery=${snapshot.totals.pendingRecovery}`,
    `primary: ready=${snapshot.primaryReadiness.ready} (${snapshot.primaryReadiness.reason})`,
    ""
  ];
  if (snapshot.records.length === 0) {
    lines.push("(no delivery candidates yet — empty evidence)");
    return lines.join("\n");
  }
  for (const record of snapshot.records) {
    lines.push(
      `- ${record.disposition} ${record.channelLabel} run=${record.runId} ack=${record.ackState} recovery=${record.recoveryState} sent=${record.outboundSent}`
    );
  }
  return lines.join("\n");
}
