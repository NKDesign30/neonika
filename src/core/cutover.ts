export type TCutoverStageId = "shadow" | "mirror" | "canary" | "primary" | "retire";

export interface ICutoverStage {
  readonly id: TCutoverStageId;
  readonly label: string;
  readonly meaning: string;
  readonly exitGate: string;
}

export const neonikaCutoverStages: readonly ICutoverStage[] = [
  {
    id: "shadow",
    label: "Shadow",
    meaning: "Neonika observes or runs manual tests only.",
    exitGate: "No production channel depends on it."
  },
  {
    id: "mirror",
    label: "Mirror",
    meaning: "The same prompts can be run through old and new paths.",
    exitGate: "Output quality and latency are measured."
  },
  {
    id: "canary",
    label: "Canary",
    meaning: "One private channel routes selected commands to Neonika.",
    exitGate: "Rollback is one config change."
  },
  {
    id: "primary",
    label: "Primary",
    meaning: "Neonika handles private Discord agent runs.",
    exitGate: "Mission Control and logs prove stability."
  },
  {
    id: "retire",
    label: "Retire",
    meaning: "The previous runtime becomes fallback or legacy.",
    exitGate: "Export, import, and rollback are documented."
  }
];

/**
 * The cutover stages in which Neonika is allowed to send real outbound
 * traffic. Canary opens outbound for one allowlisted channel; Primary keeps
 * outbound open once Neonika has become the primary handler. Every other
 * stage (shadow, mirror, retire) stays no-send. This is the single source of
 * truth shared by all outbound send paths so they never disagree on which
 * stages may send.
 */
export type TNeonOutboundStage = "canary" | "primary";

/** True when the given cutover stage may perform real outbound sends. */
export function isNeonOutboundStage(stage: TCutoverStageId): stage is TNeonOutboundStage {
  return stage === "canary" || stage === "primary";
}

/**
 * The stages that are a resting place rather than a step. `shadow` is where an
 * install sits while it only observes, `primary` is where it sits while it serves,
 * and `retire` is where it sits once the previous runtime is gone.
 *
 * `mirror` and `canary` are the transitional rungs: an install passing through them
 * is mid-migration and has an unfinished comparison or a partly-routed channel behind
 * it. That is what deserves an operator's attention — not the stage id itself.
 */
export function isNeonSteadyCutoverStage(stage: TCutoverStageId): boolean {
  return stage === "shadow" || stage === "primary" || stage === "retire";
}

/**
 * The stage an installation resolves to when nothing states otherwise — neither a
 * live `NEON_CUTOVER_STAGE`, nor a persisted promotion.
 *
 * `primary` rather than `shadow`, because the ladder below it exists to compare an
 * old runtime against a new one. A fresh install has no old runtime, so it can never
 * clear the mirror rung and would sit at the bottom of a climb it has no reason to
 * make. Starting at primary does not make it speak: outbound needs the approval flag,
 * the enabled flag and an injected transport on top of the stage, and a fresh install
 * has none of them.
 *
 * Promoted installations are unaffected — both a live env value and a persisted
 * promotion take precedence over this fallback.
 */
export const neonDefaultCutoverStage: TCutoverStageId = "primary";

/**
 * Reads and validates the cutover stage from an env record (the `NEON_CUTOVER_STAGE`
 * key). Returns undefined when absent or not a known stage id.
 *
 * Prefer {@link resolveCutoverStageFromEnv} — it answers "which stage am I on", which
 * is what nearly every caller wants. Reach for this one only to tell a *stated* stage
 * from a defaulted one, which is a question about operator intent rather than about
 * runtime state.
 */
export function readCutoverStageFromEnv(
  env: Readonly<Record<string, string | undefined>>
): TCutoverStageId | undefined {
  const raw = env["NEON_CUTOVER_STAGE"]?.trim();
  return neonikaCutoverStages.some((stage) => stage.id === raw)
    ? (raw as TCutoverStageId)
    : undefined;
}

/**
 * Resolves the effective cutover stage: the env value when it names a known stage,
 * otherwise {@link neonDefaultCutoverStage}. This is the single place the fallback
 * lives, so readers cannot drift apart on what an unconfigured install is.
 */
export function resolveCutoverStageFromEnv(
  env: Readonly<Record<string, string | undefined>>
): TCutoverStageId {
  return readCutoverStageFromEnv(env) ?? neonDefaultCutoverStage;
}

