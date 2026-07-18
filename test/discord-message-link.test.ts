import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseNeonDiscordMessageLink } from "../src/index.js";

describe("parseNeonDiscordMessageLink", () => {
  it("parses a canonical message link", () => {
    assert.deepEqual(parseNeonDiscordMessageLink("https://discord.com/channels/111/222/333"), {
      guildId: "111",
      channelId: "222",
      messageId: "333"
    });
  });

  it("accepts discordapp.com, ptb/canary subdomains, a missing scheme, trailing slash, and query", () => {
    const expected = { guildId: "1", channelId: "2", messageId: "3" };
    assert.deepEqual(parseNeonDiscordMessageLink("https://discordapp.com/channels/1/2/3"), expected);
    assert.deepEqual(parseNeonDiscordMessageLink("https://ptb.discord.com/channels/1/2/3"), expected);
    assert.deepEqual(parseNeonDiscordMessageLink("canary.discord.com/channels/1/2/3"), expected);
    assert.deepEqual(parseNeonDiscordMessageLink("https://discord.com/channels/1/2/3/"), expected);
    assert.deepEqual(parseNeonDiscordMessageLink("https://discord.com/channels/1/2/3?x=1"), expected);
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseNeonDiscordMessageLink("  https://discord.com/channels/1/2/3  "), {
      guildId: "1",
      channelId: "2",
      messageId: "3"
    });
  });

  it("returns null for DM links, truncated links, foreign hosts, and garbage", () => {
    assert.equal(parseNeonDiscordMessageLink("https://discord.com/channels/@me/2/3"), null);
    assert.equal(parseNeonDiscordMessageLink("https://discord.com/channels/1/2"), null);
    assert.equal(parseNeonDiscordMessageLink("https://discord.com/channels/1/2/3/extra"), null);
    assert.equal(parseNeonDiscordMessageLink("https://example.com/channels/1/2/3"), null);
    assert.equal(parseNeonDiscordMessageLink("not a link"), null);
    assert.equal(parseNeonDiscordMessageLink(""), null);
  });
});
