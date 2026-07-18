import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { readNeonGatewayRuns } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import { redactSnapshotText } from "../harness/redaction.js";
import {
  writeNeonMemoryDbEntry,
  type INeonMemoryDbWriteGate,
  type INeonMemoryDbWriteResult
} from "../memory/neonMemoryDbWriter.js";
import type { INeonEmbeddingProvider } from "../memory/neonEmbeddingProvider.js";
import {
  defaultTranscriptsDir,
  scanNeonTranscripts
} from "./transcriptScan.js";
import { extractNeonTranscript } from "./transcriptExtract.js";
import {
  applyNeonLiveIndexQualityGate,
  renderNeonLiveIndexQualitySummary,
  type INeonLiveIndexQualitySummary
} from "./liveIndexQualityGate.js";

const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_SOURCE_ITEMS = 50;
const PREVIEW_LIMIT = 500;
// Provisional score stamped at collect time; the quality gate replaces it with
// a content-derived score (20-60) before any record reaches the memory DB.
const COLLECT_IMPORTANCE_PLACEHOLDER = 72;

export type TNeonLiveIndexSource = "discord" | "claude" | "codex";
export type TNeonLiveIndexSyncState = "planned" | "written" | "blocked";

export interface INeonLiveIndexRecord {
  readonly source: TNeonLiveIndexSource;
  readonly sourceKey: string;
  readonly sourceFile: string;
  readonly agent: string;
  readonly category: "live-index";
  readonly content: string;
  readonly entryDate: string;
  readonly importanceScore: number;
}

export interface INeonLiveIndexTotals {
  readonly discord: number;
  readonly claude: number;
  readonly codex: number;
  readonly records: number;
}

export interface INeonLiveIndexCollection {
  readonly generatedAt: string;
  readonly totals: INeonLiveIndexTotals;
  readonly records: readonly INeonLiveIndexRecord[];
  readonly diagnostics: readonly string[];
}

export interface ICollectNeonLiveIndexOptions {
  readonly projectRoot?: string;
  readonly transcriptProjectsDir?: string;
  readonly codexSessionsDir?: string;
  readonly now?: () => Date;
  readonly maxAgeMs?: number;
  readonly maxSourceItems?: number;
}

