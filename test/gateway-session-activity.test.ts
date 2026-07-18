import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonActivitySnapshot,
  createNeonSessionsSnapshot,
  renderNeonActivityReport,
  renderNeonSessionsReport,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon Sessions and Activity snapshots", () => {
  it("groups Gateway runs into durable Neon session rows", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createSessionRun(projectRoot, "run-1", "completed"));
      await writeNeonGatewayRun(projectRoot, createSessionRun(projectRoot, "run-2", "failed"));

      const snapshot = await createNeonSessionsSnapshot(projectRoot, {
        now: () => new Date("2026-05-31T22:00:00.000Z")
      });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.sessions, 1);
      assert.equal(snapshot.totals.runs, 2);
      assert.equal(snapshot.totals.failedRuns, 1);
      assert.equal(snapshot.totals.runningRuns, 0);
      assert.deepEqual(snapshot.totals.tokenTotals, {
        inputTokens: 16,
        outputTokens: 6,
        totalTokens: 22
      });
      assert.equal(snapshot.sessions[0]?.key, "session-key-1");
      assert.equal(snapshot.sessions[0]?.runCount, 2);
      assert.equal(snapshot.sessions[0]?.messageCount, 4);
      assert.equal(snapshot.sessions[0]?.sessionStatus, "failed");
      assert.equal(snapshot.sessions[0]?.runningRuns, 0);
      assert.deepEqual(snapshot.sessions[0]?.tokenTotals, {
        inputTokens: 16,
        outputTokens: 6,
        totalTokens: 22
      });
      assert.equal(snapshot.sessions[0]?.goal, "Ship Neonika Discord parity");
      const transcript = snapshot.sessions[0]?.transcript;
      assert.ok(transcript);
      assert.equal(transcript.conversationId.startsWith("chat-"), true);
      assert.equal(
        transcript.chatPath,
        `/mission-control/chat?replayConversationId=${transcript.conversationId}&replayChannelId=900000000000000005`
      );
      assert.equal(transcript.replayPath, "/mission-control/activity?sessionKey=session-key-1");
      assert.equal(
        transcript.apiPath,
        `/api/neon-replay?sessionKey=session-key-1&conversationId=${transcript.conversationId}&channelId=900000000000000005`
      );
      assert.equal(snapshot.sessions[0]?.latestRunId, "run-2");
      assert.equal(snapshot.sessions[0]?.workspaceName.startsWith("/"), false);
      const report = renderNeonSessionsReport(snapshot);
      assert.match(report, /Neon Sessions: ready/);
      assert.match(report, /status: failed \(latest=failed\)/);
      assert.match(report, /tokens: 22 \(16 in \/ 6 out\)/);
      assert.match(report, /goal: Ship Neonika Discord parity/);
      assert.match(report, /transcript: \/mission-control\/activity\?sessionKey=session-key-1/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("projects Gateway run events into redacted activity entries", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createSessionRun(projectRoot, "run-activity", "failed"));

      const snapshot = await createNeonActivitySnapshot(projectRoot, {
        now: () => new Date("2026-05-31T22:00:00.000Z")
      });
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.runs, 1);
      assert.ok(snapshot.totals.entries >= 7);
      assert.ok(snapshot.totals.errors >= 2);
      assert.ok(snapshot.entries.some((entry) => entry.kind === "delivery"));
      assert.ok(snapshot.entries.some((entry) => entry.kind === "command" && entry.status === "error"));
      assert.ok(snapshot.entries.some((entry) => entry.kind === "usage" && entry.summary.includes("8 token")));
      assert.doesNotMatch(serialized, /\/Users\/operator\/secret/);
      assert.doesNotMatch(serialized, /sk-test-secret/);
      assert.match(serialized, /\[REDACTED_PATH\]/);
      assert.match(serialized, /\[REDACTED\]/);
      assert.match(renderNeonActivityReport(snapshot), /Neon Activity: ready/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("hides internal channel progress tool events from activity entries", async () => {
    const projectRoot = await createTempProjectRoot();
    const baseRun = createSessionRun(projectRoot, "run-hidden-progress", "completed");
    const run: INeonGatewayShadowRun = {
      ...baseRun,
      events: [
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: "turn.completed turn-1 status=completed",
          hideFromChannelProgress: true
        },
        {
          kind: "tool-output",
          toolName: "shell",
          output: "visible"
        },
        {
          kind: "final",
          text: "Done"
        }
      ]
    };

    try {
      await writeNeonGatewayRun(projectRoot, run);

      const snapshot = await createNeonActivitySnapshot(projectRoot);
      const serialized = JSON.stringify(snapshot);

      assert.doesNotMatch(serialized, /turn\.completed/u);
      assert.ok(snapshot.entries.some((entry) => entry.summary === "shell returned output."));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("treats a persisted running Gateway run as an active session and activity row", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createSessionRun(projectRoot, "run-running", "running"));

      const sessions = await createNeonSessionsSnapshot(projectRoot, {
        now: () => new Date("2026-05-31T22:00:00.000Z")
      });
      const activity = await createNeonActivitySnapshot(projectRoot, {
        now: () => new Date("2026-05-31T22:00:00.000Z")
      });
      const runEntry = activity.entries.find(
        (entry) => entry.id === "run-running:002:run"
      );

      assert.equal(sessions.totals.runningRuns, 1);
      assert.equal(sessions.sessions[0]?.sessionStatus, "running");
      assert.equal(sessions.sessions[0]?.latestRunStatus, "running");
      assert.equal(runEntry?.status, "running");
      assert.match(renderNeonSessionsReport(sessions), /status: running \(latest=running\)/);
      assert.match(renderNeonActivityReport(activity), /codex-app-server running/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("merges tool activity by toolCallId without leaking tool output secrets", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createToolCallRun(projectRoot));

      const snapshot = await createNeonActivitySnapshot(projectRoot, {
        now: () => new Date("2026-05-31T22:00:00.000Z")
      });
      const serialized = JSON.stringify(snapshot);
      const shellEntry = snapshot.entries.find((entry) => entry.id === "run-tool-call:tool:call-shell-1");

      assert.ok(shellEntry);
      assert.equal(shellEntry.toolCallId, "call-shell-1");
      assert.equal(shellEntry.kind, "tool");
      assert.equal(shellEntry.status, "done");
      assert.equal(shellEntry.title, "Tool shell");
      assert.equal(shellEntry.summary, "shell returned output.");
      assert.equal(snapshot.entries.filter((entry) => entry.title === "Tool shell").length, 1);
      assert.doesNotMatch(serialized, /sk-test-secret/);
      assert.match(serialized, /\[REDACTED\]/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("marks a tool-call with a dangling tool-start (no output) as running", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createToolCallRun(projectRoot));

      const snapshot = await createNeonActivitySnapshot(projectRoot, {
        now: () => new Date("2026-05-31T22:00:00.000Z")
      });
      const browserEntry = snapshot.entries.find(
        (entry) => entry.id === "run-tool-call:tool:call-browser-1"
      );
      const shellEntry = snapshot.entries.find(
        (entry) => entry.id === "run-tool-call:tool:call-shell-1"
      );

      assert.equal(browserEntry?.status, "running");
      assert.equal(shellEntry?.status, "done");
      assert.ok(snapshot.totals.running >= 1);
      assert.match(renderNeonActivityReport(snapshot), /status: running/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("returns empty snapshots when no Gateway runs exist", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const sessions = await createNeonSessionsSnapshot(projectRoot);
      const activity = await createNeonActivitySnapshot(projectRoot);

      assert.equal(sessions.state, "empty");
      assert.equal(sessions.sessions.length, 0);
      assert.equal(activity.state, "empty");
      assert.equal(activity.entries.length, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createSessionRun(
  projectRoot: string,
  runId: string,
  status: INeonGatewayShadowRun["status"]
): INeonGatewayShadowRun {
  const failed = status === "failed";

  return {
    runId,
    mode: "shadow",
    status,
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      threadId: "thread-1",
      messageId: `${runId}-message`,
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "read-only",
      goal: "Ship Neonika Discord parity",
      contentPreview: "Session and activity smoke",
      receivedAt: failed ? "2026-05-31T21:02:00.000Z" : "2026-05-31T21:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-key-1",
    memoryState: failed ? "failed" : "attached",
    events: [
      {
        kind: "tool-start",
        toolName: "shell"
      },
      {
        kind: "tool-output",
        toolName: "shell",
        output: "OPENAI_API_KEY=sk-test-secret-1234567890"
      },
      {
        kind: "file-write",
        path: "/Users/operator/secret/project/output.txt"
      },
      {
        kind: "command-exit",
        command: "npm test",
        exitCode: failed ? 1 : 0
      },
      {
        kind: "token-usage",
        inputTokens: failed ? 6 : 10,
        outputTokens: failed ? 2 : 4,
        totalTokens: failed ? 8 : 14
      },
      failed
        ? {
            kind: "failed",
            message: "Command failed"
          }
        : {
            kind: "final",
            text: "Done"
          }
    ],
    finalText: failed ? "Command failed" : "Done",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: failed ? "Command failed" : "Done"
    },
    startedAt: failed ? "2026-05-31T21:02:00.000Z" : "2026-05-31T21:00:00.000Z",
    completedAt: failed ? "2026-05-31T21:02:02.000Z" : "2026-05-31T21:00:01.000Z"
  };
}

function createToolCallRun(projectRoot: string): INeonGatewayShadowRun {
  return {
    ...createSessionRun(projectRoot, "run-tool-call", "completed"),
    events: [
      {
        kind: "tool-start",
        toolName: "shell",
        toolCallId: "call-shell-1"
      },
      {
        kind: "tool-output",
        toolName: "shell",
        toolCallId: "call-shell-1",
        output: "OPENAI_API_KEY=sk-test-secret-1234567890"
      },
      {
        kind: "tool-start",
        toolName: "browser",
        toolCallId: "call-browser-1"
      },
      {
        kind: "final",
        text: "Done"
      }
    ]
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-session-activity-"));
}
