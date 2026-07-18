import {
  planNeonRunLifecycleAction,
  resolveNeonInFlightRunGate,
  type INeonInFlightRunGate,
  type INeonInFlightRunRecord,
  type INeonInFlightRunSnapshot,
  type TNeonRunLifecycleAction,
  type TNeonRunLifecycleDecisionState
} from "./inFlightRunRegistry.js";

/**
 * Read-only live-session runtime readiness.
 *
 * It answers "what is missing before resume/branch/label/delete/checkpoints can
 * be real" without building any fake session action. For each capability it asks
 * the real lifecycle planner (`planNeonRunLifecycleAction`, which is
 * `executed:false`) how the action would classify *assuming a hypothetical live
 * in-flight run*, and pairs that with the concrete runtime piece still missing.
 *
 * The hypothetical probe record exists only to reveal the per-capability
 * architectural truth: even with a live run, stop/abort would be
 * `interrupt-ready` but resume/branch/label/delete stay `plan-only` (they need a
 * persisted session runtime). Checkpoints are `not-modeled` (no checkpoint
 * events in the run-store). Crucially `liveRuntimeReady` is hard false: the
 * shadow run-store is terminal-only, no real in-flight session exists, so none of
 * these is actually available now. Nothing here executes, sends or mutates.
 */

export type TNeonLiveSessionCapability =
  | "stop"
  | "abort"
  | "resume"
  | "branch"
  | "label"
  | "delete"
  | "checkpoint";

export type TNeonLiveSessionCapabilityState = TNeonRunLifecycleDecisionState | "not-modeled";

export interface INeonLiveSessionCapabilityReadiness {
  readonly capability: TNeonLiveSessionCapability;
  readonly state: TNeonLiveSessionCapabilityState;
  readonly reason: string;
  readonly missingRuntimePiece: string;
  readonly executed: false;
}

export interface INeonLiveSessionReadinessTotals {
  readonly total: number;
  readonly blocked: number;
  readonly planOnly: number;
  readonly interruptReady: number;
  readonly notModeled: number;
}

export interface INeonLiveSessionReadinessSnapshot {
  /** The live in-flight lifecycle gate as currently resolved from env. */
  readonly envGateEnabled: boolean;
  readonly liveRuntimeReady: boolean;
  readonly runtime: {
    readonly activeRuns: number;
    readonly busy: boolean;
    readonly lastRunActivityAt: string | null;
    readonly runningRunIds: readonly string[];
  };
  readonly capabilities: readonly INeonLiveSessionCapabilityReadiness[];
  /** Deduped concrete runtime pieces still missing, in first-seen order. */
  readonly missingRuntimePieces: readonly string[];
  readonly totals: INeonLiveSessionReadinessTotals;
  readonly note: string;
}

const INTERRUPT_MISSING_PIECE =
  "Live in-flight run fed from the real ingress loop (the shadow run-store is terminal-only)";
const NO_MISSING_PIECE = "none";
const SESSION_MISSING_PIECE = "Persisted session runtime to resume/branch/restore from";
const CHECKPOINT_MISSING_PIECE = "Checkpoint/compaction events written to the run store";

const LIFECYCLE_CAPABILITIES: readonly TNeonRunLifecycleAction[] = [
  "stop",
  "abort",
  "resume",
  "branch",
  "label",
  "delete"
];

function missingPieceFor(action: TNeonRunLifecycleAction, hasActiveRun: boolean): string {
  if (action === "stop" || action === "abort") {
    return hasActiveRun ? NO_MISSING_PIECE : INTERRUPT_MISSING_PIECE;
  }

  return SESSION_MISSING_PIECE;
}

