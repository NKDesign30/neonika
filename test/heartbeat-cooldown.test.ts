import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordNeonHeartbeatRunStart, shouldDeferNeonHeartbeatWake } from "../src/index.js";

const now = 1_000_000;

describe("Neon heartbeat cooldown (pure defer matrix)", () => {
  it("never defers a manual wake (flood-exempt)", () => {
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "manual",
      reason: undefined,
      now,
      nextDueMs: now + 5000,
      recentRunStarts: [now - 100, now - 200, now - 300, now - 400, now - 500, now - 600]
    });
    assert.equal(decision.defer, false);
  });

  it("runs an immediate wake unless the flood-guard trips", () => {
    assert.equal(
      shouldDeferNeonHeartbeatWake({ intent: "immediate", reason: undefined, now, nextDueMs: now })
        .defer,
      false
    );
    const flooded = shouldDeferNeonHeartbeatWake({
      intent: "immediate",
      reason: undefined,
      now,
      nextDueMs: now,
      recentRunStarts: [now - 100, now - 200, now - 300, now - 400, now - 500]
    });
    assert.deepEqual(flooded, { defer: true, reason: "flood" });
  });

  it("defers a scheduled wake while not due, runs once due", () => {
    assert.deepEqual(
      shouldDeferNeonHeartbeatWake({ intent: "scheduled", reason: undefined, now, nextDueMs: now + 1 }),
      { defer: true, reason: "not-due" }
    );
    assert.equal(
      shouldDeferNeonHeartbeatWake({ intent: "scheduled", reason: undefined, now, nextDueMs: now })
        .defer,
      false
    );
  });

  it("lets the first event wake through (bootstrap responsiveness)", () => {
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "event",
      reason: undefined,
      now,
      nextDueMs: now + 9999
    });
    assert.equal(decision.defer, false);
  });

  it("defers an event wake that is not due yet", () => {
    assert.deepEqual(
      shouldDeferNeonHeartbeatWake({
        intent: "event",
        reason: undefined,
        now,
        nextDueMs: now + 1,
        lastRunStartedAtMs: now - 60_000
      }),
      { defer: true, reason: "not-due" }
    );
  });

  it("defers an event wake inside the min-spacing window", () => {
    assert.deepEqual(
      shouldDeferNeonHeartbeatWake({
        intent: "event",
        reason: undefined,
        now,
        nextDueMs: now,
        lastRunStartedAtMs: now - 5000 // < default 30s spacing
      }),
      { defer: true, reason: "min-spacing" }
    );
  });

  it("defers reason 'flood' when >= threshold runs fall inside the window", () => {
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "event",
      reason: undefined,
      now,
      nextDueMs: now,
      lastRunStartedAtMs: now - 60_000,
      recentRunStarts: [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000]
    });
    assert.deepEqual(decision, { defer: true, reason: "flood" });
  });

  it("flood-guard returns null below the threshold (early exit)", () => {
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "event",
      reason: undefined,
      now,
      nextDueMs: now,
      lastRunStartedAtMs: now - 60_000,
      recentRunStarts: [now - 1000, now - 2000]
    });
    assert.equal(decision.defer, false);
  });

  it("checks the flood-guard before the scheduled/event gates", () => {
    // not-due would otherwise fire, but flood wins on a non-immediate wake
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "event",
      reason: undefined,
      now,
      nextDueMs: now + 10_000,
      lastRunStartedAtMs: now - 60_000,
      recentRunStarts: [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000]
    });
    assert.deepEqual(decision, { defer: true, reason: "flood" });
  });

  it("recordNeonHeartbeatRunStart does not mutate the input and keeps newest threshold+1", () => {
    const buffer = Object.freeze([1, 2, 3, 4, 5, 6]);
    const next = recordNeonHeartbeatRunStart(buffer, 7, 5);
    assert.deepEqual(buffer, [1, 2, 3, 4, 5, 6]); // unchanged (frozen would throw on mutation)
    assert.deepEqual(next, [2, 3, 4, 5, 6, 7]); // newest threshold+1 = 6 entries
  });

  it("keeps no reason on the run branch (exactOptional discriminated union)", () => {
    const decision = shouldDeferNeonHeartbeatWake({
      intent: "manual",
      reason: undefined,
      now,
      nextDueMs: now
    });
    assert.equal(decision.defer, false);
    assert.equal("reason" in decision, false);
  });
});
