import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getNeonWakeTargetKey,
  isNeonRetryableHeartbeatBusySkipReason,
  normalizeNeonHeartbeatWakeReason,
  queueNeonPendingWakeReason,
  resolveNeonWakePriority,
  type INeonPendingWakeReason
} from "../src/index.js";

describe("Neon heartbeat wake model (pure)", () => {
  it("prioritises manual/immediate as ACTION even over a retry reason", () => {
    assert.equal(
      resolveNeonWakePriority({ source: "retry", intent: "manual", reason: "retry" }),
      3
    );
    assert.equal(
      resolveNeonWakePriority({ source: "retry", intent: "immediate", reason: "retry" }),
      3
    );
  });

  it("maps retry/interval/default priorities", () => {
    assert.equal(resolveNeonWakePriority({ source: "retry", intent: "event", reason: "retry" }), 0);
    assert.equal(
      resolveNeonWakePriority({ source: "interval", intent: "scheduled", reason: "interval" }),
      1
    );
    assert.equal(
      resolveNeonWakePriority({ source: "exec-event", intent: "event", reason: "exec" }),
      2
    );
  });

  it("normalises empty/whitespace/undefined reasons to 'requested'", () => {
    assert.equal(normalizeNeonHeartbeatWakeReason(undefined), "requested");
    assert.equal(normalizeNeonHeartbeatWakeReason("   "), "requested");
    assert.equal(normalizeNeonHeartbeatWakeReason("  cron tick "), "cron tick");
  });

  it("builds distinct target keys; whitespace-only collapses to empty", () => {
    assert.notEqual(
      getNeonWakeTargetKey({ agentId: "a" }),
      getNeonWakeTargetKey({ agentId: "b" })
    );
    assert.equal(getNeonWakeTargetKey({ agentId: "   " }), getNeonWakeTargetKey({}));
  });

  it("sets a wake on an empty map", () => {
    const map = new Map<string, INeonPendingWakeReason>();
    queueNeonPendingWakeReason(map, {
      source: "interval",
      intent: "scheduled",
      agentId: "a",
      requestedAt: 1000
    });
    assert.equal(map.size, 1);
  });

  it("upgrades on higher priority and never downgrades", () => {
    const map = new Map<string, INeonPendingWakeReason>();
    queueNeonPendingWakeReason(map, {
      source: "interval",
      intent: "scheduled",
      agentId: "a",
      requestedAt: 1000
    }); // INTERVAL (1)
    queueNeonPendingWakeReason(map, {
      source: "manual",
      intent: "manual",
      agentId: "a",
      requestedAt: 1001
    }); // ACTION (3)
    assert.equal(map.get("a::")?.priority, 3);

    queueNeonPendingWakeReason(map, {
      source: "interval",
      intent: "scheduled",
      agentId: "a",
      requestedAt: 1002
    }); // INTERVAL (1) -> must NOT downgrade the pending ACTION
    assert.equal(map.get("a::")?.priority, 3);
  });

  it("breaks ties last-write-wins at equal priority", () => {
    const map = new Map<string, INeonPendingWakeReason>();
    queueNeonPendingWakeReason(map, {
      source: "interval",
      intent: "scheduled",
      agentId: "a",
      reason: "first",
      requestedAt: 1000
    });
    queueNeonPendingWakeReason(map, {
      source: "interval",
      intent: "scheduled",
      agentId: "a",
      reason: "second",
      requestedAt: 1000
    });
    assert.equal(map.get("a::")?.reason, "second");
  });

  it("preserves the heartbeat override when same-target wakes coalesce", () => {
    const map = new Map<string, INeonPendingWakeReason>();
    queueNeonPendingWakeReason(map, {
      source: "interval",
      intent: "scheduled",
      agentId: "a",
      requestedAt: 1000,
      heartbeat: { target: "discord" }
    });
    queueNeonPendingWakeReason(map, {
      source: "manual",
      intent: "manual",
      agentId: "a",
      requestedAt: 1001
    }); // higher priority, no override
    assert.deepEqual(map.get("a::")?.heartbeat, { target: "discord" });
  });

  it("recognises the 3 retryable busy-skip reasons", () => {
    assert.equal(isNeonRetryableHeartbeatBusySkipReason("requests-in-flight"), true);
    assert.equal(isNeonRetryableHeartbeatBusySkipReason("cron-in-progress"), true);
    assert.equal(isNeonRetryableHeartbeatBusySkipReason("lanes-busy"), true);
    assert.equal(isNeonRetryableHeartbeatBusySkipReason("quiet-hours"), false);
  });
});
