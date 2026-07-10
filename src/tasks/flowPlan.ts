import {
  neonFlowStatusOrder,
  type INeonFlowDefinition,
  type INeonFlowStep,
  type INeonFlowTrigger,
  type TNeonFlowStepEffect,
  type TNeonFlowStatus
} from "./flowModel.js";
import { readNeonFlows, resolveNeonFlowStatePaths } from "./flowStore.js";

/**
 * Neon Flow planning + projection.
 *
 * The planner is the only way a flow "runs": it produces a descriptive dry-run
 * execution plan and executes nothing. Every step is classified as either
 * `plan` (a read-only step safe to simulate) or `blocked` (a gated/side-effecting
 * step that needs explicit approval). The plan's `executable` field is the
 * literal `false`, so it can never signal "go" — autonomous execution is not a
 * code path here, by construction. This is the "default plan/dry-run, no ungated
 * automation" invariant in type form.
 */

export type TNeonFlowStepDecision = "plan" | "blocked";

export type TNeonFlowStepDecisionReason =
  | "read-only-step"
  | "gated-side-effect"
  | "explicitly-gated"
  | "flow-disabled";

export interface INeonFlowPlannedStep {
  readonly stepId: string;
  readonly title: string;
  readonly effect: TNeonFlowStepEffect;
  readonly action: string;
  readonly decision: TNeonFlowStepDecision;
  readonly reason: TNeonFlowStepDecisionReason;
}

export interface INeonFlowPlanTotals {
  readonly steps: number;
  readonly plannable: number;
  readonly blocked: number;
  readonly gatedActions: number;
  /** Blocked steps awaiting human approval (excludes steps blocked only because the flow is disabled). */
  readonly waitingApproval: number;
}

/**
 * A single step held in the dry-run plan because it needs explicit human approval
 * before it could ever run. This is a read-only projection — surfacing it never
 * authorizes the step; `INeonFlowExecutionPlan.executable` stays the literal false.
 */
export interface INeonFlowWaitingApprovalStep {
  readonly stepId: string;
  readonly title: string;
  readonly effect: TNeonFlowStepEffect;
  readonly action: string;
  readonly reason: TNeonFlowStepDecisionReason;
}

export interface INeonFlowExecutionPlan {
  readonly flowId: string;
  readonly name: string;
  readonly mode: "dry-run";
  readonly generatedAt: string;
  readonly ownerAgentId: string;
  readonly status: TNeonFlowStatus;
  readonly trigger: INeonFlowTrigger;
  /** Literal false: a plan never authorizes execution. Gated steps require human approval out-of-band. */
  readonly executable: false;
  readonly totals: INeonFlowPlanTotals;
  readonly steps: readonly INeonFlowPlannedStep[];
  /** Steps blocked specifically on human approval, projected for the operator. Read-only. */
  readonly waitingApproval: readonly INeonFlowWaitingApprovalStep[];
  readonly safety: INeonFlowPlanSafety;
}

export interface INeonFlowPlanSafety {
  readonly autonomousExecution: false;
  readonly gatedActionsRequireApproval: true;
  readonly cutoverStage: "shadow";
}

export interface ICreateNeonFlowPlanOptions {
  readonly now?: () => Date;
}

const flowPlanSafety: INeonFlowPlanSafety = {
  autonomousExecution: false,
  gatedActionsRequireApproval: true,
  cutoverStage: "shadow"
};

export function planNeonFlowExecution(
  flow: INeonFlowDefinition,
  options: ICreateNeonFlowPlanOptions = {}
): INeonFlowExecutionPlan {
  const steps = flow.steps.map((step) => planFlowStep(step, flow.status));
  const blocked = steps.filter((step) => step.decision === "blocked").length;
  const gatedActions = flow.steps.filter((step) => step.gated).length;
  const waitingApproval = steps
    .filter((step) => step.decision === "blocked" && step.reason !== "flow-disabled")
    .map((step) => ({
      stepId: step.stepId,
      title: step.title,
      effect: step.effect,
      action: step.action,
      reason: step.reason
    }));

  return {
    flowId: flow.flowId,
    name: flow.name,
    mode: "dry-run",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    ownerAgentId: flow.ownerAgentId,
    status: flow.status,
    trigger: flow.trigger,
    executable: false,
    totals: {
      steps: steps.length,
      plannable: steps.length - blocked,
      blocked,
      gatedActions,
      waitingApproval: waitingApproval.length
    },
    steps,
    waitingApproval,
    safety: flowPlanSafety
  };
}

export function renderNeonFlowPlanReport(plan: INeonFlowExecutionPlan): string {
  const header = [
    `Neon Flow plan: ${plan.name} (${plan.flowId})`,
    `Mode: ${plan.mode} · executable: ${plan.executable} · status: ${plan.status}`,
    `Trigger: ${plan.trigger.kind}${plan.trigger.match ? ` (${plan.trigger.match})` : ""}`,
    `Steps: ${plan.totals.steps} · plannable: ${plan.totals.plannable} · blocked: ${plan.totals.blocked} · ` +
      `gated: ${plan.totals.gatedActions} · waiting approval: ${plan.totals.waitingApproval}`
  ];

  const stepLines = plan.steps.map((step, index) => {
    const marker = step.decision === "blocked" ? "BLOCKED" : "plan";
    return `   ${index + 1}. [${marker}] ${step.title} (${step.effect}:${step.action}) — ${step.reason}`;
  });

  const approvalLines =
    plan.waitingApproval.length > 0
      ? [
          `Waiting for approval (${plan.waitingApproval.length}):`,
          ...plan.waitingApproval.map((step) => `   · ${step.title} (${step.effect}:${step.action}) — ${step.reason}`)
        ]
      : [];

  return [...header, ...stepLines, ...approvalLines].join("\n");
}

