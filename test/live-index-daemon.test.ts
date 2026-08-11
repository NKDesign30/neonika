import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  bootstrapNeonMemorySchema,
  createNeonLiveIndexDaemon,
  createNeonLiveIndexDaemonPublicSnapshot,
  createNeonLocalEmbeddingProvider,
  resolveNeonMemoryWritebackGate,
  scanNeonLiveIndexDaemon,
  searchNeonMemoryDb,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon live-index daemon", () => {
  it("coalesces overlapping scans so one interval cannot race another writeback", async () => {
    const fixture = await createDaemonFixture();
    const service = createNeonLiveIndexDaemon({
      projectRoot: fixture.projectRoot,
      transcriptProjectsDir: fixture.transcriptProjectsDir,
      codexSessionsDir: fixture.codexSessionsDir,
      now: () => new Date("2026-06-08T12:00:00.000Z")
    });

    try {
      const [first, second] = await Promise.all([
        service.scanNow("cli"),
        service.scanNow("api")
      ]);
      const metrics = await readFile(first.metricsPath, "utf8");

      assert.equal(first.state?.scanCount, 1);
      assert.equal(second.state?.scanCount, 1);
      assert.equal(metrics.trim().split("\n").length, 1);
    } finally {
      await service.stop();
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("persists source state and detects unchanged follow-up scans", async () => {
    const fixture = await createDaemonFixture();
    const now = (): Date => new Date("2026-06-08T12:00:00.000Z");

    try {
      const first = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        now,
        reason: "smoke"
      });
      const second = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        now,
        reason: "smoke"
      });
      const persisted = JSON.parse(await readFile(first.statePath, "utf8")) as { readonly scanCount: number };
      const metrics = await readFile(first.metricsPath, "utf8");

      assert.equal(first.collection?.totals.records, 3);
      assert.equal(first.state?.sources.discord.changed, 1);
      assert.equal(first.state?.sources.claude.changed, 1);
      assert.equal(first.state?.sources.codex.changed, 1);
      assert.equal(second.state?.scanCount, 2);
      assert.equal(second.state?.sources.discord.unchanged, 1);
      assert.equal(second.state?.sources.claude.unchanged, 1);
      assert.equal(second.state?.sources.codex.unchanged, 1);
      assert.equal(persisted.scanCount, 2);
      assert.equal(metrics.trim().split("\n").length, 2);
      assert.equal((await stat(first.statePath)).mode & 0o777, 0o600);
      assert.equal((await stat(first.metricsPath)).mode & 0o777, 0o600);
      assert.equal(
        (await stat(join(fixture.projectRoot, "state", "indexer"))).mode & 0o777,
        0o700
      );
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("promotes only changed records to an armed isolated memory DB", async () => {
    const fixture = await createDaemonFixture();
    const now = (): Date => new Date("2026-06-08T12:00:00.000Z");
    const dbPath = join(fixture.projectRoot, "isolated-semantic-memory.db");
    const backupDir = join(fixture.projectRoot, "memory-backups");

    try {
      await createPrivateMemoryDb(dbPath);
      const first = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        primaryMemoryDbPath: dbPath,
        memoryBackupDir: backupDir,
        memoryWritebackGate: readyWritebackGate(),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });
      const second = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        primaryMemoryDbPath: dbPath,
        memoryBackupDir: backupDir,
        memoryWritebackGate: readyWritebackGate(),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });
      const third = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        primaryMemoryDbPath: dbPath,
        memoryBackupDir: backupDir,
        memoryWritebackGate: readyWritebackGate(),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });
      const hits = searchNeonMemoryDb("Codex", { dbPath, category: "live-index", limit: 5 });

      assert.equal(first.memoryPromotion.state, "planned");
      assert.equal(first.memoryPromotion.changedRecords, 3);
      assert.equal(first.memoryPromotion.promotableRecords, 0);
      assert.equal(first.memoryPromotion.writtenRecords, 0);
      assert.equal(first.memoryPromotion.writeback.target.state, "validated");
      assert.equal(second.memoryPromotion.state, "written");
      assert.equal(second.memoryPromotion.changedRecords, 0);
      assert.equal(second.memoryPromotion.promotableRecords, 3);
      assert.equal(second.memoryPromotion.writtenRecords, 3);
      assert.equal(second.memoryPromotion.writeback.backup.state, "verified");
      assert.equal(third.memoryPromotion.state, "planned");
      assert.equal(third.memoryPromotion.changedRecords, 0);
      assert.equal(third.memoryPromotion.promotableRecords, 0);
      assert.equal(third.memoryPromotion.writtenRecords, 0);
      assert.ok(hits.length > 0);

      const metrics = await readFile(second.metricsPath, "utf8");
      assert.match(metrics, /"backupState":"verified"/u);
      assert.match(metrics, /"targetState":"validated"/u);
      assert.doesNotMatch(metrics, new RegExp(escapeRegExp(fixture.projectRoot), "u"));
      assert.doesNotMatch(metrics, /dbPath|statePath|metricsPath|"content"/u);

      const publicSnapshot = createNeonLiveIndexDaemonPublicSnapshot(second);
      const serialized = JSON.stringify(publicSnapshot);
      assert.equal(publicSnapshot.state?.scanCount, 2);
      assert.doesNotMatch(serialized, new RegExp(escapeRegExp(fixture.projectRoot), "u"));
      assert.doesNotMatch(serialized, /"records":\[|"content"|dbPath|statePath|metricsPath/u);
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps a blocked target unmarked and retries the batch on the next scan", async () => {
    const fixture = await createDaemonFixture();
    const now = (): Date => new Date("2026-06-08T12:00:00.000Z");
    const workingDb = join(fixture.projectRoot, "isolated-semantic-memory.db");
    const unwritableDb = join(fixture.projectRoot, "missing-dir", "nested", "memory.db");
    const backupDir = join(fixture.projectRoot, "memory-backups");

    const scan = (dbPath: string): ReturnType<typeof scanNeonLiveIndexDaemon> =>
      scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        primaryMemoryDbPath: dbPath,
        memoryBackupDir: backupDir,
        memoryWritebackGate: readyWritebackGate(),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });

    try {
      await createPrivateMemoryDb(workingDb);
      await scan(workingDb); // first scan only registers the records
      const failing = await scan(unwritableDb);

      assert.equal(failing.memoryPromotion.state, "blocked");
      assert.equal(failing.memoryPromotion.writtenRecords, 0);
      assert.ok(
        failing.diagnostics.some((entry) => entry.includes("target-not-regular")),
        "expected the target guard to appear in diagnostics"
      );

      // Nothing was lost: the same records are promotable again and now land.
      const recovered = await scan(workingDb);
      assert.equal(recovered.memoryPromotion.failedRecords, 0);
      assert.equal(recovered.memoryPromotion.writtenRecords, 3);
      const hits = searchNeonMemoryDb("Codex", { dbPath: workingDb, category: "live-index", limit: 5 });
      assert.ok(hits.length > 0);
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps rejected records unpromoted in a mixed batch without churn", async () => {
    const fixture = await createDaemonFixture();
    await writeSlopTranscriptFixture(fixture.transcriptProjectsDir);
    const now = (): Date => new Date("2026-06-08T12:00:00.000Z");
    const dbPath = join(fixture.projectRoot, "isolated-semantic-memory.db");
    const backupDir = join(fixture.projectRoot, "memory-backups");
    const scan = (): ReturnType<typeof scanNeonLiveIndexDaemon> =>
      scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        primaryMemoryDbPath: dbPath,
        memoryBackupDir: backupDir,
        memoryWritebackGate: readyWritebackGate(),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });

    try {
      await createPrivateMemoryDb(dbPath);
      const first = await scan();
      const second = await scan();
      const third = await scan();
      const slopRecord = second.state?.records.find((record) => record.sourceFile.includes("slop-session"));

      // 4 collected records, all stable on scan 2: 3 pass the gate, 1 rejected.
      assert.equal(first.collection?.totals.records, 4);
      assert.equal(second.memoryPromotion.promotableRecords, 3);
      assert.equal(second.memoryPromotion.rejectedRecords, 1);
      assert.equal(second.memoryPromotion.writtenRecords, 3);
      // The rejected record must never be marked as promoted.
      assert.ok(slopRecord);
      assert.equal(slopRecord.promotedContentHash, undefined);
      // Scan 3: accepted records are promoted, the rejected one is re-evaluated
      // and rejected again - no writes, no churn.
      assert.equal(third.memoryPromotion.promotableRecords, 0);
      assert.equal(third.memoryPromotion.rejectedRecords, 1);
      assert.equal(third.memoryPromotion.writtenRecords, 0);
      assert.equal(third.memoryPromotion.state, "planned");
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

});

