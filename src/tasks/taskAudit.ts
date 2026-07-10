import { type INeonTaskRecord, type TNeonTaskStatus } from "./taskModel.js";

/**
 * Read-only task audit findings (P-Tasks diagnostics): pure detectors over the
 * projected task records (`readNeonTasks` output). Rebuild-native + ADAPTED from
 * OpenClaw `src/tasks/task-registry.audit.ts` (listTaskAuditFindings:98,
 * summarizeTaskAuditFindings:201).
 *
 * OpenClaw keys its findings off live run-lifecycle fields (queued/running/lost,
 * cleanupAfter, startedAt/endedAt, deliveryStatus) that Neon's shadow,
 * terminal-only task model does not carry. The Neon-native findings derive only
 * from the fields that DO exist on INeonTaskRecord: status, due, runIds,
 * createdAt, updatedAt. No new state, no gate, no I/O — callers pass the records
 * (and optionally the set of known run ids for orphaned-link detection, which
 * the CLI fills from the gateway run store). Pure so it cannot recurse into the
 * doctor/cutover snapshot chain.
 * See THIRD_PARTY_NOTICES.md for attribution.
 */

export type TNeonTaskAuditSeverity = "warn" | "error";

export type TNeonTaskAuditCode =
  | "overdue"
  | "stale-in-progress"
  | "stale-blocked"
  | "orphaned-run-link"
  | "inconsistent-timestamps";

export interface INeonTaskAuditFinding {
  readonly code: TNeonTaskAuditCode;
  readonly severity: TNeonTaskAuditSeverity;
  readonly taskId: string;
  readonly detail: string;
  readonly ageMs?: number;
}

export type TNeonTaskAuditCodeCounts = Readonly<Record<TNeonTaskAuditCode, number>>;

export interface INeonTaskAuditSummary {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly byCode: TNeonTaskAuditCodeCounts;
}

export interface IListNeonTaskAuditFindingsOptions {
  readonly now?: () => Date;
  readonly staleInProgressMs?: number;
  readonly staleBlockedMs?: number;
  readonly knownRunIds?: ReadonlySet<string>;
}

// Mirrors OpenClaw DEFAULT_STALE_RUNNING_MS (30 min) for the active lane. "blocked"
// is an expected resting state, so it gets a longer 7-day window before it counts
// as stuck.
const DEFAULT_STALE_IN_PROGRESS_MS = 30 * 60_000;
const DEFAULT_STALE_BLOCKED_MS = 7 * 24 * 60 * 60_000;

const terminalStatuses: ReadonlySet<TNeonTaskStatus> = new Set<TNeonTaskStatus>([
  "done",
  "cancelled"
]);

const severityRank: Readonly<Record<TNeonTaskAuditSeverity, number>> = {
  error: 0,
  warn: 1
};

const neonTaskAuditCodes: readonly TNeonTaskAuditCode[] = [
  "overdue",
  "stale-in-progress",
  "stale-blocked",
  "orphaned-run-link",
  "inconsistent-timestamps"
];

