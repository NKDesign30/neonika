import {
  appendNeonCommitment,
  applyNeonCommitmentStatus,
  readNeonCommitments,
  resolveNeonCommitmentStoreGate,
  type INeonCommitmentRecord,
  type INeonCommitmentStoreGate
} from "./commitmentStore.js";

export const neonCommitmentLifecycleEnvKey = "NEON_COMMITMENT_LIFECYCLE_ENABLED";
export const NEON_COMMITMENT_LIFECYCLE_DEFAULT_SNOOZE_MS = 15 * 60_000;

export interface INeonCommitmentLifecycleGate {
  readonly enabled: boolean;
  readonly envKey: typeof neonCommitmentLifecycleEnvKey;
  readonly reason: "lifecycle-enabled" | "lifecycle-disabled";
}

export interface IMarkNeonCommitmentsHeartbeatObservedOptions {
  readonly commitmentIds: readonly string[];
  readonly storePath?: string;
  readonly nowMs: number;
  readonly gate?: INeonCommitmentLifecycleGate;
  readonly storeGate?: INeonCommitmentStoreGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly snoozeMs?: number;
}

export interface INeonCommitmentLifecycleResult {
  readonly state: "blocked" | "noop" | "updated";
  readonly gate: INeonCommitmentLifecycleGate;
  readonly updatedIds: readonly string[];
  readonly skippedIds: readonly string[];
  readonly diagnostics: readonly string[];
}

export function resolveNeonCommitmentLifecycleGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCommitmentLifecycleGate {
  const enabled = env[neonCommitmentLifecycleEnvKey] === "ready";
  return {
    enabled,
    envKey: neonCommitmentLifecycleEnvKey,
    reason: enabled ? "lifecycle-enabled" : "lifecycle-disabled"
  };
}

export async function markNeonCommitmentsHeartbeatObserved(
  options: IMarkNeonCommitmentsHeartbeatObservedOptions
): Promise<INeonCommitmentLifecycleResult> {
  const gate = options.gate ?? resolveNeonCommitmentLifecycleGate(options.env ?? process.env);
  const commitmentIds = [...new Set(options.commitmentIds.filter((id) => id.trim().length > 0))];
  if (!gate.enabled || !options.storePath) {
    return {
      state: "blocked",
      gate,
      updatedIds: [],
      skippedIds: commitmentIds,
      diagnostics: [
        "commitment-lifecycle blocked: requires NEON_COMMITMENT_LIFECYCLE_ENABLED and an explicit isolated storePath"
      ]
    };
  }
  if (commitmentIds.length === 0) {
    return {
      state: "noop",
      gate,
      updatedIds: [],
      skippedIds: [],
      diagnostics: ["commitment-lifecycle noop: no emitted commitment ids"]
    };
  }

  const commitments = await readNeonCommitments({ storePath: options.storePath });
  const latest = new Map<string, INeonCommitmentRecord>();
  for (const commitment of commitments) {
    latest.set(commitment.id, commitment);
  }

  const snoozeMs = Math.max(1, Math.floor(options.snoozeMs ?? NEON_COMMITMENT_LIFECYCLE_DEFAULT_SNOOZE_MS));
  const storeGate =
    options.storeGate ?? resolveNeonCommitmentStoreGate({ NEON_COMMITMENTS_STORE_ENABLED: "ready" });
  const updatedIds: string[] = [];
  const skippedIds: string[] = [];
  const diagnostics: string[] = [];

  for (const commitmentId of commitmentIds) {
    const commitment = latest.get(commitmentId);
    if (!commitment) {
      skippedIds.push(commitmentId);
      diagnostics.push(`commitment-lifecycle skipped ${commitmentId}: not found`);
      continue;
    }
    const transition = applyNeonCommitmentStatus(commitment, "snoozed", options.nowMs, {
      snoozedUntilMs: options.nowMs + snoozeMs
    });
    if (!transition.applied) {
      skippedIds.push(commitmentId);
      diagnostics.push(`commitment-lifecycle skipped ${commitmentId}: ${transition.reason}`);
      continue;
    }
    const observedCommitment: INeonCommitmentRecord = {
      ...transition.commitment,
      attempts: commitment.attempts + 1
    };
    const append = await appendNeonCommitment({
      commitment: observedCommitment,
      gate: storeGate,
      storePath: options.storePath
    });
    if (append.state !== "appended") {
      skippedIds.push(commitmentId);
      diagnostics.push(...append.diagnostics);
      continue;
    }
    updatedIds.push(commitmentId);
    diagnostics.push(`commitment-lifecycle snoozed ${commitmentId}`);
  }

  return {
    state: updatedIds.length > 0 ? "updated" : "noop",
    gate,
    updatedIds,
    skippedIds,
    diagnostics
  };
}
