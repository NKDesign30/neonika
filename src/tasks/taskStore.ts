import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  parseNeonTaskRecord,
  projectNeonTaskRecords,
  type INeonTaskLink,
  type INeonTaskRecord
} from "./taskModel.js";

/**
 * Append-only Neon Task store.
 *
 * Tasks are internal Workboard bookkeeping (like gateway shadow runs), so the
 * store writes freely to `state/tasks/tasks.jsonl` — this is observability state,
 * not outbound automation. Updates are appended as new lines carrying the same
 * taskId; readers collapse to the latest per id via projectNeonTaskRecords.
 *
 * Every free-text field is redacted both on write and on read, so a hand-edited
 * line can never leak a secret to a snapshot, API response, or report.
 */

const DEFAULT_STATE_ROOT = "state";
const TASKS_STATE_DIR = "tasks";
const TASKS_FILE = "tasks.jsonl";

export interface INeonTaskStatePaths {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly tasksRoot: string;
  readonly tasksPath: string;
}

export interface INeonTaskReadOptions {
  readonly maxRecords?: number;
}

export function resolveNeonTaskStatePaths(projectRoot: string): INeonTaskStatePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, DEFAULT_STATE_ROOT);
  const tasksRoot = join(stateRoot, TASKS_STATE_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    stateRoot,
    tasksRoot,
    tasksPath: join(tasksRoot, TASKS_FILE)
  };
}

export async function writeNeonTask(projectRoot: string, task: INeonTaskRecord): Promise<void> {
  const paths = resolveNeonTaskStatePaths(projectRoot);
  const safeTask = redactTaskRecord(task);

  await mkdir(dirname(paths.tasksPath), { recursive: true });
  await appendFile(paths.tasksPath, `${JSON.stringify(safeTask)}\n`, "utf8");
}

/**
 * Read every persisted task line in file order, redacted. Malformed lines are
 * dropped. Pass maxRecords to keep only the most recent N appended lines.
 */
export async function readNeonTaskRecords(
  projectRoot: string,
  options: INeonTaskReadOptions = {}
): Promise<readonly INeonTaskRecord[]> {
  const paths = resolveNeonTaskStatePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.tasksPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const records = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseTaskLine)
    .filter((record): record is INeonTaskRecord => record !== undefined);

  return options.maxRecords ? records.slice(-options.maxRecords) : records;
}

/**
 * Read tasks collapsed to the latest record per taskId (the current board state).
 */
export async function readNeonTasks(
  projectRoot: string,
  options: INeonTaskReadOptions = {}
): Promise<readonly INeonTaskRecord[]> {
  const records = await readNeonTaskRecords(projectRoot, options);

  return projectNeonTaskRecords(records);
}

export function redactTaskRecord(task: INeonTaskRecord): INeonTaskRecord {
  return {
    taskId: task.taskId,
    title: redactText(task.title),
    ...(task.summary ? { summary: redactText(task.summary) } : {}),
    source: task.source,
    ...(task.sourceRef ? { sourceRef: redactText(task.sourceRef) } : {}),
    channel: task.channel,
    ...(task.channelId ? { channelId: task.channelId } : {}),
    ownerAgentId: task.ownerAgentId,
    status: task.status,
    priority: task.priority,
    ...(task.due ? { due: task.due } : {}),
    labels: task.labels.map(redactText),
    links: task.links.map(redactTaskLink),
    runIds: task.runIds,
    ...(task.flowId ? { flowId: task.flowId } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function redactTaskLink(link: INeonTaskLink): INeonTaskLink {
  return {
    type: link.type,
    ref: redactText(link.ref),
    ...(link.label ? { label: redactText(link.label) } : {})
  };
}

function parseTaskLine(line: string): INeonTaskRecord | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  const record = parseNeonTaskRecord(parsed);

  return record ? redactTaskRecord(record) : undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
