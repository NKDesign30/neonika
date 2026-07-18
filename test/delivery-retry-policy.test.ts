import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeNeonDeliveryBackoffMs,
  planNeonDeliveryRetry,
  renderNeonDeliveryRetryScheduleReport,
  NEON_DELIVERY_BACKOFF_MS,
  NEON_DELIVERY_MAX_RETRIES
} from "../src/index.js";

const base = 1_000_000;

describe("Neon outbound delivery retry policy (DP-1, upstream delivery-queue-recovery)", () => {
  it("mirrors the upstream backoff schedule and clamps past the table", () => {
    assert.deepEqual(NEON_DELIVERY_BACKOFF_MS, [5_000, 25_000, 120_000, 600_000]);
    assert.equal(computeNeonDeliveryBackoffMs(0), 0);
    assert.equal(computeNeonDeliveryBackoffMs(-3), 0);
    assert.equal(computeNeonDeliveryBackoffMs(1), 5_000);
    assert.equal(computeNeonDeliveryBackoffMs(2), 25_000);
    assert.equal(computeNeonDeliveryBackoffMs(3), 120_000);
    assert.equal(computeNeonDeliveryBackoffMs(4), 600_000);
    // Past the table clamps to the last value.
    assert.equal(computeNeonDeliveryBackoffMs(9), 600_000);
  });

  it("gives up once retryCount reaches MAX_RETRIES", () => {
    const decision = planNeonDeliveryRetry({
      retryCount: NEON_DELIVERY_MAX_RETRIES,
      enqueuedAtMs: base,
      now: base
    });
    assert.equal(decision.state, "exhausted");
    assert.equal(decision.safety.outboundSent, false);
  });

  it("treats the first replay after a crash as immediately eligible", () => {
    const decision = planNeonDeliveryRetry({ retryCount: 0, enqueuedAtMs: base, now: base });
    assert.equal(decision.state, "eligible");
    assert.equal(decision.remainingBackoffMs, 0);
  });

  it("waits out the backoff window from the last attempt", () => {
    const decision = planNeonDeliveryRetry({
      retryCount: 1,
      enqueuedAtMs: base - 1_000_000,
      lastAttemptAtMs: base,
      now: base + 10_000 // 10s after attempt; retry 2 backoff is 25s
    });
    assert.equal(decision.state, "waiting");
    assert.equal(decision.backoffMs, 25_000);
    assert.equal(decision.nextEligibleAtMs, base + 25_000);
    assert.equal(decision.remainingBackoffMs, 15_000);
  });

  it("becomes eligible once the backoff window has passed", () => {
    const decision = planNeonDeliveryRetry({
      retryCount: 1,
      enqueuedAtMs: base - 1_000_000,
      lastAttemptAtMs: base,
      now: base + 30_000 // past the 25s window
    });
    assert.equal(decision.state, "eligible");
    assert.equal(decision.remainingBackoffMs, 0);
  });

  it("falls back to enqueuedAt when there is no valid last-attempt timestamp", () => {
    const decision = planNeonDeliveryRetry({
      retryCount: 2,
      enqueuedAtMs: base,
      now: base + 60_000 // retry 3 backoff is 120s; window not passed from enqueue
    });
    assert.equal(decision.state, "waiting");
    assert.equal(decision.nextEligibleAtMs, base + 120_000);
  });

  it("renders a schedule report that never claims a send", () => {
    const report = renderNeonDeliveryRetryScheduleReport(base);
    assert.match(report, /Max retries: 5/);
    assert.match(report, /Backoff schedule: 5s -> 25s -> 2m -> 10m/);
    assert.match(report, /Outbound sent: false/);
    assert.match(report, /retryCount 5: give up/);
  });
});
