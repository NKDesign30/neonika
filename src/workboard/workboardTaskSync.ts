import { redactText } from "../harness/redaction.js";
import {
  isNeonTaskChannel,
  type INeonTaskRecord,
  type TNeonTaskStatus
} from "../tasks/taskModel.js";
import { writeNeonTask } from "../tasks/taskStore.js";
import type { INeonWorkboardCard } from "./workboardModel.js";

const SUMMARY_MAX_LENGTH = 280;

export interface ISyncNeonWorkboardCardTaskOptions {
  readonly card: INeonWorkboardCard;
  readonly status: Extract<TNeonTaskStatus, "blocked" | "cancelled" | "done">;
  readonly summary?: string | undefined;
  readonly runId?: string | undefined;
  readonly nowMs: number;
}

export type TSyncNeonWorkboardCardTaskResult =
  | { readonly state: "skipped"; readonly reason: "missing-task-id" }
  | { readonly state: "written"; readonly task: INeonTaskRecord };

export async function syncNeonWorkboardCardTask(
  projectRoot: string,
  options: ISyncNeonWorkboardCardTaskOptions
): Promise<TSyncNeonWorkboardCardTaskResult> {
  const taskId = options.card.taskId?.trim();
  if (!taskId) {
    return { state: "skipped", reason: "missing-task-id" };
  }

  const nowIso = new Date(options.nowMs).toISOString();
  const source = options.card.metadata?.source;
  const channel = isNeonTaskChannel(source?.channel) ? source.channel : "cli";
  const sourceRef = source?.dedupeKey ?? source?.messageId ?? options.card.id;
  const summary = options.summary ? redactText(options.summary).slice(0, SUMMARY_MAX_LENGTH) : undefined;
  const runIds = options.runId ? [options.runId] : options.card.runId ? [options.card.runId] : [];
  const links = [
    ...(options.runId ? [{ type: "run" as const, ref: options.runId }] : []),
    ...(options.card.sourceUrl ? [{ type: "url" as const, ref: options.card.sourceUrl }] : [])
  ];

  const task: INeonTaskRecord = {
    taskId,
    title: redactText(options.card.title),
    ...(summary ? { summary } : {}),
    source: channel === "cli" ? "operator" : "channel",
    sourceRef,
    channel,
    ...(source?.channelId ? { channelId: source.channelId } : {}),
    ownerAgentId: options.card.agentId ?? "workboard-autopilot",
    status: options.status,
    priority: options.card.priority,
    labels: [...new Set(["workboard", ...options.card.labels, options.status])].slice(0, 20),
    links,
    runIds,
    createdAt: new Date(options.card.createdAt).toISOString(),
    updatedAt: nowIso
  };

  await writeNeonTask(projectRoot, task);

  return { state: "written", task };
}