export interface IShadowExitGateFacts {
  readonly runCount: number;
  readonly shadowRunCount: number;
  readonly deliverySuppressedCount: number;
  readonly failedCount: number;
}

export interface IShadowExitGateEvidence {
  readonly met: boolean;
  readonly reasons: readonly string[];
}

/**
 * Evaluates the Shadow stage exit gate ("No production channel depends on it.")
 * against persisted Gateway run facts. Cleanliness is scoped to shadow-mode
 * runs: every shadow run must keep its delivery suppressed (no shadow leak), and
 * no run may have failed. Intentional live deliveries under a canary/primary
 * stage are a separate, expected category and do not re-violate this gate. With
 * the run-store invariant (shadow-mode <-> suppressed, live-mode <-> delivered)
 * a shadow leak surfaces as shadowRunCount !== deliverySuppressedCount. The
 * evaluation is read-only and never mutates the cutover stage.
 */
export function evaluateShadowExitGate(facts: IShadowExitGateFacts): IShadowExitGateEvidence {
  const hasShadowRuns = facts.shadowRunCount > 0;
  const shadowClean = hasShadowRuns && facts.shadowRunCount === facts.deliverySuppressedCount;
  const noFailures = facts.failedCount === 0;
  const met = hasShadowRuns && shadowClean && noFailures;

  const reasons: string[] = [
    hasShadowRuns
      ? `persisted shadow runs present (shadow=${facts.shadowRunCount}, runs=${facts.runCount})`
      : "no persisted shadow runs to inspect",
    shadowClean
      ? `every shadow run kept delivery suppressed (shadow=${facts.shadowRunCount}, suppressed=${facts.deliverySuppressedCount})`
      : `shadow delivery leak detected (shadow=${facts.shadowRunCount}, suppressed=${facts.deliverySuppressedCount})`,
    noFailures
      ? "no failed gateway runs"
      : `failed gateway runs present (failed=${facts.failedCount})`
  ];

  return { met, reasons };
}

export interface IMirrorExitGateFacts {
  readonly routeReady: boolean;
  readonly memoryReady: boolean;
  readonly mirrorEvidenceReady: boolean;
  readonly mirrorAcceptedCount: number;
}

export interface IMirrorExitGateEvidence {
  readonly met: boolean;
  readonly reasons: readonly string[];
}

/**
 * Evaluates the Mirror stage exit gate ("Output quality and latency are
 * measured.") against facts that already exist in the cutover pipeline. The
 * gate is met only when Discord routes are scoped, the memory check passes, and
 * the stored old-vs-new mirror evidence has reached the "ready" state. This
 * mirrors the existing inline condition used by the Mirror gate and introduces
 * no new quality or latency threshold: readiness is derived from the persisted
 * mirror-evidence verdicts (match/acceptable vs. drift/failed), not from a freely
 * chosen latency limit. The evaluation is read-only and never mutates state.
 */
export function evaluateMirrorExitGate(facts: IMirrorExitGateFacts): IMirrorExitGateEvidence {
  const met = facts.routeReady && facts.memoryReady && facts.mirrorEvidenceReady;

  const reasons: string[] = [
    facts.routeReady
      ? "discord routes are scoped"
      : "discord routes are not scoped yet",
    facts.memoryReady
      ? "memory check passes"
      : "memory check does not pass yet",
    facts.mirrorEvidenceReady
      ? `mirror comparison evidence is ready (accepted=${facts.mirrorAcceptedCount})`
      : `mirror comparison evidence is not ready (accepted=${facts.mirrorAcceptedCount})`
  ];

  return { met, reasons };
}

export type TCutoverGateState = "pass" | "warn" | "fail" | "locked";

export interface ICanaryExitGateFacts {
  readonly rollbackConfigured: boolean;
  readonly canaryApproved: boolean;
}

export interface ICanaryExitGateEvidence {
  readonly met: boolean;
  readonly reasons: readonly string[];
}

/**
 * Evaluates the Canary stage exit gate ("Rollback is one config change.")
 * against facts that already exist in the cutover pipeline. The gate is met only
 * when the preceding Mirror gate has passed, a one-command rollback is
 * configured, and the operator has explicitly approved canary routing. This mirrors the
 * existing inline condition used by the Canary gate and introduces no new
 * latency, quality, or error-rate threshold: readiness stays a function of the
 * mirror precondition plus the rollback and approval flags. The evaluation is
 * read-only and never mutates the cutover stage.
 */
