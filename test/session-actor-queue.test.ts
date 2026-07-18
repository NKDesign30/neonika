import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNeonSessionActorQueue, normalizeNeonSessionActorQueueKey } from "../src/index.js";

interface IDeferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): IDeferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, reject, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Neon session actor queue", () => {
  it("serializes work for the same session key", async () => {
    const queue = createNeonSessionActorQueue();
    const gate = deferred<void>();
    const order: string[] = [];

    const first = queue.run("discord:guild/channel", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
      return 1;
    });
    const second = queue.run("discord:guild/channel", async () => {
      order.push("second:start");
      order.push("second:end");
      return 2;
    });

    await flushMicrotasks();

    assert.deepEqual(order, ["first:start"]);
    assert.equal(queue.getPendingCountForSession("discord:guild/channel"), 2);
    assert.equal(queue.snapshot().active, 1);
    assert.equal(queue.snapshot().pending, 2);

    gate.resolve();

    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
    assert.equal(queue.getPendingCountForSession("discord:guild/channel"), 0);
  });

  it("keeps different session keys independent", async () => {
    const queue = createNeonSessionActorQueue();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const started: string[] = [];

    const first = queue.run("session-a", async () => {
      started.push("a");
      await firstGate.promise;
      return "a";
    });
    const second = queue.run("session-b", async () => {
      started.push("b");
      await secondGate.promise;
      return "b";
    });

    await flushMicrotasks();

    assert.deepEqual(started.sort(), ["a", "b"]);
    assert.equal(queue.snapshot().active, 2);
    assert.equal(queue.snapshot().pending, 2);

    firstGate.resolve();
    secondGate.resolve();

    assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  });

  it("does not poison a session queue after a task failure", async () => {
    const queue = createNeonSessionActorQueue();

    await assert.rejects(
      () =>
        queue.enqueue("session-failure", async () => {
          throw new Error("boom");
        }),
      /boom/
    );

    await assert.doesNotReject(async () => {
      const result = await queue.enqueue("session-failure", async () => "ok");
      assert.equal(result, "ok");
    });
  });

  it("does not emit unhandled rejections for awaited task failures", async () => {
    const queue = createNeonSessionActorQueue();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await assert.rejects(
        queue.enqueue("session-unhandled", async () => {
          throw new Error("boom");
        }),
        /boom/
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("cleans up only idle sessions after the configured idle window", async () => {
    let now = 1_000;
    const queue = createNeonSessionActorQueue({ maxIdleMs: 50, now: () => now });
    const gate = deferred<void>();

    await queue.run("done", async () => "ok");
    const active = queue.run("active", async () => {
      await gate.promise;
      return "active";
    });
    await flushMicrotasks();

    now = 1_049;
    assert.equal(queue.cleanupIdle(), 0);
    now = 1_050;
    assert.equal(queue.cleanupIdle(), 1);
    assert.deepEqual(
      queue.snapshot().sessions.map((session) => session.sessionKey),
      ["active"]
    );

    gate.resolve();
    assert.equal(await active, "active");

    now = 1_100;
    assert.equal(queue.cleanupIdle(), 1);
    assert.equal(queue.snapshot().sessionCount, 0);
  });

  it("normalizes keys conservatively and rejects empty keys", () => {
    assert.equal(normalizeNeonSessionActorQueueKey("  session  "), "session");
    assert.throws(() => normalizeNeonSessionActorQueueKey(" \t "), /non-empty session key/);
  });
});
