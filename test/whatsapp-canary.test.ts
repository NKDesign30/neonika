import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonWhatsAppCanaryMessageId,
  deliverNeonWhatsAppCanaryReply,
  isNeonWhatsAppCanaryMessageId,
  parseNeonWhatsAppCanaryCommand,
  readNeonDeliveryReceipts,
  resolveNeonWhatsAppCanaryGate,
  type INeonGatewayShadowRun,
  writeNeonCutoverPromotion
} from "../src/index.js";

describe("Neonika WhatsApp owner canary", () => {
  it("accepts only the explicit /neon command prefix", () => {
    assert.deepEqual(parseNeonWhatsAppCanaryCommand("/neon system status"), {
      state: "accepted",
      content: "system status"
    });
    assert.deepEqual(parseNeonWhatsAppCanaryCommand("  /neon   system status  "), {
      state: "accepted",
      content: "system status"
    });
    assert.deepEqual(parseNeonWhatsAppCanaryCommand("/neon"), {
      state: "dropped",
      reason: "empty-command"
    });
    assert.deepEqual(parseNeonWhatsAppCanaryCommand("/neonika system status"), {
      state: "dropped",
      reason: "command-prefix-required"
    });
    assert.deepEqual(parseNeonWhatsAppCanaryCommand("system status"), {
      state: "dropped",
      reason: "command-prefix-required"
    });
  });

  it("requires the independent exact-ready flag and the shared outbound gates", () => {
    const ready = resolveNeonWhatsAppCanaryGate({
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "ready",
      NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
      NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "ready"
    });
    const wrongIndependentValue = resolveNeonWhatsAppCanaryGate({
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "ready",
      NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
      NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "true"
    });
    const disarmed = resolveNeonWhatsAppCanaryGate({
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "ready",
      NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "ready"
    });

    assert.equal(ready.ready, true);
    assert.deepEqual(ready.blockers, []);
    assert.equal(wrongIndependentValue.ready, false);
    assert.ok(wrongIndependentValue.blockers.includes("whatsapp-canary-disabled"));
    assert.equal(disarmed.ready, false);
    assert.ok(disarmed.blockers.includes("outbound-disarmed"));
  });

  it("derives a deterministic transport id that can be rejected on inbound replay", () => {
    const first = createNeonWhatsAppCanaryMessageId("delivery-intent-1");
    const second = createNeonWhatsAppCanaryMessageId("delivery-intent-1");

    assert.equal(first, second);
    assert.match(first, /^NEON[A-F0-9]{28}$/u);
    assert.equal(isNeonWhatsAppCanaryMessageId(first), true);
    assert.equal(isNeonWhatsAppCanaryMessageId("ordinary-whatsapp-message"), false);
  });

  it("reloads the persisted arm and records exactly one leak-safe delivery", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-whatsapp-canary-delivery-"));
    const bodies: string[] = [];
    const messageIds: string[] = [];
    const run = completedWhatsAppRun();
    const liveEnv = {
      NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "ready"
    } as const;
    const sendText = (
      peerJid: string,
      body: string,
      messageId: string
    ): Promise<{ readonly messageId: string }> => {
      assert.equal(peerJid, "15551234567@s.whatsapp.net");
      bodies.push(body);
      messageIds.push(messageId);
      return Promise.resolve({ messageId });
    };

    try {
      const disarmed = await deliverNeonWhatsAppCanaryReply({
        projectRoot,
        run,
        ownerPeerId: "+15551234567",
        liveEnv,
        sendText,
        now: () => new Date("2026-08-11T20:00:00.000Z")
      });
      assert.equal(disarmed.state, "suppressed");
      assert.ok(disarmed.blockers.includes("outbound-disarmed"));
      assert.equal(bodies.length, 0);

      await writeNeonCutoverPromotion(
        projectRoot,
        {
          NEON_CUTOVER_STAGE: "canary",
          NEON_CUTOVER_CANARY_APPROVED: "ready",
          NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
        },
        { now: () => new Date("2026-08-11T20:00:01.000Z") }
      );
      const delivered = await deliverNeonWhatsAppCanaryReply({
        projectRoot,
        run,
        ownerPeerId: "+15551234567",
        liveEnv,
        sendText,
        now: () => new Date("2026-08-11T20:00:02.000Z")
      });
      const replay = await deliverNeonWhatsAppCanaryReply({
        projectRoot,
        run,
        ownerPeerId: "+15551234567",
        liveEnv,
        sendText,
        now: () => new Date("2026-08-11T20:00:03.000Z")
      });
      await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready"
      });
      const afterDisarm = await deliverNeonWhatsAppCanaryReply({
        projectRoot,
        run: {
          ...run,
          runId: "whatsapp-canary-run-after-disarm",
          request: { ...run.request, messageId: "wa:after-disarm" }
        },
        ownerPeerId: "+15551234567",
        liveEnv,
        sendText,
        now: () => new Date("2026-08-11T20:00:04.000Z")
      });
      const receipts = await readNeonDeliveryReceipts(projectRoot);

      assert.equal(delivered.state, "delivered");
      assert.equal(delivered.outboundSent, true);
      assert.equal(replay.state, "already-delivered");
      assert.equal(replay.outboundSent, false);
      assert.equal(afterDisarm.state, "suppressed");
      assert.ok(afterDisarm.blockers.includes("outbound-disarmed"));
      assert.equal(bodies.length, 1);
      assert.equal(messageIds.length, 1);
      assert.equal(isNeonWhatsAppCanaryMessageId(messageIds[0] ?? ""), true);
      assert.doesNotMatch(bodies[0] ?? "", /sk-live-super-secret-value/u);
      assert.equal(receipts.length, 2);
      assert.ok(
        receipts.some(
          (receipt) => receipt.state === "delivered" && receipt.cutoverStage === "canary"
        )
      );
      assert.ok(receipts.some((receipt) => receipt.state === "suppressed"));
      assert.doesNotMatch(JSON.stringify(receipts), /15551234567|sk-live-super-secret-value/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function completedWhatsAppRun(): INeonGatewayShadowRun {
  return {
    runId: "whatsapp-canary-run-1",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "whatsapp",
      accountId: "default",
      channelId: "wa:owner-channel-fingerprint",
      messageId: "wa:owner-message-fingerprint",
      userId: "owner:primary",
      userDisplayName: "Owner",
      agentId: "chaty",
      workspaceRoot: "/tmp/neonika-whatsapp-canary",
      mode: "read-only",
      contentPreview: "system status",
      receivedAt: "2026-08-11T19:59:59.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "whatsapp-canary-session",
    memoryState: "skipped",
    events: [{ kind: "final", text: "Canary ready" }],
    finalText: "Canary ready OPENAI_API_KEY=sk-live-super-secret-value",
    delivery: {
      state: "suppressed",
      targetChannel: "whatsapp",
      targetChannelId: "wa:owner-channel-fingerprint",
      reason: "shadow-mode",
      finalText: "Canary ready OPENAI_API_KEY=sk-live-super-secret-value"
    },
    startedAt: "2026-08-11T19:59:59.000Z",
    completedAt: "2026-08-11T20:00:00.000Z"
  };
}
