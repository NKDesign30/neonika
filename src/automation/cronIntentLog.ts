import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import { resolveNeonCronTimerGate, type INeonCronTimerGate } from "./cronTimerRuntime.js";
import type { INeonCronDaemonTickResult } from "./cronDaemonRuntime.js";

/**
 * Cron intent history (P4 Automation): a gated, append-only JSONL record of the
 * run-intents a cron daemon tick WOULD create. neon-core executes nothing, so
 * this is an intent history, not an run-log with ok/error status.
 *
 * Same gated seam as the daemon cursor: writing requires the cron timer gate
 * (`NEON_CRON_TIMER_ENABLED`, default-off) AND an explicit isolated `storePath`.
 * The pure builder maps a real `runNeonCronDaemonTick` result onto entries:
 *   - current emitted windows -> "emitted"
 *   - back-filled catch-up windows -> "catch-up"
 *   - already-seen (deduped) jobs -> "skipped"
 * A gate-closed tick produces zero rows by design (no "blocked" spam), which is
 * the honest Neon behavior: no tick ran, nothing to record.
 *
 * Redaction-first (jobId through `redactText`); window labels are derived time
 * buckets (non-secret). Deliberately different from upstream `cron/run-log.ts`,
 * which records real per-run status because upstream actually executes runs.
 */
export type TNeonCronIntentStatus = "emitted" | "catch-up" | "skipped";

export interface INeonCronIntentLogEntry {
  readonly recordedAt: string;
  readonly jobId: string;
  readonly status: TNeonCronIntentStatus;
  /** Present for emitted/catch-up windows; absent for skipped jobs. */
  readonly window?: string;
}

export type TNeonCronIntentLogState = "appended" | "blocked";

export interface INeonCronIntentLogAppendResult {
  readonly state: TNeonCronIntentLogState;
  readonly gate: INeonCronTimerGate;
  readonly storePath?: string;
  readonly count: number;
  readonly diagnostics: readonly string[];
}

export { resolveNeonCronTimerGate as resolveNeonCronIntentLogGate };

export function resolveNeonCronIntentLogPath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "cron-intents.jsonl");
}

export function buildNeonCronIntentEntries(
  result: INeonCronDaemonTickResult,
  now?: () => Date
): readonly INeonCronIntentLogEntry[] {
  const recordedAt = (now?.() ?? new Date()).toISOString();
  const entries: INeonCronIntentLogEntry[] = [];

  for (const jobId of result.tick.emitted) {
    const window = result.tick.nextEmitted[jobId];
    entries.push({
      recordedAt,
      jobId: redactText(jobId),
      status: "emitted",
      ...(window ? { window } : {})
    });
  }
  for (const emission of result.catchup) {
    entries.push({
      recordedAt,
      jobId: redactText(emission.jobId),
      status: "catch-up",
      window: emission.window
    });
  }
  for (const jobId of result.tick.deduped) {
    entries.push({
      recordedAt,
      jobId: redactText(jobId),
      status: "skipped"
    });
  }
  return entries;
}

export async function appendNeonCronIntentLog(options: {
  readonly entries: readonly INeonCronIntentLogEntry[];
  readonly gate: INeonCronTimerGate;
  readonly storePath?: string;
}): Promise<INeonCronIntentLogAppendResult> {
  if (!options.gate.enabled || !options.storePath) {
    return {
      state: "blocked",
      gate: options.gate,
      ...(options.storePath ? { storePath: options.storePath } : {}),
      count: 0,
      diagnostics: [
        "cron-intent-log blocked: requires NEON_CRON_TIMER_ENABLED and an explicit isolated storePath"
      ]
    };
  }

  if (options.entries.length === 0) {
    return {
      state: "appended",
      gate: options.gate,
      storePath: options.storePath,
      count: 0,
      diagnostics: ["no cron intent entries to append"]
    };
  }

  await mkdir(dirname(options.storePath), { recursive: true });
  const payload = options.entries.map((entry) => JSON.stringify(entry)).join("\n");
  await appendFile(options.storePath, `${payload}\n`, "utf8");

  return {
    state: "appended",
    gate: options.gate,
    storePath: options.storePath,
    count: options.entries.length,
    diagnostics: [
      `appended ${options.entries.length} cron intent entr${options.entries.length === 1 ? "y" : "ies"}`
    ]
  };
}

export async function readNeonCronIntentLog(options: {
  readonly storePath: string;
  readonly limit?: number;
}): Promise<readonly INeonCronIntentLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(options.storePath, "utf8");
  } catch {
    return [];
  }

  const entries = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCronIntentEntry)
    .filter((entry): entry is INeonCronIntentLogEntry => entry !== undefined);

  if (options.limit === undefined || !Number.isFinite(options.limit)) {
    return entries;
  }
  const limit = Math.max(0, Math.floor(options.limit));
  return limit === 0 ? [] : entries.slice(-limit);
}

export function renderNeonCronIntentLog(entries: readonly INeonCronIntentLogEntry[]): string {
  if (entries.length === 0) {
    return "Cron intent log: empty";
  }
  return [
    `Cron intent log: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    ...entries.map((entry) => {
      const windowSuffix = entry.window ? ` @ ${entry.window}` : "";
      return `  [${entry.status}] ${entry.jobId}${windowSuffix} (${entry.recordedAt})`;
    })
  ].join("\n");
}

function parseCronIntentEntry(line: string): INeonCronIntentLogEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const recordedAt = record["recordedAt"];
  const jobId = record["jobId"];
  const status = record["status"];

  if (typeof recordedAt !== "string" || typeof jobId !== "string") {
    return undefined;
  }
  if (status !== "emitted" && status !== "catch-up" && status !== "skipped") {
    return undefined;
  }

  const window = record["window"];
  return {
    recordedAt,
    jobId,
    status,
    ...(typeof window === "string" ? { window } : {})
  };
}
