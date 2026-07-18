import type { TNeonChannel } from "../harness/types.js";

/**
 * Neonika Tasks data model.
 *
 * A task is the unit of visible work on the Neonika Workboard. The shape mirrors the
 * goal contract fields (taskId, source, channel, owner agent, status, priority,
 * due, links, runIds) plus the minimal bookkeeping needed to project a board
 * (title, timestamps, labels). This module is pure: it owns the types and the
 * strict, no-throw parsers used to read persisted JSONL lines. Redaction of free
 * text lives in the store (taskStore.ts), exactly like gateway/types.ts stays
 * pure while gateway/runStore.ts redacts on write.
 */

export type TNeonTaskStatus =
  | "backlog"
  | "ready"
  | "in-progress"
  | "blocked"
  | "done"
  | "cancelled";

export type TNeonTaskPriority = "low" | "normal" | "high" | "urgent";

/** Where the task originated. Operator-created, derived from a channel message, spawned by a flow, lifted from a run/memory/doctor signal. */
export type TNeonTaskSource = "operator" | "channel" | "flow" | "run" | "memory" | "doctor";

/** Reference kinds a task can link to. `url` refs are still redacted as free text on write. */
export type TNeonTaskLinkType =
  | "run"
  | "session"
  | "conversation"
  | "flow"
  | "task"
  | "memory"
  | "url";

export interface INeonTaskLink {
  readonly type: TNeonTaskLinkType;
  readonly ref: string;
  readonly label?: string;
}

export interface INeonTaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly summary?: string;
  readonly source: TNeonTaskSource;
  readonly sourceRef?: string;
  readonly channel: TNeonChannel;
  readonly channelId?: string;
  readonly ownerAgentId: string;
  readonly status: TNeonTaskStatus;
  readonly priority: TNeonTaskPriority;
  readonly due?: string;
  readonly labels: readonly string[];
  readonly links: readonly INeonTaskLink[];
  readonly runIds: readonly string[];
  readonly flowId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const neonTaskStatusOrder: readonly TNeonTaskStatus[] = [
  "backlog",
  "ready",
  "in-progress",
  "blocked",
  "done",
  "cancelled"
];

export const neonTaskPriorityOrder: readonly TNeonTaskPriority[] = [
  "urgent",
  "high",
  "normal",
  "low"
];

const MAX_TASK_LABELS = 16;
const MAX_TASK_LINKS = 32;
const MAX_TASK_RUN_IDS = 64;
const MAX_REFERENCE_LENGTH = 400;

export function isNeonTaskStatus(value: unknown): value is TNeonTaskStatus {
  return (
    value === "backlog" ||
    value === "ready" ||
    value === "in-progress" ||
    value === "blocked" ||
    value === "done" ||
    value === "cancelled"
  );
}

export function isNeonTaskPriority(value: unknown): value is TNeonTaskPriority {
  return value === "low" || value === "normal" || value === "high" || value === "urgent";
}

export function isNeonTaskSource(value: unknown): value is TNeonTaskSource {
  return (
    value === "operator" ||
    value === "channel" ||
    value === "flow" ||
    value === "run" ||
    value === "memory" ||
    value === "doctor"
  );
}

export function isNeonTaskLinkType(value: unknown): value is TNeonTaskLinkType {
  return (
    value === "run" ||
    value === "session" ||
    value === "conversation" ||
    value === "flow" ||
    value === "task" ||
    value === "memory" ||
    value === "url"
  );
}

export function isNeonTaskChannel(value: unknown): value is TNeonChannel {
  return (
    value === "discord" ||
    value === "telegram" ||
    value === "whatsapp" ||
    value === "webchat" ||
    value === "cli" ||
    value === "device"
  );
}

/**
 * Strict, no-throw parser for one persisted task line. Returns undefined for any
 * malformed shape so the store can drop bad lines instead of crashing, matching
 * the gateway run store's parse-and-skip contract. Free text is taken as-is here;
 * the store re-redacts on read so a hand-edited file can never leak.
 */