function readyWritebackGate(): ReturnType<typeof resolveNeonMemoryWritebackGate> {
  return resolveNeonMemoryWritebackGate({
    NEON_MEMORY_WRITE_ENABLED: "ready",
    NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
  });
}

async function createPrivateMemoryDb(dbPath: string): Promise<void> {
  const database = new DatabaseSync(dbPath);
  try {
    bootstrapNeonMemorySchema(database);
  } finally {
    database.close();
  }
  await chmod(dbPath, 0o600);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface IDaemonFixture {
  readonly projectRoot: string;
  readonly transcriptProjectsDir: string;
  readonly codexSessionsDir: string;
}

async function createDaemonFixture(): Promise<IDaemonFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-live-index-daemon-test-"));
  const transcriptProjectsDir = join(projectRoot, "claude-projects");
  const codexSessionsDir = join(projectRoot, "codex-sessions");

  await writeNeonGatewayRun(projectRoot, createDiscordRun(projectRoot));
  await writeTranscriptFixture(transcriptProjectsDir);
  await writeCodexFixture(codexSessionsDir);

  return { projectRoot, transcriptProjectsDir, codexSessionsDir };
}

function createDiscordRun(projectRoot: string): INeonGatewayShadowRun {
  return {
    runId: "discord-live-index-daemon-run",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "read-only",
      contentPreview: "Discord daemon fixture",
      receivedAt: "2026-06-08T11:59:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "discord-daemon-session",
    memoryState: "attached",
    events: [{ kind: "final", text: "done" }],
    finalText: "done",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "done"
    },
    startedAt: "2026-06-08T11:59:00.000Z",
    completedAt: "2026-06-08T12:00:00.000Z"
  };
}

