import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonLocalEmbeddingProvider,
  resolveNeonMemoryDbWriteGate,
  scanNeonLiveIndexDaemon,
  searchNeonMemoryDb,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon live-index daemon", () => {
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
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

  it("promotes only changed records to an armed isolated memory DB", async () => {
    const fixture = await createDaemonFixture();
    const now = (): Date => new Date("2026-06-08T12:00:00.000Z");
    const dbPath = join(fixture.projectRoot, "isolated-semantic-memory.db");

    try {
      const first = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        memoryGate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });
      const second = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        memoryGate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });
      const third = await scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        memoryGate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });
      const hits = searchNeonMemoryDb("Codex", { dbPath, category: "live-index", limit: 5 });

      assert.equal(first.memoryPromotion.state, "planned");
      assert.equal(first.memoryPromotion.changedRecords, 3);
      assert.equal(first.memoryPromotion.promotableRecords, 0);
      assert.equal(first.memoryPromotion.writes.length, 0);
      assert.equal(second.memoryPromotion.state, "written");
      assert.equal(second.memoryPromotion.changedRecords, 0);
      assert.equal(second.memoryPromotion.promotableRecords, 3);
      assert.equal(second.memoryPromotion.writes.filter((write) => write.state === "written").length, 3);
      assert.equal(second.memoryPromotion.safety.targetedRealMemoryDb, false);
      assert.equal(third.memoryPromotion.state, "planned");
      assert.equal(third.memoryPromotion.changedRecords, 0);
      assert.equal(third.memoryPromotion.promotableRecords, 0);
      assert.equal(third.memoryPromotion.writes.length, 0);
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
    const scan = (): ReturnType<typeof scanNeonLiveIndexDaemon> =>
      scanNeonLiveIndexDaemon({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        memoryDbPath: dbPath,
        memoryGate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
        embedder: createNeonLocalEmbeddingProvider(),
        now,
        reason: "smoke"
      });

    try {
      const first = await scan();
      const second = await scan();
      const third = await scan();
      const slopRecord = second.state?.records.find((record) => record.sourceFile.includes("slop-session"));

      // 4 collected records, all stable on scan 2: 3 pass the gate, 1 rejected.
      assert.equal(first.collection?.totals.records, 4);
      assert.equal(second.memoryPromotion.promotableRecords, 3);
      assert.equal(second.memoryPromotion.rejectedRecords, 1);
      assert.equal(second.memoryPromotion.writes.filter((write) => write.state === "written").length, 3);
      // The rejected record must never be marked as promoted.
      assert.ok(slopRecord);
      assert.equal(slopRecord.promotedContentHash, undefined);
      // Scan 3: accepted records are promoted, the rejected one is re-evaluated
      // and rejected again - no writes, no churn.
      assert.equal(third.memoryPromotion.promotableRecords, 0);
      assert.equal(third.memoryPromotion.rejectedRecords, 1);
      assert.equal(third.memoryPromotion.writes.length, 0);
      assert.equal(third.memoryPromotion.state, "planned");
    } finally {
      await rm(fixture.projectRoot, { force: true, recursive: true });
    }
  });

});

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
      payload: { id: "codex-live-index-daemon-session", cwd: "/Users/smoke/neon-core" }
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
