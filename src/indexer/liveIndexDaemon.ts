import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  collectNeonLiveIndexRecords,
  createNeonLiveIndexPublicDiagnostics,
  type ICollectNeonLiveIndexOptions,
  type INeonLiveIndexCollection,
  type INeonLiveIndexRecord,
  type TNeonLiveIndexSource
} from "./liveIndexSync.js";
import {
  executeNeonMemoryWriteback,
  resolveNeonMemoryWritebackGate,
  type INeonMemoryWritebackGate,
  type INeonMemoryWritebackResult
} from "../memory/neonMemoryWriteback.js";
import type { INeonEmbeddingProvider } from "../memory/neonEmbeddingProvider.js";
import { applyNeonLiveIndexQualityGate } from "./liveIndexQualityGate.js";

const STATE_VERSION = 1;
const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const SOURCES: readonly TNeonLiveIndexSource[] = ["discord", "claude", "codex"];

export type TNeonLiveIndexDaemonScanReason = "startup" | "interval" | "api" | "cli" | "smoke";

export interface INeonLiveIndexDaemonRecordState {
  readonly recordKey: string;
  readonly source: TNeonLiveIndexSource;
  readonly sourceKey: string;
  readonly sourceFile: string;
  readonly agent: string;
  readonly contentHash: string;
  readonly promotedContentHash?: string;
  readonly promotedAt?: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly entryDate: string;
}

export interface INeonLiveIndexDaemonSourceState {
  readonly source: TNeonLiveIndexSource;
  readonly records: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly lastScanAt: string;
}

export interface INeonLiveIndexDaemonState {
  readonly version: typeof STATE_VERSION;
  readonly scanCount: number;
  readonly lastScanAt: string;
  readonly lastScanReason: TNeonLiveIndexDaemonScanReason;
  readonly records: readonly INeonLiveIndexDaemonRecordState[];
  readonly sources: Record<TNeonLiveIndexSource, INeonLiveIndexDaemonSourceState>;
}

export type TNeonLiveIndexMemoryPromotionState =
  | "disabled"
  | "planned"
  | "written"
  | "blocked"
  | "failed";

export interface INeonLiveIndexMemoryPromotionSnapshot {
  readonly state: TNeonLiveIndexMemoryPromotionState;
  readonly changedRecords: number;
  readonly promotableRecords: number;
  readonly rejectedRecords: number;
  readonly writtenRecords: number;
  readonly blockedRecords: number;
  readonly failedRecords: number;
  readonly writeback: INeonMemoryWritebackResult;
}

export interface INeonLiveIndexDaemonSnapshot {
  readonly running: boolean;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly statePath: string;
  readonly metricsPath: string;
  readonly state?: INeonLiveIndexDaemonState;
  readonly collection?: INeonLiveIndexCollection;
  readonly memoryPromotion: INeonLiveIndexMemoryPromotionSnapshot;
  readonly diagnostics: readonly string[];
}

export interface INeonLiveIndexDaemonOptions extends ICollectNeonLiveIndexOptions {
  readonly statePath?: string;
  readonly metricsPath?: string;
  readonly intervalMs?: number;
  readonly enabled?: boolean;
  readonly memoryDbPath?: string;
  readonly primaryMemoryDbPath?: string;
  readonly memoryBackupDir?: string;
  readonly memoryWritebackGate?: INeonMemoryWritebackGate;
  readonly embedder?: INeonEmbeddingProvider;
}

export interface INeonLiveIndexDaemonPublicState {
  readonly version: typeof STATE_VERSION;
  readonly scanCount: number;
  readonly lastScanAt: string;
  readonly lastScanReason: TNeonLiveIndexDaemonScanReason;
  readonly sources: Record<TNeonLiveIndexSource, INeonLiveIndexDaemonSourceState>;
}

