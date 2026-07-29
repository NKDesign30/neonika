// Adapted from NK Design's Neon runtime tests for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  bootstrapNeonMemorySchema,
  createNeonMemoryIndexActivitySnapshot,
  readNeonMemoryIndexEntryDetail
} from "../src/index.js";

// The DB stores created_at as SQLite-UTC ("YYYY-MM-DD HH:MM:SS"); the
// histogram groups via date(created_at, 'localtime'). Both sides derive from
// the same Date so the expectation follows the machine's timezone.
function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

describe("Neon memory index activity snapshot", () => {
  let root = "";
  let dbPath = "";

  function seed(rows: ReadonlyArray<{
    readonly category: string;
    readonly source: string;
    readonly content: string;
    readonly createdAt: string;
    readonly agent?: string;
  }>): void {
    const database = new DatabaseSync(dbPath);
    try {
      bootstrapNeonMemorySchema(database);
      const insert = database.prepare(
        `INSERT INTO memory_entries
           (source_file, content, entry_date, agent, category, content_hash, created_at, importance_score)
         VALUES (?, ?, '2026-07-26', ?, ?, ?, ?, 70)`
      );
      for (const [index, row] of rows.entries()) {
        insert.run(row.source, row.content, row.agent ?? "live-indexer", row.category, `h-${index}`, row.createdAt);
      }
    } finally {
      database.close();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "neon-idx-activity-"));
    dbPath = join(root, "semantic-memory.db");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports a missing database instead of failing", () => {
    const snapshot = createNeonMemoryIndexActivitySnapshot(join(root, "nope.db"));
    assert.equal(snapshot.state, "missing-db");
    assert.equal(snapshot.entries.length, 0);
  });

  it("lists the newest write first and answers when it happened", () => {
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-2590e38e.md",
        content: "## Session-Summary [neonika]\n- Indexer-Gate gebaut",
        createdAt: "2026-07-26 09:00:00"
      },
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-global-f9fd8e10.md",
        content: "## Session-Summary [global]\n**Was gemacht:**\n- WebSocket-Bug untersucht",
        createdAt: "2026-07-26 11:30:00"
      }
    ]);

    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath);
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.entries[0]?.project, "global");
    assert.equal(snapshot.entries[0]?.sessionShort, "f9fd8e10");
    // SQLite UTC timestamps must leave as ISO-UTC, or the browser shows local.
    assert.equal(snapshot.lastWriteAt, "2026-07-26T11:30:00Z");
    assert.equal(snapshot.entries[0]?.createdAt, "2026-07-26T11:30:00Z");
    // Preview skips the header AND the "Was gemacht:" section label and shows
    // the first real content line.
    assert.equal(snapshot.entries[0]?.preview, "- WebSocket-Bug untersucht");
  });

  it("parses projects that contain dashes", () => {
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-global-WebstormProjects-website-sandbox-ab12cd34.md",
        content: "- Inhalt",
        createdAt: "2026-07-26 10:00:00"
      }
    ]);
    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath);
    assert.equal(snapshot.entries[0]?.project, "global-WebstormProjects-website-sandbox");
    assert.equal(snapshot.entries[0]?.sessionShort, "ab12cd34");
  });

  it("keeps decisions and foreign agents in their lanes", () => {
    seed([
      {
        category: "decision",
        source: "decisions/2026-07-26-variable-naming-collision.md",
        content: "**DECISION: Kollision**",
        createdAt: "2026-07-26 10:00:00"
      },
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-11223344.md",
        content: "- echter Inhalt",
        createdAt: "2026-07-26 10:05:00",
        agent: "someone-else"
      }
    ]);
    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath);
    // The foreign agent's row is not the live-indexer's work.
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.category, "decision");
    assert.equal(snapshot.entries[0]?.project, "variable-naming-collision");
    assert.equal(snapshot.totals.decisions, 1);
    assert.equal(snapshot.totals.summaries, 0);
  });

  it("fills a dense 14-day histogram in local time", () => {
    // Anchored to Date.now() — the SQL window is datetime('now','-14 days'),
    // so pinned calendar dates would rot into a wall-clock time bomb.
    const recent = new Date(Date.now() - 60_000);
    const older = new Date(Date.now() - 2 * 86_400_000);
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-2590e38e.md",
        content: "- frisch",
        createdAt: utcStamp(recent)
      },
      {
        category: "decision",
        source: "decisions/2026-07-26-histogramm.md",
        content: "**DECISION: Balken**",
        createdAt: utcStamp(older)
      }
    ]);

    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath);
    assert.equal(snapshot.days.length, 14);
    // Days without writes are zero bars, not missing bars.
    assert.ok(snapshot.days.every((day) => typeof day.day === "string"));
    const recentDay = snapshot.days.find((day) => day.day === localDay(recent));
    const olderDay = snapshot.days.find((day) => day.day === localDay(older));
    assert.equal(recentDay?.summaries, 1);
    assert.equal(olderDay?.decisions, 1);
  });

  it("narrows only the list with a category filter, never the totals", () => {
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-2590e38e.md",
        content: "- Summary-Inhalt",
        createdAt: "2026-07-26 09:00:00"
      },
      {
        category: "decision",
        source: "decisions/2026-07-26-filter.md",
        content: "**DECISION: Filter**",
        createdAt: "2026-07-26 10:00:00"
      }
    ]);

    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath, { category: "decision" });
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.category, "decision");
    // The header numbers keep telling the whole truth while the list filters.
    assert.equal(snapshot.totals.summaries, 1);
    assert.equal(snapshot.totals.decisions, 1);
  });

  it("pages the list with offset and reports the filtered total", () => {
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-11111111.md",
        content: "- eins",
        createdAt: "2026-07-26 09:00:00"
      },
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-22222222.md",
        content: "- zwei",
        createdAt: "2026-07-26 10:00:00"
      },
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-33333333.md",
        content: "- drei",
        createdAt: "2026-07-26 11:00:00"
      }
    ]);

    const page = createNeonMemoryIndexActivitySnapshot(dbPath, { limit: 2, offset: 2 });
    assert.equal(page.filteredTotal, 3);
    assert.equal(page.offset, 2);
    // Newest first, so page two carries the oldest of the three.
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.sessionShort, "11111111");
  });

  it("serves one entry's full redacted content by id, and only its own lanes", () => {
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-2590e38e.md",
        content: "## Session-Summary [neonika]\n- Token sk-ant-api03-abcdefghij1234567890 im Log entdeckt",
        createdAt: "2026-07-26 09:00:00"
      },
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-99999999.md",
        content: "- fremder Inhalt",
        createdAt: "2026-07-26 10:00:00",
        agent: "someone-else"
      }
    ]);

    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath);
    const ownId = snapshot.entries[0]?.id;
    assert.ok(typeof ownId === "number" && ownId > 0);

    const detail = readNeonMemoryIndexEntryDetail(dbPath, ownId);
    assert.equal(detail.state, "ready");
    if (detail.state === "ready") {
      // Full content, not the one-line preview — but still redacted.
      assert.match(detail.entry.content, /## Session-Summary/);
      assert.doesNotMatch(detail.entry.content, /sk-ant-api03-abcdefghij/);
    }

    assert.equal(readNeonMemoryIndexEntryDetail(dbPath, 999_999).state, "not-found");

    // The foreign agent's row exists in the DB but is not reachable here.
    const database = new DatabaseSync(dbPath, { readOnly: true });
    const foreignId = (
      database.prepare("SELECT id FROM memory_entries WHERE agent = 'someone-else'").get() as {
        id: number;
      }
    ).id;
    database.close();
    assert.equal(readNeonMemoryIndexEntryDetail(dbPath, foreignId).state, "not-found");
  });

  it("never leaks a secret through the preview", () => {
    seed([
      {
        category: "session-summary",
        source: "session-summaries/2026-07-26-neonika-99887766.md",
        content: "- Token sk-ant-api03-abcdefghij1234567890 gefunden",
        createdAt: "2026-07-26 10:00:00"
      }
    ]);
    const snapshot = createNeonMemoryIndexActivitySnapshot(dbPath);
    assert.doesNotMatch(JSON.stringify(snapshot), /sk-ant-api03-abcdefghij/);
  });
});
