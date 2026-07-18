import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNeonTranscriptScheduleIntent,
  resolveNeonCronTimerGate
} from "../src/index.js";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("Neonika Transcript schedule intent (S5)", () => {
  it("is disabled by default and never marks anything executed", () => {
    const intent = buildNeonTranscriptScheduleIntent({
      gate: resolveNeonCronTimerGate({}),
      now: NOW
    });
    assert.equal(intent.gateEnabled, false);
    assert.equal(intent.wouldEmit, false);
    assert.equal(intent.safety.executed, false);
    assert.equal(intent.safety.timerStarted, false);
    assert.equal(intent.safety.outboundSent, false);
    assert.equal(intent.command, "node dist/src/cli.js transcript");
  });

  it("flips wouldEmit when armed but still starts no timer and runs nothing", () => {
    const intent = buildNeonTranscriptScheduleIntent({
      gate: resolveNeonCronTimerGate({ NEON_CRON_TIMER_ENABLED: "ready" }),
      now: NOW
    });
    assert.equal(intent.gateEnabled, true);
    assert.equal(intent.wouldEmit, true);
    // Arming the gate must NOT start a timer or execute a run from this module.
    assert.equal(intent.safety.executed, false);
    assert.equal(intent.safety.timerStarted, false);
  });

  it("anchors generatedAt to the injected clock", () => {
    const intent = buildNeonTranscriptScheduleIntent({ gate: resolveNeonCronTimerGate({}), now: NOW });
    assert.equal(intent.generatedAt, new Date(NOW).toISOString());
  });
});
