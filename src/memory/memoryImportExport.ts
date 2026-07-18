import { createHash } from "node:crypto";

import { redactText } from "../harness/redaction.js";
import {
  readNeonMemoryStore,
  type INeonMemoryStoreEntry
} from "./memoryWriteRuntime.js";

/**
 * Memory importer/exporter dry-run (P6.1, step 1).
 *
 * The productive memory-write runtime (DP-11) persists redacted entries to an
 * operator-designated isolated JSON store and NEVER touches the real
 * semantic-memory DB (`targetedRealMemoryDb:false`). Before any decision about
 * whether/how those entries enter a real backend, the build queue asks for an
 * importer/exporter dry-run first: model what a real import WOULD contain and a
 * portable export artifact, without connecting to or writing any database.
 *
 * Both functions here are read-only over the isolated store. The import plan is
 * structurally dry-run: `wouldWriteRealDb:false`, `realDbConnected:false`. It
 * does not query a real DB to diff existing rows (that would require a live
 * connection), so every importable record is reported as a candidate insert
 * with a stable `contentHash` a future real importer can use for idempotency.
 * Content is re-run through `redactText` so the plan/export can never carry a
 * secret even if the on-disk store was hand-edited. Pushing any of this into a
 * real semantic-memory DB stays a deliberate operator/product decision.
 */
export interface INeonMemoryImportRecord {
  readonly sourceEntryId: string;
  /** sha256 of the redacted content — stable idempotency key for a future real importer. */
  readonly contentHash: string;
  readonly content: string;
  readonly category?: string;
  readonly source?: string;
  readonly writtenAt: string;
}

export interface INeonMemoryImportPlan {
  /** Structural invariant: this is always a dry-run plan, never an executed import. */
  readonly mode: "dry-run";
  readonly storePath: string;
  readonly totalEntries: number;
  readonly importableRecords: number;
  readonly skippedEmpty: number;
  readonly records: readonly INeonMemoryImportRecord[];
  readonly safety: {
    readonly wouldWriteRealDb: false;
    readonly realDbConnected: false;
    readonly targetedRealMemoryDb: false;
  };
  readonly diagnostics: readonly string[];
}

export interface INeonMemoryExportManifest {
  readonly format: "neon-memory-export";
  readonly version: 1;
  readonly generatedAt: string;
  readonly storePath: string;
  readonly entryCount: number;
  readonly entries: readonly INeonMemoryStoreEntry[];
  readonly safety: { readonly readOnly: true; readonly targetedRealMemoryDb: false };
}

export interface ICreateNeonMemoryImportPlanOptions {
  readonly entries?: readonly INeonMemoryStoreEntry[];
}

export interface ICreateNeonMemoryExportManifestOptions {
  readonly entries?: readonly INeonMemoryStoreEntry[];
  readonly now?: () => Date;
}

const importSafety = {
  wouldWriteRealDb: false,
  realDbConnected: false,
  targetedRealMemoryDb: false
} as const;

export async function createNeonMemoryImportPlan(
  storePath: string,
  options: ICreateNeonMemoryImportPlanOptions = {}
): Promise<INeonMemoryImportPlan> {
  const entries = options.entries ?? (await readNeonMemoryStore(storePath));
  const records: INeonMemoryImportRecord[] = [];
  let skippedEmpty = 0;

  for (const entry of entries) {
    const content = redactText(entry.content.replace(/\s+/g, " ").trim());
    if (content.length === 0) {
      skippedEmpty += 1;
      continue;
    }

    records.push({
      sourceEntryId: entry.id,
      contentHash: createHash("sha256").update(content).digest("hex").slice(0, 32),
      content,
      ...(entry.category ? { category: redactText(entry.category) } : {}),
      ...(entry.source ? { source: redactText(entry.source) } : {}),
      writtenAt: entry.writtenAt
    });
  }

  return {
    mode: "dry-run",
    storePath,
    totalEntries: entries.length,
    importableRecords: records.length,
    skippedEmpty,
    records,
    safety: importSafety,
    diagnostics: [
      `dry-run import plan: ${records.length} candidate insert(s) from ${entries.length} store entry(ies)${skippedEmpty > 0 ? `, ${skippedEmpty} skipped (empty)` : ""}`,
      "no real semantic-memory DB was connected or written; pushing these records is a separate operator/product decision"
    ]
  };
}

export function renderNeonMemoryImportPlanReport(plan: INeonMemoryImportPlan): string {
  const lines = [
    `Neonika Memory Import Plan: ${plan.mode}`,
    `Store: ${plan.storePath}`,
    `Entries: ${plan.totalEntries} · importable: ${plan.importableRecords} · skipped-empty: ${plan.skippedEmpty}`,
    `Safety: wouldWriteRealDb=${plan.safety.wouldWriteRealDb} realDbConnected=${plan.safety.realDbConnected} targetedRealMemoryDb=${plan.safety.targetedRealMemoryDb}`,
    "Records:"
  ];

  if (plan.records.length === 0) {
    lines.push("- none");
  }

  for (const record of plan.records) {
    lines.push(
      `- ${record.sourceEntryId} [${record.contentHash}]${record.category ? ` (${record.category})` : ""}: ${record.content}`
    );
  }

  for (const diagnostic of plan.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}

export async function createNeonMemoryExportManifest(
  storePath: string,
  options: ICreateNeonMemoryExportManifestOptions = {}
): Promise<INeonMemoryExportManifest> {
  const rawEntries = options.entries ?? (await readNeonMemoryStore(storePath));
  const entries = rawEntries.map((entry) => ({
    id: entry.id,
    content: redactText(entry.content),
    writtenAt: entry.writtenAt,
    ...(entry.category ? { category: redactText(entry.category) } : {}),
    ...(entry.source ? { source: redactText(entry.source) } : {})
  }));

  return {
    format: "neon-memory-export",
    version: 1,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    storePath,
    entryCount: entries.length,
    entries,
    safety: { readOnly: true, targetedRealMemoryDb: false }
  };
}

export function renderNeonMemoryExportManifest(manifest: INeonMemoryExportManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
