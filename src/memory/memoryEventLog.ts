import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactText } from "../harness/redaction.js";
import { resolveNeonMemoryWriteGate, type INeonMemoryWriteGate } from "./memoryWriteRuntime.js";
import { hashNeonRecallQuery } from "./recallTracking.js";

/**
 * Memory-host event log (P3 Memory observability): a gated, append-only JSONL
 * audit trail of the three memory lifecycle events
 * (recall.recorded / promotion.applied / dream.completed).
 *
 * Same gated seam as `memoryWriteRuntime` / `recallTracking`: writing requires
 * BOTH `NEON_MEMORY_WRITE_ENABLED` (default-off) AND an explicit isolated
 * `storePath`. The real emitter wiring (calling this from `dreamingRuntime`
 * reflection/promotion) is a separate slice; this is the gated persistence layer
 * with a CLI dry-run as the entry point.
 *
 * Redaction-first, deliberately different from upstream `memory-host-sdk/events.ts`
 * which stores raw query text + raw file paths: Neon stores only a query hash,
 * counts, redacted candidate keys, and the phase name — never raw queries/paths.
 */
export type TNeonMemoryEventType =
  | "memory.recall.recorded"
  | "memory.promotion.applied"
  | "memory.dream.completed";

export type TNeonDreamStorageMode = "inline" | "separate" | "both";

export interface INeonMemoryRecallRecordedEvent {
  readonly type: "memory.recall.recorded";
  readonly recordedAt: string;
  /** Hashed query — raw query text is never persisted. */
  readonly queryHash: string;
  readonly resultCount: number;
}

export interface INeonMemoryPromotionAppliedEvent {
  readonly type: "memory.promotion.applied";
  readonly recordedAt: string;
  readonly applied: number;
  /** Redacted, length-capped candidate keys — no raw file paths. */
  readonly candidateKeys: readonly string[];
}

export interface INeonMemoryDreamCompletedEvent {
  readonly type: "memory.dream.completed";
  readonly recordedAt: string;
  readonly phase: string;
  readonly lineCount: number;
  readonly storageMode: TNeonDreamStorageMode;
}

export type TNeonMemoryEvent =
  | INeonMemoryRecallRecordedEvent
  | INeonMemoryPromotionAppliedEvent
  | INeonMemoryDreamCompletedEvent;

export type TNeonMemoryEventAppendState = "appended" | "blocked";

export interface INeonMemoryEventAppendResult {
  readonly state: TNeonMemoryEventAppendState;
  readonly gate: INeonMemoryWriteGate;
  readonly storePath?: string;
  readonly event?: TNeonMemoryEvent;
  readonly diagnostics: readonly string[];
}

const MAX_CANDIDATE_KEYS = 50;
const MAX_KEY_LENGTH = 200;

export { resolveNeonMemoryWriteGate as resolveNeonMemoryEventLogGate };

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function clampCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function buildNeonRecallRecordedEvent(params: {
  readonly query: string;
  readonly resultCount: number;
  readonly now?: () => Date;
}): INeonMemoryRecallRecordedEvent {
  return {
    type: "memory.recall.recorded",
    recordedAt: nowIso(params.now),
    queryHash: hashNeonRecallQuery(params.query),
    resultCount: clampCount(params.resultCount)
  };
}

export function buildNeonPromotionAppliedEvent(params: {
  readonly applied: number;
  readonly candidateKeys: readonly string[];
  readonly now?: () => Date;
}): INeonMemoryPromotionAppliedEvent {
  const candidateKeys = params.candidateKeys
    .slice(0, MAX_CANDIDATE_KEYS)
    .map((key) => redactText(key).slice(0, MAX_KEY_LENGTH));

  return {
    type: "memory.promotion.applied",
    recordedAt: nowIso(params.now),
    applied: clampCount(params.applied),
    candidateKeys
  };
}

export function buildNeonDreamCompletedEvent(params: {
  readonly phase: string;
  readonly lineCount: number;
  readonly storageMode: TNeonDreamStorageMode;
  readonly now?: () => Date;
}): INeonMemoryDreamCompletedEvent {
  return {
    type: "memory.dream.completed",
    recordedAt: nowIso(params.now),
    phase: redactText(params.phase).slice(0, MAX_KEY_LENGTH),
    lineCount: clampCount(params.lineCount),
    storageMode: params.storageMode
  };
}

export async function appendNeonMemoryEvent(options: {
  readonly event: TNeonMemoryEvent;
  readonly gate: INeonMemoryWriteGate;
  readonly storePath?: string;
}): Promise<INeonMemoryEventAppendResult> {
  if (!options.gate.enabled || !options.storePath) {
    return {
      state: "blocked",
      gate: options.gate,
      ...(options.storePath ? { storePath: options.storePath } : {}),
      diagnostics: [
        "memory-event-log blocked: requires NEON_MEMORY_WRITE_ENABLED and an explicit isolated storePath"
      ]
    };
  }

  await mkdir(dirname(options.storePath), { recursive: true });
  await appendFile(options.storePath, `${JSON.stringify(options.event)}\n`, "utf8");

  return {
    state: "appended",
    gate: options.gate,
    storePath: options.storePath,
    event: options.event,
    diagnostics: [`memory event appended (${options.event.type})`]
  };
}

export async function readNeonMemoryEvents(options: {
  readonly storePath: string;
  readonly limit?: number;
}): Promise<readonly TNeonMemoryEvent[]> {
  let raw: string;
  try {
    raw = await readFile(options.storePath, "utf8");
  } catch {
    return [];
  }

  const events = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseNeonMemoryEvent)
    .filter((event): event is TNeonMemoryEvent => Boolean(event));

  if (options.limit === undefined || !Number.isFinite(options.limit)) {
    return events;
  }

  const limit = Math.max(0, Math.floor(options.limit));
  return limit === 0 ? [] : events.slice(-limit);
}

export function renderNeonMemoryEventLogReport(result: INeonMemoryEventAppendResult): string {
  return [
    `Neon Memory Event Log: ${result.state} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Store: ${result.storePath ?? "none (isolated store required)"}`,
    `Event: ${result.event?.type ?? "none"}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function parseNeonMemoryEvent(line: string): TNeonMemoryEvent | undefined {
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
  const type = record["type"];
  const recordedAt = record["recordedAt"];

  if (typeof recordedAt !== "string") {
    return undefined;
  }

  if (type === "memory.recall.recorded") {
    const queryHash = record["queryHash"];
    const resultCount = record["resultCount"];
    if (typeof queryHash !== "string" || typeof resultCount !== "number") {
      return undefined;
    }
    return { type, recordedAt, queryHash, resultCount };
  }

  if (type === "memory.promotion.applied") {
    const applied = record["applied"];
    const candidateKeys = record["candidateKeys"];
    if (typeof applied !== "number" || !Array.isArray(candidateKeys)) {
      return undefined;
    }
    return {
      type,
      recordedAt,
      applied,
      candidateKeys: candidateKeys.filter((key): key is string => typeof key === "string")
    };
  }

  if (type === "memory.dream.completed") {
    const phase = record["phase"];
    const lineCount = record["lineCount"];
    const storageMode = record["storageMode"];
    if (typeof phase !== "string" || typeof lineCount !== "number") {
      return undefined;
    }
    if (storageMode !== "inline" && storageMode !== "separate" && storageMode !== "both") {
      return undefined;
    }
    return { type, recordedAt, phase, lineCount, storageMode };
  }

  return undefined;
}
