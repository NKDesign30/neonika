import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonChatSnapshot,
  renderNeonChatReport,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neonika Chat transcript", () => {
  it("groups Gateway runs into channel conversations with inbound and agent messages", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createChatRun("run-chat-1", "Was ist der Status?"));
      await writeNeonGatewayRun(projectRoot, createChatRun("run-chat-2", "Zeig die letzte Antwort"));

      const snapshot = await createNeonChatSnapshot(projectRoot, {
        now: () => new Date("2026-05-31T21:44:00.000Z")
      });
      const conversation = snapshot.conversations[0];

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.conversations, 1);
      assert.equal(snapshot.totals.sourceRuns, 2);
      assert.equal(snapshot.totals.filteredRuns, 2);
      assert.equal(snapshot.totals.runs, 2);
      assert.equal(snapshot.totals.messages, 4);
      assert.equal(conversation?.runCount, 2);
      assert.equal(conversation?.messages[0]?.direction, "inbound");
      assert.ok(conversation?.messages.some((message) => message.direction === "agent"));
      assert.equal(conversation?.users[0], "Operator");
      assert.equal(conversation?.agents[0], "chaty");
      assert.doesNotMatch(JSON.stringify(snapshot), /sk-test-secret-value/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("attaches redacted tool events to the agent chat message", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createChatToolRun("run-chat-tools"));

      const snapshot = await createNeonChatSnapshot(projectRoot, {
        now: () => new Date("2026-05-31T21:44:00.000Z")
      });
      const conversation = snapshot.conversations[0];
      const agentMessage = conversation?.messages.find((message) => message.direction === "agent");
      const serialized = JSON.stringify(snapshot);

      assert.ok(agentMessage);
      assert.equal(agentMessage.toolEvents.length, 4);
      assert.equal(agentMessage.toolEvents[0]?.kind, "tool-start");
      assert.equal(agentMessage.toolEvents[0]?.toolCallId, "call-shell-1");
      assert.equal(agentMessage.toolEvents[1]?.kind, "tool-output");
      assert.equal(agentMessage.toolEvents[1]?.preview, "[REDACTED_SECRET]");
      assert.equal(agentMessage.toolEvents[2]?.kind, "file-write");
      assert.equal(agentMessage.toolEvents[2]?.preview, "[REDACTED_PATH]");
      assert.equal(agentMessage.toolEvents[3]?.kind, "command-exit");
      assert.equal(agentMessage.toolEvents[3]?.status, "error");
      assert.doesNotMatch(serialized, /sk-test-secret-value/);
      assert.doesNotMatch(serialized, /\/Users\/operator\/secret/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("hides internal channel progress tool events from chat tool events", async () => {
    const projectRoot = await createTempProjectRoot();
    const baseRun = createChatToolRun("run-chat-hidden-progress");
    const run: INeonGatewayShadowRun = {
      ...baseRun,
      events: [
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: "turn.completed turn-1 status=completed",
          hideFromChannelProgress: true
        },
        ...baseRun.events
      ]
    };

    try {
      await writeNeonGatewayRun(projectRoot, run);

      const snapshot = await createNeonChatSnapshot(projectRoot);
      const agentMessage = snapshot.conversations[0]?.messages.find((message) => message.direction === "agent");
      const serialized = JSON.stringify(snapshot);

      assert.equal(agentMessage?.toolEvents.length, 4);
      assert.doesNotMatch(serialized, /turn\.completed/u);
      assert.equal(agentMessage?.toolEvents[0]?.toolName, "shell");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("filters channel transcripts from the run store without fetching Discord history", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createChatRun("run-chat-main", "Main bleibt draußen"));
      await writeNeonGatewayRun(
        projectRoot,
        createChatRun("run-chat-ops", "Ops bitte anzeigen", {
          channelId: "900000000000000004",
          harnessSessionKey:
            "neon:codex:chaty:discord:default:900000000000000001:900000000000000004:main:hash:read-only"
        })
      );

      const snapshot = await createNeonChatSnapshot(projectRoot, {
        channelId: "900000000000000004",
        now: () => new Date("2026-05-31T21:45:00.000Z")
      });
      const report = renderNeonChatReport(snapshot);
      const conversation = snapshot.conversations[0];

      assert.equal(snapshot.state, "ready");
      assert.deepEqual(snapshot.filters, {
        channelId: "900000000000000004"
      });
      assert.equal(snapshot.totals.sourceRuns, 2);
      assert.equal(snapshot.totals.filteredRuns, 1);
      assert.equal(snapshot.totals.runs, 1);
      assert.equal(snapshot.totals.conversations, 1);
      assert.equal(snapshot.totals.messages, 2);
      assert.equal(conversation?.channelId, "900000000000000004");
      assert.equal(conversation?.messages[0]?.textPreview, "Ops bitte anzeigen");
      assert.doesNotMatch(JSON.stringify(snapshot), /Main bleibt draußen/);
      assert.match(report, /Runs: 1\/2/);
      assert.match(report, /Filters: channelId=900000000000000004/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reports not-found when chat filters do not match stored runs", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createChatRun("run-chat-main", "Main"));

      const snapshot = await createNeonChatSnapshot(projectRoot, {
        channelId: "missing-channel"
      });

      assert.equal(snapshot.state, "not-found");
      assert.equal(snapshot.totals.sourceRuns, 1);
      assert.equal(snapshot.totals.filteredRuns, 0);
      assert.equal(snapshot.totals.messages, 0);
      assert.deepEqual(snapshot.conversations, []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("filters chat transcripts by agent without fetching Discord history", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createChatRun("run-chat-chaty", "Chaty Lauf", { agentId: "chaty" }));
      await writeNeonGatewayRun(projectRoot, createChatRun("run-chat-nova", "Nova Lauf", { agentId: "nova" }));

      const snapshot = await createNeonChatSnapshot(projectRoot, { agentId: "nova" });

      assert.deepEqual(snapshot.filters, { agentId: "nova" });
      assert.equal(snapshot.totals.filteredRuns, 1);
      assert.ok(
        snapshot.conversations.every((conversation) =>
          conversation.messages.every(
            (message) => message.direction === "inbound" || message.agentId === "nova"
          )
        )
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders leak-safe tool cards for the latest agent message in the chat report", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createChatToolRun("run-chat-cards"));

      const snapshot = await createNeonChatSnapshot(projectRoot, {
        now: () => new Date("2026-05-31T21:44:00.000Z")
      });
      const report = renderNeonChatReport(snapshot);

      assert.match(report, /Tools \[chaty run-chat-cards\]:/);
      assert.match(report, /\[tool-start\] Tool shell \(started\)/);
      assert.match(report, /tool=shell/);
      assert.match(report, /\[command-exit\].*\(error\)/);
      assert.match(report, /exit=1/);
      // The redacted previews surface, never the raw secret/path.
      assert.match(report, /\[REDACTED_SECRET\]/);
      assert.match(report, /\[REDACTED_PATH\]/);
      assert.doesNotMatch(report, /sk-test-secret-value/);
      assert.doesNotMatch(report, /\/Users\/operator\/secret/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders an empty chat report when no Gateway runs exist", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const report = renderNeonChatReport(await createNeonChatSnapshot(projectRoot));

      assert.match(report, /Neonika Chat: empty/);
      assert.match(report, /Latest: none/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

interface ICreateChatRunOverrides {
  readonly channelId?: string;
  readonly harnessSessionKey?: string;
  readonly agentId?: string;
}

function createChatRun(
  runId: string,
  contentPreview: string,
  overrides: ICreateChatRunOverrides = {}
): INeonGatewayShadowRun {
  const channelId = overrides.channelId ?? "900000000000000005";

  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId,
      threadId: "900000000000000011",
      messageId: `${runId}-message`,
      userId: "operator",
      userDisplayName: "Operator",
      agentId: overrides.agentId ?? "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview,
      receivedAt: "2026-05-31T21:42:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey:
      overrides.harnessSessionKey ??
      "neon:codex:chaty:discord:default:900000000000000001:900000000000000005:thread:hash:read-only",
    memoryState: "attached",
    events: [
      {
        kind: "final",
        text: "Antwort sk-test-secret-value"
      }
    ],
    finalText: "Antwort sk-test-secret-value",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "Antwort sk-test-secret-value"
    },
    startedAt: "2026-05-31T21:42:00.000Z",
    completedAt: "2026-05-31T21:42:01.000Z"
  };
}

function createChatToolRun(runId: string): INeonGatewayShadowRun {
  return {
    ...createChatRun(runId, "Zeig mir die Tool-Ausführung"),
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
        output: "sk-test-secret-value"
      },
      {
        kind: "file-write",
        path: "/Users/operator/secret/project/output.txt"
      },
      {
        kind: "command-exit",
        command: "npm test --token sk-test-secret-value",
        exitCode: 1
      },
      {
        kind: "final",
        text: "Antwort sk-test-secret-value"
      }
    ]
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-chat-transcript-"));
}