export function parseNeonTaskRecord(value: unknown): INeonTaskRecord | undefined {
  if (!isTaskRecordObject(value)) {
    return undefined;
  }

  if (
    typeof value["taskId"] !== "string" ||
    value["taskId"].length === 0 ||
    typeof value["title"] !== "string" ||
    !isNeonTaskSource(value["source"]) ||
    !isNeonTaskChannel(value["channel"]) ||
    typeof value["ownerAgentId"] !== "string" ||
    value["ownerAgentId"].length === 0 ||
    !isNeonTaskStatus(value["status"]) ||
    !isNeonTaskPriority(value["priority"]) ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string"
  ) {
    return undefined;
  }

  const labels = parseStringList(value["labels"], MAX_TASK_LABELS);
  const runIds = parseStringList(value["runIds"], MAX_TASK_RUN_IDS);
  const links = parseTaskLinks(value["links"]);

  return {
    taskId: value["taskId"],
    title: value["title"],
    ...(isNonEmptyString(value["summary"]) ? { summary: value["summary"] } : {}),
    source: value["source"],
    ...(isNonEmptyString(value["sourceRef"]) ? { sourceRef: value["sourceRef"] } : {}),
    channel: value["channel"],
    ...(isNonEmptyString(value["channelId"]) ? { channelId: value["channelId"] } : {}),
    ownerAgentId: value["ownerAgentId"],
    status: value["status"],
    priority: value["priority"],
    ...(isNonEmptyString(value["due"]) ? { due: value["due"] } : {}),
    labels,
    links,
    runIds,
    ...(isNonEmptyString(value["flowId"]) ? { flowId: value["flowId"] } : {}),
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"]
  };
}

export function parseNeonTaskLink(value: unknown): INeonTaskLink | undefined {
  if (!isTaskRecordObject(value)) {
    return undefined;
  }

  if (!isNeonTaskLinkType(value["type"]) || !isNonEmptyString(value["ref"])) {
    return undefined;
  }

  return {
    type: value["type"],
    ref: clampReference(value["ref"]),
    ...(isNonEmptyString(value["label"]) ? { label: clampReference(value["label"]) } : {})
  };
}

/**
 * Collapse an append-only task event log into the latest record per taskId.
 *
 * The store is append-only (like the gateway run store), so a task update writes
 * a new line carrying the same taskId. The latest line in file order wins,
 * giving update semantics without rewriting the file. Order of the returned
 * records is the order each taskId was first seen.
 */
export function projectNeonTaskRecords(
  records: readonly INeonTaskRecord[]
): readonly INeonTaskRecord[] {
  const latest = new Map<string, INeonTaskRecord>();
  const order: string[] = [];

  for (const record of records) {
    if (!latest.has(record.taskId)) {
      order.push(record.taskId);
    }
    latest.set(record.taskId, record);
  }

  return order.map((taskId) => latest.get(taskId)).filter(isDefinedTask);
}

function parseTaskLinks(value: unknown): readonly INeonTaskLink[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const links: INeonTaskLink[] = [];
  for (const candidate of value) {
    if (links.length >= MAX_TASK_LINKS) {
      break;
    }

    const link = parseNeonTaskLink(candidate);
    if (link) {
      links.push(link);
    }
  }

  return links;
}

function parseStringList(value: unknown, max: number): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: string[] = [];
  for (const candidate of value) {
    if (items.length >= max) {
      break;
    }

    if (isNonEmptyString(candidate)) {
      items.push(clampReference(candidate));
    }
  }

  return items;
}

function clampReference(value: string): string {
  return value.length > MAX_REFERENCE_LENGTH ? value.slice(0, MAX_REFERENCE_LENGTH) : value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTaskRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDefinedTask(value: INeonTaskRecord | undefined): value is INeonTaskRecord {
  return value !== undefined;
}
