import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import { createNeonDiscordTypingTransport, type INeonDeliveryQueueTarget } from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-123"
};

interface IFakeTypingState {
  loginCount: number;
  typingCalls: number;
  destroyCount: number;
}

function createFakeTypingClient(opts: { textBased?: boolean } = {}): {
  readonly client: Client;
  readonly state: IFakeTypingState;
} {
  const state: IFakeTypingState = { loginCount: 0, typingCalls: 0, destroyCount: 0 };
  const base = { isTextBased: () => opts.textBased !== false };
  const channel =
    opts.textBased === false
      ? base
      : {
          ...base,
          sendTyping: async () => {
            state.typingCalls += 1;
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

describe("createNeonDiscordTypingTransport (Z483, gated)", () => {
  it("logs in and triggers channel.sendTyping exactly once", async () => {
    const { client, state } = createFakeTypingClient();
    const transport = createNeonDiscordTypingTransport({ token: "tok", createClient: () => client });
    await transport.sendTyping(TARGET);
    assert.equal(state.loginCount, 1);
    assert.equal(state.typingCalls, 1);
    await transport.close();
    assert.equal(state.destroyCount, 1);
  });

  it("rejects a channel that does not support typing", async () => {
    const { client, state } = createFakeTypingClient({ textBased: false });
    const transport = createNeonDiscordTypingTransport({ token: "tok", createClient: () => client });
    await assert.rejects(() => transport.sendTyping(TARGET), /not a text channel that supports typing/i);
    assert.equal(state.typingCalls, 0);
    await transport.close();
  });
});