export function listNeonTaskAuditFindings(
  tasks: readonly INeonTaskRecord[],
  options: IListNeonTaskAuditFindingsOptions = {}
): readonly INeonTaskAuditFinding[] {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const staleInProgressMs = options.staleInProgressMs ?? DEFAULT_STALE_IN_PROGRESS_MS;
  const staleBlockedMs = options.staleBlockedMs ?? DEFAULT_STALE_BLOCKED_MS;
  const knownRunIds = options.knownRunIds;
  const findings: INeonTaskAuditFinding[] = [];

  for (const task of tasks) {
    const isTerminal = terminalStatuses.has(task.status);
    const updatedMs = parseTimestampMs(task.updatedAt);
    const createdMs = parseTimestampMs(task.createdAt);
    const ageMs = updatedMs === undefined ? undefined : Math.max(0, nowMs - updatedMs);

    // Corrupt bookkeeping: a task cannot be updated before it was created.
    if (updatedMs !== undefined && createdMs !== undefined && updatedMs < createdMs) {
      findings.push({
        code: "inconsistent-timestamps",
        severity: "error",
        taskId: task.taskId,
        detail: "updatedAt is earlier than createdAt"
      });
    }

    if (!isTerminal && isOverdue(task.due, nowMs)) {
      findings.push({
        code: "overdue",
        severity: "warn",
        taskId: task.taskId,
        detail: `non-terminal task is past its due date (${task.due ?? ""})`
      });
    }

    if (task.status === "in-progress" && ageMs !== undefined && ageMs >= staleInProgressMs) {
      findings.push({
        code: "stale-in-progress",
        severity: "warn",
        taskId: task.taskId,
        detail: "in-progress task has not advanced recently",
        ageMs
      });
    }

    if (task.status === "blocked" && ageMs !== undefined && ageMs >= staleBlockedMs) {
      findings.push({
        code: "stale-blocked",
        severity: "warn",
        taskId: task.taskId,
        detail: "blocked task has been stuck for a long time",
        ageMs
      });
    }

    // Only flag orphaned links when the caller supplied the known run ids and the
    // task is still active — a missing run behind a live task is actionable, a
    // missing run behind a done/cancelled task is just history.
    if (knownRunIds !== undefined && !isTerminal) {
      for (const runId of task.runIds) {
        if (!knownRunIds.has(runId)) {
          findings.push({
            code: "orphaned-run-link",
            severity: "warn",
            taskId: task.taskId,
            detail: `linked run ${runId} no longer exists in the run store`
          });
        }
      }
    }
  }

  findings.sort(compareNeonTaskAuditFindings);

  return findings;
}

export function summarizeNeonTaskAuditFindings(
  findings: readonly INeonTaskAuditFinding[]
): INeonTaskAuditSummary {
  const byCode = createCodeCounts();
  let errors = 0;
  let warnings = 0;

  for (const finding of findings) {
    byCode[finding.code] += 1;

    if (finding.severity === "error") {
      errors += 1;
    } else {
      warnings += 1;
    }
  }

  return {
    total: findings.length,
    errors,
    warnings,
    byCode
  };
}

export function renderNeonTaskAuditReport(
  findings: readonly INeonTaskAuditFinding[],
  summary: INeonTaskAuditSummary
): string {
  const header = [
    `Neon Task Audit: ${summary.total === 0 ? "clean" : `${summary.total} finding(s)`}`,
    `Errors: ${summary.errors} · Warnings: ${summary.warnings}`
  ];

  const lines =
    findings.length === 0
      ? ["- none"]
      : findings.map((finding) => {
          const age =
            finding.ageMs === undefined
              ? ""
              : ` (age ${Math.round(finding.ageMs / 60_000)}m)`;

          return `- [${finding.severity}] ${finding.code} ${finding.taskId}: ${finding.detail}${age}`;
        });

  return [...header, "Findings:", ...lines].join("\n");
}

function compareNeonTaskAuditFindings(
  left: INeonTaskAuditFinding,
  right: INeonTaskAuditFinding
): number {
  const severityDelta = severityRank[left.severity] - severityRank[right.severity];

  if (severityDelta !== 0) {
    return severityDelta;
  }

  const codeDelta = left.code.localeCompare(right.code);

  if (codeDelta !== 0) {
    return codeDelta;
  }

  return left.taskId.localeCompare(right.taskId);
}

function createCodeCounts(): Record<TNeonTaskAuditCode, number> {
  const counts = {} as Record<TNeonTaskAuditCode, number>;

  for (const code of neonTaskAuditCodes) {
    counts[code] = 0;
  }

  return counts;
}

function isOverdue(due: string | undefined, nowMs: number): boolean {
  if (due === undefined) {
    return false;
  }

  const dueMs = Date.parse(due);

  return Number.isFinite(dueMs) && dueMs < nowMs;
}

function parseTimestampMs(value: string): number | undefined {
  const ms = Date.parse(value);

  return Number.isNaN(ms) ? undefined : ms;
}
