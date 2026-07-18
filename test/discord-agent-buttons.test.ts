import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordAgentButtonsRuntime,
  createNeonDiscordComponentActionRegistry,
  isNeonDiscordAgentButtonsActionType,
  parseNeonDiscordButtonsMarker,
  type INeonDeliveryQueueTarget,
  type INeonGatewayShadowRun,
  type TNeonDiscordActionRow
} from "../src/index.js";

const nowIso = "2026-07-10T22:00:00.000Z";

describe("Neon Discord agent buttons marker parser", () => {
  it("parses labels and strips the marker from the reply text", () => {
    const result = parseNeonDiscordButtonsMarker(
      "Fertig gebaut.\n<NEON_BUTTONS>Weiter|Abbrechen|Details zeigen</NEON_BUTTONS>"
    );

    assert.equal(result.text, "Fertig gebaut.");
    assert.deepEqual(result.buttons, ["Weiter", "Abbrechen", "Details zeigen"]);
  });

  it("returns the text unchanged when no marker is present", () => {
    const result = parseNeonDiscordButtonsMarker("Nur Text.");

    assert.equal(result.text, "Nur Text.");
    assert.equal(result.buttons, undefined);
  });

  it("strips invalid markers without producing buttons", () => {
    const tooMany = parseNeonDiscordButtonsMarker(
      "<NEON_BUTTONS>a|b|c|d|e|f</NEON_BUTTONS>"
    );
    assert.equal(tooMany.buttons, undefined);
    assert.equal(tooMany.text, "");

    const tooLong = parseNeonDiscordButtonsMarker(
      `<NEON_BUTTONS>ok|${"x".repeat(81)}</NEON_BUTTONS>`
    );
    assert.equal(tooLong.buttons, undefined);
  });

  it("uses the first marker, strips all, and redacts secrets in labels", () => {
    const result = parseNeonDiscordButtonsMarker(
      [
        "Antwort.",
        "<NEON_BUTTONS>rotate sk-test-secret-value|keep</NEON_BUTTONS>",
        "<NEON_BUTTONS>Zweiter|Marker</NEON_BUTTONS>"
      ].join("\n")
    );

    assert.equal(result.buttons?.length, 2);
    assert.doesNotMatch(JSON.stringify(result.buttons), /sk-test-secret-value/u);
    assert.doesNotMatch(result.text, /NEON_BUTTONS/u);
  });
});

describe("Neon Discord agent buttons runtime", () => {
  it("presents a button row and feeds the clicked label into execute", async () => {
    const registry = createNeonDiscordComponentActionRegistry({ now: () => new Date(nowIso) });
    const posted: Array<{ content: string; rows: readonly TNeonDiscordActionRow[] }> = [];
    const executed: string[] = [];
    const runtime = createNeonDiscordAgentButtonsRuntime({
      registry,
      transport: {
        postComponents: (_target, content, rows) => {
          posted.push({ content, rows });
          return Promise.resolve({ messageId: "buttons-message-1" });
        }
      },
      execute: ({ label }) => {
        executed.push(label);
        return Promise.resolve(`„${label}“ erledigt.`);
      },
      now: () => new Date(nowIso)
    });

    const presented = await runtime.present(run(), target(), ["Weiter", "Abbrechen"]);

    assert.deepEqual(presented, { messageId: "buttons-message-1" });
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.content, "Schnellantworten:");
    const row = posted[0]?.rows[0];
    if (!row || !("buttons" in row)) {
      throw new Error("Expected a button row");
    }
    assert.deepEqual(
      row.buttons.map((button) => button.label),
      ["Weiter", "Abbrechen"]
    );

    const clicked = row.buttons[1]?.customId;
    assert.ok(clicked);
    const outcome = await registry.dispatch({
      interactionId: "interaction-1",
      kind: "button",
      customId: clicked,
      userId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      createdAt: nowIso
    });

    assert.equal(outcome.state, "completed");
    assert.deepEqual(executed, ["Abbrechen"]);
    assert.ok(isNeonDiscordAgentButtonsActionType("agent-buttons:pick"));
  });

  it("rejects a click from a different user via the registry owner binding", async () => {
    const registry = createNeonDiscordComponentActionRegistry({ now: () => new Date(nowIso) });
    const executed: string[] = [];
    let capturedRows: readonly TNeonDiscordActionRow[] = [];
    const runtime = createNeonDiscordAgentButtonsRuntime({
      registry,
      transport: {
        postComponents: (_target, _content, rows) => {
          capturedRows = rows;
          return Promise.resolve({ messageId: "buttons-message-2" });
        }
      },
      execute: ({ label }) => {
        executed.push(label);
        return Promise.resolve("ok");
      },
      now: () => new Date(nowIso)
    });

    await runtime.present(run(), target(), ["Weiter"]);
    const row = capturedRows[0];
    if (!row || !("buttons" in row)) {
      throw new Error("Expected a button row");
    }
    const outcome = await registry.dispatch({
      interactionId: "interaction-2",
      kind: "button",
      customId: row.buttons[0]?.customId ?? "",
      userId: "fremder",
      guildId: "guild-1",
      channelId: "channel-1",
      createdAt: nowIso
    });

    assert.notEqual(outcome.state, "completed");
    assert.deepEqual(executed, []);
  });

  it("fails soft when the transport throws and when labels are invalid", async () => {
    const registry = createNeonDiscordComponentActionRegistry({ now: () => new Date(nowIso) });
    const runtime = createNeonDiscordAgentButtonsRuntime({
      registry,
      transport: {
        postComponents: () => {
          throw new Error("transport down");
        }
      },
      execute: () => Promise.resolve("ok"),
      now: () => new Date(nowIso)
    });

    assert.equal(await runtime.present(run(), target(), ["Weiter"]), undefined);
    assert.equal(await runtime.present(run(), target(), []), undefined);
    assert.equal(await runtime.present(run(), target(), ["x".repeat(81)]), undefined);
  });
});

function target(): INeonDeliveryQueueTarget {
  return {
    channel: "discord",
    accountId: "default",
    channelId: "channel-1"
  };
}

function run(): INeonGatewayShadowRun {
  return {
    runId: "run-1",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "operator",
      userDisplayName: "the operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/neonika",
      mode: "read-only",
      contentPreview: "ping",
      receivedAt: nowIso
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-1",
    memoryState: "attached",
    events: [],
    finalText: "Fertig.",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "Fertig."
    },
    startedAt: nowIso,
    completedAt: nowIso
  };
}