export interface INeonLiveIndexDaemonPublicSnapshot {
  readonly running: boolean;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly storage: { readonly state: "private"; readonly metrics: "private" };
  readonly state?: INeonLiveIndexDaemonPublicState;
  readonly collection?: Pick<INeonLiveIndexCollection, "generatedAt" | "totals" | "diagnostics">;
  readonly memoryPromotion: INeonLiveIndexMemoryPromotionSnapshot;
  readonly diagnostics: readonly string[];
}

export interface INeonLiveIndexDaemonService {
  readonly enabled: boolean;
  readonly intervalMs: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  scanNow(reason: TNeonLiveIndexDaemonScanReason): Promise<INeonLiveIndexDaemonSnapshot>;
  getSnapshot(): INeonLiveIndexDaemonSnapshot;
}

export function resolveNeonLiveIndexDaemonOptionsFromEnv(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): INeonLiveIndexDaemonOptions {
  const intervalMs = parseIntervalMs(env["NEON_LIVE_INDEX_DAEMON_INTERVAL_MS"]);
  const statePath = env["NEON_LIVE_INDEX_DAEMON_STATE_PATH"]?.trim();
  const metricsPath = env["NEON_LIVE_INDEX_DAEMON_METRICS_PATH"]?.trim();
  const memoryDbPath = env["NEON_LIVE_INDEX_MEMORY_DB_PATH"]?.trim();
  const primaryMemoryDbPath = env["NEON_MEMORY_DB_PATH"]?.trim();
  const memoryBackupDir = env["NEON_MEMORY_BACKUP_DIR"]?.trim();

  return {
    projectRoot,
    enabled: isEnabledEnv(env["NEON_LIVE_INDEX_DAEMON_ENABLED"]),
    intervalMs,
    ...(statePath ? { statePath } : {}),
    ...(metricsPath ? { metricsPath } : {}),
    ...(memoryDbPath ? { memoryDbPath } : {}),
    ...(primaryMemoryDbPath ? { primaryMemoryDbPath } : {}),
    ...(memoryBackupDir ? { memoryBackupDir } : {}),
    memoryWritebackGate: resolveNeonMemoryWritebackGate(env)
  };
}

export function defaultNeonLiveIndexDaemonStatePath(projectRoot: string): string {
  return join(projectRoot, "state", "indexer", "live-index-daemon-state.json");
}

export function defaultNeonLiveIndexDaemonMetricsPath(projectRoot: string): string {
  return join(projectRoot, "state", "indexer", "live-index-daemon-metrics.jsonl");
}

export function createNeonLiveIndexDaemon(
  options: INeonLiveIndexDaemonOptions
): INeonLiveIndexDaemonService {
  const projectRoot = options.projectRoot ?? process.cwd();
  const statePath = options.statePath ?? defaultNeonLiveIndexDaemonStatePath(projectRoot);
  const metricsPath = options.metricsPath ?? defaultNeonLiveIndexDaemonMetricsPath(projectRoot);
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const enabled = options.enabled ?? false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeScan: Promise<INeonLiveIndexDaemonSnapshot> | undefined;
  let latest: INeonLiveIndexDaemonSnapshot = {
    running: false,
    enabled,
    intervalMs,
    statePath,
    metricsPath,
    memoryPromotion: {
      state: "disabled",
      changedRecords: 0,
      promotableRecords: 0,
      writtenRecords: 0,
      blockedRecords: 0,
      failedRecords: 0,
      rejectedRecords: 0,
      writeback: emptyWritebackResult("memory writeback has not run")
    },
    diagnostics: enabled
      ? ["live-index daemon ready; waiting for first scan"]
      : ["live-index daemon interval disabled; api/manual scans remain available"]
  };

  const scanNow = (reason: TNeonLiveIndexDaemonScanReason): Promise<INeonLiveIndexDaemonSnapshot> => {
    if (activeScan) {
      return activeScan;
    }
    const scan = scanNeonLiveIndexDaemon({
      ...options,
      projectRoot,
      statePath,
      metricsPath,
      intervalMs,
      enabled,
      reason,
      running: timer !== undefined
    }).then((snapshot) => {
      latest = snapshot;
      return snapshot;
    }).finally(() => {
      if (activeScan === scan) {
        activeScan = undefined;
      }
    });
    activeScan = scan;
    return scan;
  };

  return {
    enabled,
    intervalMs,
    start: async () => {
      if (!enabled || timer !== undefined) {
        return;
      }
      await scanNow("startup");
      timer = setInterval(() => {
        void scanNow("interval");
      }, intervalMs);
      timer.unref?.();
    },
    stop: async () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      latest = { ...latest, running: false };
    },
    scanNow,
    getSnapshot: () => ({
      ...latest,
      running: timer !== undefined
    })
  };
}

