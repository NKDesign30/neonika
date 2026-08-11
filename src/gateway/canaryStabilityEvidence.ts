import { readNeonOperatorAcks, type INeonOperatorAck } from "./operatorAcks.js";
import { readNeonGatewayRuns } from "./runStore.js";
import type { INeonGatewayShadowRun } from "./types.js";

/**
 * Authoritative, read-only Canary evidence over persisted Gateway runs and
 * operator acknowledgements. A delivery qualifies only when the run itself
 * proves `live + completed + delivered + cutoverStage=canary + messageId`.
 * Acknowledgements count only when recorded after that delivery completed.
 *
 * The projection contains no message body, message id, channel id, ack note,
 * error text, workspace path, or operator identity. It never sends or mutates.
 */

export type TNeonCanaryStabilityVerdict = "no-evidence" | "collecting" | "stable" | "unstable";

export type TNeonCanaryStabilityDisposition =
  | "awaiting-acknowledgement"
  | "acknowledged"
  | "failed";

export interface INeonCanaryStabilityRecord {
  readonly runId: string;
  readonly channel: INeonGatewayShadowRun["request"]["channel"];
  readonly disposition: TNeonCanaryStabilityDisposition;
  readonly delivered: boolean;
  readonly acknowledged: boolean;
  readonly occurredAt: string;
}

export interface INeonCanaryStabilityTotals {
  readonly inspected: number;
  readonly delivered: number;
  readonly acknowledged: number;
  readonly unresolvedFailures: number;
}

export type TNeonCanaryStabilityPrimaryReadinessReason =
  | "ready"
  | "needs-five-acknowledged-canary-deliveries"
  | "unresolved-failures";

export interface INeonCanaryStabilityPrimaryReadiness {
  readonly ready: boolean;
  readonly reason: TNeonCanaryStabilityPrimaryReadinessReason;
}

export interface INeonCanaryStabilitySnapshot {
  readonly verdict: TNeonCanaryStabilityVerdict;
  readonly limit: number;
  readonly records: readonly INeonCanaryStabilityRecord[];
  readonly totals: INeonCanaryStabilityTotals;
  readonly primaryReadiness: INeonCanaryStabilityPrimaryReadiness;
}

const DEFAULT_LIMIT = 50;
const requiredAcknowledgedDeliveries = 5;

export function summarizeNeonCanaryStability(
  runs: readonly INeonGatewayShadowRun[],
  acknowledgements: readonly INeonOperatorAck[],
  options: { readonly limit?: number } = {}
): INeonCanaryStabilitySnapshot {
  const limit = normalizeLimit(options.limit);
  const orderedRuns = [...runs]
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, limit);
  const acknowledgementByRunId = new Map(
    acknowledgements.map((acknowledgement) => [acknowledgement.runId, acknowledgement])
  );

  const records: INeonCanaryStabilityRecord[] = [];
  for (const run of orderedRuns) {
    if (run.status === "failed") {
      records.push({
        runId: run.runId,
        channel: run.request.channel,
        disposition: "failed",
        delivered: false,
        acknowledged: false,
        occurredAt: run.completedAt
      });
      continue;
    }
    if (!isGenuineCanaryDelivery(run)) {
      continue;
    }

    const acknowledged = isPositivePostDeliveryAcknowledgement(
      acknowledgementByRunId.get(run.runId),
      run.completedAt
    );
    records.push({
      runId: run.runId,
      channel: run.request.channel,
      disposition: acknowledged ? "acknowledged" : "awaiting-acknowledgement",
      delivered: true,
      acknowledged,
      occurredAt: run.completedAt
    });
  }

  const totals: INeonCanaryStabilityTotals = {
    inspected: orderedRuns.length,
    delivered: records.filter((record) => record.delivered).length,
    acknowledged: records.filter((record) => record.acknowledged).length,
    unresolvedFailures: records.filter((record) => record.disposition === "failed").length
  };
  const primaryReadiness = resolvePrimaryReadiness(totals);
  const verdict: TNeonCanaryStabilityVerdict =
    totals.unresolvedFailures > 0
      ? "unstable"
      : primaryReadiness.ready
        ? "stable"
        : totals.delivered === 0
          ? "no-evidence"
          : "collecting";

  return { verdict, limit, records, totals, primaryReadiness };
}

export async function readNeonCanaryStabilityEvidence(
  projectRoot: string,
  options: { readonly limit?: number } = {}
): Promise<INeonCanaryStabilitySnapshot> {
  const limit = normalizeLimit(options.limit);
  const [runs, acknowledgements] = await Promise.all([
    readNeonGatewayRuns(projectRoot, { maxRuns: limit }),
    readNeonOperatorAcks(projectRoot)
  ]);
  return summarizeNeonCanaryStability(runs, acknowledgements, { limit });
}

export function renderNeonCanaryStabilityReport(snapshot: INeonCanaryStabilitySnapshot): string {
  const lines: string[] = [
    "Neonika Canary Stability Evidence",
    `verdict=${snapshot.verdict} inspected=${snapshot.totals.inspected} delivered=${snapshot.totals.delivered} acknowledged=${snapshot.totals.acknowledged} unresolved-failures=${snapshot.totals.unresolvedFailures}`,
    `primary: ready=${snapshot.primaryReadiness.ready} (${snapshot.primaryReadiness.reason})`,
    ""
  ];
  if (snapshot.records.length === 0) {
    lines.push("(no genuine canary delivery or unresolved failure evidence — empty evidence)");
    return lines.join("\n");
  }
  for (const record of snapshot.records) {
    lines.push(
      `- ${record.disposition} channel=${record.channel} run=${record.runId} delivered=${record.delivered} acknowledged=${record.acknowledged}`
    );
  }
  return lines.join("\n");
}

function isGenuineCanaryDelivery(run: INeonGatewayShadowRun): boolean {
  return (
    run.mode === "live" &&
    run.status === "completed" &&
    run.delivery.state === "delivered" &&
    run.delivery.cutoverStage === "canary" &&
    Boolean(run.delivery.messageId)
  );
}

function isPositivePostDeliveryAcknowledgement(
  acknowledgement: INeonOperatorAck | undefined,
  completedAt: string
): boolean {
  if (!acknowledgement) {
    return false;
  }
  const acknowledgedTime = Date.parse(acknowledgement.ackedAt);
  const completedTime = Date.parse(completedAt);
  return (
    Number.isFinite(acknowledgedTime) &&
    Number.isFinite(completedTime) &&
    acknowledgedTime >= completedTime
  );
}

function resolvePrimaryReadiness(
  totals: INeonCanaryStabilityTotals
): INeonCanaryStabilityPrimaryReadiness {
  if (totals.unresolvedFailures > 0) {
    return { ready: false, reason: "unresolved-failures" };
  }
  if (totals.acknowledged < requiredAcknowledgedDeliveries) {
    return { ready: false, reason: "needs-five-acknowledged-canary-deliveries" };
  }
  return { ready: true, reason: "ready" };
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Canary stability limit must be between 1 and 1000");
  }
  return value;
}
