import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import {
  buildNeonDiscordEmbedPayload,
  createNeonDiscordOutboundTransport,
  NEON_DISCORD_EMBED_LIMITS,
  type INeonDeliveryQueueTarget
} from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-123"
};

describe("buildNeonDiscordEmbedPayload (Z320)", () => {
  it("builds a valid embed with title, description, color, and fields", () => {
    const result = buildNeonDiscordEmbedPayload([
      {
        title: "Build",
        description: "done",
        color: 0x2eab73,
        fields: [{ name: "state", value: "green", inline: true }]
      }
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.embeds.length, 1);
      assert.equal(result.embeds[0]?.title, "Build");
      assert.equal(result.embeds[0]?.color, 0x2eab73);
      assert.equal(result.embeds[0]?.fields?.[0]?.name, "state");
      assert.equal(result.embeds[0]?.fields?.[0]?.inline, true);
    }
  });

  it("rejects an empty list and a content-free embed", () => {
    assert.equal(buildNeonDiscordEmbedPayload([]).ok, false);
    assert.equal(buildNeonDiscordEmbedPayload([{}]).ok, false);
  });

  it("rejects an over-limit title, too many embeds, and over the total char cap", () => {
    const longTitle = "x".repeat(NEON_DISCORD_EMBED_LIMITS.title + 1);
    assert.equal(buildNeonDiscordEmbedPayload([{ title: longTitle }]).ok, false);

    const tooMany = Array.from({ length: NEON_DISCORD_EMBED_LIMITS.embedsPerMessage + 1 }, () => ({
      description: "x"
    }));
    assert.equal(buildNeonDiscordEmbedPayload(tooMany).ok, false);

    // 4096 + 4096 description chars exceeds the 6000-char combined cap.
    const overTotal = buildNeonDiscordEmbedPayload([
      { description: "x".repeat(NEON_DISCORD_EMBED_LIMITS.description) },
      { description: "y".repeat(NEON_DISCORD_EMBED_LIMITS.description) }
    ]);
    assert.equal(overTotal.ok, false);
  });

  it("collects every validation error at once (invalid url + color)", () => {
    const result = buildNeonDiscordEmbedPayload([{ title: "t", url: "ftp://x", color: -1 }]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length >= 2, "expected url and color errors");
    }
  });
});

interface IFakeEmbedState {
  loginCount: number;
  sentEmbeds: { readonly title?: string }[][];
  sendCount: number;
}

function createFakeEmbedClient(): { readonly client: Client; readonly state: IFakeEmbedState } {
  const state: IFakeEmbedState = { loginCount: 0, sentEmbeds: [], sendCount: 0 };
  const channel = {
    isSendable: () => true,
    send: async (payload: { embeds?: readonly { readonly title?: string }[] }) => {
      state.sendCount += 1;
      state.sentEmbeds.push([...(payload.embeds ?? [])]);
      return { id: `discord-message-${state.sendCount}` };
    }
  };
  const fake = {
    login: async (token: string) => {
      state.loginCount += 1;
      return token;
    },
    channels: { fetch: async (_id: string) => channel },
    destroy: async () => {}
  };
  return { client: fake as unknown as Client, state };
}

describe("transport.postEmbed (Z320, gated)", () => {
  it("sends a validated embed via the injected client and returns the message id", async () => {
    const { client, state } = createFakeEmbedClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    const result = await transport.postEmbed(TARGET, [{ title: "Hi", description: "there" }]);
    assert.equal(result.messageId, "discord-message-1");
    assert.equal(state.sentEmbeds.length, 1);
    assert.equal(state.sentEmbeds[0]?.[0]?.title, "Hi");
    await transport.close();
  });

  it("rejects an invalid embed BEFORE login, so nothing leaves the suppressed state", async () => {
    const { client, state } = createFakeEmbedClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    await assert.rejects(() => transport.postEmbed(TARGET, [{}]), /invalid embed/i);
    assert.equal(state.loginCount, 0);
    assert.equal(state.sentEmbeds.length, 0);
    await transport.close();
  });
});

describe("buildNeonDiscordEmbedPayload image/thumbnail/author/footer surfaces", () => {
  it("attaches image, thumbnail, author url+icon, and footer icon", () => {
    const result = buildNeonDiscordEmbedPayload([
      {
        description: "rich",
        imageUrl: "https://cdn.example.com/i.png",
        thumbnailUrl: "https://cdn.example.com/t.png",
        authorName: "Neo",
        authorUrl: "https://example.com/neo",
        authorIconUrl: "https://cdn.example.com/a.png",
        footerText: "footer",
        footerIconUrl: "https://cdn.example.com/f.png"
      }
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const embed = result.embeds[0];
      assert.equal(embed?.image?.url, "https://cdn.example.com/i.png");
      assert.equal(embed?.thumbnail?.url, "https://cdn.example.com/t.png");
      assert.equal(embed?.author?.name, "Neo");
      assert.equal(embed?.author?.url, "https://example.com/neo");
      assert.equal(embed?.author?.icon_url, "https://cdn.example.com/a.png");
      assert.equal(embed?.footer?.text, "footer");
      assert.equal(embed?.footer?.icon_url, "https://cdn.example.com/f.png");
    }
  });

  it("rejects a non-http image or thumbnail url", () => {
    assert.equal(buildNeonDiscordEmbedPayload([{ description: "x", imageUrl: "ftp://x/i.png" }]).ok, false);
    assert.equal(buildNeonDiscordEmbedPayload([{ description: "x", thumbnailUrl: "ftp://x/t.png" }]).ok, false);
  });

  it("rejects author url/icon without an author name and footer icon without footer text", () => {
    assert.equal(buildNeonDiscordEmbedPayload([{ description: "x", authorUrl: "https://e/x" }]).ok, false);
    assert.equal(buildNeonDiscordEmbedPayload([{ description: "x", authorIconUrl: "https://e/x.png" }]).ok, false);
    assert.equal(buildNeonDiscordEmbedPayload([{ description: "x", footerIconUrl: "https://e/x.png" }]).ok, false);
  });

  it("collects both icon-url errors at once when author and footer icons are non-http", () => {
    const result = buildNeonDiscordEmbedPayload([
      { authorName: "Neo", authorIconUrl: "ftp://x/a.png", footerText: "f", footerIconUrl: "ftp://x/f.png" }
    ]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length >= 2, "expected author and footer icon errors");
    }
  });
});