export async function scanNeonLiveIndexDaemon(
  options: INeonLiveIndexDaemonOptions & {
    readonly reason?: TNeonLiveIndexDaemonScanReason;
    readonly running?: boolean;
  }
): Promise<INeonLiveIndexDaemonSnapshot> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const statePath = options.statePath ?? defaultNeonLiveIndexDaemonStatePath(projectRoot);
  const metricsPath = options.metricsPath ?? defaultNeonLiveIndexDaemonMetricsPath(projectRoot);
  const intervalMs = clampInterval(options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const reason = options.reason ?? "api";
  const previous = await readDaemonState(statePath);
  const collection = await collectNeonLiveIndexRecords(options);
  const scannedAt = collection.generatedAt;
  const stateBeforePromotion = buildDaemonState({
    ...(previous ? { previous } : {}),
    records: collection.records,
    scannedAt,
    reason
  });
  const changedRecordCount = countChanged(stateBeforePromotion);
  const promotableKeys = getStableUnpromotedRecordKeys(stateBeforePromotion, previous);
  const promotableRecords = collection.records.filter((record) => promotableKeys.has(createRecordKey(record)));
  const quality = applyNeonLiveIndexQualityGate(promotableRecords);
  const memoryPromotion = await promoteRecordsToMemory({
    options,
    changedRecords: changedRecordCount,
    recordsToPromote: quality.accepted,
    rejectedRecords: quality.summary.rejected
  });
  const state = applyMemoryPromotion(stateBeforePromotion, quality.accepted, memoryPromotion, scannedAt);
  const diagnostics = [
    ...collection.diagnostics,
    `live-index daemon scan ${state.scanCount}: ${collection.totals.records} record(s), ${changedRecordCount} changed, ${quality.accepted.length} promotable, ${quality.summary.rejected} rejected by quality gate`,
    renderMemoryPromotionDiagnostic(memoryPromotion)
  ];

  await persistDaemonState(statePath, state);
  await appendDaemonMetric(metricsPath, {
    generatedAt: scannedAt,
    reason,
    records: collection.totals.records,
    discord: collection.totals.discord,
    claude: collection.totals.claude,
    codex: collection.totals.codex,
    changed: changedRecordCount,
    promotable: quality.accepted.length,
    rejected: quality.summary.rejected,
    memoryState: memoryPromotion.state,
    memoryWrites: memoryPromotion.writtenRecords,
    backupState: memoryPromotion.writeback.backup.state,
    ...(memoryPromotion.writeback.backup.snapshotId
      ? { backupSnapshotId: memoryPromotion.writeback.backup.snapshotId }
      : {}),
    targetState: memoryPromotion.writeback.target.state,
    targetReason: memoryPromotion.writeback.target.reason
  });

  return {
    running: options.running ?? false,
    enabled: options.enabled ?? false,
    intervalMs,
    statePath,
    metricsPath,
    state,
    collection,
    memoryPromotion,
    diagnostics
  };
}

