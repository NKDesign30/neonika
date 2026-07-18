import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonAutomationSnapshot,
  evaluateNeonCronTick,
  renderNeonCronTickReport,
  resolveNeonCronTimerGate,
  type INeonAutomationJob,
  type INeonAutomationSnapshot
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");

describe("Neon cron timer runtime (DP-8)", () => {
  it("keeps the timer gate off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonCronTimerGate({}).enabled, false);
    assert.equal(resolveNeonCronTimerGate({}).reason, "timer-disabled");

    for (const value of ["1", "ready", "true", "yes"]) {
      const gate = resolveNeonCronTimerGate({ NEON_CRON_TIMER_ENABLED: value });
      assert.equal(gate.enabled, true, `value ${value} should arm the timer`);
      assert.equal(gate.reason, "timer-enabled");
    }

    assert.equal(resolveNeonCronTimerGate({ NEON_CRON_TIMER_ENABLED: "0" }).enabled, false);
  });

  it("does not evaluate any tick while the timer gate is closed", () => {
    const result = evaluateNeonCronTick({
      gate: { enabled: false, reason: "timer-disabled", envKey: "NEON_CRON_TIMER_ENABLED" },
      now: () => fixedNow
    });

    assert.equal(result.armed, false);
    assert.equal(result.intents.length, 0);
    assert.equal(result.emitted.length, 0);
    assert.equal(result.safety.executed, false);
    assert.equal(result.safety.outboundSent, false);
  });

  it("arms against the real catalog but emits nothing because every job stays disabled", () => {
    const result = evaluateNeonCronTick({
      gate: { enabled: true, reason: "timer-enabled", envKey: "NEON_CRON_TIMER_ENABLED" },
      now: () => fixedNow,
      forceJobIds: ["heartbeat-review", "memory-digest"]
    });

    assert.equal(result.armed, true);
    assert.ok(result.intents.length >= 1);
    // Default catalog jobs are all `disabled`, so even forced + armed the timer
    // emits zero executable intents — the honest shadow-contract default.
    assert.equal(result.emitted.length, 0);
    assert.ok(result.intents.every((intent) => intent.action === "none"));
    assert.equal(result.safety.executed, false);
  });

  it("emits exactly one shadow run intent for a ready, due cron job", () => {
    const snapshot = withSingleReadyCronJob();

    const result = evaluateNeonCronTick({
      gate: { enabled: true, reason: "timer-enabled", envKey: "NEON_CRON_TIMER_ENABLED" },
      now: () => fixedNow,
      snapshot
    });

    assert.equal(result.armed, true);
    assert.deepEqual(result.emitted, ["ready-cron"]);
    assert.equal(result.deduped.length, 0);
    const intent = result.intents.find((entry) => entry.jobId === "ready-cron");
    assert.equal(intent?.action, "shadow-run-intent");
    assert.equal(intent?.state, "ready");
    // The intent is data only — the timer never runs it.
    assert.equal(result.safety.executed, false);
    assert.equal(result.safety.outboundSent, false);
    assert.equal(result.nextEmitted["ready-cron"], intent?.dueAt);
  });

  it("dedups a job already emitted for the same due window (prevents-duplicate-timers analog)", () => {
    const snapshot = withSingleReadyCronJob();
    const dueAt = snapshot.jobs[0]?.nextRunAt;
    assert.ok(dueAt);

    const result = evaluateNeonCronTick({
      gate: { enabled: true, reason: "timer-enabled", envKey: "NEON_CRON_TIMER_ENABLED" },
      now: () => fixedNow,
      snapshot,
      alreadyEmitted: { "ready-cron": dueAt }
    });

    assert.deepEqual(result.deduped, ["ready-cron"]);
    assert.equal(result.emitted.length, 0);
    assert.equal(result.nextEmitted["ready-cron"], dueAt);
  });

  it("renders a leak-free tick report that names the gate and safety posture", () => {
    const report = renderNeonCronTickReport(
      evaluateNeonCronTick({
        gate: { enabled: false, reason: "timer-disabled", envKey: "NEON_CRON_TIMER_ENABLED" },
        now: () => fixedNow
      })
    );

    assert.match(report, /Neonika Cron Timer: disabled/);
    assert.match(report, /executed=false outboundSent=false/);
  });
});

function withSingleReadyCronJob(): INeonAutomationSnapshot {
  const base = createNeonAutomationSnapshot({ generatedAt: fixedNow });
  const readyJob: INeonAutomationJob = {
    id: "ready-cron",
    kind: "cron",
    label: "Ready Cron",
    state: "ready",
    policy: "operator-approval-required",
    schedule: "every-5m",
    intervalMinutes: 5,
    nextRunAt: new Date(fixedNow.getTime() - 60_000).toISOString(),
    source: "test-fixture",
    summary: "Ready, due cron job used to prove the emit path."
  };

  return { ...base, jobs: [readyJob] };
}
