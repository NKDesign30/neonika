import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  claimNeonInboundReplay,
  createNeonDiscordInboundReplayGuard,
  buildNeonInboundReplayKey,
  createNeonDiscordInboundReplayFileStore,
  resolveNeonDiscordInboundReplayPath
} from "../src/gateway/discordInboundReplayGuard.js";

describe("Neon Discord inbound replay guard", () => {
  it("claims a fresh key and flags the second claim as duplicate", () => {
    const guard = createNeonDiscordInboundReplayGuard({ now: () => 1000 });
    assert.equal(guard.claim("a"), "claimed");
    assert.equal(guard.claim("a"), "duplicate");
    assert.equal(guard.claim("b"), "claimed");
  });

  it("re-claims a key only after its TTL expires", () => {
    let nowMs = 1000;
    const guard = createNeonDiscordInboundReplayGuard({ ttlMs: 5000, now: () => nowMs });
    assert.equal(guard.claim("a"), "claimed");
    nowMs = 5999; // still within the TTL window
    assert.equal(guard.claim("a"), "duplicate");
    nowMs = 6001; // past 1000 + 5000
    assert.equal(guard.claim("a"), "claimed");
  });

  it("evicts the oldest claims beyond maxEntries", () => {
    const guard = createNeonDiscordInboundReplayGuard({ maxEntries: 2, now: () => 1000 });
    guard.claim("a");
    guard.claim("b");
    guard.claim("c"); // pushes over the cap -> evicts "a"
    assert.equal(guard.size(), 2);
    assert.equal(guard.claim("a"), "claimed"); // "a" was evicted, so it is fresh again
  });

  it("builds a stable account:channel:message key", () => {
    assert.equal(
      buildNeonInboundReplayKey({ accountId: "acct", channelId: "chan", messageId: "msg" }),
      "acct:chan:msg"
    );
  });

  it("size reflects only live claims after expiry", () => {
    let nowMs = 0;
    const guard = createNeonDiscordInboundReplayGuard({ ttlMs: 100, now: () => nowMs });
    guard.claim("a");
    guard.claim("b");
    assert.equal(guard.size(), 2);
    nowMs = 101;
    assert.equal(guard.size(), 0);
  });

  it("dedupes across guard instances with the persistent file store", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-replay-persist-"));
    const filePath = resolveNeonDiscordInboundReplayPath(projectRoot);
    const store = createNeonDiscordInboundReplayFileStore(filePath);
    let nowMs = 1000;

    try {
      const firstGuard = createNeonDiscordInboundReplayGuard({
        ttlMs: 5000,
        persistentStore: store,
        now: () => nowMs
      });
      assert.equal(await claimNeonInboundReplay(firstGuard, "persisted"), "claimed");

      nowMs = 2000;
      const restartedGuard = createNeonDiscordInboundReplayGuard({
        ttlMs: 5000,
        persistentStore: store,
        now: () => nowMs
      });
      assert.equal(await claimNeonInboundReplay(restartedGuard, "persisted"), "duplicate");

      nowMs = 7001;
      const expiredGuard = createNeonDiscordInboundReplayGuard({
        ttlMs: 5000,
        persistentStore: store,
        now: () => nowMs
      });
      assert.equal(await claimNeonInboundReplay(expiredGuard, "persisted"), "claimed");
      assert.match(filePath, /discord-inbound-replay\.jsonl$/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("fails open and keeps memory dedupe when persistence fails", async () => {
    const errors: unknown[] = [];
    const guard = createNeonDiscordInboundReplayGuard({
      persistentStore: {
        async lookup(): Promise<number | undefined> {
          throw new Error("store unavailable");
        },
        async register(): Promise<void> {
          throw new Error("store still unavailable");
        }
      },
      logPersistenceError: (error) => errors.push(error),
      now: () => 1000
    });

    assert.equal(await claimNeonInboundReplay(guard, "a"), "claimed");
    assert.equal(await claimNeonInboundReplay(guard, "a"), "duplicate");
    assert.equal(errors.length, 1);
  });

  it("bounds the persistent file store by newest replay records", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-replay-bounds-"));
    const filePath = resolveNeonDiscordInboundReplayPath(projectRoot);
    const store = createNeonDiscordInboundReplayFileStore(filePath, { maxRecords: 2 });

    try {
      await store.register("old", 1000);
      await store.register("newer", 2000);
      await store.register("newest", 3000);

      const raw = await readFile(filePath, "utf8");
      assert.doesNotMatch(raw, /"old"/);
      assert.match(raw, /"newer"/);
      assert.match(raw, /"newest"/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