export function renderNeonLiveIndexDaemonReport(snapshot: INeonLiveIndexDaemonSnapshot): string {
  const state = snapshot.state;

  return [
    "Neonika Live Index Daemon",
    `Enabled: ${snapshot.enabled}`,
    `Running: ${snapshot.running}`,
    `Interval: ${snapshot.intervalMs}ms`,
    "State storage: private",
    "Metrics storage: private",
    `Scans: ${state?.scanCount ?? 0}`,
    `Last scan: ${state?.lastScanAt ?? "never"} (${state?.lastScanReason ?? "none"})`,
    `Sources: discord=${state?.sources.discord.records ?? 0}/${state?.sources.discord.changed ?? 0} changed claude=${state?.sources.claude.records ?? 0}/${state?.sources.claude.changed ?? 0} changed codex=${state?.sources.codex.records ?? 0}/${state?.sources.codex.changed ?? 0} changed`,
    `Memory promotion: ${snapshot.memoryPromotion.state} changed=${snapshot.memoryPromotion.changedRecords} promotable=${snapshot.memoryPromotion.promotableRecords} rejected=${snapshot.memoryPromotion.rejectedRecords} written=${snapshot.memoryPromotion.writtenRecords} blocked=${snapshot.memoryPromotion.blockedRecords} failed=${snapshot.memoryPromotion.failedRecords}`,
    `Writeback target: ${snapshot.memoryPromotion.writeback.target.state} (${snapshot.memoryPromotion.writeback.target.reason})`,
    `Pre-write backup: ${snapshot.memoryPromotion.writeback.backup.state}${snapshot.memoryPromotion.writeback.backup.snapshotId ? ` (${snapshot.memoryPromotion.writeback.backup.snapshotId})` : ""}`,
    ...snapshot.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

export function createNeonLiveIndexDaemonPublicSnapshot(
  snapshot: INeonLiveIndexDaemonSnapshot
): INeonLiveIndexDaemonPublicSnapshot {
  const state = snapshot.state
    ? {
        version: snapshot.state.version,
        scanCount: snapshot.state.scanCount,
        lastScanAt: snapshot.state.lastScanAt,
        lastScanReason: snapshot.state.lastScanReason,
        sources: snapshot.state.sources
      }
    : undefined;
  const collection = snapshot.collection
    ? {
        generatedAt: snapshot.collection.generatedAt,
        totals: snapshot.collection.totals,
        diagnostics: createNeonLiveIndexPublicDiagnostics(snapshot.collection.diagnostics)
      }
    : undefined;

  return {
    running: snapshot.running,
    enabled: snapshot.enabled,
    intervalMs: snapshot.intervalMs,
    storage: { state: "private", metrics: "private" },
    ...(state ? { state } : {}),
    ...(collection ? { collection } : {}),
    memoryPromotion: snapshot.memoryPromotion,
    diagnostics: createNeonLiveIndexPublicDiagnostics(snapshot.diagnostics)
  };
}

function buildDaemonState(input: {
  readonly previous?: INeonLiveIndexDaemonState;
  readonly records: readonly INeonLiveIndexRecord[];
  readonly scannedAt: string;
  readonly reason: TNeonLiveIndexDaemonScanReason;
}): INeonLiveIndexDaemonState {
  const previousByKey = new Map((input.previous?.records ?? []).map((record) => [record.recordKey, record]));
  const nextRecords = input.records.map((record) => {
    const recordKey = createRecordKey(record);
    const previous = previousByKey.get(recordKey);
    const contentHash = hashRecord(record);

    return {
      recordKey,
      source: record.source,
      sourceKey: record.sourceKey,
      sourceFile: record.sourceFile,
      agent: record.agent,
      contentHash,
      ...(previous?.promotedContentHash ? { promotedContentHash: previous.promotedContentHash } : {}),
      ...(previous?.promotedAt ? { promotedAt: previous.promotedAt } : {}),
      firstSeenAt: previous?.firstSeenAt ?? input.scannedAt,
      lastSeenAt: input.scannedAt,
      entryDate: record.entryDate
    };
  });

  return {
    version: STATE_VERSION,
    scanCount: (input.previous?.scanCount ?? 0) + 1,
    lastScanAt: input.scannedAt,
    lastScanReason: input.reason,
    records: nextRecords,
    sources: {
      discord: buildSourceState("discord", nextRecords, previousByKey, input.scannedAt),
      claude: buildSourceState("claude", nextRecords, previousByKey, input.scannedAt),
      codex: buildSourceState("codex", nextRecords, previousByKey, input.scannedAt)
    }
  };
}

function buildSourceState(
  source: TNeonLiveIndexSource,
  records: readonly INeonLiveIndexDaemonRecordState[],
  previousByKey: ReadonlyMap<string, INeonLiveIndexDaemonRecordState>,
  scannedAt: string
): INeonLiveIndexDaemonSourceState {
  const sourceRecords = records.filter((record) => record.source === source);
  const changed = sourceRecords.filter((record) => {
    const previous = previousByKey.get(record.recordKey);
    return !previous || previous.contentHash !== record.contentHash;
  }).length;

  return {
    source,
    records: sourceRecords.length,
    changed,
    unchanged: sourceRecords.length - changed,
    lastScanAt: scannedAt
  };
}

async function readDaemonState(path: string): Promise<INeonLiveIndexDaemonState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isDaemonState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function persistDaemonState(path: string, state: INeonLiveIndexDaemonState): Promise<void> {
  await preparePrivateStorageParent(path);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(path, 0o600);
}

async function appendDaemonMetric(path: string, metric: {
  readonly generatedAt: string;
  readonly reason: TNeonLiveIndexDaemonScanReason;
  readonly records: number;
  readonly discord: number;
  readonly claude: number;
  readonly codex: number;
  readonly changed: number;
  readonly promotable: number;
  readonly rejected: number;
  readonly memoryState: TNeonLiveIndexMemoryPromotionState;
  readonly memoryWrites: number;
  readonly backupState: INeonMemoryWritebackResult["backup"]["state"];
  readonly backupSnapshotId?: string;
  readonly targetState: INeonMemoryWritebackResult["target"]["state"];
  readonly targetReason: INeonMemoryWritebackResult["target"]["reason"];
}): Promise<void> {
  await preparePrivateStorageParent(path);
  await appendFile(path, `${JSON.stringify(metric)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(path, 0o600);
}

async function preparePrivateStorageParent(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
}

function getStableUnpromotedRecordKeys(
  state: INeonLiveIndexDaemonState,
  previous: INeonLiveIndexDaemonState | undefined
): ReadonlySet<string> {
  const previousByKey = new Map((previous?.records ?? []).map((record) => [record.recordKey, record]));
  return new Set(
    state.records
      .filter((record) => {
        const previousRecord = previousByKey.get(record.recordKey);
        return Boolean(previousRecord) &&
          previousRecord?.contentHash === record.contentHash &&
          previousRecord.promotedContentHash !== record.contentHash;
      })
      .map((record) => record.recordKey)
  );
}

async function promoteRecordsToMemory(input: {
  readonly options: INeonLiveIndexDaemonOptions;
  readonly changedRecords: number;
  readonly recordsToPromote: readonly INeonLiveIndexRecord[];
  readonly rejectedRecords: number;
}): Promise<INeonLiveIndexMemoryPromotionSnapshot> {
  const dbPath = input.options.memoryDbPath;
  const writebackGate = input.options.memoryWritebackGate;
  const disabledSnapshot = (state: TNeonLiveIndexMemoryPromotionState): INeonLiveIndexMemoryPromotionSnapshot => ({
    state,
    changedRecords: input.changedRecords,
    promotableRecords: input.recordsToPromote.length,
    rejectedRecords: input.rejectedRecords,
    writtenRecords: 0,
    blockedRecords: state === "blocked" ? input.recordsToPromote.length : 0,
    failedRecords: state === "failed" ? input.recordsToPromote.length : 0,
    writeback: emptyWritebackResult("memory writeback is not configured")
  });

  if (!dbPath || !writebackGate) {
    return disabledSnapshot("disabled");
  }

  const writeback = await executeNeonMemoryWriteback({
    targetDbPath: dbPath,
    primaryDbPath: input.options.primaryMemoryDbPath,
    backupDir: input.options.memoryBackupDir,
    gate: writebackGate,
    inputs: input.recordsToPromote.map((record) => ({
      sourceFile: record.sourceFile,
      content: record.content,
      agent: record.agent,
      category: record.category,
      entryDate: record.entryDate,
      importanceScore: record.importanceScore
    })),
    ...(input.options.embedder ? { embedder: input.options.embedder } : {}),
    ...(input.options.now ? { now: input.options.now } : {})
  });
  return {
    state: writeback.state,
    changedRecords: input.changedRecords,
    promotableRecords: input.recordsToPromote.length,
    rejectedRecords: input.rejectedRecords,
    writtenRecords: writeback.writes.written,
    blockedRecords: writeback.writes.blocked,
    failedRecords: writeback.state === "failed" ? input.recordsToPromote.length : 0,
    writeback
  };
}

function applyMemoryPromotion(
  state: INeonLiveIndexDaemonState,
  promotedRecords: readonly INeonLiveIndexRecord[],
  promotion: INeonLiveIndexMemoryPromotionSnapshot,
  promotedAt: string
): INeonLiveIndexDaemonState {
  if (promotion.state !== "written") {
    return state;
  }
  const writtenByKey = new Set(promotedRecords.map((record) => createRecordKey(record)));

  return {
    ...state,
    records: state.records.map((record) => writtenByKey.has(record.recordKey)
      ? { ...record, promotedContentHash: record.contentHash, promotedAt }
      : record)
  };
}

function renderMemoryPromotionDiagnostic(promotion: INeonLiveIndexMemoryPromotionSnapshot): string {
  return `live-index memory promotion: ${promotion.state}, changed=${promotion.changedRecords}, promotable=${promotion.promotableRecords}, rejected=${promotion.rejectedRecords}, written=${promotion.writtenRecords}, blocked=${promotion.blockedRecords}, failed=${promotion.failedRecords}, target=${promotion.writeback.target.reason}, backup=${promotion.writeback.backup.state}`;
}

function emptyWritebackResult(diagnostic: string): INeonMemoryWritebackResult {
  return {
    state: "planned",
    target: {
      state: "blocked",
      reason: "missing-target",
      targetConfigured: false,
      matchesPrimary: false,
      ownerOnly: false
    },
    backup: { state: "not-created", entries: 0, rotated: 0 },
    writes: { requested: 0, written: 0, inserted: 0, updated: 0, embedded: 0, blocked: 0 },
    diagnostics: [diagnostic]
  };
}

function countChanged(state: INeonLiveIndexDaemonState): number {
  return SOURCES.reduce((total, source) => total + state.sources[source].changed, 0);
}

function createRecordKey(record: INeonLiveIndexRecord): string {
  return `${record.source}:${record.sourceKey}`;
}

function hashRecord(record: INeonLiveIndexRecord): string {
  return createHash("sha256")
    .update(record.source)
    .update("\0")
    .update(record.sourceKey)
    .update("\0")
    .update(record.content)
    .digest("hex");
}

function isDaemonState(value: unknown): value is INeonLiveIndexDaemonState {
  if (!isRecord(value)) {
    return false;
  }
  return value["version"] === STATE_VERSION && typeof value["scanCount"] === "number" && Array.isArray(value["records"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIntervalMs(value: string | undefined): number {
  if (!value) {
    return DEFAULT_INTERVAL_MS;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? clampInterval(parsed) : DEFAULT_INTERVAL_MS;
}

function clampInterval(value: number): number {
  return Math.max(MIN_INTERVAL_MS, value);
}

function isEnabledEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "ready" || value === "on";
}
