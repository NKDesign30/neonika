import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordCapacityFingerprint,
  createNeonDiscordCapacityGate,
  createNeonDiscordComponentActionRegistry,
  parseNeonDiscordCapacityUpgradeRequest,
  resolveNeonDiscordCapacityDecision,
  type INeonDiscordComponentInteraction,
  type TNeonDiscordActionRow
} from "../src/index.js";

describe("Discord capacity router", () => {
  it("routes chat to Luna, normal work to Terra, and high-stakes work to Sol confirmation", () => {
    assert.deepEqual(resolveNeonDiscordCapacityDecision({ content: "super danke" }), {
      tier: "luna",
      model: "gpt-5.6-luna",
      effort: "medium",
      requiresConfirmation: false,
      reasons: ["kurze Unterhaltung"]
    });

    assert.deepEqual(
      resolveNeonDiscordCapacityDecision({
        content: "Ändere in der Leadliste Zeile 2 und prüfe danach den neuen Stand."
      }),
      {
        tier: "terra",
        model: "gpt-5.6-terra",
        effort: "high",
        requiresConfirmation: false,
        reasons: ["operativer Arbeitsauftrag"]
      }
    );

    const heavy = resolveNeonDiscordCapacityDecision({
      content:
        "Stell dich in die Rolle einer Bank, prüfe den Businessplan für einen Kredit und überarbeite die Finanzplanung für 3 bis 5 Jahre, bis du zufrieden bist."
    });
    assert.equal(heavy.tier, "sol");
    assert.equal(heavy.model, "gpt-5.6-sol");
    assert.equal(heavy.effort, "xhigh");
    assert.equal(heavy.requiresConfirmation, true);
    assert.ok(heavy.reasons.includes("Finanzen oder Bankprüfung"));
    assert.ok(heavy.reasons.includes("mehrstufige Qualitätsprüfung"));
  });

  it("keeps ordinary attachment transformations on Terra", () => {
    assert.equal(
      resolveNeonDiscordCapacityDecision({
        content: "Übersetze diese Preisliste und erstelle daraus eine Excel-Datei.",
        attachments: [{ name: "Preisliste.pdf", kind: "file" }]
      }).tier,
      "terra"
    );
  });

  it("creates an owner-bound single-use decision card for the pending task", async () => {
    const now = () => new Date("2026-07-10T12:00:00.000Z");
    const actionIds = ["capacity-sol", "capacity-terra", "capacity-cancel"];
    const registry = createNeonDiscordComponentActionRegistry({
      now,
      createActionId: () => actionIds.shift() ?? "unexpected-action"
    });
    const postedRows: TNeonDiscordActionRow[][] = [];
    const executions: Array<{ readonly model: string; readonly effort: string; readonly messageId: string }> = [];
    const gate = createNeonDiscordCapacityGate({
      registry,
      now,
      transport: {
        postComponents: (_target, _content, rows) => {
          postedRows.push([...rows]);
          return Promise.resolve({ messageId: "capacity-card-1" });
        }
      },
      execute: (input) => {
        executions.push({
          model: input.runtime.model,
          effort: input.runtime.effort,
          messageId: input.messageId
        });
        return Promise.resolve({ runId: "capacity-run-1", status: "completed" });
      }
    });
    const fingerprint = createNeonDiscordCapacityFingerprint({ content: "Prüfe den Businessplan als Bank." });

    const opened = await gate.request({
      target: {
        channel: "discord",
        accountId: "default",
        guildId: "guild-1",
        channelId: "channel-1",
        replyToMessageId: "message-1"
      },
      ownerUserId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-1",
      messageId: "message-1",
      fingerprint,
      decision: resolveNeonDiscordCapacityDecision({ content: "Prüfe den Businessplan als Bank." })
    });

    assert.equal(opened.messageId, "capacity-card-1");
    const row = postedRows[0]?.[0];
    assert.ok(row && "buttons" in row);
    assert.deepEqual(row.buttons.map((button) => button.label), [
      "Sol xhigh verwenden",
      "Mit Terra fortfahren",
      "Abbrechen"
    ]);
    const solCustomId = row.buttons[0]?.customId;
    const terraCustomId = row.buttons[1]?.customId;
    assert.ok(solCustomId);
    assert.ok(terraCustomId);

    const stranger = await registry.dispatch(
      createInteraction(solCustomId, "stranger", "guild-1", "channel-1")
    );
    assert.deepEqual(stranger, {
      state: "rejected",
      reason: "owner-mismatch",
      message: "Diese Aktion gehört einem anderen Nutzer."
    });

    const accepted = await registry.dispatch(
      createInteraction(solCustomId, "operator", "guild-1", "channel-1")
    );
    assert.equal(accepted.state, "completed");
    assert.deepEqual(executions, [
      { model: "gpt-5.6-sol", effort: "xhigh", messageId: "message-1" }
    ]);

    const replay = await registry.dispatch(
      createInteraction(terraCustomId, "operator", "guild-1", "channel-1")
    );
    assert.deepEqual(replay, {
      state: "rejected",
      reason: "already-consumed",
      message: "Diese Aktion wurde bereits verwendet."
    });
  });

  it("fingerprints the task content and attachment identity", () => {
    const original = createNeonDiscordCapacityFingerprint({
      content: "Businessplan prüfen",
      attachments: [{ name: "plan.pdf", kind: "file" }]
    });
    const same = createNeonDiscordCapacityFingerprint({
      content: "Businessplan prüfen",
      attachments: [{ name: "plan.pdf", kind: "file" }]
    });
    const edited = createNeonDiscordCapacityFingerprint({
      content: "Businessplan sofort freigeben",
      attachments: [{ name: "plan.pdf", kind: "file" }]
    });

    assert.equal(original, same);
    assert.notEqual(original, edited);
  });

  it("accepts only an exact pre-tool self-escalation marker", () => {
    assert.deepEqual(
      parseNeonDiscordCapacityUpgradeRequest(
        '<NEON_CAPACITY_UPGRADE tier="sol">Bankfähige Gesamtprüfung nötig.</NEON_CAPACITY_UPGRADE>'
      ),
      { tier: "sol", reason: "Bankfähige Gesamtprüfung nötig." }
    );
    assert.equal(
      parseNeonDiscordCapacityUpgradeRequest(
        'Ich würde erhöhen. <NEON_CAPACITY_UPGRADE tier="sol">Mehr Tiefe.</NEON_CAPACITY_UPGRADE>'
      ),
      undefined
    );
  });
});

function createInteraction(
  customId: string,
  userId: string,
  guildId: string,
  channelId: string
): INeonDiscordComponentInteraction {
  return {
    interactionId: `interaction-${userId}`,
    kind: "button",
    customId,
    userId,
    guildId,
    channelId,
    messageId: "capacity-card-1",
    createdAt: "2026-07-10T12:00:01.000Z"
  };
}
