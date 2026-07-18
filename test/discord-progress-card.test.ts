import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordComponentActionRegistry,
  createNeonDiscordProgressCardRuntime,
  createNeonDiscordRunControl,
  createNeonInFlightRunRegistry,
  createNeonSessionActorQueue,
  pickNeonProgressLabel,
  progressLineFromHarnessEvent,
  renderNeonDiscordProgressCard,
  shouldStartNeonDiscordProgressCard,
  type INeonDiscordProgressCardTransport,
  type INeonInFlightRunGate,
  type TNeonDiscordActionRow
} from "../src/index.js";

const enabledGate: INeonInFlightRunGate = {
  enabled: true,
  reason: "lifecycle-enabled",
  envKey: "NEON_LIVE_RUN_LIFECYCLE_ENABLED"
};

describe("Neon Discord progress card", () => {
  it("shows task progress only for real work, not normal chat", () => {
    assert.equal(shouldStartNeonDiscordProgressCard({ kind: "assistant-delta", text: "mooin" }), false);
    assert.equal(shouldStartNeonDiscordProgressCard({ kind: "final", text: "Moin." }), false);
    assert.equal(shouldStartNeonDiscordProgressCard({ kind: "tool-start", toolName: "exec" }), true);
    assert.equal(shouldStartNeonDiscordProgressCard({ kind: "file-write", path: "output.pdf" }), true);
    assert.equal(shouldStartNeonDiscordProgressCard({
      kind: "tool-output",
      toolName: "codex-app-server",
      output: "turn started",
      hideFromChannelProgress: true
    }), false);
  });

  it("posts one owner-bound Stop card and removes its components at completion", async () => {
    const transport = new RecordingProgressTransport();
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date("2026-07-10T01:00:00.000Z"),
      createActionId: () => "progress-stop"
    });
    const runtime = createNeonDiscordProgressCardRuntime({
      transport,
      registry,
      runControl: createRunControl(),
      now: () => new Date("2026-07-10T01:00:00.000Z"),
      minUpdateMs: 1
    });

    const handle = await runtime.start(startInput());
    const customId = readStopCustomId(transport.posts[0]?.rows ?? []);
    const foreign = await registry.dispatch({
      interactionId: "foreign",
      kind: "button",
      customId,
      userId: "other",
      guildId: "guild-1",
      channelId: "channel-1",
      createdAt: "2026-07-10T01:00:01.000Z"
    });
    const owner = await registry.dispatch({
      interactionId: "owner",
      kind: "button",
      customId,
      userId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      createdAt: "2026-07-10T01:00:01.000Z"
    });
    const finished = await handle.finish("completed");

    assert.equal(transport.posts.length, 1);
    assert.match(transport.posts[0]?.body ?? "", /Auftrag angenommen/u);
    assert.equal(foreign.state, "rejected");
    assert.equal(owner.state, "completed");
    assert.equal(transport.edits.at(-1)?.body, "✅ Auftrag abgeschlossen.");
    assert.deepEqual(transport.edits.at(-1)?.rows, []);
    assert.equal(finished.errorCount, 0);
  });

  it("coalesces harness events into fixed leak-safe states", async () => {
    const transport = new RecordingProgressTransport();
    const now = () => new Date("2026-07-10T01:00:00.000Z");
    const runtime = createNeonDiscordProgressCardRuntime({
      transport,
      registry: createNeonDiscordComponentActionRegistry({
        now
      }),
      runControl: createRunControl(),
      now,
      minUpdateMs: 1
    });
    const handle = await runtime.start(startInput());

    handle.observe({ kind: "tool-start", toolName: "secret-tool-sk-test-123" });
    handle.observe({ kind: "file-write", path: "/Users/operator/secret.pdf" });
    handle.observe({ kind: "command-exit", command: "cat .env", exitCode: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const result = await handle.finish("cancelled");
    const serialized = JSON.stringify(transport);

    assert.equal(transport.posts.length, 1);
    assert.ok(result.updateCount >= 1);
    assert.equal(transport.edits.at(-1)?.body, "⏹️ Auftrag gestoppt.");
    assert.doesNotMatch(serialized, /secret-tool|secret\.pdf|cat \.env|\/Users\/operator/u);
  });

  it("renders the upstream-style draft: label header, tool lines, step counter", async () => {
    const transport = new RecordingProgressTransport();
    const now = () => new Date("2026-07-10T01:00:00.000Z");
    const runtime = createNeonDiscordProgressCardRuntime({
      transport,
      registry: createNeonDiscordComponentActionRegistry({ now }),
      runControl: createRunControl(),
      now,
      minUpdateMs: 1
    });
    const handle = await runtime.start(startInput());
    const label = pickNeonProgressLabel("session-1");

    handle.observe({ kind: "tool-start", toolName: "web-search", detail: "Dragapult 3D model" });
    handle.observe({ kind: "tool-start", toolName: "command", detail: "npm run build" });
    handle.observe({ kind: "tool-output", toolName: "command", output: "item.completed commandExecution", detail: "npm run build" });
    handle.observe({ kind: "file-write", path: "/tmp/site/index.html" });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await handle.finish("completed");

    const bodies = transport.edits.map((edit) => edit.body).join("\n---\n");
    assert.match(bodies, new RegExp(`\\*\\*${label} …\\*\\* · Schritt 3`, "u"));
    assert.match(bodies, /🌐 Recherche: Dragapult 3D model/u);
    assert.match(bodies, /🛠️ Kommando: npm run build ✓/u);
    assert.match(bodies, /✍️ Datei geschrieben/u);
    assert.doesNotMatch(bodies, /index\.html|\/tmp/u);
    assert.equal(transport.edits.at(-1)?.body, "✅ Auftrag abgeschlossen.");
  });

  it("compacts overlong detail lines to 120 chars", () => {
    const long = "x".repeat(200);
    const body = renderNeonDiscordProgressCard("working", {
      count: 1,
      lines: [`🛠️ Kommando: ${long}`],
      label: "Working"
    });
    const line = body.split("\n")[1] ?? "";
    assert.equal(line.length, 120);
    assert.ok(line.endsWith("…"));
  });

  it("maps harness events onto registry labels with redacted-at-source details", () => {
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "web-search" }),
      "🌐 Recherche"
    );
    assert.equal(
      progressLineFromHarnessEvent({
        kind: "tool-start",
        toolName: "command",
        detail: "npm test"
      }),
      "🛠️ Kommando: npm test"
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "secret-tool-sk-test-123" }),
      "🧩 Arbeitsschritt"
    );
    assert.equal(
      progressLineFromHarnessEvent({
        kind: "tool-output",
        toolName: "codex-app-server",
        output: "turn.started t-1",
        hideFromChannelProgress: true
      }),
      undefined
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "final", text: "done" }),
      undefined
    );
  });

  it("maps Claude CLI tool names onto card labels and hides generic tool results", () => {
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "Bash" }),
      "🛠️ Kommando"
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "Read" }),
      "📖 Liest"
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "Edit" }),
      "📝 Dateien"
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "Grep" }),
      "🔎 Suche"
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "WebSearch" }),
      "🌐 Recherche"
    );
    assert.equal(
      progressLineFromHarnessEvent({ kind: "tool-start", toolName: "Task" }),
      "🤖 Agent"
    );
    // Claude tool_result events carry no per-tool identity; rendering them
    // would break merge-by-identity with the named start line.
    assert.equal(
      progressLineFromHarnessEvent({
        kind: "tool-output",
        toolName: "claude-cli",
        output: "done"
      }),
      undefined
    );
  });

  it("keeps the agent run fail-soft when a card edit fails", async () => {
    const transport = new RecordingProgressTransport(true);
    const now = () => new Date("2026-07-10T01:00:00.000Z");
    const runtime = createNeonDiscordProgressCardRuntime({
      transport,
      registry: createNeonDiscordComponentActionRegistry({
        now
      }),
      runControl: createRunControl(),
      now
    });
    const handle = await runtime.start(startInput());

    const result = await handle.finish("failed");

    assert.equal(result.errorCount, 1);
    assert.equal(result.updateCount, 0);
  });
});

