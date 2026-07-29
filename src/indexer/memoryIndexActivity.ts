// Adapted from NK Design's Neon runtime for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

// Neon Transcript Indexer — what the live indexer actually wrote, and when.
//
// The Mission Control indexer view knew everything about the TypeScript path
// (daemon scans, sync gate, decision candidates) and nothing about the result:
// the session summaries and decisions the Python live-indexer lands in the
// semantic-memory DB. "Is my memory being written?" was only answerable via
// sqlite3 by hand. This snapshot reads the answer — strictly read-only.

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

import { redactText } from "../harness/redaction.js";

export type TNeonMemoryIndexCategory = "session-summary" | "decision";

export interface INeonMemoryIndexEntry {
  /** DB row id — the handle the detail lookup takes. */
  readonly id: number;
  readonly category: TNeonMemoryIndexCategory;
  /** Calendar date the session belongs to (entry_date). */
  readonly entryDate: string;
  /** When the indexer wrote the row (created_at, UTC ISO). */
  readonly createdAt: string;
  /** Project parsed from the source file name; "?" when unparseable. */
  readonly project: string;
  /** First 8 chars of the session id, "" for decisions. */
  readonly sessionShort: string;
  /** Redacted, single-line preview of the stored content. */
  readonly preview: string;
  readonly importance: number;
}

export interface INeonMemoryIndexDay {
  /** Local calendar day (YYYY-MM-DD) — grouped in the server's timezone. */
  readonly day: string;
  readonly summaries: number;
  readonly decisions: number;
}

export interface INeonMemoryIndexActivitySnapshot {
  readonly state: "ready" | "empty" | "missing-db";
  readonly generatedAt: string;
  readonly totals: {
    readonly summaries: number;
    readonly decisions: number;
    /** Rows written in the last 24h — the "is it alive?" number. */
    readonly last24h: number;
  };
  /** Most recent write, or undefined when the table has none. */
  readonly lastWriteAt?: string;
  /**
   * Dense last-14-days histogram, oldest first. Always global (never
   * category-filtered) so the sparkline keeps telling the whole truth while
   * the list below is filtered.
   */
  readonly days: readonly INeonMemoryIndexDay[];
  /** Page start the entries list was read at. */
  readonly offset: number;
  /** How many rows match the active category filter in total — pagination math. */
  readonly filteredTotal: number;
  readonly entries: readonly INeonMemoryIndexEntry[];
}

export interface ICreateNeonMemoryIndexActivityOptions {
  readonly limit?: number;
  readonly offset?: number;
  /** Narrows the entries list only; totals and days stay global. */
  readonly category?: TNeonMemoryIndexCategory;
  readonly now?: () => Date;
}

export interface INeonMemoryIndexEntryDetail extends INeonMemoryIndexEntry {
  /** Full stored content — redacted, never raw. */
  readonly content: string;
}

export type TNeonMemoryIndexEntryDetailResult =
  | { readonly state: "missing-db" | "not-found" }
  | { readonly state: "ready"; readonly entry: INeonMemoryIndexEntryDetail };

// session-summaries/2026-07-26-global-WebstormProjects-website-sandbox-f9fd8e10.md
//                   ^date       ^project (may contain dashes)         ^session
const summarySourcePattern = /^session-summaries\/\d{4}-\d{2}-\d{2}-(.+)-([0-9a-f]{8})\.md$/;
// decisions/2026-07-26-variable-naming-collision.md — the slug is the topic,
// not a project; decisions carry their session inside the content instead.
const decisionSourcePattern = /^decisions\/\d{4}-\d{2}-\d{2}-(.+)\.md$/;

function parseSource(
  category: TNeonMemoryIndexCategory,
  sourceFile: string
): { project: string; sessionShort: string } {
  if (category === "session-summary") {
    const match = summarySourcePattern.exec(sourceFile);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { project: match[1], sessionShort: match[2] };
    }
    return { project: "?", sessionShort: "" };
  }
  const match = decisionSourcePattern.exec(sourceFile);
  return { project: match?.[1] ?? "?", sessionShort: "" };
}

