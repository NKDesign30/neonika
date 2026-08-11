import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonHeartbeatDaemonStatusSnapshot,
  renderNeonHeartbeatDaemonStatusReport,
  renderNeonMissionControlHeartbeatDaemonStatusPanel,
  resolveNeonHeartbeatDaemonCursorPath,
  resolveNeonHeartbeatDaemonLivePath,
  runNeonHeartbeatDaemonTick,
  resolveNeonHeartbeatTimerGate,
  writeNeonHeartbeatDaemonLiveState,
  type INeonHeartbeatAgentState
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");
const agents: readonly INeonHeartbeatAgentState[] = [{ agentId: "neo", intervalMs: 900_000 }];

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-heartbeat-panel-test-"));
}

describe("Neon heartbeat daemon status panel (read-only)", () => {
  it("reads the gate off by default and an honest absent cursor", async () => {
    const root = await tempRoot();
    try {
      const snapshot = await createNeonHeartbeatDaemonStatusSnapshot(root, {
        env: {},
        now: () => fixedNow,
        agents
      });
      assert.equal(snapshot.gate.enabled, false);
      assert.equal(snapshot.cursorPresent, false);
      assert.equal(snapshot.safety.agentExecuted, false);
      assert.equal(snapshot.safety.outboundSent, false);
      assert.equal(snapshot.safety.wroteLiveRun, false);
      assert.equal(snapshot.agents.length, 1);
      assert.equal(snapshot.agents[0]?.lastEmittedWindow, undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("surfaces the persisted cursor window after an armed tick", async () => {
    const root = await tempRoot();
    try {
      await runNeonHeartbeatDaemonTick({
        cursorPath: resolveNeonHeartbeatDaemonCursorPath(root),
        schedulerSeed: "neonika",
        agents,
        gate: resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "1" }),
        now: () => fixedNow
      });
      const snapshot = await createNeonHeartbeatDaemonStatusSnapshot(root, {
        env: {},
        now: () => fixedNow,
        agents
      });
      assert.equal(snapshot.cursorPresent, true);
      assert.ok(snapshot.agents[0]?.lastEmittedWindow, "cursor window surfaced for neo");
      assert.match(renderNeonHeartbeatDaemonStatusReport(snapshot), /wroteLiveRun=false/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders the 'not loaded' empty state when no snapshot is supplied", () => {
    const panel = renderNeonMissionControlHeartbeatDaemonStatusPanel();
    assert.match(panel, /not loaded/u);
    assert.match(panel, /heartbeatDaemonPanel/u);
  });

  it("distinguishes the viewer env gate from the persisted daemon gate", async () => {
    const root = await tempRoot();
    try {
      await writeNeonHeartbeatDaemonLiveState(resolveNeonHeartbeatDaemonLivePath(root), {
        version: 1,
        pid: 42,
        alive: true,
        gateEnabled: true,
        intervalMs: 60_000,
        startedAt: fixedNow.toISOString(),
        nextTickAt: new Date(fixedNow.getTime() + 60_000).toISOString(),
        tickCount: 0,
        dueIntentsLastTick: 0,
        dueCommitmentsLastTick: 2,
        lifecycleCommitmentsLastTick: 1,
        createdRunsTotal: 0,
        executedRunsTotal: 1,
        failedRunsTotal: 0,
        retryAttemptsTotal: 1,
        deliveredRunsTotal: 1
      });
      const snapshot = await createNeonHeartbeatDaemonStatusSnapshot(root, {
        env: { NEON_SCHEDULED_AGENT_EXECUTION_ENABLED: "ready" },
        now: () => fixedNow,
        agents
      });
      const report = renderNeonHeartbeatDaemonStatusReport(snapshot);
      const panel = renderNeonMissionControlHeartbeatDaemonStatusPanel(snapshot);

      assert.equal(snapshot.gate.enabled, false);
      assert.equal(snapshot.daemon?.gateEnabled, true);
      assert.equal(snapshot.executionGate.enabled, true);
      assert.equal(snapshot.safety.agentExecuted, true);
      assert.equal(snapshot.safety.outboundSent, true);
      assert.match(report, /view gate disabled/u);
      assert.match(report, /daemonGate=armed/u);
      assert.match(report, /dueCommitments\(lastTick\) 2/u);
      assert.match(report, /lifecycleCommitments\(lastTick\) 1/u);
      assert.match(report, /executed 1.*retries 1.*delivered 1/u);
      assert.match(panel, /view gate/u);
      assert.match(panel, /daemonGate armed/u);
      assert.match(panel, /commitments\(lastTick\) 2/u);
      assert.match(panel, /lifecycleCommitments\(lastTick\) 1/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders the shadow tag (gate off) and an escaped, leak-safe panel", async () => {
    const root = await tempRoot();
    try {
      const snapshot = await createNeonHeartbeatDaemonStatusSnapshot(root, {
        env: {},
        now: () => fixedNow,
        agents
      });
      const panel = renderNeonMissionControlHeartbeatDaemonStatusPanel(snapshot);
      assert.match(panel, /shadow/u);
      assert.match(panel, /agentExecuted=false/u);
      assert.doesNotMatch(panel, /secret/iu);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders the ARMED tag when the gate is enabled", async () => {
    const root = await tempRoot();
    try {
      const snapshot = await createNeonHeartbeatDaemonStatusSnapshot(root, {
        env: { NEON_HEARTBEAT_TIMER_ENABLED: "1" },
        now: () => fixedNow,
        agents
      });
      const panel = renderNeonMissionControlHeartbeatDaemonStatusPanel(snapshot);
      assert.match(panel, /ARMED/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
