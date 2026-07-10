import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNeonWebhookPayload,
  createNeonDiscordWebhookTransport,
  evaluateNeonWebhookLivePreconditions,
  NEON_DISCORD_WEBHOOK_LIMITS,
  type INeonWebhookClientLike,
  type INeonWebhookSendOptions
} from "../src/index.js";

describe("buildNeonWebhookPayload (Z326)", () => {
  it("builds a valid proxy-identity payload", () => {
    const result = buildNeonWebhookPayload({
      content: "hello",
      username: "Neon Bot",
      avatarUrl: "https://example.com/a.png"
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.payload.content, "hello");
      assert.equal(result.payload.username, "Neon Bot");
    }
  });

  it("accepts a content-less payload when an embed is present", () => {
    const result = buildNeonWebhookPayload({ content: "", embeds: [{ title: "Status" }] });
    assert.equal(result.ok, true);
  });

  it("rejects empty payload, over-long username, forbidden names, and a bad avatar", () => {
    assert.equal(buildNeonWebhookPayload({ content: "   " }).ok, false);

    const longName = "x".repeat(NEON_DISCORD_WEBHOOK_LIMITS.username + 1);
    assert.equal(buildNeonWebhookPayload({ content: "x", username: longName }).ok, false);

    assert.equal(buildNeonWebhookPayload({ content: "x", username: "clyde-bot" }).ok, false);
    assert.equal(buildNeonWebhookPayload({ content: "x", username: "Discord Helper" }).ok, false);

    assert.equal(buildNeonWebhookPayload({ content: "x", avatarUrl: "ftp://x/a.png" }).ok, false);
  });

  it("collects multiple errors at once (forbidden name + bad avatar)", () => {
    const result = buildNeonWebhookPayload({ content: "x", username: "clyde", avatarUrl: "notaurl" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length >= 2);
    }
  });
});

describe("evaluateNeonWebhookLivePreconditions (Z326)", () => {
  it("is not ready by default (no url, no flags)", () => {
    const pre = evaluateNeonWebhookLivePreconditions({});
    assert.equal(pre.ready, false);
    assert.equal(pre.webhookUrlPresent, false);
  });

  it("requires every piece: url + enable + canary stage + approval", () => {
    const pre = evaluateNeonWebhookLivePreconditions({
      NEON_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/secret",
      NEON_WEBHOOK_OUTBOUND_ENABLED: "true",
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "true"
    });
    assert.equal(pre.ready, true);

    const missingFlag = evaluateNeonWebhookLivePreconditions({
      NEON_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/secret",
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "true"
    });
    assert.equal(missingFlag.ready, false);
  });
});

interface IFakeWebhookState {
  sends: INeonWebhookSendOptions[];
  destroyCount: number;
}

function createFakeWebhookClient(): {
  readonly create: (url: string) => INeonWebhookClientLike;
  readonly state: IFakeWebhookState;
} {
  const state: IFakeWebhookState = { sends: [], destroyCount: 0 };
  const create = (_url: string): INeonWebhookClientLike => ({
    async send(options: INeonWebhookSendOptions) {
      state.sends.push(options);
      return { id: `webhook-message-${state.sends.length}` };
    },
    destroy() {
      state.destroyCount += 1;
    }
  });
  return { create, state };
}

describe("createNeonDiscordWebhookTransport (Z326, gated)", () => {
  it("sends a validated payload through the injected client and returns the message id", async () => {
    const { create, state } = createFakeWebhookClient();
    const transport = createNeonDiscordWebhookTransport({
      webhookUrl: "https://discord.com/api/webhooks/1/secret",
      createWebhookClient: create
    });
    const result = await transport.send({ content: "hi", username: "Neon Bot" });
    assert.equal(result.messageId, "webhook-message-1");
    assert.equal(state.sends.length, 1);
    assert.equal(state.sends[0]?.content, "hi");
    assert.equal(state.sends[0]?.username, "Neon Bot");
    await transport.close();
    assert.equal(state.destroyCount, 1);
  });

  it("rejects an invalid payload BEFORE constructing the client (no send)", async () => {
    const { create, state } = createFakeWebhookClient();
    const transport = createNeonDiscordWebhookTransport({
      webhookUrl: "https://discord.com/api/webhooks/1/secret",
      createWebhookClient: create
    });
    await assert.rejects(() => transport.send({ content: "x", username: "clyde" }), /invalid webhook/i);
    assert.equal(state.sends.length, 0);
    assert.equal(state.destroyCount, 0);
    await transport.close();
  });
});
