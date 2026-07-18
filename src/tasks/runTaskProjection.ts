import { redactText } from "../harness/redaction.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import type { INeonTaskRecord } from "./taskModel.js";

// Read-only projection: lift a terminal gateway run into a task
// record for the operator "runs as tasks" surface (parity gap row 454).
//
// This NEVER persists (no writeNeonTask) and NEVER spawns a run — it is a pure
// view over the terminal run store. The live task executor (subagent/ACP/cron run
// lifecycle) stays cutover-gated; this slice only surfaces the runs that already
// finished as a derived task list. All projected text crosses the HTTP boundary,
// so titles/summaries are redacted defensively even though the stored run is
// already redacted.

const TITLE_MAX_LENGTH = 120;
const SUMMARY_MAX_LENGTH = 280;

function deriveRunTaskTitle(run: INeonGatewayShadowRun): string {
  const preview = run.request.goal?.trim() ?? run.request.contentPreview.trim();
  const base = preview.length > 0 ? preview : `Run ${run.runId}`;
  return redactText(base).slice(0, TITLE_MAX_LENGTH);
}

export function mapNeonGatewayRunToTask(run: INeonGatewayShadowRun): INeonTaskRecord | undefined {
  // Only terminal runs project. Shadow runs are always terminal; the explicit guard
  // keeps the no-live-spawn contract visible and future-proofs a live "running" status.
  if (run.status === "running") {
    return undefined;
  }

  const summary = redactText(run.finalText.trim()).slice(0, SUMMARY_MAX_LENGTH);

  return {
    taskId: `run:${run.runId}`,
    title: deriveRunTaskTitle(run),
    ...(summary ? { summary } : {}),
    source: "run",
    sourceRef: run.runId,
    channel: run.request.channel,
    ...(run.request.channelId ? { channelId: run.request.channelId } : {}),
    ownerAgentId: run.request.agentId,
    status: run.status === "completed" ? "done" : run.status === "cancelled" ? "cancelled" : "blocked",
    priority: run.status === "failed" ? "high" : "normal",
    labels: ["run", run.status],
    links: [{ type: "run", ref: run.runId }],
    runIds: [run.runId],
    createdAt: run.startedAt,
    updatedAt: run.completedAt
  };
}

export type TNeonRunTaskProjectionState = "ready" | "empty";

export interface INeonRunTaskProjection {
  readonly state: TNeonRunTaskProjectionState;
  readonly taskCount: number;
  readonly doneCount: number;
  readonly blockedCount: number;
  readonly cancelledCount: number;
  readonly tasks: readonly INeonTaskRecord[];
}

export function createNeonRunTaskProjection(
  runs: readonly INeonGatewayShadowRun[]
): INeonRunTaskProjection {
  const tasks = runs
    .map((run) => mapNeonGatewayRunToTask(run))
    .filter((task): task is INeonTaskRecord => task !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return {
    state: tasks.length > 0 ? "ready" : "empty",
    taskCount: tasks.length,
    doneCount: tasks.filter((task) => task.status === "done").length,
    blockedCount: tasks.filter((task) => task.status === "blocked").length,
    cancelledCount: tasks.filter((task) => task.status === "cancelled").length,
    tasks
  };
}

// Leak-safe text report for CLI/log surfaces: status + redacted title + channel/agent
// labels only, never raw run content.
export function renderNeonRunTaskProjectionReport(projection: INeonRunTaskProjection): string {
  if (projection.state === "empty") {
    return "Neon run-tasks: no terminal runs to project (read-only, no spawn).";
  }
  const lines = [
    `Neon run-tasks: ${projection.taskCount} task(s) from terminal runs ` +
      `(${projection.doneCount} done / ${projection.blockedCount} blocked / ${projection.cancelledCount} cancelled) · read-only, no spawn`
  ];
  for (const task of projection.tasks) {
    lines.push(`  · [${task.status}] ${task.title} <${task.channel}/${task.ownerAgentId}> (${task.taskId})`);
  }
  return lines.join("\n");
}
