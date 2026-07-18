import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  appendNeonCommitment,
  buildNeonCommitmentRecord,
  createNeonHeartbeatDaemonService,
  isNeonHeartbeatDaemonStale,
  parseNeonHeartbeatDurationMs,
  readNeonCommitments,
  readNeonGatewayRuns,
  readNeonHeartbeatDaemonLiveState,
  resolveNeonCommitmentLifecycleGate,
  resolveNeonCommitmentStoreGate,
  resolveNeonCommitmentStorePath,
  resolveNeonHeartbeatDaemonLivePath,
  resolveNeonHeartbeatAgentsFromEnv,
  resolveNeonHeartbeatTimerGate,
  writeNeonHeartbeatDaemonLiveState,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatDaemonLiveState
} from "../src/index.js";

const agents: readonly INeonHeartbeatAgentState[] = [
  { agentId: "neo", intervalMs: 900_000 },
  { agentId: "chaty", intervalMs: 900_000 }
];
const armedGate = resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "ready" });
const offGate = resolveNeonHeartbeatTimerGate({});

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-heartbeat-service-test-"));
}

describe("Neon heartbeat daemon service (shadow)", () => {
  it("resolves runtime heartbeat agents from env instead of smoke fixtures", () => {
    assert.deepEqual(resolveNeonHeartbeatAgentsFromEnv({ NEON_HEARTBEAT_AGENTS: "chaty:15m,neo:30s" }), [
      { agentId: "chaty", intervalMs: 900_000 },
      { agentId: "neo", intervalMs: 30_000 }
    ]);
    assert.deepEqual(resolveNeonHeartbeatAgentsFromEnv({ NEON_DISCORD_AGENT_ID: "forge" }), [
      { agentId: "forge", intervalMs: 900_000 }
    ]);
    assert.equal(parseNeonHeartbeatDurationMs("1h", 1), 3_600_000);
    assert.equal(parseNeonHeartbeatDurationMs("broken", 42), 42);
  });

  it("writes terminal shadow run-records and tracks liveness across ticks", async () => {
    const root = await tempRoot();
    let clockMs = Date.parse("2026-06-02T12:00:00.000Z");
    try {
      const service = createNeonHeartbeatDaemonService({
        projectRoot: root,
        schedulerSeed: "neonika",
        agents,
        intervalMs: 900_000,
        gate: armedGate,
        now: () => new Date(clockMs)
      });
      await service.start();
      // Two ticks, advancing past one interval each so a fresh window emits.
      clockMs += 16 * 60_000;
      const first = await service.tickOnce();
      clockMs += 16 * 60_000;
      const second = await service.tickOnce();

      assert.equal(first.execution.createdRunCount, 2, "both agents emit on the first new window");
      assert.equal(second.execution.createdRunCount, 2);
      assert.equal(first.execution.safety.outboundSent, false);

      const live = service.getState();
      assert.equal(live.alive, true);
      assert.equal(live.tickCount, 2);
      assert.equal(live.createdRunsTotal, 4);
      assert.equal(live.dueCommitmentsLastTick, 0);
      assert.ok(live.lastTickAt);
      assert.ok(live.nextTickAt);

      const runs = await readNeonGatewayRuns(root);
      const heartbeatRuns = runs.filter((run) => run.runId.startsWith("heartbeat-"));
      assert.equal(heartbeatRuns.length, 4);
      assert.ok(heartbeatRuns.every((run) => run.mode === "shadow"));
      assert.ok(heartbeatRuns.every((run) => run.delivery.state === "suppressed"));

      await service.stop();
      assert.equal(service.getState().alive, false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("feeds due commitments from the real store into heartbeat shadow run-records", async () => {
    const root = await tempRoot();
    const baseMs = Date.parse("2026-06-02T12:00:00.000Z");
    const storePath = resolveNeonCommitmentStorePath(root);
    try {
      const commitment = buildNeonCommitmentRecord(
        {
          id: "commitment-1",
          agentId: "chaty",
          sessionKey: "discord/private",
          channel: "discord",
          kind: "open_loop",
          source: "agent_promise",
          suggestedText: "check the Pokemon page deployment",
          dedupeKey: "discord/private:katapuldra",
          confidence: 0.9,
          dueWindow: {
            earliestMs: baseMs - 60_000,
            latestMs: baseMs + 3_600_000,
            timezone: "Europe/Berlin"
          }
        },
        baseMs - 120_000
      );
      const append = await appendNeonCommitment({
        commitment,
        gate: resolveNeonCommitmentStoreGate({ NEON_COMMITMENTS_STORE_ENABLED: "ready" }),
        storePath
      });
      assert.equal(append.state, "appended");

      const service = createNeonHeartbeatDaemonService({
        projectRoot: root,
        schedulerSeed: "neonika",
        agents,
        intervalMs: 900_000,
        gate: armedGate,
        now: () => new Date(baseMs),
        commitmentStorePath: storePath,
        commitmentLifecycle: {
          gate: resolveNeonCommitmentLifecycleGate({ NEON_COMMITMENT_LIFECYCLE_ENABLED: "ready" }),
          snoozeMs: 900_000
        }
      });
      const outcome = await service.tickOnce();

      assert.equal(outcome.state.dueCommitmentsLastTick, 1);
      assert.equal(outcome.state.lifecycleCommitmentsLastTick, 1);
      assert.equal(outcome.commitmentLifecycle.state, "updated");
      assert.deepEqual(outcome.commitmentLifecycle.updatedIds, ["commitment-1"]);
      assert.ok(
        outcome.tick.tick.emissions.some(
          (emission) =>
            emission.source === "commitment" &&
            emission.agentId === "chaty" &&
            emission.commitmentIds?.includes("commitment-1") === true
        ),
        "commitment wake should be part of the heartbeat tick"
      );

      const runs = await readNeonGatewayRuns(root);
      const commitmentRun = runs.find((run) =>
        run.request.contentPreview.includes("commitments=commitment-1")
      );
      assert.ok(commitmentRun, "commitment wake should produce a visible terminal run-record");
      assert.equal(commitmentRun.delivery.state, "suppressed");
      assert.equal(commitmentRun.mode, "shadow");

      const commitments = await readNeonCommitments({ storePath });
      const updated = commitments.find((candidate) => candidate.id === "commitment-1");
      assert.equal(updated?.status, "snoozed");
      assert.equal(updated?.attempts, 1);
      assert.equal(updated?.snoozedUntilMs, baseMs + 900_000);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ticks but writes nothing when the gate is closed", async () => {
    const root = await tempRoot();
    try {
      const service = createNeonHeartbeatDaemonService({
        projectRoot: root,
        schedulerSeed: "neonika",
        agents,
        intervalMs: 900_000,
        gate: offGate,
        now: () => new Date(Date.parse("2026-06-02T12:00:00.000Z"))
      });
      const outcome = await service.tickOnce();
      assert.equal(outcome.execution.createdRunCount, 0);
      assert.equal(outcome.state.dueIntentsLastTick, 0);
      assert.equal(outcome.state.dueCommitmentsLastTick, 0);
      const runs = await readNeonGatewayRuns(root);
      assert.equal(runs.filter((run) => run.runId.startsWith("heartbeat-")).length, 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists liveness state and round-trips it", async () => {
    const root = await tempRoot();
    const livePath = resolveNeonHeartbeatDaemonLivePath(root);
    try {
      const service = createNeonHeartbeatDaemonService({
        projectRoot: root,
        schedulerSeed: "neonika",
        agents,
        intervalMs: 900_000,
        gate: armedGate,
        now: () => new Date(Date.parse("2026-06-02T12:00:00.000Z"))
      });
      await service.start();
      const persisted = await readNeonHeartbeatDaemonLiveState(livePath);
      assert.ok(persisted);
      assert.equal(persisted?.alive, true);
      assert.equal(persisted?.version, 1);
      await service.stop();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("flags a stale daemon (alive but next tick overdue), not a stopped one", () => {
    const base = Date.parse("2026-06-02T12:00:00.000Z");
    const alive: INeonHeartbeatDaemonLiveState = {
      version: 1,
      pid: 1,
      alive: true,
      gateEnabled: true,
      intervalMs: 900_000,
      startedAt: new Date(base).toISOString(),
      nextTickAt: new Date(base).toISOString(),
      tickCount: 1,
      dueIntentsLastTick: 0,
      dueCommitmentsLastTick: 0,
      lifecycleCommitmentsLastTick: 0,
      createdRunsTotal: 0
    };
    // Grace is 60s: within grace is not stale, well past it is.
    assert.equal(isNeonHeartbeatDaemonStale(alive, base + 30_000), false, "within grace");
    assert.equal(isNeonHeartbeatDaemonStale(alive, base + 2 * 60_000 + 1), true);
    assert.equal(isNeonHeartbeatDaemonStale({ ...alive, alive: false }, base + 10 * 60_000), false);
  });

  it("writeNeonHeartbeatDaemonLiveState round-trips without leaking", async () => {
    const root = await tempRoot();
    const livePath = resolveNeonHeartbeatDaemonLivePath(root);
    try {
      const state: INeonHeartbeatDaemonLiveState = {
        version: 1,
        pid: 42,
        alive: true,
        gateEnabled: true,
        intervalMs: 900_000,
        startedAt: "2026-06-02T12:00:00.000Z",
        tickCount: 3,
        dueIntentsLastTick: 2,
        dueCommitmentsLastTick: 0,
        lifecycleCommitmentsLastTick: 0,
        createdRunsTotal: 6
      };
      await writeNeonHeartbeatDaemonLiveState(livePath, state);
      const read = await readNeonHeartbeatDaemonLiveState(livePath);
      assert.deepEqual(read, state);
      assert.doesNotMatch(JSON.stringify(read), /secret/iu);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
