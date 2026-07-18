import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  collectNeonLiveIndexRecords,
  createNeonLocalEmbeddingProvider,
  resolveNeonMemoryDbWriteGate,
  runNeonLiveIndexMemorySync,
  searchNeonMemoryDb,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon live-index memory sync", () => {
  it("collects Discord/Gateway, Claude transcript and Codex session records with redaction", async () => {
    const fixture = await createLiveIndexFixture();

    try {
      const collection = await collectNeonLiveIndexRecords({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        maxSourceItems: 10
      });
      const serialized = JSON.stringify(collection);

      assert.equal(collection.totals.discord, 1);
      assert.equal(collection.totals.claude, 1);
      assert.equal(collection.totals.codex, 1);
      assert.equal(collection.totals.records, 3);
      assert.deepEqual(
        [...new Set(collection.records.map((record) => record.source))].sort(),
        ["claude", "codex", "discord"]
      );
      assert.doesNotMatch(serialized, /sk-liveindex/u);
      assert.doesNotMatch(serialized, /\/Users\/smoke/u);
    } finally {
      await cleanup(fixture.projectRoot);
    }
  });

  it("is plan-only without a dbPath", async () => {
    const fixture = await createLiveIndexFixture();

    try {
      const result = await runNeonLiveIndexMemorySync({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        gate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" })
      });

      assert.equal(result.state, "planned");
      assert.equal(result.writes.length, 0);
      assert.equal(result.collection.totals.records, 3);
    } finally {
      await cleanup(fixture.projectRoot);
    }
  });

  it("writes all collected records to an isolated semantic-memory DB when armed", async () => {
    const fixture = await createLiveIndexFixture();
    const dbPath = join(fixture.projectRoot, "isolated-semantic-memory.db");

    try {
      const result = await runNeonLiveIndexMemorySync({
        projectRoot: fixture.projectRoot,
        transcriptProjectsDir: fixture.transcriptProjectsDir,
        codexSessionsDir: fixture.codexSessionsDir,
        dbPath,
        gate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
        embedder: createNeonLocalEmbeddingProvider()
      });
      const hits = searchNeonMemoryDb("Codex", { dbPath, category: "live-index", limit: 5 });

      assert.equal(result.state, "written");
      assert.equal(result.writes.filter((write) => write.state === "written").length, 3);
      assert.equal(result.safety.targetedRealMemoryDb, false);
      assert.ok(hits.length > 0);
    } finally {
      await cleanup(fixture.projectRoot);
    }
  });
});

interface ILiveIndexFixture {
  readonly projectRoot: string;
  readonly transcriptProjectsDir: string;
  readonly codexSessionsDir: string;
}

async function createLiveIndexFixture(): Promise<ILiveIndexFixture> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-live-index-test-"));
  const transcriptProjectsDir = join(projectRoot, "claude-projects");
  const codexSessionsDir = join(projectRoot, "codex-sessions");

  await writeNeonGatewayRun(projectRoot, createDiscordRun(projectRoot));
  await writeTranscriptFixture(transcriptProjectsDir);
  await writeCodexFixture(codexSessionsDir);

  return { projectRoot, transcriptProjectsDir, codexSessionsDir };
}

function createDiscordRun(projectRoot: string): INeonGatewayShadowRun {
  return {
    runId: "discord-live-index-run",
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
      contentPreview: "Discord memory sync with sk-liveindex1234567890abcdef at /Users/smoke/discord.txt",
      receivedAt: "2026-06-08T11:59:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "discord-session",
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
  const sessionDir = join(projectsDir, "-Users-smoke-neon-projects-live-index");
  await mkdir(sessionDir, { recursive: true });
  const padding = "Transcript fixture text above scanner byte floor. ".repeat(6);
  const lines = [
    JSON.stringify({ type: "user", message: `Cloud memory sync. ${padding}` }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: `Cloud ready with sk-liveindex1234567890abcdef at /Users/smoke/cloud.txt. ${padding}`
          }
        ]
      }
    })
  ];
  await writeFile(join(sessionDir, "claude-live-index.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function writeCodexFixture(sessionsDir: string): Promise<void> {
  const sessionDir = join(sessionsDir, "2026", "06", "08");
  await mkdir(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-06-08T12:00:00.000Z",
      payload: { id: "codex-live-index-session", cwd: "/Users/smoke/neonika" }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-08T12:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Bitte sammle diese Codex-Session für Memory." }]
      }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-08T12:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Codex digest ready for live-index sync." }]
      }
    })
  ];
  await writeFile(join(sessionDir, "codex-live-index-session.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function cleanup(projectRoot: string): Promise<void> {
  await rm(projectRoot, { force: true, recursive: true });
}
