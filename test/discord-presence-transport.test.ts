import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ActivityType, type Client } from "discord.js";

import {
  buildNeonDiscordPresencePayload,
  createNeonDiscordPresenceTransport,
  NEON_DISCORD_PRESENCE_LIMITS,
  type INeonDiscordActivity,
  type INeonDiscordPresence
} from "../src/index.js";

describe("buildNeonDiscordPresencePayload (Z327)", () => {
  it("builds a status + watching activity", () => {
    const result = buildNeonDiscordPresencePayload({
      status: "idle",
      activity: { type: "watching", name: "the channel" }
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.presence.status, "idle");
      assert.equal(result.presence.activities?.[0]?.name, "the channel");
      assert.equal(result.presence.activities?.[0]?.type, ActivityType.Watching);
    }
  });

  it("builds a status-only presence (no activity) and a custom activity with state", () => {
    const statusOnly = buildNeonDiscordPresencePayload({ status: "dnd" });
    assert.equal(statusOnly.ok, true);
    if (statusOnly.ok) {
      assert.equal(statusOnly.presence.activities?.length, 0);
    }
    const custom = buildNeonDiscordPresencePayload({
      status: "online",
      activity: { type: "custom", name: "Custom Status", state: "building bricks" }
    });
    assert.equal(custom.ok, true);
    if (custom.ok) {
      assert.equal(custom.presence.activities?.[0]?.type, ActivityType.Custom);
      assert.equal(custom.presence.activities?.[0]?.state, "building bricks");
    }
  });

  it("rejects a bad status, empty/long name, and an unsupported type", () => {
    assert.equal(
      buildNeonDiscordPresencePayload({ status: "busy" as INeonDiscordPresence["status"] }).ok,
      false
    );
    assert.equal(
      buildNeonDiscordPresencePayload({ status: "online", activity: { type: "playing", name: "  " } }).ok,
      false
    );
    const longName = "x".repeat(NEON_DISCORD_PRESENCE_LIMITS.activityName + 1);
    assert.equal(
      buildNeonDiscordPresencePayload({ status: "online", activity: { type: "playing", name: longName } }).ok,
      false
    );
    // Deliberately-invalid activity type to exercise the type-validation branch.
    const badType = { type: "vibing", name: "x" } as unknown as INeonDiscordActivity;
    assert.equal(buildNeonDiscordPresencePayload({ status: "online", activity: badType }).ok, false);
  });

  it("collects multiple validation errors at once (bad status + empty name)", () => {
    const result = buildNeonDiscordPresencePayload({
      status: "nope" as INeonDiscordPresence["status"],
      activity: { type: "playing", name: "" }
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length >= 2, "expected status and name errors");
    }
  });
});

interface IFakePresenceState {
  loginCount: number;
  presences: { readonly status?: string }[];
  destroyCount: number;
}

function createFakePresenceClient(): { readonly client: Client; readonly state: IFakePresenceState } {
  const state: IFakePresenceState = { loginCount: 0, presences: [], destroyCount: 0 };
  const fake = {
    login: async (token: string) => {
      state.loginCount += 1;
      return token;
    },
    isReady: () => true,
    user: {
      setPresence: (data: { status?: string }) => {
        state.presences.push({ ...(data.status !== undefined ? { status: data.status } : {}) });
      }
    },
    destroy: async () => {
      state.destroyCount += 1;
    }
  };
  return { client: fake as unknown as Client, state };
}

describe("createNeonDiscordPresenceTransport (Z327, gated)", () => {
  it("logs in and calls client.user.setPresence with the validated presence", async () => {
    const { client, state } = createFakePresenceClient();
    const transport = createNeonDiscordPresenceTransport({ token: "tok", createClient: () => client });
    await transport.setPresence({ status: "idle", activity: { type: "watching", name: "logs" } });
    assert.equal(state.loginCount, 1);
    assert.equal(state.presences.length, 1);
    assert.equal(state.presences[0]?.status, "idle");
    await transport.close();
    assert.equal(state.destroyCount, 1);
  });

  it("rejects an invalid presence BEFORE login, so nothing leaves suppressed", async () => {
    const { client, state } = createFakePresenceClient();
    const transport = createNeonDiscordPresenceTransport({ token: "tok", createClient: () => client });
    await assert.rejects(
      () => transport.setPresence({ status: "elsewhere" as INeonDiscordPresence["status"] }),
      /invalid presence/i
    );
    assert.equal(state.loginCount, 0);
    assert.equal(state.presences.length, 0);
    await transport.close();
  });
});

describe("buildNeonDiscordPresencePayload streaming url", () => {
  it("attaches a twitch stream url to a streaming activity", () => {
    const activity: INeonDiscordActivity = { type: "streaming", name: "Coding", url: "https://twitch.tv/neon" };
    const result = buildNeonDiscordPresencePayload({ status: "online", activity });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.presence.activities?.[0]?.url, "https://twitch.tv/neon");
      assert.equal(result.presence.activities?.[0]?.type, ActivityType.Streaming);
    }
  });

  it("accepts a youtube subdomain stream url", () => {
    const result = buildNeonDiscordPresencePayload({
      status: "online",
      activity: { type: "streaming", name: "Live", url: "https://www.youtube.com/watch?v=x" }
    });
    assert.equal(result.ok, true);
  });

  it("rejects a stream url on a non-streaming activity", () => {
    const result = buildNeonDiscordPresencePayload({
      status: "online",
      activity: { type: "playing", name: "x", url: "https://twitch.tv/neon" }
    });
    assert.equal(result.ok, false);
  });

  it("rejects a non-twitch/youtube stream url", () => {
    const result = buildNeonDiscordPresencePayload({
      status: "online",
      activity: { type: "streaming", name: "x", url: "https://example.com/stream" }
    });
    assert.equal(result.ok, false);
  });
});
