import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordComponentActionRegistry,
  createNeonDiscordSessionRuntimePicker,
  isNeonDiscordSessionRuntimePickerCommand,
  neonDiscordClaudeRuntimePresets,
  resolveNeonDiscordSessionRuntimeStatePath,
  type INeonDiscordRuntimeOption,
  type INeonGatewayShadowRun,
  type TNeonDiscordActionRow
} from "../src/index.js";

const nowIso = "2026-07-10T08:00:00.000Z";
const catalog: readonly INeonDiscordRuntimeOption[] = [
  {
    id: "codex-primary",
    label: "Codex · gpt-5.6-sol · xhigh",
    description: "OpenAI · Codex App Server",
    provider: "openai",
    runtime: "codex",
    lane: "codex-app-server",
    model: "gpt-5.6-sol",
    effort: "xhigh"
  },
  {
    id: "claude-primary",
    label: "Claude · opus · max",
    description: "Anthropic · Claude CLI",
    provider: "anthropic",
    runtime: "claude",
    lane: "claude-cli",
    model: "opus",
    effort: "max"
  }
];

describe("Discord session runtime picker", () => {
  it("recognizes only exact picker commands", () => {
    assert.equal(isNeonDiscordSessionRuntimePickerCommand("/model"), true);
    assert.equal(isNeonDiscordSessionRuntimePickerCommand(" /modell "), true);
    assert.equal(isNeonDiscordSessionRuntimePickerCommand("/runtime"), true);
    assert.equal(isNeonDiscordSessionRuntimePickerCommand("/model bitte"), false);
    assert.equal(isNeonDiscordSessionRuntimePickerCommand("model"), false);
  });

  it("binds owner and scope, persists the choice, and confirms it from a real run", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-runtime-picker-"));
    const transport = new RecordingTransport();
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(nowIso),
      createActionId: () => "runtime-picker"
    });
    const picker = createNeonDiscordSessionRuntimePicker({
      projectRoot,
      registry,
      transport,
      catalog,
      now: () => new Date(nowIso)
    });

    try {
      await picker.open(openInput());
      const customId = readSelectCustomId(transport.rows);
      const foreign = await registry.dispatch(interaction(customId, "other", ["claude-primary"]));
      const owner = await registry.dispatch(interaction(customId, "operator", ["claude-primary"]));
      const selected = picker.resolve("session-1", "operator");

      assert.equal(foreign.state, "rejected");
      assert.equal(foreign.reason, "owner-mismatch");
      assert.equal(owner.state, "completed");
      assert.equal(selected?.provider, "anthropic");
      assert.equal(selected?.model, "opus");
      assert.equal(selected?.status, "pending-confirmation");
      assert.equal((await stat(resolveNeonDiscordSessionRuntimeStatePath(projectRoot))).mode & 0o777, 0o600);

      const restarted = createNeonDiscordSessionRuntimePicker({
        projectRoot,
        registry: createNeonDiscordComponentActionRegistry(),
        transport: new RecordingTransport(),
        catalog,
        now: () => new Date(nowIso)
      });
      assert.equal(restarted.resolve("session-1", "operator")?.selectionId, "claude-primary");
      assert.equal(await restarted.confirmRun(run("claude-cli", catalog[1])), true);
      assert.equal(restarted.resolve("session-1", "operator")?.status, "confirmed");
      assert.equal(restarted.resolve("session-1", "operator")?.confirmedRunId, "run-1");
      const changedCatalog = createNeonDiscordSessionRuntimePicker({
        projectRoot,
        registry: createNeonDiscordComponentActionRegistry(),
        transport: new RecordingTransport(),
        catalog: catalog.map((entry) => entry.id === "claude-primary" ? { ...entry, model: "sonnet" } : entry),
        now: () => new Date(nowIso)
      });
      assert.equal(changedCatalog.resolve("session-1", "operator"), undefined);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects a forged catalog value and incompatible runtime metadata", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-runtime-picker-forged-"));
    const transport = new RecordingTransport();
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(nowIso),
      createActionId: () => "runtime-forged"
    });
    const picker = createNeonDiscordSessionRuntimePicker({
      projectRoot,
      registry,
      transport,
      catalog,
      now: () => new Date(nowIso)
    });

    try {
      await picker.open(openInput());
      const result = await registry.dispatch(
        interaction(readSelectCustomId(transport.rows), "operator", ["forged-model"])
      );
      assert.equal(result.state, "failed");
      assert.equal(picker.resolve("session-1", "operator"), undefined);
      assert.throws(
        () => createNeonDiscordSessionRuntimePicker({
          projectRoot,
          registry,
          transport,
          catalog: [{ ...catalog[0]!, provider: "anthropic" }]
        }),
        /incompatible/u
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("ships a curated Claude preset palette that validates against the picker", async () => {
    assert.equal(neonDiscordClaudeRuntimePresets.length, 4);
    assert.equal(new Set(neonDiscordClaudeRuntimePresets.map((preset) => preset.id)).size, 4);
    for (const preset of neonDiscordClaudeRuntimePresets) {
      assert.equal(preset.provider, "anthropic");
      assert.equal(preset.runtime, "claude");
      assert.equal(preset.lane, "claude-cli");
      assert.ok(["opus", "sonnet", "haiku"].includes(preset.model ?? ""));
      assert.ok(["low", "medium", "high", "xhigh", "max"].includes(preset.effort ?? ""));
    }

    // The presets must pass the picker's own catalog validation.
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-runtime-picker-presets-"));
    try {
      const picker = createNeonDiscordSessionRuntimePicker({
        projectRoot,
        registry: createNeonDiscordComponentActionRegistry({ now: () => new Date(nowIso) }),
        transport: new RecordingTransport(),
        catalog: neonDiscordClaudeRuntimePresets,
        now: () => new Date(nowIso)
      });
      assert.deepEqual(picker.list(), []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

class RecordingTransport {
  rows: readonly TNeonDiscordActionRow[] = [];

  postComponents(
    _target: Parameters<ReturnType<typeof createNeonDiscordSessionRuntimePicker>["open"]>[0]["target"],
    _content: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }> {
    this.rows = rows;
    return Promise.resolve({ messageId: "picker-message-1" });
  }
}

function openInput() {
  return {
    target: {
      channel: "discord" as const,
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      replyToMessageId: "origin-1"
    },
    ownerUserId: "operator",
    guildId: "guild-1",
    channelId: "channel-1",
    sessionKey: "session-1"
  };
}

function interaction(customId: string, userId: string, values: readonly string[]) {
  return {
    interactionId: `interaction-${userId}`,
    kind: "string-select" as const,
    customId,
    userId,
    guildId: "guild-1",
    channelId: "channel-1",
    values,
    createdAt: nowIso
  };
}

function readSelectCustomId(rows: readonly TNeonDiscordActionRow[]): string {
  const row = rows[0];
  if (!row || !("select" in row)) {
    throw new Error("Expected runtime picker select row");
  }
  return row.select.customId;
}

function run(
  harnessId: "codex-app-server" | "claude-cli",
  runtime: INeonDiscordRuntimeOption | undefined
): INeonGatewayShadowRun {
  if (!runtime) {
    throw new Error("Runtime fixture is missing");
  }
  return {
    runId: "run-1",
    mode: "live",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/neonika",
      mode: "write",
      contentPreview: "hello",
      receivedAt: nowIso
    },
    harnessId,
    runtime: {
      provider: runtime.provider,
      runtime: runtime.runtime,
      lane: runtime.lane,
      model: runtime.model,
      effort: runtime.effort
    },
    harnessSessionKey: "session-1",
    memoryState: "skipped",
    events: [{ kind: "final", text: "done" }],
    finalText: "done",
    delivery: {
      state: "delivered",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "canary-reply",
      finalText: "done",
      messageId: "reply-1"
    },
    startedAt: nowIso,
    completedAt: "2026-07-10T08:00:05.000Z"
  };
}
