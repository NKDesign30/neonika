/**
 * Neon Flow data model.
 *
 * A flow is a declarative playbook: a trigger plus an ordered list of steps. Each
 * step declares a side-effect class (read/write/send/exec) and whether it is
 * gated. Flows are never auto-executed — the planner (flowPlan.ts) turns a flow
 * into a dry-run execution plan where any gated or side-effecting step is marked
 * blocked. This honors the central invariant "no ungated automation".
 *
 * Shape reference: upstream managed TaskFlows (src/tasks/task-flow-registry.ts —
 * goal/currentStep/state) and the workboard extension, rebuilt Neon-native rather
 * than copied. This module is pure (types + strict no-throw parsers); redaction
 * lives in flowStore.ts.
 */

export type TNeonFlowTriggerKind =
  | "manual"
  | "channel-message"
  | "schedule"
  | "run-completed"
  | "memory-event";

/** The side-effect class of a step. Only `read` is safe to simulate; the rest are gated. */
export type TNeonFlowStepEffect = "read" | "write" | "send" | "exec";

export type TNeonFlowStatus = "draft" | "armed" | "disabled";

export interface INeonFlowTrigger {
  readonly kind: TNeonFlowTriggerKind;
  readonly match?: string;
}

export interface INeonFlowStep {
  readonly stepId: string;
  readonly title: string;
  readonly effect: TNeonFlowStepEffect;
  readonly action: string;
  readonly gated: boolean;
  readonly note?: string;
}

export interface INeonFlowDefinition {
  readonly flowId: string;
  readonly name: string;
  readonly description?: string;
  readonly ownerAgentId: string;
  readonly trigger: INeonFlowTrigger;
  readonly steps: readonly INeonFlowStep[];
  readonly status: TNeonFlowStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const neonFlowStatusOrder: readonly TNeonFlowStatus[] = ["armed", "draft", "disabled"];

const MAX_FLOW_STEPS = 64;
const MAX_REFERENCE_LENGTH = 400;

export function isNeonFlowTriggerKind(value: unknown): value is TNeonFlowTriggerKind {
  return (
    value === "manual" ||
    value === "channel-message" ||
    value === "schedule" ||
    value === "run-completed" ||
    value === "memory-event"
  );
}

export function isNeonFlowStepEffect(value: unknown): value is TNeonFlowStepEffect {
  return value === "read" || value === "write" || value === "send" || value === "exec";
}

export function isNeonFlowStatus(value: unknown): value is TNeonFlowStatus {
  return value === "draft" || value === "armed" || value === "disabled";
}

/**
 * A step is gated whenever it carries a non-read side effect. A read step may
 * still be explicitly gated by the author, but write/send/exec are always gated:
 * the planner can never downgrade a side-effecting step to plannable.
 */
export function isNeonFlowStepGated(effect: TNeonFlowStepEffect, explicitGated: boolean): boolean {
  return effect !== "read" ? true : explicitGated;
}

export function parseNeonFlowDefinition(value: unknown): INeonFlowDefinition | undefined {
  if (!isFlowObject(value)) {
    return undefined;
  }

  const trigger = parseNeonFlowTrigger(value["trigger"]);

  if (
    typeof value["flowId"] !== "string" ||
    value["flowId"].length === 0 ||
    typeof value["name"] !== "string" ||
    typeof value["ownerAgentId"] !== "string" ||
    value["ownerAgentId"].length === 0 ||
    !trigger ||
    !isNeonFlowStatus(value["status"]) ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    flowId: value["flowId"],
    name: value["name"],
    ...(isNonEmptyString(value["description"]) ? { description: value["description"] } : {}),
    ownerAgentId: value["ownerAgentId"],
    trigger,
    steps: parseNeonFlowSteps(value["steps"]),
    status: value["status"],
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"]
  };
}

export function parseNeonFlowTrigger(value: unknown): INeonFlowTrigger | undefined {
  if (!isFlowObject(value) || !isNeonFlowTriggerKind(value["kind"])) {
    return undefined;
  }

  return {
    kind: value["kind"],
    ...(isNonEmptyString(value["match"]) ? { match: clampReference(value["match"]) } : {})
  };
}

export function parseNeonFlowStep(value: unknown): INeonFlowStep | undefined {
  if (!isFlowObject(value)) {
    return undefined;
  }

  if (
    typeof value["stepId"] !== "string" ||
    value["stepId"].length === 0 ||
    typeof value["title"] !== "string" ||
    !isNeonFlowStepEffect(value["effect"]) ||
    typeof value["action"] !== "string"
  ) {
    return undefined;
  }

  const explicitGated = value["gated"] === true;

  return {
    stepId: value["stepId"],
    title: value["title"],
    effect: value["effect"],
    action: clampReference(value["action"]),
    gated: isNeonFlowStepGated(value["effect"], explicitGated),
    ...(isNonEmptyString(value["note"]) ? { note: value["note"] } : {})
  };
}

/**
 * Collapse an append-only flow log to the latest definition per flowId, in the
 * order each flowId first appeared (mirrors projectNeonTaskRecords).
 */
export function projectNeonFlowDefinitions(
  flows: readonly INeonFlowDefinition[]
): readonly INeonFlowDefinition[] {
  const latest = new Map<string, INeonFlowDefinition>();
  const order: string[] = [];

  for (const flow of flows) {
    if (!latest.has(flow.flowId)) {
      order.push(flow.flowId);
    }
    latest.set(flow.flowId, flow);
  }

  return order.map((flowId) => latest.get(flowId)).filter(isDefinedFlow);
}

function parseNeonFlowSteps(value: unknown): readonly INeonFlowStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const steps: INeonFlowStep[] = [];
  for (const candidate of value) {
    if (steps.length >= MAX_FLOW_STEPS) {
      break;
    }

    const step = parseNeonFlowStep(candidate);
    if (step) {
      steps.push(step);
    }
  }

  return steps;
}

function clampReference(value: string): string {
  return value.length > MAX_REFERENCE_LENGTH ? value.slice(0, MAX_REFERENCE_LENGTH) : value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFlowObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDefinedFlow(value: INeonFlowDefinition | undefined): value is INeonFlowDefinition {
  return value !== undefined;
}