export interface INeonLiveIndexMemorySyncResult {
  readonly state: TNeonLiveIndexSyncState;
  readonly collection: INeonLiveIndexCollection;
  readonly quality: INeonLiveIndexQualitySummary;
  readonly dbPath?: string;
  readonly writes: readonly INeonMemoryDbWriteResult[];
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

export interface IRunNeonLiveIndexMemorySyncOptions extends ICollectNeonLiveIndexOptions {
  readonly dbPath?: string;
  readonly gate: INeonMemoryDbWriteGate;
  readonly allowRealDb?: boolean;
  readonly embedder?: INeonEmbeddingProvider;
}

interface ICodexSessionDigest {
  readonly sessionId: string;
  readonly project: string;
  readonly messageCount: number;
  readonly userCount: number;
  readonly assistantCount: number;
  readonly latestPreview: string;
}

interface IMutableCodexDigest {
  sessionId: string;
  project: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  latestText: string;
}

export function defaultCodexSessionsDir(): string {
  return join(homedir(), ".codex", "sessions");
}

export async function collectNeonLiveIndexRecords(
  options: ICollectNeonLiveIndexOptions = {}
): Promise<INeonLiveIndexCollection> {
  const now = options.now?.() ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxSourceItems = options.maxSourceItems ?? DEFAULT_MAX_SOURCE_ITEMS;
  const records: INeonLiveIndexRecord[] = [];
  const diagnostics: string[] = [];

  const discordRecords = await collectDiscordRecords(options.projectRoot ?? process.cwd(), now, maxSourceItems);
  records.push(...discordRecords);

  const claudeRecords = await collectClaudeRecords({
    projectsDir: options.transcriptProjectsDir ?? defaultTranscriptsDir(),
    now,
    maxAgeMs,
    maxSourceItems
  });
  records.push(...claudeRecords);

  const codexRecords = await collectCodexRecords({
    sessionsDir: options.codexSessionsDir ?? defaultCodexSessionsDir(),
    now,
    maxAgeMs,
    maxSourceItems,
    diagnostics
  });
  records.push(...codexRecords);

  return {
    generatedAt: now.toISOString(),
    totals: {
      discord: discordRecords.length,
      claude: claudeRecords.length,
      codex: codexRecords.length,
      records: records.length
    },
    records,
    diagnostics
  };
}

export async function runNeonLiveIndexMemorySync(
  options: IRunNeonLiveIndexMemorySyncOptions
): Promise<INeonLiveIndexMemorySyncResult> {
  const collection = await collectNeonLiveIndexRecords(options);
  const quality = applyNeonLiveIndexQualityGate(collection.records);

  if (!options.dbPath) {
    return {
      state: "planned",
      collection,
      quality: quality.summary,
      writes: [],
      safety: { targetedRealMemoryDb: false },
      diagnostics: [
        "live-index sync planned: no dbPath supplied",
        renderNeonLiveIndexQualitySummary(quality.summary)
      ]
    };
  }

  const writes: INeonMemoryDbWriteResult[] = [];
  for (const record of quality.accepted) {
    writes.push(
      await writeNeonMemoryDbEntry({
        dbPath: options.dbPath,
        gate: options.gate,
        // Digests are ephemeral state: one row per source, latest state wins.
        dedupe: "source-file",
        input: {
          sourceFile: record.sourceFile,
          content: record.content,
          agent: record.agent,
          category: record.category,
          entryDate: record.entryDate,
          importanceScore: record.importanceScore
        },
        ...(options.allowRealDb !== undefined ? { allowRealDb: options.allowRealDb } : {}),
        ...(options.embedder ? { embedder: options.embedder } : {}),
        ...(options.now ? { now: options.now } : {})
      })
    );
  }

  const written = writes.filter((write) => write.state === "written").length;
  const targetedRealMemoryDb = writes.some((write) => write.safety.targetedRealMemoryDb);
  return {
    // No accepted records means there was nothing to write - that is "planned"
    // (nothing pending), not "blocked" (write gate refused). Mirrors the
    // daemon's promotion-state semantics.
    state: written > 0 ? "written" : quality.accepted.length === 0 ? "planned" : "blocked",
    collection,
    quality: quality.summary,
    dbPath: options.dbPath,
    writes,
    safety: { targetedRealMemoryDb },
    diagnostics: [
      `live-index sync: ${written}/${quality.accepted.length} accepted record(s) written`,
      renderNeonLiveIndexQualitySummary(quality.summary),
      ...collection.diagnostics
    ]
  };
}

export function renderNeonLiveIndexMemorySyncReport(result: INeonLiveIndexMemorySyncResult): string {
  const inserted = result.writes.filter((write) => write.inserted).length;
  const updated = result.writes.filter((write) => write.updated).length;
  const blocked = result.writes.filter((write) => write.state === "blocked").length;

  return [
    `Neonika Live Index Sync: ${result.state}`,
    `Sources: discord=${result.collection.totals.discord} claude=${result.collection.totals.claude} codex=${result.collection.totals.codex}`,
    `Records: ${result.collection.totals.records}`,
    `Quality: accepted=${result.quality.accepted} rejected=${result.quality.rejected}`,
    `Writes: inserted=${inserted} updated=${updated} blocked=${blocked}`,
    `DB: ${result.dbPath ?? "none"}`,
    `Safety: targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

async function collectDiscordRecords(
  projectRoot: string,
  now: Date,
  maxSourceItems: number
): Promise<readonly INeonLiveIndexRecord[]> {
  const runs = (await readNeonGatewayRuns(projectRoot, { maxRuns: maxSourceItems }))
    .filter((run) => run.request.channel === "discord")
    .filter((run) => run.status === "completed" || run.status === "failed");
  const bySession = new Map<string, INeonGatewayShadowRun[]>();

  for (const run of runs) {
    const existing = bySession.get(run.harnessSessionKey) ?? [];
    bySession.set(run.harnessSessionKey, [...existing, run]);
  }

  return Array.from(bySession.entries()).map(([sessionKey, sessionRuns]) => {
    const latest = sessionRuns.reduce((current, candidate) => {
      return timestampMs(candidate.completedAt) >= timestampMs(current.completedAt) ? candidate : current;
    });
    const preview = cleanPreview(latest.request.contentPreview || latest.finalText || "");
    // NOTE: The digest line format (`Runs:`, `Messages:`, `Tool failures:`,
    // `Latest preview:`) is parsed by liveIndexQualityGate.ts. Renaming a
    // label silently degrades the gate - keep both sides in sync.
    const content = [
      "Discord live-index digest",
      `Session: ${sessionKey}`,
      `Agent: ${latest.request.agentId}`,
      `Channel: ${latest.request.channelId}`,
      `Runs: ${sessionRuns.length}`,
      `Latest status: ${latest.status}`,
      `Latest preview: ${preview}`
    ].join("\n");

    return createRecord({
      source: "discord",
      sourceKey: sessionKey,
      sourceFile: `live-index/discord/${stableLabel(sessionKey)}.md`,
      agent: latest.request.agentId,
      content,
      entryDate: entryDate(now)
    });
  });
}

async function collectClaudeRecords(options: {
  readonly projectsDir: string;
  readonly now: Date;
  readonly maxAgeMs: number;
  readonly maxSourceItems: number;
}): Promise<readonly INeonLiveIndexRecord[]> {
  const files = await scanNeonTranscripts({
    projectsDir: options.projectsDir,
    now: options.now.getTime(),
    maxAgeMs: options.maxAgeMs
  });
  const records: INeonLiveIndexRecord[] = [];

  for (const file of files.slice(0, options.maxSourceItems)) {
    if (file.isSubagent) {
      continue;
    }
    const extract = await extractNeonTranscript(file.jsonlPath);
    if (extract.messageCount === 0) {
      continue;
    }
    const sessionKey = `${file.project}:${file.sessionId}`;
    const content = [
      "Claude transcript live-index digest",
      `Project: ${file.project}`,
      `Session: ${file.sessionId}`,
      `Mode: ${file.mode}`,
      `Messages: ${extract.messageCount} (${extract.userCount} user / ${extract.assistantCount} assistant)`,
      `Tool failures: ${extract.toolFailureCount}`,
      `Latest preview: ${cleanPreview(extract.latestPreview)}`
    ].join("\n");

    records.push(
      createRecord({
        source: "claude",
        sourceKey: sessionKey,
        sourceFile: `live-index/claude/${stableLabel(sessionKey)}.md`,
        agent: "neo",
        content,
        entryDate: entryDate(options.now)
      })
    );
  }

  return records;
}

async function collectCodexRecords(options: {
  readonly sessionsDir: string;
  readonly now: Date;
  readonly maxAgeMs: number;
  readonly maxSourceItems: number;
  readonly diagnostics: string[];
}): Promise<readonly INeonLiveIndexRecord[]> {
  const files = await listRecentJsonlFiles(options.sessionsDir, options.now, options.maxAgeMs);
  const records: INeonLiveIndexRecord[] = [];

  for (const file of files.slice(0, options.maxSourceItems)) {
    const digest = await readCodexSessionDigest(file);
    if (!digest || digest.messageCount === 0) {
      continue;
    }
    const content = [
      "Codex session live-index digest",
      `Project: ${digest.project}`,
      `Session: ${digest.sessionId}`,
      `Messages: ${digest.messageCount} (${digest.userCount} user / ${digest.assistantCount} assistant)`,
      `Latest preview: ${cleanPreview(digest.latestPreview)}`
    ].join("\n");

    records.push(
      createRecord({
        source: "codex",
        sourceKey: digest.sessionId,
        sourceFile: `live-index/codex/${stableLabel(digest.sessionId)}.md`,
        agent: "chaty",
        content,
        entryDate: entryDate(options.now)
      })
    );
  }

  if (files.length === 0) {
    options.diagnostics.push(`codex source empty or unavailable: ${cleanPreview(options.sessionsDir)}`);
  }

  return records;
}

async function readCodexSessionDigest(filePath: string): Promise<ICodexSessionDigest | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  const acc: IMutableCodexDigest = {
    sessionId: basename(filePath, ".jsonl"),
    project: "global",
    messageCount: 0,
    userCount: 0,
    assistantCount: 0,
    latestText: ""
  };

  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    foldCodexEntry(entry, acc);
  }

  if (acc.messageCount === 0) {
    return undefined;
  }

  return {
    sessionId: acc.sessionId,
    project: acc.project,
    messageCount: acc.messageCount,
    userCount: acc.userCount,
    assistantCount: acc.assistantCount,
    latestPreview: cleanPreview(acc.latestText)
  };
}

function foldCodexEntry(entry: unknown, acc: IMutableCodexDigest): void {
  if (!isRecord(entry)) {
    return;
  }
  const payload = entry["payload"];
  if (!isRecord(payload)) {
    return;
  }

  if (entry["type"] === "session_meta") {
    const id = readString(payload["id"]);
    const cwd = readString(payload["cwd"]);
    if (id) {
      acc.sessionId = id;
    }
    if (cwd) {
      acc.project = basename(cwd) || "global";
    }
    return;
  }

  if (entry["type"] !== "response_item") {
    return;
  }

  const role = readString(payload["role"]);
  if (role !== "user" && role !== "assistant") {
    return;
  }
  const text = extractCodexText(payload["content"]);
  if (text.length < 10) {
    return;
  }

  acc.messageCount += 1;
  if (role === "user") {
    acc.userCount += 1;
  } else {
    acc.assistantCount += 1;
  }
  acc.latestText = text;
}

function extractCodexText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const text = readString(item["text"]) || readString(item["content"]);
    if (text) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

async function listRecentJsonlFiles(root: string, now: Date, maxAgeMs: number): Promise<readonly string[]> {
  const files: Array<{ readonly path: string; readonly mtimeMs: number }> = [];
  await walkJsonl(root, files);
  return files
    .filter((file) => now.getTime() - file.mtimeMs <= maxAgeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((file) => file.path);
}

async function walkJsonl(
  dir: string,
  files: Array<{ readonly path: string; readonly mtimeMs: number }>
): Promise<void> {
  let entries: readonly string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const name of entries) {
    const path = join(dir, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      await walkJsonl(path, files);
    } else if (info.isFile() && name.endsWith(".jsonl")) {
      files.push({ path, mtimeMs: info.mtimeMs });
    }
  }
}

function createRecord(input: {
  readonly source: TNeonLiveIndexSource;
  readonly sourceKey: string;
  readonly sourceFile: string;
  readonly agent: string;
  readonly content: string;
  readonly entryDate: string;
}): INeonLiveIndexRecord {
  return {
    source: input.source,
    sourceKey: input.sourceKey,
    sourceFile: input.sourceFile,
    agent: input.agent,
    category: "live-index",
    content: redactSnapshotText(input.content, { previewLimit: 2_000 }),
    entryDate: input.entryDate,
    importanceScore: COLLECT_IMPORTANCE_PLACEHOLDER
  };
}

function cleanPreview(value: string): string {
  return redactSnapshotText(value.replace(/\s+/g, " ").trim(), { previewLimit: PREVIEW_LIMIT });
}

function stableLabel(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return clean.slice(0, 90) || "unknown";
}

function entryDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
