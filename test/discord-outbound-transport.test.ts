import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import {
  createNeonDiscordOutboundTransport,
  type INeonDeliveryQueueTarget
} from "../src/index.js";

const SECRET_TOKEN = "discord-bot-token-SHOULD-NEVER-LEAK-abc123";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-123"
};

interface IFakeSendPayload {
  readonly content: string;
  readonly reply?: { readonly messageReference: string; readonly failIfNotExists?: boolean };
}

interface IFakeDiscordState {
  loginCount: number;
  loginToken: string;
  destroyCount: number;
  fetched: string[];
  sent: string[];
  replies: (string | null)[];
  sendCount: number;
}

function createFakeDiscordClient(opts: { channelFound?: boolean; sendable?: boolean } = {}): {
  readonly client: Client;
  readonly state: IFakeDiscordState;
} {
  const state: IFakeDiscordState = {
    loginCount: 0,
    loginToken: "",
    destroyCount: 0,
    fetched: [],
    sent: [],
    replies: [],
    sendCount: 0
  };
  const channel =
    opts.channelFound === false
      ? null
      : {
          isSendable: () => opts.sendable !== false,
          send: async (payload: string | IFakeSendPayload) => {
            state.sendCount += 1;
            if (typeof payload === "string") {
              state.sent.push(payload);
              state.replies.push(null);
            } else {
              state.sent.push(payload.content);
              state.replies.push(payload.reply ? payload.reply.messageReference : null);
            }
            return { id: `discord-message-${state.sendCount}` };
          }
        };
  const fake = {
    login: async (token: string) => {
      state.loginCount += 1;
      state.loginToken = token;
      return token;
    },
    channels: {
      fetch: async (id: string) => {
        state.fetched.push(id);
        return channel;
      }
    },
    destroy: async () => {
      state.destroyCount += 1;
    }
  };
  return { client: fake as unknown as Client, state };
}

describe("Neon Discord outbound transport (gated live-side-effect module)", () => {
  it("logs in once, sends the verbatim body, and returns only the message id", async () => {
    const { client, state } = createFakeDiscordClient();
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    const first = await transport.postMessage(TARGET, "already-redacted body");
    assert.deepEqual(first, { messageId: "discord-message-1" });
    assert.equal(state.loginCount, 1);
    assert.deepEqual(state.sent, ["already-redacted body"]);
    assert.deepEqual(state.fetched, ["channel-123"]);

    // A second post reuses the existing login (no re-login per call).
    await transport.postMessage(TARGET, "second body");
    assert.equal(state.loginCount, 1);
    assert.deepEqual(state.sent, ["already-redacted body", "second body"]);
  });

  it("hands the token only to login and never exposes it on the object or results", async () => {
    const { client, state } = createFakeDiscordClient();
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    const result = await transport.postMessage(TARGET, "body");

    // The token reaches discord.js login...
    assert.equal(state.loginToken, SECRET_TOKEN);
    // ...but is never stored on the transport or echoed back from a method.
    assert.ok(!("token" in transport));
    assert.doesNotMatch(JSON.stringify(transport), /SHOULD-NEVER-LEAK/);
    assert.doesNotMatch(JSON.stringify(result), /SHOULD-NEVER-LEAK/);
  });

  it("throws when the canary channel is not found or not visible", async () => {
    const { client } = createFakeDiscordClient({ channelFound: false });
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    await assert.rejects(transport.postMessage(TARGET, "body"), /not found or not visible/);
  });

  it("throws when the channel is not a sendable text channel", async () => {
    const { client } = createFakeDiscordClient({ sendable: false });
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    await assert.rejects(transport.postMessage(TARGET, "body"), /not a sendable text channel/);
  });

  it("destroys the client on close and re-logs in on a later post", async () => {
    const { client, state } = createFakeDiscordClient();
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    await transport.postMessage(TARGET, "body");
    assert.equal(state.loginCount, 1);

    await transport.close();
    assert.equal(state.destroyCount, 1);

    // After close the session is gone, so the next post logs in again.
    await transport.postMessage(TARGET, "body again");
    assert.equal(state.loginCount, 2);

    // close() is a no-op when not logged in.
    await transport.close();
    await transport.close();
    assert.equal(state.destroyCount, 2);
  });

  it("splits a body over the Discord limit into multiple sequential sends", async () => {
    const { client, state } = createFakeDiscordClient();
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    const longBody = "x".repeat(4500);
    const result = await transport.postMessage(TARGET, longBody);

    assert.ok(state.sent.length >= 3, `expected multiple chunks, got ${state.sent.length}`);
    for (const chunk of state.sent) {
      assert.ok(chunk.length <= 2000, `chunk exceeded the Discord limit: ${chunk.length}`);
    }
    // The returned id anchors on the first chunk.
    assert.equal(result.messageId, "discord-message-1");
    // Reassembled chunks are lossless for a plain run.
    assert.equal(state.sent.join(""), longBody);
  });

  it("attaches replyToMessageId to the first chunk only", async () => {
    const { client, state } = createFakeDiscordClient();
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    const target: INeonDeliveryQueueTarget = { ...TARGET, replyToMessageId: "origin-msg-9" };
    await transport.postMessage(target, "y".repeat(4500));

    assert.ok(state.replies.length >= 3);
    assert.equal(state.replies[0], "origin-msg-9");
    for (let i = 1; i < state.replies.length; i++) {
      assert.equal(state.replies[i], null, `chunk ${i} should not carry a reply reference`);
    }
  });

  it("posts into target.threadId instead of the parent channel when present", async () => {
    const { client, state } = createFakeDiscordClient();
    const transport = createNeonDiscordOutboundTransport({
      token: SECRET_TOKEN,
      createClient: () => client
    });

    const target: INeonDeliveryQueueTarget = { ...TARGET, threadId: "thread-77" };
    await transport.postMessage(target, "short body");

    assert.deepEqual(state.fetched, ["thread-77"]);
    assert.deepEqual(state.sent, ["short body"]);
  });
});
