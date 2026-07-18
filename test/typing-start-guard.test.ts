import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createNeonTypingStartGuard } from "../src/index.js";

describe("Neon typing start guard (upstream typing-start-guard parity)", () => {
  it("skips when sealed without invoking the start thunk", async () => {
    let started = false;
    const guard = createNeonTypingStartGuard({ isSealed: () => true });
    const outcome = await guard.run(() => {
      started = true;
    });
    assert.equal(outcome, "skipped");
    assert.equal(started, false);
  });

  it("skips when shouldBlock returns true", async () => {
    const guard = createNeonTypingStartGuard({ isSealed: () => false, shouldBlock: () => true });
    assert.equal(await guard.run(() => {}), "skipped");
  });

  it("starts on success and resets the failure counter", async () => {
    let failures = 0;
    const guard = createNeonTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 2,
      onStartError: () => {
        failures += 1;
      }
    });
    assert.equal(
      await guard.run(() => {
        throw new Error("boom");
      }),
      "failed"
    );
    // A success between failures resets the streak, so the next failure is "failed" not "tripped".
    assert.equal(await guard.run(() => {}), "started");
    assert.equal(
      await guard.run(() => {
        throw new Error("boom");
      }),
      "failed"
    );
    assert.equal(failures, 2);
    assert.equal(guard.isTripped(), false);
  });

  it("trips after the configured consecutive failures and stays tripped", async () => {
    let tripCount = 0;
    const guard = createNeonTypingStartGuard({
      isSealed: () => false,
      maxConsecutiveFailures: 2,
      onTrip: () => {
        tripCount += 1;
      }
    });
    const fail = () => guard.run(() => {
      throw new Error("boom");
    });
    assert.equal(await fail(), "failed");
    assert.equal(await fail(), "tripped");
    assert.equal(guard.isTripped(), true);
    assert.equal(tripCount, 1);
    // Once tripped, further runs are skipped (and the thunk never fires).
    let firedAfterTrip = false;
    assert.equal(
      await guard.run(() => {
        firedAfterTrip = true;
      }),
      "skipped"
    );
    assert.equal(firedAfterTrip, false);

    guard.reset();
    assert.equal(guard.isTripped(), false);
    assert.equal(await guard.run(() => {}), "started");
  });

  it("rethrows when rethrowOnError is set", async () => {
    const guard = createNeonTypingStartGuard({ isSealed: () => false, rethrowOnError: true });
    await assert.rejects(
      guard.run(() => {
        throw new Error("propagate");
      }),
      /propagate/
    );
  });
});