export type TNeonFlowsSnapshotState = "ready" | "empty";

export type TNeonFlowStatusCounts = Readonly<Record<TNeonFlowStatus, number>>;

export interface INeonFlowSummary {
  readonly flowId: string;
  readonly name: string;
  readonly ownerAgentId: string;
  readonly status: TNeonFlowStatus;
  readonly triggerKind: INeonFlowTrigger["kind"];
  readonly stepCount: number;
  readonly gatedStepCount: number;
  readonly updatedAt: string;
}

export interface INeonFlowsTotals {
  readonly flows: number;
  readonly armed: number;
  readonly gatedSteps: number;
  readonly byStatus: TNeonFlowStatusCounts;
}

export interface INeonFlowsSnapshot {
  readonly state: TNeonFlowsSnapshotState;
  readonly generatedAt: string;
  readonly totals: INeonFlowsTotals;
  readonly source: ReturnType<typeof resolveNeonFlowStatePaths>;
  readonly flows: readonly INeonFlowSummary[];
}

export interface ICreateNeonFlowsSnapshotOptions {
  readonly maxRecords?: number;
  readonly now?: () => Date;
}

export async function createNeonFlowsSnapshot(
  projectRoot: string,
  options: ICreateNeonFlowsSnapshotOptions = {}
): Promise<INeonFlowsSnapshot> {
  const flows = await readNeonFlows(
    projectRoot,
    options.maxRecords ? { maxRecords: options.maxRecords } : {}
  );
  const summaries = flows.map(summarizeFlow).sort((left, right) => {
    const statusDelta = statusRank(left.status) - statusRank(right.status);
    return statusDelta !== 0 ? statusDelta : right.updatedAt.localeCompare(left.updatedAt);
  });

  return {
    state: summaries.length > 0 ? "ready" : "empty",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    totals: computeFlowsTotals(summaries),
    source: resolveNeonFlowStatePaths(projectRoot),
    flows: summaries
  };
}

export function renderNeonFlowsReport(snapshot: INeonFlowsSnapshot): string {
  const header = [
    `Neon Flows: ${snapshot.state}`,
    `Flows: ${snapshot.totals.flows} (armed ${snapshot.totals.armed}) · gated steps: ${snapshot.totals.gatedSteps}`
  ];

  const flowLines = snapshot.flows.map((flow) => {
    return `   - [${flow.status}] ${flow.name} <${flow.triggerKind}> steps=${flow.stepCount} gated=${flow.gatedStepCount} (${flow.flowId})`;
  });

  return [...header, ...flowLines].join("\n");
}

function planFlowStep(step: INeonFlowStep, status: TNeonFlowStatus): INeonFlowPlannedStep {
  const decision = resolveStepDecision(step, status);

  return {
    stepId: step.stepId,
    title: step.title,
    effect: step.effect,
    action: step.action,
    decision: decision.decision,
    reason: decision.reason
  };
}

function resolveStepDecision(
  step: INeonFlowStep,
  status: TNeonFlowStatus
): { decision: TNeonFlowStepDecision; reason: TNeonFlowStepDecisionReason } {
  if (status === "disabled") {
    return { decision: "blocked", reason: "flow-disabled" };
  }

  if (step.effect !== "read") {
    return { decision: "blocked", reason: "gated-side-effect" };
  }

  if (step.gated) {
    return { decision: "blocked", reason: "explicitly-gated" };
  }

  return { decision: "plan", reason: "read-only-step" };
}

function summarizeFlow(flow: INeonFlowDefinition): INeonFlowSummary {
  return {
    flowId: flow.flowId,
    name: flow.name,
    ownerAgentId: flow.ownerAgentId,
    status: flow.status,
    triggerKind: flow.trigger.kind,
    stepCount: flow.steps.length,
    gatedStepCount: flow.steps.filter((step) => step.gated).length,
    updatedAt: flow.updatedAt
  };
}

function computeFlowsTotals(summaries: readonly INeonFlowSummary[]): INeonFlowsTotals {
  const byStatus = createStatusCounts();
  let gatedSteps = 0;

  for (const summary of summaries) {
    byStatus[summary.status] += 1;
    gatedSteps += summary.gatedStepCount;
  }

  return {
    flows: summaries.length,
    armed: byStatus.armed,
    gatedSteps,
    byStatus
  };
}

function statusRank(status: TNeonFlowStatus): number {
  const index = neonFlowStatusOrder.indexOf(status);

  return index === -1 ? neonFlowStatusOrder.length : index;
}

function createStatusCounts(): Record<TNeonFlowStatus, number> {
  return {
    draft: 0,
    armed: 0,
    disabled: 0
  };
}
