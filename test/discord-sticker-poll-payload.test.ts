import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import {
  buildNeonDiscordPollPayload,
  buildNeonDiscordStickerPayload,
  createNeonDiscordOutboundTransport,
  NEON_DISCORD_STICKER_POLL_LIMITS,
  type INeonDeliveryQueueTarget,
  type INeonDiscordPoll
} from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = { channel: "discord", accountId: "a", channelId: "channel-1" };

const validPoll: INeonDiscordPoll = {
  question: "Ship it?",
  answers: [{ text: "Yes" }, { text: "No" }],
  durationHours: 24
};

describe("buildNeonDiscordStickerPayload (Z323)", () => {
  it("accepts 1-3 snowflake ids", () => {
    const result = buildNeonDiscordStickerPayload(["112233445566778899"]);
    assert.equal(result.ok, true);
  });

  it("rejects empty, too many, and non-snowflake ids", () => {
    assert.equal(buildNeonDiscordStickerPayload([]).ok, false);
    const tooMany = Array.from({ length: NEON_DISCORD_STICKER_POLL_LIMITS.maxStickers + 1 }, () => "112233445566778899");
    assert.equal(buildNeonDiscordStickerPayload(tooMany).ok, false);
    assert.equal(buildNeonDiscordStickerPayload(["nope"]).ok, false);
  });
});

describe("buildNeonDiscordPollPayload (Z323)", () => {
  it("builds a valid poll with layout + duration", () => {
    const result = buildNeonDiscordPollPayload(validPoll);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.poll.question.text, "Ship it?");
      assert.equal(result.poll.answers.length, 2);
      assert.equal(result.poll.duration, 24);
    }
  });

  it("rejects empty question, no/too-many answers, long answer text, and bad duration", () => {
    assert.equal(buildNeonDiscordPollPayload({ ...validPoll, question: "  " }).ok, false);
    assert.equal(buildNeonDiscordPollPayload({ ...validPoll, answers: [] }).ok, false);
    const tooMany = Array.from({ length: NEON_DISCORD_STICKER_POLL_LIMITS.pollAnswers + 1 }, (_u, i) => ({ text: `a${i}` }));
    assert.equal(buildNeonDiscordPollPayload({ ...validPoll, answers: tooMany }).ok, false);
    const longText = "x".repeat(NEON_DISCORD_STICKER_POLL_LIMITS.pollAnswerText + 1);
    assert.equal(buildNeonDiscordPollPayload({ ...validPoll, answers: [{ text: longText }] }).ok, false);
    assert.equal(buildNeonDiscordPollPayload({ ...validPoll, durationHours: 0 }).ok, false);
    assert.equal(buildNeonDiscordPollPayload({ ...validPoll, durationHours: 9999 }).ok, false);
  });
});

interface IFakeState {
  sends: { readonly hasStickers: boolean; readonly hasPoll: boolean }[];
}

function createFakeClient(): { readonly client: Client; readonly state: IFakeState } {
  const state: IFakeState = { sends: [] };
  const channel = {
    isSendable: () => true,
    send: async (payload: { stickers?: readonly unknown[]; poll?: unknown }) => {
      state.sends.push({ hasStickers: (payload.stickers?.length ?? 0) > 0, hasPoll: payload.poll !== undefined });
      return { id: `m-${state.sends.length}` };
    }
  };
  const fake = {
    login: async (token: string) => token,
    channels: { fetch: async (_id: string) => channel },
    destroy: async () => {}
  };
  return { client: fake as unknown as Client, state };
}

describe("transport.postStickers / postPoll (Z323, gated)", () => {
  it("sends stickers with body text and a poll via the injected client", async () => {
    const { client, state } = createFakeClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    const s = await transport.postStickers(TARGET, "look", ["112233445566778899"]);
    assert.equal(s.messageId, "m-1");
    assert.equal(state.sends[0]?.hasStickers, true);
    const p = await transport.postPoll(TARGET, validPoll);
    assert.equal(p.messageId, "m-2");
    assert.equal(state.sends[1]?.hasPoll, true);
    await transport.close();
  });

  it("rejects an invalid sticker/poll and empty sticker body before sending", async () => {
    const { client, state } = createFakeClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    await assert.rejects(() => transport.postStickers(TARGET, "  ", ["112233445566778899"]), /without body text/i);
    await assert.rejects(() => transport.postStickers(TARGET, "ok", ["bad"]), /invalid sticker/i);
    await assert.rejects(() => transport.postPoll(TARGET, { ...validPoll, answers: [] }), /invalid poll/i);
    assert.equal(state.sends.length, 0);
    await transport.close();
  });
});
