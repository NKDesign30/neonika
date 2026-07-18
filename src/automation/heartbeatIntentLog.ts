import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  resolveNeonHeartbeatTimerGate,
  type INeonHeartbeatTimerGate
} from "./heartbeatTimerRuntime.js";
import type { INeonHeartbeatDaemonTickResult } from "./heartbeatDaemonRuntime.js";

/**
 * Heartbeat intent history: a gated, append-only JSONL record of the wake
 * intents a heartbeat daemon tick WOULD create. neonika executes nothing, so
 * this is an intent history, not an run-log with ok/error status.
 *
 * Same gated seam as the daemon cursor: writing requires the heartbeat timer
 * gate (`NEON_HEARTBEAT_TIMER_ENABLED`, default-off) AND an explicit isolated
 * `storePath`. The pure builder maps a real `runNeonHeartbeatDaemonTick` result:
 *   - current emitted windows -> "emitted"
 *   - back-filled catch-up windows -> "catch-up"
 *   - cooldown/active-hours skips -> "deferred"
 *   - already-seen windows -> "deduped"
 * A gate-closed tick produces zero rows by design (no "blocked" spam).
 *
 * Redaction-first (agentId through `redactText`); window labels are derived time
 * buckets (non-secret). Mirrors `cronIntentLog.ts`.
 */
export type TNeonHeartbeatIntentStatus = "emitted" | "catch-up" | "deferred" | "deduped";

export interface INeonHeartbeatIntentLogEntry {
  readonly recordedAt: string;
  readonly agentId: string;
  readonly status: TNeonHeartbeatIntentStatus;
  /** Present for emitted/catch-up windows; absent for deferred/deduped. */
  readonly window?: string;
}

export type TNeonHeartbeatIntentLogState = "appended" | "blocked";

export interface INeonHeartbeatIntentLogAppendResult {
  readonly state: TNeonHeartbeatIntentLogState;
  readonly gate: INeonHeartbeatTimerGate;
  readonly storePath?: string;
  readonly count: number;
  readonly diagnostics: readonly string[];
}

export { resolveNeonHeartbeatTimerGate as resolveNeonHeartbeatIntentLogGate };

export function resolveNeonHeartbeatIntentLogPath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "heartbeat-intents.jsonl");
}

export function buildNeonHeartbeatIntentEntries(
  result: INeonHeartbeatDaemonTickResult,
  now?: () => Date
): readonly INeonHeartbeatIntentLogEntry[] {
  const recordedAt = (now?.() ?? new Date()).toISOString();
  const entries: INeonHeartbeatIntentLogEntry[] = [];

  for (const agentId of result.tick.emitted) {
    const window = result.tick.nextEmitted[agentId];
    entries.push({
      recordedAt,
      agentId: redactText(agentId),
      status: "emitted",
      ...(window ? { window } : {})
    });
  }
  for (const emission of result.catchup) {
    entries.push({
      recordedAt,
      agentId: redactText(emission.agentId),
      status: "catch-up",
      window: emission.window
    });
  }
  for (const entry of result.tick.deferred) {
    entries.push({
      recordedAt,
      agentId: redactText(entry.agentId),
      status: "deferred"
    });
  }
  for (const agentId of result.tick.deduped) {
    entries.push({
      recordedAt,
      agentId: redactText(agentId),
      status: "deduped"
    });
  }
  return entries;
}

export async function appendNeonHeartbeatIntentLog(options: {
  readonly entries: readonly INeonHeartbeatIntentLogEntry[];
  readonly gate: INeonHeartbeatTimerGate;
  readonly storePath?: string;
}): Promise<INeonHeartbeatIntentLogAppendResult> {
  if (!options.gate.enabled || !options.storePath) {
    return {
      state: "blocked",
      gate: options.gate,
      ...(options.storePath ? { storePath: options.storePath } : {}),
      count: 0,
      diagnostics: [
        "heartbeat-intent-log blocked: requires NEON_HEARTBEAT_TIMER_ENABLED and an explicit isolated storePath"
      ]
    };
  }

  if (options.entries.length === 0) {
    return {
      state: "appended",
      gate: options.gate,
      storePath: options.storePath,
      count: 0,
      diagnostics: ["no heartbeat intent entries to append"]
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
      `appended ${options.entries.length} heartbeat intent entr${options.entries.length === 1 ? "y" : "ies"}`
    ]
  };
}

export async function readNeonHeartbeatIntentLog(options: {
  readonly storePath: string;
  readonly limit?: number;
}): Promise<readonly INeonHeartbeatIntentLogEntry[]> {
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
    .map(parseHeartbeatIntentEntry)
    .filter((entry): entry is INeonHeartbeatIntentLogEntry => entry !== undefined);

  if (options.limit === undefined || !Number.isFinite(options.limit)) {
    return entries;
  }
  const limit = Math.max(0, Math.floor(options.limit));
  return limit === 0 ? [] : entries.slice(-limit);
}

export function renderNeonHeartbeatIntentLog(
  entries: readonly INeonHeartbeatIntentLogEntry[]
): string {
  if (entries.length === 0) {
    return "Heartbeat intent log: empty";
  }
  return [
    `Heartbeat intent log: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    ...entries.map((entry) => {
      const windowSuffix = entry.window ? ` @ ${entry.window}` : "";
      return `  [${entry.status}] ${entry.agentId}${windowSuffix} (${entry.recordedAt})`;
    })
  ].join("\n");
}

function parseHeartbeatIntentEntry(line: string): INeonHeartbeatIntentLogEntry | undefined {
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
  const agentId = record["agentId"];
  const status = record["status"];

  if (typeof recordedAt !== "string" || typeof agentId !== "string") {
    return undefined;
  }
  if (status !== "emitted" && status !== "catch-up" && status !== "deferred" && status !== "deduped") {
    return undefined;
  }

  const window = record["window"];
  return {
    recordedAt,
    agentId,
    status,
    ...(typeof window === "string" ? { window } : {})
  };
}
