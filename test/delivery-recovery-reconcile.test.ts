import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isNeonPermanentDeliveryError,
  reconcileNeonDeliveryRecovery,
  renderNeonDeliveryReconcileReport,
  NEON_DELIVERY_MAX_RETRIES,
  NEON_PERMANENT_DELIVERY_ERROR_PATTERNS
} from "../src/index.js";

const base = 1_000_000;

describe("Neon delivery recovery reconcile (DP-1, upstream permanent-error classify)", () => {
  it("classifies the upstream permanent error patterns and lets transient ones through", () => {
    assert.equal(NEON_PERMANENT_DELIVERY_ERROR_PATTERNS.length, 11);
    for (const permanent of [
      "no conversation reference found",
      "Chat not found",
      "user not found",
      "Bot is not a member",
      "bot was blocked by the user",
      "forbidden: bot was kicked from the group",
      "chat_id is empty",
      "recipient is not a valid user",
      "outbound not configured for channel discord",
      "ambiguous discord recipient",
      "User alice not in room"
    ]) {
      assert.equal(isNeonPermanentDeliveryError(permanent), true, permanent);
    }

    for (const transient of ["socket hang up", "503 service unavailable", "ETIMEDOUT", "rate limited"]) {
      assert.equal(isNeonPermanentDeliveryError(transient), false, transient);
    }
  });

  it("gives up immediately on a permanent error with no retry attached", () => {
    const decision = reconcileNeonDeliveryRecovery({
      error: "chat not found",
      retryCount: 0,
      enqueuedAtMs: base,
      now: base
    });
    assert.equal(decision.state, "permanent-failure");
    assert.equal(decision.permanent, true);
    assert.equal(decision.retry, null);
    assert.equal(decision.safety.outboundSent, false);
  });

  it("schedules a transient error as a backoff retry", () => {
    const eligible = reconcileNeonDeliveryRecovery({
      error: "socket hang up",
      retryCount: 0,
      enqueuedAtMs: base,
      now: base
    });
    assert.equal(eligible.state, "retry-eligible");
    assert.equal(eligible.permanent, false);
    assert.ok(eligible.retry);

    const waiting = reconcileNeonDeliveryRecovery({
      retryCount: 1,
      enqueuedAtMs: base,
      lastAttemptAtMs: base,
      now: base + 5_000 // retry 2 backoff is 25s
    });
    assert.equal(waiting.state, "retry-waiting");
  });

  it("reports exhausted once retries are spent, even without an error", () => {
    const decision = reconcileNeonDeliveryRecovery({
      retryCount: NEON_DELIVERY_MAX_RETRIES,
      enqueuedAtMs: base,
      now: base
    });
    assert.equal(decision.state, "exhausted");
    assert.equal(decision.permanent, false);
  });

  it("never echoes the raw error into the decision", () => {
    const decision = reconcileNeonDeliveryRecovery({
      error: "chat not found token=sk-abcdef0123456789ABCDEF",
      retryCount: 0,
      enqueuedAtMs: base,
      now: base
    });
    assert.doesNotMatch(JSON.stringify(decision), /sk-abcdef/);
    assert.doesNotMatch(JSON.stringify(decision), /chat not found/);
  });

  it("renders a readable reconcile report", () => {
    const report = renderNeonDeliveryReconcileReport(
      reconcileNeonDeliveryRecovery({ error: "user not found", retryCount: 0, enqueuedAtMs: base, now: base })
    );
    assert.match(report, /State: permanent-failure/);
    assert.match(report, /Permanent: true/);
    assert.match(report, /Outbound sent: false/);
  });
});