class RecordingProgressTransport implements INeonDiscordProgressCardTransport {
  readonly posts: Array<{ readonly body: string; readonly rows: readonly TNeonDiscordActionRow[] }> = [];
  readonly edits: Array<{ readonly body: string; readonly rows: readonly TNeonDiscordActionRow[] }> = [];

  constructor(private readonly failEdits = false) {}

  post(
    _target: Parameters<INeonDiscordProgressCardTransport["post"]>[0],
    body: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }> {
    this.posts.push({ body, rows });
    return Promise.resolve({ messageId: "progress-message-1" });
  }

  edit(
    _target: Parameters<INeonDiscordProgressCardTransport["edit"]>[0],
    _messageId: string,
    body: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<void> {
    if (this.failEdits) {
      return Promise.reject(new Error("transport failed"));
    }
    this.edits.push({ body, rows });
    return Promise.resolve();
  }
}

function createRunControl() {
  return createNeonDiscordRunControl({
    inFlightRuns: createNeonInFlightRunRegistry({ gate: enabledGate }),
    sessionQueue: createNeonSessionActorQueue(),
    interruptRun: async () => undefined
  });
}

function startInput() {
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

function readStopCustomId(rows: readonly TNeonDiscordActionRow[]): string {
  const first = rows[0];
  if (!first || !("buttons" in first)) {
    throw new Error("Expected progress Stop button row");
  }
  const customId = first.buttons[0]?.customId;
  if (!customId) {
    throw new Error("Expected progress Stop custom id");
  }
  return customId;
}