export function evaluateCanaryExitGate(
  facts: ICanaryExitGateFacts,
  mirrorState: TCutoverGateState
): ICanaryExitGateEvidence {
  const mirrorPassed = mirrorState === "pass";
  const met = mirrorPassed && facts.rollbackConfigured && facts.canaryApproved;

  const reasons: string[] = [
    mirrorPassed
      ? "mirror gate passed"
      : `mirror gate not passed (state=${mirrorState})`,
    facts.rollbackConfigured
      ? "rollback configured"
      : "rollback not configured",
    facts.canaryApproved
      ? "canary approved"
      : "canary not approved"
  ];

  return { met, reasons };
}

export interface IPrimaryExitGateFacts {
  readonly primaryApproved: boolean;
  readonly doctorHasNoFailures: boolean;
  readonly completedCount: number;
  readonly failedCount: number;
}

export interface IPrimaryExitGateEvidence {
  readonly met: boolean;
  readonly reasons: readonly string[];
}

/**
 * Evaluates the Primary stage exit gate ("Mission Control and logs prove
 * stability.") against facts that already exist in the cutover pipeline. The
 * gate is met only when the preceding Canary gate has passed, the operator has approved
 * primary routing, Doctor reports no failing checks, and the runtime has reached
 * the existing stability bar (at least five completed runs with zero failures).
 * This mirrors the existing inline condition used by the Primary gate and
 * introduces no new threshold: the completedCount>=5 / failedCount===0 stability
 * bar is the pre-existing one, not a freshly chosen number. The evaluation is
 * read-only and never mutates the cutover stage.
 */
export function evaluatePrimaryExitGate(
  facts: IPrimaryExitGateFacts,
  canaryState: TCutoverGateState
): IPrimaryExitGateEvidence {
  const canaryPassed = canaryState === "pass";
  const stableRuns = facts.completedCount >= 5 && facts.failedCount === 0;
  const met = canaryPassed && facts.primaryApproved && facts.doctorHasNoFailures && stableRuns;

  const reasons: string[] = [
    canaryPassed
      ? "canary gate passed"
      : `canary gate not passed (state=${canaryState})`,
    facts.primaryApproved
      ? "primary approved"
      : "primary not approved",
    facts.doctorHasNoFailures
      ? "doctor reports no failures"
      : "doctor reports failures",
    stableRuns
      ? `stable runs present (completed=${facts.completedCount}, failed=${facts.failedCount})`
      : `not enough stable runs (completed=${facts.completedCount}, failed=${facts.failedCount})`
  ];

  return { met, reasons };
}

export interface IRetireExitGateFacts {
  readonly retireEvidenceReady: boolean;
  readonly rollbackConfigured: boolean;
}

export interface IRetireExitGateEvidence {
  readonly met: boolean;
  readonly reasons: readonly string[];
}

/**
 * Evaluates the Retire stage exit gate ("Export, import, and rollback are
 * documented.") against facts that already exist in the cutover pipeline. The
 * gate is met only when the preceding Primary gate has passed, export/import
 * proof is captured, and a one-command rollback remains configured. This mirrors
 * the existing inline condition used by the Retire gate and introduces no new
 * threshold. The evaluation is read-only and never mutates the cutover stage.
 */
export function evaluateRetireExitGate(
  facts: IRetireExitGateFacts,
  primaryState: TCutoverGateState
): IRetireExitGateEvidence {
  const primaryPassed = primaryState === "pass";
  const met = primaryPassed && facts.retireEvidenceReady && facts.rollbackConfigured;

  const reasons: string[] = [
    primaryPassed
      ? "primary gate passed"
      : `primary gate not passed (state=${primaryState})`,
    facts.retireEvidenceReady
      ? "retire evidence ready"
      : "retire evidence not ready",
    facts.rollbackConfigured
      ? "rollback configured"
      : "rollback not configured"
  ];

  return { met, reasons };
}