// SQLite's datetime('now') writes "YYYY-MM-DD HH:MM:SS" in UTC without a
// marker. Handed to the browser as-is, Date() reads it as LOCAL time and the
// dashboard shows every write two hours off (CEST). Normalize to ISO-UTC here,
// where the format is known — not in the client, where it would be a guess.
function toIsoUtc(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(" ", "T")}Z`;
  }
  return value;
}

// Shared row → entry projection for the list and the detail lookup, so both
// parse source names and normalize timestamps identically.
function toEntry(row: Record<string, unknown>): INeonMemoryIndexEntry {
  const category = row["category"] === "decision" ? "decision" : "session-summary";
  const sourceFile = typeof row["source_file"] === "string" ? row["source_file"] : "";
  const { project, sessionShort } = parseSource(category, sourceFile);
  return {
    id: typeof row["id"] === "number" ? row["id"] : Number(row["id"] ?? 0),
    category,
    entryDate: typeof row["entry_date"] === "string" ? row["entry_date"] : "",
    createdAt: toIsoUtc(typeof row["created_at"] === "string" ? row["created_at"] : ""),
    project,
    sessionShort,
    preview: toPreview(typeof row["content"] === "string" ? row["content"] : ""),
    importance: typeof row["importance_score"] === "number" ? row["importance_score"] : 0
  };
}

function toPreview(content: string): string {
  // First non-header, non-empty line carries the most signal; headers repeat
  // the project/date the row already exposes as columns. Bold markers are
  // stripped (the dashboard renders plain text) and pure section labels like
  // "Was gemacht:" are skipped — they are structure, not content.
  const lines = content.split("\n").map((candidate) => candidate.trim().replace(/\*\*/g, ""));
  const line =
    lines.find(
      (candidate) => candidate.length > 0 && !candidate.startsWith("#") && !/^[^:]{1,48}:$/.test(candidate)
    ) ??
    lines.find((candidate) => candidate.length > 0) ??
    "";
  return redactText(line.slice(0, 220));
}

/**
 * Read the live-indexer's recent writes from the semantic-memory DB.
 *
 * Opens read-only via SQLite URI so a missing or locked DB can never be
 * mutated by the dashboard path — the view observes the memory, it does not
 * participate in it.
 */
export function createNeonMemoryIndexActivitySnapshot(
  dbPath: string,
  options: ICreateNeonMemoryIndexActivityOptions = {}
): INeonMemoryIndexActivitySnapshot {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const limit = options.limit && options.limit > 0 ? Math.min(200, Math.floor(options.limit)) : 25;

  if (!existsSync(dbPath)) {
    return {
      state: "missing-db",
      generatedAt,
      totals: { summaries: 0, decisions: 0, last24h: 0 },
      days: [],
      offset: 0,
      filteredTotal: 0,
      entries: []
    };
  }

  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const totalsRow = database
      .prepare(
        `SELECT
           SUM(CASE WHEN category = 'session-summary' THEN 1 ELSE 0 END) AS summaries,
           SUM(CASE WHEN category = 'decision' THEN 1 ELSE 0 END) AS decisions,
           SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last24h,
           MAX(created_at) AS lastWriteAt
         FROM memory_entries
         WHERE agent = 'live-indexer' AND category IN ('session-summary', 'decision')`
      )
      .get() as Record<string, unknown>;

    // Per-day counts in the server's local timezone: the dashboard runs on the
    // same machine as this server, so 'localtime' matches what the viewer's
    // clock calls "today" — grouping by UTC would shift late-evening writes
    // into the next day's bar.
    const dayRows = database
      .prepare(
        `SELECT date(created_at, 'localtime') AS day,
                SUM(CASE WHEN category = 'session-summary' THEN 1 ELSE 0 END) AS summaries,
                SUM(CASE WHEN category = 'decision' THEN 1 ELSE 0 END) AS decisions
           FROM memory_entries
          WHERE agent = 'live-indexer' AND category IN ('session-summary', 'decision')
            AND created_at >= datetime('now', '-14 days')
          GROUP BY day`
      )
      .all() as Array<Record<string, unknown>>;

    const countsByDay = new Map<string, { summaries: number; decisions: number }>();
    for (const row of dayRows) {
      if (typeof row["day"] === "string") {
        countsByDay.set(row["day"], {
          summaries: Number(row["summaries"] ?? 0),
          decisions: Number(row["decisions"] ?? 0)
        });
      }
    }
    // Dense fill: a day without writes is a zero bar, not a missing bar —
    // gaps are exactly the signal the histogram exists to show.
    const days: INeonMemoryIndexDay[] = [];
    const today = options.now?.() ?? new Date();
    for (let offset = 13; offset >= 0; offset -= 1) {
      const date = new Date(today.getTime() - offset * 86_400_000);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const counts = countsByDay.get(day);
      days.push({ day, summaries: counts?.summaries ?? 0, decisions: counts?.decisions ?? 0 });
    }

    const categoryClause = options.category ? "AND category = ?" : "";
    const categoryArgs = options.category ? [options.category] : [];

    const filteredRow = database
      .prepare(
        `SELECT COUNT(*) AS filteredTotal
           FROM memory_entries
          WHERE agent = 'live-indexer' AND category IN ('session-summary', 'decision') ${categoryClause}`
      )
      .get(...categoryArgs) as Record<string, unknown>;
    const filteredTotal = Number(filteredRow["filteredTotal"] ?? 0);

    const offset = options.offset && options.offset > 0 ? Math.floor(options.offset) : 0;
    const rows = database
      .prepare(
        `SELECT id, category, entry_date, created_at, source_file, content, importance_score
           FROM memory_entries
          WHERE agent = 'live-indexer'
            AND category IN ('session-summary', 'decision')
            ${categoryClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`
      )
      .all(...categoryArgs, limit, offset) as Array<Record<string, unknown>>;

    const entries: INeonMemoryIndexEntry[] = rows.map((row) => toEntry(row));

    const lastWriteAtRaw = totalsRow["lastWriteAt"];
    const lastWriteAt = typeof lastWriteAtRaw === "string" ? toIsoUtc(lastWriteAtRaw) : lastWriteAtRaw;
    return {
      state: entries.length > 0 ? "ready" : "empty",
      generatedAt,
      totals: {
        summaries: Number(totalsRow["summaries"] ?? 0),
        decisions: Number(totalsRow["decisions"] ?? 0),
        last24h: Number(totalsRow["last24h"] ?? 0)
      },
      ...(typeof lastWriteAt === "string" && lastWriteAt.length > 0 ? { lastWriteAt } : {}),
      days,
      offset,
      filteredTotal,
      entries
    };
  } finally {
    database.close();
  }
}

/**
 * Full content of one live-indexer entry — the "click a row for more" lookup.
 *
 * Scoped to the same agent/category lanes as the list so a row id from any
 * other agent's memory can never be read through this path, and the content
 * leaves redacted like every other boundary crossing.
 */
export function readNeonMemoryIndexEntryDetail(
  dbPath: string,
  entryId: number
): TNeonMemoryIndexEntryDetailResult {
  if (!existsSync(dbPath)) {
    return { state: "missing-db" };
  }

  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT id, category, entry_date, created_at, source_file, content, importance_score
           FROM memory_entries
          WHERE id = ? AND agent = 'live-indexer' AND category IN ('session-summary', 'decision')`
      )
      .get(entryId) as Record<string, unknown> | undefined;

    if (!row) {
      return { state: "not-found" };
    }

    const content = typeof row["content"] === "string" ? row["content"] : "";
    return {
      state: "ready",
      entry: { ...toEntry(row), content: redactText(content) }
    };
  } finally {
    database.close();
  }
}
