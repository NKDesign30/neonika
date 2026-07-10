import type { INeonTaskRecord } from "./taskModel.js";

/**
 * Addressable task lookups (P4 Tasks): pure, in-memory selectors over the
 * projected task records (`readNeonTasks` output). neon-core already reads all
 * tasks and filters by status/priority in the workboard projection, but offered
 * no by-key lookup. These are read-only filters — no new state, no gate.
 *
 * "Latest" resolves ties by max `updatedAt`. Rebuild-native from upstream
 * `src/tasks/task-registry.ts` (findTaskByRunId, findLatestTaskForSessionKey,
 * listTasksForAgentId, listTasksForFlowId, resolveTaskForLookupToken). The
 * session axis maps onto Neon's task links (`type: "session"`), since a Neon
 * task record carries session linkage via links rather than a session field.
 */
export function findNeonTaskByRunId(
  tasks: readonly INeonTaskRecord[],
  runId: string
): INeonTaskRecord | undefined {
  if (runId.length === 0) {
    return undefined;
  }
  return pickLatestTask(tasks.filter((task) => task.runIds.includes(runId)));
}

export function findLatestNeonTaskForSessionKey(
  tasks: readonly INeonTaskRecord[],
  sessionKey: string
): INeonTaskRecord | undefined {
  if (sessionKey.length === 0) {
    return undefined;
  }
  return pickLatestTask(
    tasks.filter((task) =>
      task.links.some((link) => link.type === "session" && link.ref === sessionKey)
    )
  );
}

export function listNeonTasksForOwner(
  tasks: readonly INeonTaskRecord[],
  ownerAgentId: string
): readonly INeonTaskRecord[] {
  return tasks.filter((task) => task.ownerAgentId === ownerAgentId);
}

/**
 * Owner-scope a single resolved task: returns the task only when it belongs to
 * the caller's owner agent, otherwise undefined. Read-only guard mirroring
 * Upstream's canOwnerAccessTask (task-owner-access.ts) for single-access lookups
 * (by run/session/token), complementing listNeonTasksForOwner. Fail-closed on an
 * empty owner id. Owner-scoped *mutations* are deliberately not modeled — Neon
 * task mutations are shadow-suppressed, so only reads need scoping here.
 */
export function scopeNeonTaskToOwner(
  task: INeonTaskRecord | undefined,
  ownerAgentId: string
): INeonTaskRecord | undefined {
  if (task === undefined || ownerAgentId.length === 0) {
    return undefined;
  }
  return task.ownerAgentId === ownerAgentId ? task : undefined;
}

export function listNeonTasksForFlowId(
  tasks: readonly INeonTaskRecord[],
  flowId: string
): readonly INeonTaskRecord[] {
  return tasks.filter((task) => task.flowId === flowId);
}

/**
 * Resolve an opaque lookup token to a single task, trying the most specific key
 * first: exact taskId, then a run the task references, then a session link.
 */
export function resolveNeonTaskForLookupToken(
  tasks: readonly INeonTaskRecord[],
  token: string
): INeonTaskRecord | undefined {
  if (token.length === 0) {
    return undefined;
  }
  const byId = tasks.find((task) => task.taskId === token);
  if (byId) {
    return byId;
  }
  const byRun = findNeonTaskByRunId(tasks, token);
  if (byRun) {
    return byRun;
  }
  return findLatestNeonTaskForSessionKey(tasks, token);
}

function pickLatestTask(tasks: readonly INeonTaskRecord[]): INeonTaskRecord | undefined {
  let latest: INeonTaskRecord | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const task of tasks) {
    const ms = updatedAtMs(task);
    if (latest === undefined || ms > latestMs) {
      latest = task;
      latestMs = ms;
    }
  }
  return latest;
}

function updatedAtMs(task: INeonTaskRecord): number {
  const ms = Date.parse(task.updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
}