export function createNeonLiveSessionReadinessSnapshot(
  options: { readonly env?: NodeJS.ProcessEnv; readonly runtimeSnapshot?: INeonInFlightRunSnapshot } = {}
): INeonLiveSessionReadinessSnapshot {
  const envGate = resolveNeonInFlightRunGate(options.env ?? process.env);
  const activeRecord = options.runtimeSnapshot?.running[0];
  const hasActiveRun = activeRecord !== undefined;
  const liveRuntimeReady = envGate.enabled && hasActiveRun;
  // Architectural probe fallback: when no runtime snapshot is injected, ask each
  // action as if the gate were on AND a live run existed. When a real runtime
  // snapshot is present, plan against the real active run.
  const probeGate: INeonInFlightRunGate = { ...envGate, enabled: true, reason: "lifecycle-enabled" };
  const probeRecord: INeonInFlightRunRecord = {
    runId: "readiness-probe",
    threadId: "readiness-probe-thread",
    turnId: "readiness-probe-turn",
    sessionKey: "readiness-probe-session",
    agentId: "main",
    channel: "discord",
    state: "running",
    startedAt: "1970-01-01T00:00:00.000Z",
    lastActivityAt: "1970-01-01T00:00:00.000Z"
  };
  const plannerGate = activeRecord ? envGate : probeGate;
  const plannerRecord = activeRecord ?? probeRecord;
  const plannerRunId = activeRecord?.runId ?? "readiness-probe";

  const lifecycleCaps: INeonLiveSessionCapabilityReadiness[] = LIFECYCLE_CAPABILITIES.map((action) => {
    const decision = planNeonRunLifecycleAction({
      action,
      runId: plannerRunId,
      gate: plannerGate,
      record: plannerRecord
    });
    return {
      capability: action,
      state: decision.state,
      reason: decision.reason,
      missingRuntimePiece: missingPieceFor(action, liveRuntimeReady),
      executed: false
    };
  });

  const checkpointCap: INeonLiveSessionCapabilityReadiness = {
    capability: "checkpoint",
    state: "not-modeled",
    reason: "checkpoint-events-not-in-run-store",
    missingRuntimePiece: CHECKPOINT_MISSING_PIECE,
    executed: false
  };

  const capabilities = [...lifecycleCaps, checkpointCap];

  const missingRuntimePieces: string[] = [];
  for (const cap of capabilities) {
    if (cap.missingRuntimePiece !== NO_MISSING_PIECE && !missingRuntimePieces.includes(cap.missingRuntimePiece)) {
      missingRuntimePieces.push(cap.missingRuntimePiece);
    }
  }

  const totals: INeonLiveSessionReadinessTotals = {
    total: capabilities.length,
    blocked: capabilities.filter((cap) => cap.state === "blocked").length,
    planOnly: capabilities.filter((cap) => cap.state === "plan-only").length,
    interruptReady: capabilities.filter((cap) => cap.state === "interrupt-ready").length,
    notModeled: capabilities.filter((cap) => cap.state === "not-modeled").length
  };

  return {
    envGateEnabled: envGate.enabled,
    liveRuntimeReady,
    runtime: {
      activeRuns: options.runtimeSnapshot?.activeRuns ?? 0,
      busy: options.runtimeSnapshot?.busy ?? false,
      lastRunActivityAt: options.runtimeSnapshot?.lastRunActivityAt ?? null,
      runningRunIds: options.runtimeSnapshot?.running.map((run) => run.runId) ?? []
    },
    capabilities,
    missingRuntimePieces,
    totals,
    note: liveRuntimeReady
      ? "Read-only readiness over a real in-flight runtime snapshot; lifecycle actions are planned but not executed here."
      : "Read-only readiness; no session action is executed. Live runtime needs a real in-flight session before any lifecycle action becomes real."
  };
}

export function renderNeonLiveSessionReadinessReport(
  snapshot: INeonLiveSessionReadinessSnapshot
): string {
  const lines: string[] = [
    "Neonika Live-Session Runtime Readiness",
    `env-gate=${snapshot.envGateEnabled ? "enabled" : "disabled"} live-runtime-ready=${snapshot.liveRuntimeReady} active-runs=${snapshot.runtime.activeRuns} busy=${snapshot.runtime.busy} blocked=${snapshot.totals.blocked} plan-only=${snapshot.totals.planOnly} interrupt-ready=${snapshot.totals.interruptReady} not-modeled=${snapshot.totals.notModeled}`,
    ""
  ];
  for (const cap of snapshot.capabilities) {
    lines.push(`- ${cap.capability}: ${cap.state} (${cap.reason})`, `    missing: ${cap.missingRuntimePiece}`);
  }
  lines.push("", "Missing runtime pieces:");
  for (const piece of snapshot.missingRuntimePieces) {
    lines.push(`- ${piece}`);
  }
  return lines.join("\n");
}