async function writeTranscriptFixture(projectsDir: string): Promise<void> {
  const sessionDir = join(projectsDir, "-Users-smoke-neon-projects-live-index-daemon");
  await mkdir(sessionDir, { recursive: true });
  const padding = "Transcript daemon fixture text above scanner byte floor. ".repeat(6);
  const lines = [
    JSON.stringify({ type: "user", message: `Cloud daemon sync. ${padding}` }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: `Cloud daemon ready. ${padding}`
          }
        ]
      }
    })
  ];
  await writeFile(join(sessionDir, "claude-live-index-daemon.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function writeSlopTranscriptFixture(projectsDir: string): Promise<void> {
  const sessionDir = join(projectsDir, "-Users-smoke-neon-projects-live-index-slop");
  await mkdir(sessionDir, { recursive: true });
  const padding = "Padding so the scanner byte floor accepts this transcript file. ".repeat(6);
  // Exactly one user message and no assistant reply: the quality gate must
  // reject this digest as trivial-session.
  const lines = [JSON.stringify({ type: "user", message: `Nur ein kurzer Ping ohne Antwort. ${padding}` })];
  await writeFile(join(sessionDir, "claude-live-index-slop-session.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function writeCodexFixture(sessionsDir: string): Promise<void> {
  const sessionDir = join(sessionsDir, "2026", "06", "08");
  await mkdir(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-06-08T12:00:00.000Z",
      payload: { id: "codex-live-index-daemon-session", cwd: "/Users/smoke/neonika" }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-08T12:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Bitte sammle diese Codex-Session für den Daemon." }]
      }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-08T12:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Codex daemon digest ready." }]
      }
    })
  ];
  await writeFile(join(sessionDir, "codex-live-index-daemon-session.jsonl"), `${lines.join("\n")}\n`, "utf8");
}
