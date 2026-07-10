import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeNeonChannelRoute,
  neonChannelRouteFromInboundIdentity,
  neonRoutesShareTarget,
  normalizeNeonChannelRoute,
  type INeonChannelInboundIdentity
} from "../src/index.js";

function identity(over: Partial<INeonChannelInboundIdentity>): INeonChannelInboundIdentity {
  return {
    platform: "discord",
    accountId: "acct-1",
    channelId: "chan-1",
    userId: "user-1",
    agentId: "agent-1",
    content: "hi",
    ...over
  };
}

test("normalizeNeonChannelRoute keeps a routable ref and trims fields", () => {
  const route = normalizeNeonChannelRoute({
    channel: "discord",
    accountId: "  acct-1  ",
    to: "  chan-1  ",
    threadId: " t-9 ",
    chatType: "channel"
  });
  assert.deepEqual(route, {
    channel: "discord",
    accountId: "acct-1",
    to: "chan-1",
    threadId: "t-9",
    chatType: "channel"
  });
});

test("normalizeNeonChannelRoute drops empty optionals", () => {
  const route = normalizeNeonChannelRoute({ channel: "telegram", to: "123", accountId: "   ", threadId: "" });
  assert.deepEqual(route, { channel: "telegram", to: "123" });
});

test("normalizeNeonChannelRoute returns undefined without a known channel or a target", () => {
  assert.equal(normalizeNeonChannelRoute({ channel: "carrier-pigeon", to: "x" }), undefined);
  assert.equal(normalizeNeonChannelRoute({ channel: undefined, to: "x" }), undefined);
  assert.equal(normalizeNeonChannelRoute({ channel: "discord", to: "   " }), undefined);
});

test("neonChannelRouteFromInboundIdentity treats a workspace message as a channel post", () => {
  const route = neonChannelRouteFromInboundIdentity(
    identity({ workspaceId: "guild-1", channelId: "chan-7", threadId: "thr-2" })
  );
  assert.deepEqual(route, {
    channel: "discord",
    accountId: "acct-1",
    to: "chan-7",
    threadId: "thr-2",
    chatType: "channel"
  });
});

test("neonChannelRouteFromInboundIdentity treats a workspace-less message as a direct message", () => {
  const route = neonChannelRouteFromInboundIdentity(identity({ channelId: "dm-3" }));
  assert.equal(route?.chatType, "direct");
  assert.equal(route?.to, "dm-3");
});

test("neonRoutesShareTarget compares channel/to/thread and tolerates a missing account", () => {
  const base = normalizeNeonChannelRoute({ channel: "discord", to: "c1", accountId: "a1" });
  const sameNoAccount = normalizeNeonChannelRoute({ channel: "discord", to: "c1" });
  const otherTarget = normalizeNeonChannelRoute({ channel: "discord", to: "c2" });
  assert.equal(neonRoutesShareTarget(base, sameNoAccount), true);
  assert.equal(neonRoutesShareTarget(base, otherTarget), false);
  assert.equal(neonRoutesShareTarget(base, undefined), false);
});

test("describeNeonChannelRoute is leak-safe and redacts a secret-shaped target", () => {
  const route = normalizeNeonChannelRoute({ channel: "discord", to: "sk-livedeadbeef0123456789", chatType: "channel" });
  assert.ok(route);
  const described = describeNeonChannelRoute(route);
  assert.doesNotMatch(described, /sk-livedeadbeef0123456789/);
  assert.match(described, /discord/);
  assert.match(described, /channel/);
});
