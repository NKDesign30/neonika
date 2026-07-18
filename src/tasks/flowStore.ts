import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  parseNeonFlowDefinition,
  projectNeonFlowDefinitions,
  type INeonFlowDefinition,
  type INeonFlowStep,
  type INeonFlowTrigger
} from "./flowModel.js";

/**
 * Append-only Neon Flow store.
 *
 * Flow definitions are internal bookkeeping (like tasks and shadow runs) and are
 * written freely to `state/flows/flows.jsonl`. Persisting a flow is not
 * automation — flows only execute through the dry-run planner, and gated steps
 * never run. Free text (name/description/trigger match/step title/action/note)
 * is redacted on write and on read, so a hand-edited line can never leak.
 */

const DEFAULT_STATE_ROOT = "state";
const FLOWS_STATE_DIR = "flows";
const FLOWS_FILE = "flows.jsonl";

export interface INeonFlowStatePaths {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly flowsRoot: string;
  readonly flowsPath: string;
}

export interface INeonFlowReadOptions {
  readonly maxRecords?: number;
}

export function resolveNeonFlowStatePaths(projectRoot: string): INeonFlowStatePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, DEFAULT_STATE_ROOT);
  const flowsRoot = join(stateRoot, FLOWS_STATE_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    stateRoot,
    flowsRoot,
    flowsPath: join(flowsRoot, FLOWS_FILE)
  };
}

export async function writeNeonFlow(projectRoot: string, flow: INeonFlowDefinition): Promise<void> {
  const paths = resolveNeonFlowStatePaths(projectRoot);
  const safeFlow = redactFlowDefinition(flow);

  await mkdir(dirname(paths.flowsPath), { recursive: true });
  await appendFile(paths.flowsPath, `${JSON.stringify(safeFlow)}\n`, "utf8");
}

export async function readNeonFlowRecords(
  projectRoot: string,
  options: INeonFlowReadOptions = {}
): Promise<readonly INeonFlowDefinition[]> {
  const paths = resolveNeonFlowStatePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.flowsPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const flows = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseFlowLine)
    .filter((flow): flow is INeonFlowDefinition => flow !== undefined);

  return options.maxRecords ? flows.slice(-options.maxRecords) : flows;
}

export async function readNeonFlows(
  projectRoot: string,
  options: INeonFlowReadOptions = {}
): Promise<readonly INeonFlowDefinition[]> {
  const flows = await readNeonFlowRecords(projectRoot, options);

  return projectNeonFlowDefinitions(flows);
}

export async function readNeonFlow(
  projectRoot: string,
  flowId: string
): Promise<INeonFlowDefinition | undefined> {
  const flows = await readNeonFlows(projectRoot);

  return flows.find((flow) => flow.flowId === flowId);
}

export function redactFlowDefinition(flow: INeonFlowDefinition): INeonFlowDefinition {
  return {
    flowId: flow.flowId,
    name: redactText(flow.name),
    ...(flow.description ? { description: redactText(flow.description) } : {}),
    ownerAgentId: flow.ownerAgentId,
    trigger: redactTrigger(flow.trigger),
    steps: flow.steps.map(redactStep),
    status: flow.status,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt
  };
}

function redactTrigger(trigger: INeonFlowTrigger): INeonFlowTrigger {
  return {
    kind: trigger.kind,
    ...(trigger.match ? { match: redactText(trigger.match) } : {})
  };
}

function redactStep(step: INeonFlowStep): INeonFlowStep {
  return {
    stepId: step.stepId,
    title: redactText(step.title),
    effect: step.effect,
    action: redactText(step.action),
    gated: step.gated,
    ...(step.note ? { note: redactText(step.note) } : {})
  };
}

function parseFlowLine(line: string): INeonFlowDefinition | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  const flow = parseNeonFlowDefinition(parsed);

  return flow ? redactFlowDefinition(flow) : undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
