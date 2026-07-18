import {
  deriveCutoverGateStates,
  evaluateCanaryExitGate,
  evaluateMirrorExitGate,
  evaluatePrimaryExitGate,
  evaluateRetireExitGate,
  neonikaCutoverStages,
  nextCutoverStage,
  readOptionalCutoverEnv,
  readReadyCutoverEnv,
  type ICutoverGateState,
  type TCutoverStageId
} from "./cutover.js";
import {
  createNeonMirrorEvidenceSnapshot,
  type TNeonMirrorEvidenceState
} from "./mirrorEvidence.js";
import {
  createNeonDoctorSnapshot,
  type INeonDoctorCheck,
  type INeonDoctorSnapshot,
  type TNeonDoctorState
} from "../doctor/neonDoctor.js";
import { createNeonGatewayRouteInspectionSnapshot } from "../gateway/routeInspection.js";
import { readNeonGatewayRuns, readNeonGatewayStatus } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import { loadNeonCutoverEnv } from "./cutoverPromotion.js";

export type TNeonCutoverGateState = "pass" | "warn" | "fail" | "locked";
export type TNeonCutoverReadinessState = "ready" | "needs-evidence" | "blocked";

export interface ICreateNeonCutoverGateSnapshotOptions {
  readonly currentStage?: TCutoverStageId;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export interface INeonCutoverGate {
  readonly id: TCutoverStageId;
  readonly label: string;
  readonly state: TNeonCutoverGateState;
  readonly summary: string;
  readonly requiredEvidence: readonly string[];
  readonly evidence: readonly string[];
  readonly recovery: readonly string[];
  readonly rollback: string;
}

export interface INeonCutoverGateSource {
  readonly projectRoot: string;
  readonly doctorState: TNeonDoctorState;
  readonly routeState: string;
  readonly mirrorEvidenceState: TNeonMirrorEvidenceState;
  readonly mirrorAcceptedCount: number;
  readonly gatewayRuns: number;
  readonly activeEvidenceRuns?: number;
  readonly latestRunId: string | null;
  readonly rollbackConfigured: boolean;
}

export interface INeonCutoverGateSnapshot {
  readonly state: TNeonCutoverReadinessState;
  readonly generatedAt: string;
  readonly currentStage: TCutoverStageId;
  readonly nextStage: TCutoverStageId | null;
  readonly gates: readonly INeonCutoverGate[];
  readonly source: INeonCutoverGateSource;
}

interface ICutoverFacts {
  readonly doctor: INeonDoctorSnapshot;
  readonly routeReady: boolean;
  readonly routeState: string;
  readonly runCount: number;
  readonly shadowRunCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly deliverySuppressedCount: number;
  readonly latestRunId: string | null;
  readonly memoryState: INeonDoctorCheck["state"];
  readonly secretsState: INeonDoctorCheck["state"];
  readonly mirrorEvidenceState: TNeonMirrorEvidenceState;
  readonly mirrorAcceptedCount: number;
  readonly rollbackConfigured: boolean;
  readonly canaryApproved: boolean;
  readonly primaryApproved: boolean;
  readonly retireEvidenceReady: boolean;
}

const cutoverStageIds = neonikaCutoverStages.map((stage) => stage.id);
const activeCutoverEvidenceRunLimit = 50;

export async function createNeonCutoverGateSnapshot(
  projectRoot: string,
  options: ICreateNeonCutoverGateSnapshotOptions = {}
): Promise<INeonCutoverGateSnapshot> {
  const env = options.env ?? (await loadNeonCutoverEnv(projectRoot));
  const currentStage = options.currentStage ?? readCutoverStage(env) ?? "shadow";
  const now = options.now ?? (() => new Date());
  const [doctor, routes, status, activeRuns, mirrorEvidence] = await Promise.all([
    createNeonDoctorSnapshot(projectRoot, {
      currentStage,
      now
    }),
    createNeonGatewayRouteInspectionSnapshot(projectRoot, {
      env,
      now
    }),
    readNeonGatewayStatus(projectRoot),
    readNeonGatewayRuns(projectRoot, { maxRuns: activeCutoverEvidenceRunLimit }),
    createNeonMirrorEvidenceSnapshot(projectRoot, {
      now
    })
  ]);
  const activeEvidence = createActiveCutoverRunEvidence(activeRuns);
  const facts: ICutoverFacts = {
    doctor,
    routeReady: routes.state === "ready",
    routeState: routes.state,
    runCount: activeEvidence.runCount,
    shadowRunCount: activeEvidence.shadowRunCount,
    completedCount: activeEvidence.completedCount,
    failedCount: activeEvidence.failedCount,
    deliverySuppressedCount: activeEvidence.deliverySuppressedCount,
    latestRunId: status.latestRun?.runId ?? null,
    memoryState: findDoctorCheckState(doctor, "memory"),
    secretsState: findDoctorCheckState(doctor, "secrets"),
    mirrorEvidenceState: mirrorEvidence.state,
    mirrorAcceptedCount: mirrorEvidence.totals.accepted,
    rollbackConfigured: Boolean(readOptionalCutoverEnv(env, "NEON_CUTOVER_ROLLBACK_COMMAND")),
    canaryApproved: readReadyCutoverEnv(env, "NEON_CUTOVER_CANARY_APPROVED"),
    primaryApproved: readReadyCutoverEnv(env, "NEON_CUTOVER_PRIMARY_APPROVED"),
    retireEvidenceReady: readReadyCutoverEnv(env, "NEON_CUTOVER_RETIRE_EVIDENCE")
  };
  const gates = buildCutoverGates(facts);
  const currentGate = gates.find((gate) => gate.id === currentStage);

  return {
    state: resolveCutoverReadinessState(gates, currentGate),
    generatedAt: now().toISOString(),
    currentStage,
    nextStage: nextCutoverStage(currentStage),
    gates,
    source: {
      projectRoot,
      doctorState: doctor.state,
      routeState: routes.state,
      mirrorEvidenceState: mirrorEvidence.state,
      mirrorAcceptedCount: mirrorEvidence.totals.accepted,
      gatewayRuns: status.runCount,
      activeEvidenceRuns: activeEvidence.runCount,
      latestRunId: status.latestRun?.runId ?? null,
      rollbackConfigured: facts.rollbackConfigured
    }
  };
}

export function renderNeonCutoverGateReport(snapshot: INeonCutoverGateSnapshot): string {
  const activeEvidenceRuns = snapshot.source.activeEvidenceRuns ?? snapshot.source.gatewayRuns;

  return [
    `Neon Cutover Gates: ${snapshot.state}`,
    `Current: ${snapshot.currentStage}`,
    `Next: ${snapshot.nextStage ?? "none"}`,
    `Doctor: ${snapshot.source.doctorState}`,
    `Routes: ${snapshot.source.routeState}`,
    `Mirror Evidence: ${snapshot.source.mirrorEvidenceState} accepted=${snapshot.source.mirrorAcceptedCount}`,
    `Runs: ${snapshot.source.gatewayRuns} (active evidence=${activeEvidenceRuns})`,
    ...snapshot.gates.map((gate) => {
      const recovery = gate.recovery.length > 0 ? ` recovery=${gate.recovery.join(" | ")}` : "";
      return `${gate.state.toUpperCase()} ${gate.label}: ${gate.summary}${recovery}`;
    })
  ].join("\n");
}

function buildCutoverGates(facts: ICutoverFacts): readonly INeonCutoverGate[] {
  const gateStates = deriveCutoverGateStates({
    shadowFailed:
      facts.doctor.state === "fail" || facts.failedCount > 0 || facts.secretsState === "fail",
    runCount: facts.runCount,
    shadowRunCount: facts.shadowRunCount,
    deliverySuppressedCount: facts.deliverySuppressedCount,
    failedCount: facts.failedCount,
    routeReady: facts.routeReady,
    memoryReady: facts.memoryState === "pass",
    mirrorEvidenceReady: facts.mirrorEvidenceState === "ready",
    mirrorAcceptedCount: facts.mirrorAcceptedCount,
    rollbackConfigured: facts.rollbackConfigured,
    canaryApproved: facts.canaryApproved,
    primaryApproved: facts.primaryApproved,
    doctorHasNoFailures: facts.doctor.state !== "fail",
    completedCount: facts.completedCount,
    retireEvidenceReady: facts.retireEvidenceReady
  });
  const stateById = new Map<TCutoverStageId, ICutoverGateState["state"]>(
    gateStates.map((gate) => [gate.id, gate.state])
  );

  return [
    buildShadowGate(facts, resolveGateState(stateById, "shadow")),
    buildMirrorGate(facts, resolveGateState(stateById, "mirror")),
    buildCanaryGate(facts, resolveGateState(stateById, "canary")),
    buildPrimaryGate(facts, resolveGateState(stateById, "primary")),
    buildRetireGate(facts, resolveGateState(stateById, "retire"))
  ];
}

interface IActiveCutoverRunEvidence {
  readonly runCount: number;
  readonly shadowRunCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly deliverySuppressedCount: number;
}

function createActiveCutoverRunEvidence(
  runs: readonly INeonGatewayShadowRun[]
): IActiveCutoverRunEvidence {
  return {
    runCount: runs.length,
    shadowRunCount: runs.filter((run) => run.mode === "shadow").length,
    completedCount: runs.filter((run) => run.status === "completed").length,
    failedCount: runs.filter((run) => run.status === "failed").length,
    deliverySuppressedCount: runs.filter((run) => run.delivery.state === "suppressed").length
  };
}

function resolveGateState(
  stateById: ReadonlyMap<TCutoverStageId, TNeonCutoverGateState>,
  id: TCutoverStageId
): TNeonCutoverGateState {
  return stateById.get(id) ?? "locked";
}

function buildShadowGate(facts: ICutoverFacts, state: TNeonCutoverGateState): INeonCutoverGate {
  const passed = state === "pass";

  return createGate("shadow", state, {
    summary: passed
      ? "Shadow runtime has persisted runs and shadow delivery is suppressed."
      : "Shadow needs clean runtime evidence before mirror work.",
    requiredEvidence: [
      "At least one persisted shadow run.",
      "No failed gateway runs.",
      "All shadow delivery remains suppressed.",
      "Doctor has no failing checks."
    ],
    evidence: [
      `runs=${facts.runCount}`,
      `shadow=${facts.shadowRunCount}`,
      `failed=${facts.failedCount}`,
      `suppressed=${facts.deliverySuppressedCount}`,
      `doctor=${facts.doctor.state}`,
      `latest=${facts.latestRunId ?? "none"}`
    ],
    recovery: shadowRecovery(facts),
    rollback: "Keep the previous runtime primary; stop Neonika shadow listeners."
  });
}

function buildMirrorGate(facts: ICutoverFacts, state: TNeonCutoverGateState): INeonCutoverGate {
  if (state === "locked") {
    return createLockedGate("mirror", "Shadow gate must pass before mirror comparison.");
  }

  const exitGate = evaluateMirrorExitGate({
    routeReady: facts.routeReady,
    memoryReady: facts.memoryState === "pass",
    mirrorEvidenceReady: facts.mirrorEvidenceState === "ready",
    mirrorAcceptedCount: facts.mirrorAcceptedCount
  });
  const passed = state === "pass";

  return createGate("mirror", state, {
    summary: passed
      ? "Mirror comparison evidence is captured and routes are scoped."
      : "Mirror needs route readiness, memory proof, and stored old-vs-new comparison evidence.",
    requiredEvidence: [
      "Shadow gate is green.",
      "Discord routes are configured.",
      "Memory check passes.",
      "Mirror comparison evidence is stored."
    ],
    evidence: [
      `routes=${facts.routeState}`,
      `memory=${facts.memoryState}`,
      `mirrorEvidence=${facts.mirrorEvidenceState}`,
      `mirrorAccepted=${facts.mirrorAcceptedCount}`,
      `mirrorExitGateMet=${exitGate.met}`,
      ...exitGate.reasons.map((reason) => `mirrorExitGate: ${reason}`)
    ],
    recovery: [
      ...missingRecovery(facts.routeReady, "Configure Discord route allowlists."),
      ...missingRecovery(facts.memoryState === "pass", "Run a memory-attached gateway smoke."),
      ...missingRecovery(
        facts.mirrorEvidenceState === "ready",
        "Record an accepted mirror comparison with mirror-record."
      )
    ],
    rollback: "Keep Neonika in shadow; discard mirror output."
  });
}

function buildCanaryGate(facts: ICutoverFacts, state: TNeonCutoverGateState): INeonCutoverGate {
  if (state === "locked") {
    return createLockedGate("canary", "Mirror gate must pass before canary routing.");
  }

  const exitGate = evaluateCanaryExitGate(
    {
      rollbackConfigured: facts.rollbackConfigured,
      canaryApproved: facts.canaryApproved
    },
    "pass"
  );
  const passed = state === "pass";

  return createGate("canary", state, {
    summary: passed
      ? "Canary has approval and rollback command configured."
      : "Canary needs explicit approval and a one-command rollback.",
    requiredEvidence: [
      "Mirror gate is green.",
      "Rollback command is configured.",
      "the operator approves canary routing."
    ],
    evidence: [
      `rollback=${facts.rollbackConfigured ? "configured" : "missing"}`,
      `approval=${facts.canaryApproved ? "approved" : "pending"}`,
      `canaryExitGateMet=${exitGate.met}`,
      ...exitGate.reasons.map((reason) => `canaryExitGate: ${reason}`)
    ],
    recovery: [
      ...missingRecovery(facts.rollbackConfigured, "Set NEON_CUTOVER_ROLLBACK_COMMAND."),
      ...missingRecovery(facts.canaryApproved, "Set NEON_CUTOVER_CANARY_APPROVED=ready after operator approval.")
    ],
    rollback: "Run configured rollback command and route the private channel back to the previous runtime."
  });
}

function buildPrimaryGate(facts: ICutoverFacts, state: TNeonCutoverGateState): INeonCutoverGate {
  if (state === "locked") {
    return createLockedGate("primary", "Canary gate must pass before primary routing.");
  }

  const stableRuns = facts.completedCount >= 5 && facts.failedCount === 0;
  const doctorHasNoFailures = facts.doctor.state !== "fail";
  const exitGate = evaluatePrimaryExitGate(
    {
      primaryApproved: facts.primaryApproved,
      doctorHasNoFailures,
      completedCount: facts.completedCount,
      failedCount: facts.failedCount
    },
    "pass"
  );
  const passed = state === "pass";

  return createGate("primary", state, {
    summary: passed
      ? "Primary switch has stability evidence and approval."
      : "Primary needs more stable runs, no Doctor failures, and explicit approval.",
    requiredEvidence: [
      "Canary gate is green.",
      "At least five completed runs with zero failures.",
      "Doctor reports no failures.",
      "the operator approves primary routing."
    ],
    evidence: [
      `completed=${facts.completedCount}`,
      `failed=${facts.failedCount}`,
      `doctor=${facts.doctor.state}`,
      `approval=${facts.primaryApproved ? "approved" : "pending"}`,
      `primaryExitGateMet=${exitGate.met}`,
      ...exitGate.reasons.map((reason) => `primaryExitGate: ${reason}`)
    ],
    recovery: [
      ...missingRecovery(stableRuns, "Capture at least five clean canary runs."),
      ...missingRecovery(doctorHasNoFailures, "Fix failing Doctor checks."),
      ...missingRecovery(facts.primaryApproved, "Set NEON_CUTOVER_PRIMARY_APPROVED=ready after operator approval.")
    ],
    rollback: "Switch Discord routing back to canary or the previous runtime using the rollback command."
  });
}

function buildRetireGate(facts: ICutoverFacts, state: TNeonCutoverGateState): INeonCutoverGate {
  if (state === "locked") {
    return createLockedGate("retire", "Primary gate must pass before retiring the previous runtime.");
  }

  const exitGate = evaluateRetireExitGate(
    {
      retireEvidenceReady: facts.retireEvidenceReady,
      rollbackConfigured: facts.rollbackConfigured
    },
    "pass"
  );
  const passed = state === "pass";

  return createGate("retire", state, {
    summary: passed
      ? "Retire evidence is ready and rollback remains configured."
      : "Retire needs export/import proof and rollback documentation.",
    requiredEvidence: [
      "Primary gate is green.",
      "Export/import proof is captured.",
      "Rollback remains documented."
    ],
    evidence: [
      `retireEvidence=${facts.retireEvidenceReady ? "ready" : "missing"}`,
      `rollback=${facts.rollbackConfigured ? "configured" : "missing"}`,
      `retireExitGateMet=${exitGate.met}`,
      ...exitGate.reasons.map((reason) => `retireExitGate: ${reason}`)
    ],
    recovery: [
      ...missingRecovery(facts.retireEvidenceReady, "Set NEON_CUTOVER_RETIRE_EVIDENCE=ready after export/import proof."),
      ...missingRecovery(facts.rollbackConfigured, "Keep NEON_CUTOVER_ROLLBACK_COMMAND configured.")
    ],
    rollback: "Keep the previous runtime as legacy fallback until retire evidence is complete."
  });
}

function createGate(
  id: TCutoverStageId,
  state: TNeonCutoverGateState,
  input: {
    readonly evidence: readonly string[];
    readonly recovery: readonly string[];
    readonly requiredEvidence: readonly string[];
    readonly rollback: string;
    readonly summary: string;
  }
): INeonCutoverGate {
  const stage = neonikaCutoverStages.find((entry) => entry.id === id);

  return {
    id,
    label: stage?.label ?? id,
    state,
    summary: input.summary,
    requiredEvidence: input.requiredEvidence,
    evidence: input.evidence,
    recovery: input.recovery,
    rollback: input.rollback
  };
}

function createLockedGate(id: TCutoverStageId, summary: string): INeonCutoverGate {
  const stage = neonikaCutoverStages.find((entry) => entry.id === id);

  return {
    id,
    label: stage?.label ?? id,
    state: "locked",
    summary,
    requiredEvidence: [stage?.exitGate ?? "Previous gate must pass."],
    evidence: [],
    recovery: [summary],
    rollback: "No route change allowed at this stage."
  };
}

function shadowRecovery(facts: ICutoverFacts): readonly string[] {
  return [
    ...missingRecovery(facts.runCount > 0, "Run gateway-memory-shadow-smoke."),
    ...missingRecovery(facts.failedCount === 0, "Fix failed gateway runs before cutover."),
    ...missingRecovery(
      facts.shadowRunCount > 0 && facts.deliverySuppressedCount === facts.shadowRunCount,
      "Keep shadow delivery suppressed."
    ),
    ...missingRecovery(facts.doctor.state !== "fail", "Fix failing Doctor checks."),
    ...missingRecovery(facts.secretsState !== "fail", "Remove secret-looking values from gateway state.")
  ];
}

function missingRecovery(condition: boolean, message: string): readonly string[] {
  return condition ? [] : [message];
}

function findDoctorCheckState(
  doctor: INeonDoctorSnapshot,
  checkId: INeonDoctorCheck["id"]
): INeonDoctorCheck["state"] {
  return doctor.checks.find((check) => check.id === checkId)?.state ?? "warn";
}

function resolveCutoverReadinessState(
  gates: readonly INeonCutoverGate[],
  currentGate: INeonCutoverGate | undefined
): TNeonCutoverReadinessState {
  if (gates.some((gate) => gate.state === "fail")) {
    return "blocked";
  }

  return currentGate?.state === "pass" ? "ready" : "needs-evidence";
}

function readCutoverStage(env: Readonly<Record<string, string | undefined>>): TCutoverStageId | undefined {
  const stage = readOptionalCutoverEnv(env, "NEON_CUTOVER_STAGE");

  if (!stage) {
    return undefined;
  }

  return cutoverStageIds.includes(stage as TCutoverStageId) ? (stage as TCutoverStageId) : undefined;
}
