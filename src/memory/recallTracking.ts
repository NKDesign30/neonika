import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactText } from "../harness/redaction.js";
import { resolveNeonMemoryWriteGate, type INeonMemoryWriteGate } from "./memoryWriteRuntime.js";

/**
 * Recall-tracking persistence (P3 Memory): a gated, append-only JSONL store of
 * recall events that feeds the promotion heuristic.
 *
 * Mirrors the `memoryWriteRuntime` seam exactly: writing requires BOTH
 * `NEON_MEMORY_WRITE_ENABLED` (default-off, via `resolveNeonMemoryWriteGate`) AND
 * an explicit isolated `storePath`. Default / any missing gate stays blocked with
 * no file side effect. Like `writeNeonMemoryEntry`, the real recall-point wiring
 * (calling this from a live recall path) is a separate, deliberate slice — this
 * is the gated persistence layer with a CLI dry-run as the entry point.
 *
 * Privacy: the raw query is never stored. Only a stable 16-char hash of the
 * redacted/normalized query is persisted, so recall frequency + query-diversity
 * can be derived without keeping query text.
 *
 * `summarizeNeonRecallCounts` is the read API for the existing
 * `dreamingRuntime` access-count consumer (it filters candidates on
 * `accessCount` today, but nothing feeds it yet). Promotion thresholds match
 * Upstream `short-term-promotion.ts`
 * (`DEFAULT_PROMOTION_MIN_RECALL_COUNT` / `DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES`).
 */
export const NEON_RECALL_PROMOTION_MIN_RECALL_COUNT = 3;
export const NEON_RECALL_PROMOTION_MIN_UNIQUE_QUERIES = 2;

export interface INeonRecallEvent {
  /** Stable hash of the redacted+normalized query — raw query is never stored. */
  readonly queryHash: string;
  /** Hit source/id keys that this recall returned. */
  readonly hits: readonly string[];
  readonly recordedAt: string;
}

export interface INeonRecallAppendRequest {
  readonly query: string;
  readonly hits: readonly string[];
}

export type TNeonRecallAppendState = "appended" | "blocked";

export interface INeonRecallAppendResult {
  readonly state: TNeonRecallAppendState;
  readonly gate: INeonMemoryWriteGate;
  readonly storePath?: string;
  readonly event?: INeonRecallEvent;
  readonly safety: { readonly isolatedStore: true; readonly rawQueryStored: false };
  readonly diagnostics: readonly string[];
}

export interface IAppendNeonRecallEventOptions {
  readonly request: INeonRecallAppendRequest;
  readonly gate: INeonMemoryWriteGate;
  readonly storePath?: string;
  readonly now?: () => Date;
}

export interface INeonRecallSourceCount {
  readonly source: string;
  readonly recallCount: number;
  readonly uniqueQueries: number;
  readonly promotable: boolean;
}

const safety = { isolatedStore: true, rawQueryStored: false } as const;

export { resolveNeonMemoryWriteGate as resolveNeonRecallTrackingGate };

/** Stable 16-char hash of the redacted+normalized query (no raw query kept). */
export function hashNeonRecallQuery(query: string): string {
  const normalized = redactText(query).replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export async function appendNeonRecallEvent(
  options: IAppendNeonRecallEventOptions
): Promise<INeonRecallAppendResult> {
  const queryHash = hashNeonRecallQuery(options.request.query);
  const hits = options.request.hits.map((hit) => hit.trim()).filter((hit) => hit.length > 0);

  if (!options.gate.enabled || !options.storePath) {
    return blocked(options.gate, options.storePath, [
      "recall-tracking blocked: requires NEON_MEMORY_WRITE_ENABLED and an explicit isolated storePath"
    ]);
  }

  if (hits.length === 0) {
    return blocked(options.gate, options.storePath, ["recall-tracking blocked: no hits to record"]);
  }

  const recordedAt = (options.now?.() ?? new Date()).toISOString();
  const event: INeonRecallEvent = { queryHash, hits, recordedAt };

  await mkdir(dirname(options.storePath), { recursive: true });
  await appendFile(options.storePath, `${JSON.stringify(event)}\n`, "utf8");

  return {
    state: "appended",
    gate: options.gate,
    storePath: options.storePath,
    event,
    safety,
    diagnostics: [`recall event appended (${hits.length} hit(s))`]
  };
}

export async function readNeonRecallEvents(
  storePath: string
): Promise<readonly INeonRecallEvent[]> {
  try {
    const raw = await readFile(storePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseRecallEvent)
      .filter((event): event is INeonRecallEvent => Boolean(event));
  } catch {
    return [];
  }
}

export function summarizeNeonRecallCounts(
  events: readonly INeonRecallEvent[]
): readonly INeonRecallSourceCount[] {
  const counts = new Map<string, { recallCount: number; queries: Set<string> }>();

  for (const event of events) {
    for (const source of event.hits) {
      const entry = counts.get(source) ?? { recallCount: 0, queries: new Set<string>() };
      entry.recallCount += 1;
      entry.queries.add(event.queryHash);
      counts.set(source, entry);
    }
  }

  return [...counts.entries()]
    .map(([source, entry]) => ({
      source,
      recallCount: entry.recallCount,
      uniqueQueries: entry.queries.size,
      promotable:
        entry.recallCount >= NEON_RECALL_PROMOTION_MIN_RECALL_COUNT &&
        entry.queries.size >= NEON_RECALL_PROMOTION_MIN_UNIQUE_QUERIES
    }))
    .sort((a, b) => b.recallCount - a.recallCount || a.source.localeCompare(b.source));
}

export function renderNeonRecallTrackingReport(result: INeonRecallAppendResult): string {
  return [
    `Neonika Recall Tracking: ${result.state} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Store: ${result.storePath ?? "none (isolated store required)"}`,
    `Event: ${result.event ? `${result.event.queryHash} -> ${result.event.hits.length} hit(s)` : "none"}`,
    `Safety: isolatedStore=${result.safety.isolatedStore} rawQueryStored=${result.safety.rawQueryStored}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function blocked(
  gate: INeonMemoryWriteGate,
  storePath: string | undefined,
  diagnostics: readonly string[]
): INeonRecallAppendResult {
  return {
    state: "blocked",
    gate,
    ...(storePath ? { storePath } : {}),
    safety,
    diagnostics
  };
}

function parseRecallEvent(line: string): INeonRecallEvent | undefined {
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
  const queryHash = record["queryHash"];
  const recordedAt = record["recordedAt"];
  const hits = record["hits"];

  if (typeof queryHash !== "string" || typeof recordedAt !== "string" || !Array.isArray(hits)) {
    return undefined;
  }

  const cleanHits = hits.filter((hit): hit is string => typeof hit === "string");

  return { queryHash, hits: cleanHits, recordedAt };
}
