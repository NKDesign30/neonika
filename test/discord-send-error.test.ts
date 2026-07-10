import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyNeonDiscordSendError,
  NEON_DELIVERY_MAX_RETRIES,
  planNeonDeliveryRetryAfterSendError
} from "../src/index.js";

describe("classifyNeonDiscordSendError (Z482)", () => {
  it("treats a rate-limit (retryAfter ms) as retryable and extracts retry-after", () => {
    const c = classifyNeonDiscordSendError({ status: 429, retryAfter: 4200 });
    assert.equal(c.retryable, true);
    assert.equal(c.retryAfterMs, 4200);
  });

  it("treats 408 and 5xx as transient/retryable", () => {
    assert.equal(classifyNeonDiscordSendError({ status: 408 }).retryable, true);
    assert.equal(classifyNeonDiscordSendError({ status: 500 }).retryable, true);
    assert.equal(classifyNeonDiscordSendError({ statusCode: 503 }).retryable, true);
  });

  it("treats permanent 4xx, status-less, and non-object errors as not retryable", () => {
    assert.equal(classifyNeonDiscordSendError({ status: 403 }).retryable, false);
    assert.equal(classifyNeonDiscordSendError({ status: 404 }).retryable, false);
    assert.equal(classifyNeonDiscordSendError({ message: "boom" }).retryable, false);
    assert.equal(classifyNeonDiscordSendError("nope").retryable, false);
    assert.equal(classifyNeonDiscordSendError(null).retryable, false);
  });
});

describe("planNeonDeliveryRetryAfterSendError (Z482)", () => {
  const now = 1_000_000;
  const retry = (retryCount: number) => ({
    retryCount,
    enqueuedAtMs: now - 60_000,
    lastAttemptAtMs: now - 60_000,
    now
  });

  it("honours Discord retry-after over the computed backoff", () => {
    const plan = planNeonDeliveryRetryAfterSendError({
      error: { status: 429, retryAfter: 7500 },
      retry: retry(1)
    });
    assert.equal(plan.action, "retry");
    assert.equal(plan.waitMs, 7500);
    assert.equal(plan.nextEligibleAtMs, now + 7500);
    assert.equal(plan.safety.outboundSent, false);
  });

  it("falls back to the backoff schedule for a transient error without retry-after", () => {
    // Recent attempt so the 25s backoff for retry 2 is still pending (not yet eligible).
    const plan = planNeonDeliveryRetryAfterSendError({
      error: { status: 503 },
      retry: { retryCount: 1, enqueuedAtMs: now - 5_000, lastAttemptAtMs: now - 1_000, now }
    });
    assert.equal(plan.action, "retry");
    assert.equal(plan.waitMs > 0, true, "expected a positive backoff wait");
    assert.equal(plan.classification.retryAfterMs, undefined, "no retry-after on a plain 503");
  });

  it("gives up on a permanent error without consuming a retry", () => {
    const plan = planNeonDeliveryRetryAfterSendError({ error: { status: 403 }, retry: retry(0) });
    assert.equal(plan.action, "give-up");
    assert.equal(plan.classification.retryable, false);
    assert.equal(plan.waitMs, 0);
  });

  it("reports exhausted once retries reach the cap", () => {
    const plan = planNeonDeliveryRetryAfterSendError({
      error: { status: 503 },
      retry: retry(NEON_DELIVERY_MAX_RETRIES)
    });
    assert.equal(plan.action, "exhausted");
    assert.equal(plan.safety.outboundSent, false);
  });
});