export interface ICutoverGateStateFacts {
  /** True when Doctor, gateway runs, or secrets prove a hard shadow failure. */
  readonly shadowFailed: boolean;
  readonly runCount: number;
  readonly shadowRunCount: number;
  readonly deliverySuppressedCount: number;
  readonly failedCount: number;
  readonly routeReady: boolean;
  readonly memoryReady: boolean;
  readonly mirrorEvidenceReady: boolean;
  readonly mirrorAcceptedCount: number;
  readonly rollbackConfigured: boolean;
  readonly canaryApproved: boolean;
  readonly primaryApproved: boolean;
  readonly doctorHasNoFailures: boolean;
  readonly completedCount: number;
  readonly retireEvidenceReady: boolean;
}

export interface ICutoverGateState {
  readonly id: TCutoverStageId;
  readonly state: TCutoverGateState;
}

/**
 * Derives the ordered state of all five cutover gates (shadow → retire) from
 * facts that already exist in the cutover pipeline. This is the single source of
 * truth for the gate cascade: each later gate is "locked" until its predecessor
 * passes, mirroring the exit-gate evaluators verbatim and introducing no new
 * threshold. The derivation is pure and read-only — it never mutates the cutover
 * stage and performs no IO.
 */
export function deriveCutoverGateStates(
  facts: ICutoverGateStateFacts
): readonly ICutoverGateState[] {
  const shadowExit = evaluateShadowExitGate({
    runCount: facts.runCount,
    shadowRunCount: facts.shadowRunCount,
    deliverySuppressedCount: facts.deliverySuppressedCount,
    failedCount: facts.failedCount
  });
  const shadowState: TCutoverGateState = facts.shadowFailed
    ? "fail"
    : shadowExit.met
      ? "pass"
      : "warn";

  const mirrorState: TCutoverGateState =
    shadowState !== "pass"
      ? "locked"
      : evaluateMirrorExitGate({
            routeReady: facts.routeReady,
            memoryReady: facts.memoryReady,
            mirrorEvidenceReady: facts.mirrorEvidenceReady,
            mirrorAcceptedCount: facts.mirrorAcceptedCount
          }).met
        ? "pass"
        : "warn";

  const canaryState: TCutoverGateState =
    mirrorState !== "pass"
      ? "locked"
      : evaluateCanaryExitGate(
            {
              rollbackConfigured: facts.rollbackConfigured,
              canaryApproved: facts.canaryApproved
            },
            mirrorState
          ).met
        ? "pass"
        : "warn";

  const primaryState: TCutoverGateState =
    canaryState !== "pass"
      ? "locked"
      : evaluatePrimaryExitGate(
            {
              primaryApproved: facts.primaryApproved,
              doctorHasNoFailures: facts.doctorHasNoFailures,
              completedCount: facts.completedCount,
              failedCount: facts.failedCount
            },
            canaryState
          ).met
        ? "pass"
        : "warn";

  const retireState: TCutoverGateState =
    primaryState !== "pass"
      ? "locked"
      : evaluateRetireExitGate(
            {
              retireEvidenceReady: facts.retireEvidenceReady,
              rollbackConfigured: facts.rollbackConfigured
            },
            primaryState
          ).met
        ? "pass"
        : "warn";

  return [
    { id: "shadow", state: shadowState },
    { id: "mirror", state: mirrorState },
    { id: "canary", state: canaryState },
    { id: "primary", state: primaryState },
    { id: "retire", state: retireState }
  ];
}

export function nextCutoverStage(current: TCutoverStageId): TCutoverStageId | null {
  const currentIndex = neonikaCutoverStages.findIndex((stage) => stage.id === current);

  if (currentIndex < 0) {
    return null;
  }

  return neonikaCutoverStages[currentIndex + 1]?.id ?? null;
}

export function renderCutoverPlan(): string {
  return neonikaCutoverStages
    .map((stage) => `${stage.label}: ${stage.meaning}\n  Exit: ${stage.exitGate}`)
    .join("\n\n");
}

/**
 * Reads a trimmed, non-empty cutover env value. Single source of truth for how
 * cutover approval flags are parsed from the environment, shared by the cutover
 * gate snapshot and the doctor so both derive the gate cascade from identical
 * inputs (no divergence between the health view and the live cutover report).
 */
export function readOptionalCutoverEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string
): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/** True when a cutover approval env flag is set to a ready-like value. */
export function readReadyCutoverEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string
): boolean {
  const value = readOptionalCutoverEnv(env, key)?.toLowerCase();
  return value === "ready" || value === "true" || value === "1" || value === "yes";
}
