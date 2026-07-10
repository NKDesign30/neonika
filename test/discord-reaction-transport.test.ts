import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import { createNeonDiscordReactionTransport, type INeonDeliveryQueueTarget } from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-123"
};

interface IFakeReactionState {
  loginCount: number;
  fetchedMessages: string[];
  reactedEmojis: string[];
  destroyCount: number;
}

function createFakeReactionClient(opts: { textBased?: boolean } = {}): {
  readonly client: Client;
  readonly state: IFakeReactionState;
} {
  const state: IFakeReactionState = { loginCount: 0, fetchedMessages: [], reactedEmojis: [], destroyCount: 0 };
  const message = {
    react: async (emoji: string) => {
      state.reactedEmojis.push(emoji);
      return {};
    }
  };
  const channel = {
    isTextBased: () => opts.textBased !== false,
    messages: {
      fetch: async (id: string) => {
        state.fetchedMessages.push(id);
        return message;
      }
    }
  };
  const fake = {
    login: async (token: string) => {
      state.loginCount += 1;
      return token;
    },
    channels: { fetch: async (_id: string) => channel },
    destroy: async () => {
      state.destroyCount += 1;
    }
  };
  return { client: fake as unknown as Client, state };
}

describe("createNeonDiscordReactionTransport (Z322, gated)", () => {
  it("logs in, fetches the target message, and calls message.react with the emoji", async () => {
    const { client, state } = createFakeReactionClient();
    const transport = createNeonDiscordReactionTransport({ token: "tok", createClient: () => client });
    await transport.addReaction(TARGET, "msg-99", "👀");
    assert.equal(state.loginCount, 1);
    assert.deepEqual(state.fetchedMessages, ["msg-99"]);
    assert.deepEqual(state.reactedEmojis, ["👀"]);
    await transport.close();
    assert.equal(state.destroyCount, 1);
  });

  it("rejects a non-text channel before reacting", async () => {
    const { client, state } = createFakeReactionClient({ textBased: false });
    const transport = createNeonDiscordReactionTransport({ token: "tok", createClient: () => client });
    await assert.rejects(() => transport.addReaction(TARGET, "msg-1", "✅"), /not a text channel/i);
    assert.equal(state.reactedEmojis.length, 0);
    await transport.close();
  });
});
