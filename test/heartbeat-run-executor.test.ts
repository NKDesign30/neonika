import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNeonHeartbeatWakeRun,
  executeNeonHeartbeatWakeIntents,
  type INeonGatewayShadowRun,
  type INeonHeartbeatWakeEmission
} from "../src/index.js";

const tickAt = "2026-06-02T12:00:00.000Z";

function emission(agentId: string, windowKey: string): INeonHeartbeatWakeEmission {
  return {
    agentId,
    intent: "scheduled",
    source: "interval",
    reason: "interval",
    priority: 1,
    dueMs: Date.parse(windowKey),
    windowKey
  };
}

describe("Neon heartbeat run executor (shadow)", () => {
  it("builds a terminal shadow run-record with suppressed delivery", () => {
    const run = buildNeonHeartbeatWakeRun({
      projectRoot: "/tmp/x",
      emission: emission("neo", "2026-06-02T11:51:00.000Z"),
      tickAt
    });
    assert.equal(run.runId, "heartbeat-neo-2026-06-02T11:51:00.000Z");
    assert.equal(run.mode, "shadow");
    assert.equal(run.status, "completed");
    assert.equal(run.request.agentId, "neo");
    assert.equal(run.delivery.state, "suppressed");
    assert.equal(run.finalText, "");
    assert.equal(run.events.length, 0);
  });

  it("writes one run per emission and reports the created ids", async () => {
    const written: INeonGatewayShadowRun[] = [];
    const result = await executeNeonHeartbeatWakeIntents({
      projectRoot: "/tmp/x",
      emissions: [
        emission("neo", "2026-06-02T11:51:00.000Z"),
        emission("chaty", "2026-06-02T11:55:00.000Z")
      ],
      tickAt,
      writeRun: async (_root, run) => {
        written.push(run);
      }
    });
    assert.equal(result.createdRunCount, 2);
    assert.deepEqual(result.createdRunIds, [
      "heartbeat-neo-2026-06-02T11:51:00.000Z",
      "heartbeat-chaty-2026-06-02T11:55:00.000Z"
    ]);
    assert.equal(result.safety.outboundSent, false);
    assert.equal(result.safety.sentDiscord, false);
    assert.equal(result.safety.wroteRunStore, true);
    assert.equal(written.length, 2);
    assert.ok(written.every((run) => run.delivery.state === "suppressed"));
  });

  it("writes nothing for an empty emission set", async () => {
    let calls = 0;
    const result = await executeNeonHeartbeatWakeIntents({
      projectRoot: "/tmp/x",
      emissions: [],
      tickAt,
      writeRun: async () => {
        calls += 1;
      }
    });
    assert.equal(calls, 0);
    assert.equal(result.createdRunCount, 0);
    assert.equal(result.safety.wroteRunStore, false);
    assert.doesNotMatch(JSON.stringify(result), /secret/iu);
  });
});
