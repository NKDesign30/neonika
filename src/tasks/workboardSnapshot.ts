import {
  neonTaskPriorityOrder,
  neonTaskStatusOrder,
  type INeonTaskRecord,
  type TNeonTaskPriority,
  type TNeonTaskStatus
} from "./taskModel.js";
import { readNeonTasks, resolveNeonTaskStatePaths } from "./taskStore.js";

/**
 * Pure, read-only projection of the Neonika Task store into a Workboard view.
 *
 * Reads the latest record per taskId, groups them into status columns, and
 * derives totals (open/blocked/done/overdue, per-status and per-priority counts).
 * Every task in the snapshot is already redacted by the store, so the projection
 * stays leak-safe by construction — it only counts and groups, never re-derives
 * free text. Mirrors gateway/sessionSnapshot.ts: state ready/empty, generatedAt,
 * totals, source paths, and a render function.
 */

export type TNeonWorkboardSnapshotState = "ready" | "empty";

export type TNeonTaskStatusCounts = Readonly<Record<TNeonTaskStatus, number>>;
export type TNeonTaskPriorityCounts = Readonly<Record<TNeonTaskPriority, number>>;

export interface INeonWorkboardTotals {
  readonly tasks: number;
  readonly open: number;
  readonly blocked: number;
  readonly done: number;
  readonly overdue: number;
  readonly linkedRuns: number;
  readonly byStatus: TNeonTaskStatusCounts;
  readonly byPriority: TNeonTaskPriorityCounts;
}

export interface INeonWorkboardColumn {
  readonly status: TNeonTaskStatus;
  readonly title: string;
  readonly count: number;
  readonly tasks: readonly INeonTaskRecord[];
}

export interface INeonWorkboardSnapshot {
  readonly state: TNeonWorkboardSnapshotState;
  readonly generatedAt: string;
  readonly totals: INeonWorkboardTotals;
  readonly source: ReturnType<typeof resolveNeonTaskStatePaths>;
  readonly columns: readonly INeonWorkboardColumn[];
}

export interface ICreateNeonWorkboardSnapshotOptions {
  readonly maxRecords?: number;
  readonly now?: () => Date;
}

const neonWorkboardColumnTitles: Readonly<Record<TNeonTaskStatus, string>> = {
  backlog: "Backlog",
  ready: "Ready",
  "in-progress": "In Progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled"
};

const terminalStatuses = new Set<TNeonTaskStatus>(["done", "cancelled"]);

export async function createNeonWorkboardSnapshot(
  projectRoot: string,
  options: ICreateNeonWorkboardSnapshotOptions = {}
): Promise<INeonWorkboardSnapshot> {
  const tasks = await readNeonTasks(
    projectRoot,
    options.maxRecords ? { maxRecords: options.maxRecords } : {}
  );
  const now = options.now?.() ?? new Date();

  return {
    state: tasks.length > 0 ? "ready" : "empty",
    generatedAt: now.toISOString(),
    totals: computeWorkboardTotals(tasks, now),
    source: resolveNeonTaskStatePaths(projectRoot),
    columns: buildWorkboardColumns(tasks)
  };
}

export function renderNeonWorkboardReport(snapshot: INeonWorkboardSnapshot): string {
  const header = [
    `Neonika Workboard: ${snapshot.state}`,
    `Tasks: ${snapshot.totals.tasks} (open ${snapshot.totals.open} / blocked ${snapshot.totals.blocked} / done ${snapshot.totals.done})`,
    `Overdue: ${snapshot.totals.overdue} · Linked runs: ${snapshot.totals.linkedRuns}`
  ];

  const columns = snapshot.columns
    .filter((column) => column.count > 0)
    .map((column) => {
      const rows = column.tasks.map((task) => {
        const due = task.due ? ` due=${task.due}` : "";
        const owner = ` @${task.ownerAgentId}`;
        const links = task.runIds.length > 0 ? ` runs=${task.runIds.length}` : "";

        return `   - [${task.priority}] ${task.title}${owner}${due}${links} (${task.taskId})`;
      });

      return [`${column.title} (${column.count})`, ...rows].join("\n");
    });

  return [...header, ...columns].join("\n");
}

function buildWorkboardColumns(
  tasks: readonly INeonTaskRecord[]
): readonly INeonWorkboardColumn[] {
  return neonTaskStatusOrder.map((status) => {
    const columnTasks = tasks
      .filter((task) => task.status === status)
      .slice()
      .sort(compareTasksForColumn);

    return {
      status,
      title: neonTaskColumnTitle(status),
      count: columnTasks.length,
      tasks: columnTasks
    };
  });
}

function compareTasksForColumn(left: INeonTaskRecord, right: INeonTaskRecord): number {
  const priorityDelta = priorityRank(left.priority) - priorityRank(right.priority);

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return right.updatedAt.localeCompare(left.updatedAt);
}

function computeWorkboardTotals(
  tasks: readonly INeonTaskRecord[],
  now: Date
): INeonWorkboardTotals {
  const byStatus = createStatusCounts();
  const byPriority = createPriorityCounts();
  const nowMs = now.getTime();

  let open = 0;
  let overdue = 0;
  let linkedRuns = 0;

  for (const task of tasks) {
    byStatus[task.status] += 1;
    byPriority[task.priority] += 1;

    const isTerminal = terminalStatuses.has(task.status);

    if (!isTerminal) {
      open += 1;

      if (isOverdue(task.due, nowMs)) {
        overdue += 1;
      }
    }

    if (task.runIds.length > 0) {
      linkedRuns += 1;
    }
  }

  return {
    tasks: tasks.length,
    open,
    blocked: byStatus.blocked,
    done: byStatus.done,
    overdue,
    linkedRuns,
    byStatus,
    byPriority
  };
}

function isOverdue(due: string | undefined, nowMs: number): boolean {
  if (!due) {
    return false;
  }

  const dueMs = Date.parse(due);

  return Number.isFinite(dueMs) && dueMs < nowMs;
}

function neonTaskColumnTitle(status: TNeonTaskStatus): string {
  return neonWorkboardColumnTitles[status];
}

function priorityRank(priority: TNeonTaskPriority): number {
  const index = neonTaskPriorityOrder.indexOf(priority);

  return index === -1 ? neonTaskPriorityOrder.length : index;
}

function createStatusCounts(): Record<TNeonTaskStatus, number> {
  return {
    backlog: 0,
    ready: 0,
    "in-progress": 0,
    blocked: 0,
    done: 0,
    cancelled: 0
  };
}

function createPriorityCounts(): Record<TNeonTaskPriority, number> {
  return {
    urgent: 0,
    high: 0,
    normal: 0,
    low: 0
  };
}
