import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordComponentActionRegistry,
  createNeonDiscordRunControl,
  createNeonInFlightRunRegistry,
  createNeonSessionActorQueue,
  parseNeonDiscordRunControlCommand,
  registerNeonDiscordStopAction,
  type INeonInFlightRunGate,
  type INeonInFlightRunStart
} from "../src/index.js";

const enabledGate: INeonInFlightRunGate = {
  enabled: true,
  reason: "lifecycle-enabled",
  envKey: "NEON_LIVE_RUN_LIFECYCLE_ENABLED"
};
const disabledGate: INeonInFlightRunGate = {
  enabled: false,
  reason: "lifecycle-disabled",
  envKey: "NEON_LIVE_RUN_LIFECYCLE_ENABLED"
};

describe("Neon Discord run control", () => {
  it("recognizes only exact stop commands", () => {
    for (const value of ["/stop", "/abort", "Stop!", "stopp", "Abbruch", "abbrechen."]) {
      assert.equal(parseNeonDiscordRunControlCommand(value), "stop");
    }
    for (const value of ["stoppe später", "bitte abbrechen wenn fertig", "/stop now", "unstoppable"]) {
      assert.equal(parseNeonDiscordRunControlCommand(value), undefined);
    }
  });

  it("stops only one session, interrupts its run, and cancels its queued work", async () => {
    const queue = createNeonSessionActorQueue();
    const registry = createNeonInFlightRunRegistry({
      gate: enabledGate,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });
    registry.onRunStart(start("run-a", "session-a"));
    registry.onRunStart(start("run-b", "session-b"));
    const activeGate = deferred<void>();
    const active = queue.run("session-a", async () => await activeGate.promise);
    const queued = queue.run("session-a", async () => "must-not-run");
    await flushMicrotasks();
    const interrupted: string[] = [];
    const control = createNeonDiscordRunControl({
      inFlightRuns: registry,
      sessionQueue: queue,
      now: () => new Date("2026-07-10T00:00:05.000Z"),
      interruptRun: async (record) => {
        interrupted.push(record.runId);
      }
    });
    const signalA = control.resolveAbortSignal("run-a", "session-a", "2026-07-10T00:00:01.000Z");
    const signalB = control.resolveAbortSignal("run-b", "session-b", "2026-07-10T00:00:01.000Z");

    const result = await control.stopSession("session-a");

    assert.equal(result.state, "stopped");
    assert.equal(result.activeRunsMatched, 1);
    assert.equal(result.interruptsSent, 1);
    assert.equal(result.localAbortsSent, 1);
    assert.equal(result.pendingTasksCancelled, 1);
    assert.deepEqual(interrupted, ["run-a"]);
    assert.equal(signalA.aborted, true);
    assert.equal(signalB.aborted, false);
    assert.equal(registry.snapshot().running.find((record) => record.runId === "run-a")?.state, "interrupting");
    assert.equal(registry.snapshot().running.find((record) => record.runId === "run-b")?.state, "running");

    activeGate.resolve();
    await active;
    await assert.rejects(queued, /cancelled by an operator control/u);
  });

  it("applies the stop cutoff to an older run that reaches the harness late", async () => {
    const control = createNeonDiscordRunControl({
      inFlightRuns: createNeonInFlightRunRegistry({ gate: enabledGate }),
      sessionQueue: createNeonSessionActorQueue(),
      now: () => new Date("2026-07-10T00:00:05.000Z"),
      interruptRun: async () => undefined
    });

    await control.stopSession("session-a");
    const old = control.resolveAbortSignal("old", "session-a", "2026-07-10T00:00:01.000Z");
    const fresh = control.resolveAbortSignal("fresh", "session-a", "2026-07-10T00:00:06.000Z");

    assert.equal(old.aborted, true);
    assert.equal(fresh.aborted, false);
  });

  it("stays blocked behind the lifecycle gate", async () => {
    const control = createNeonDiscordRunControl({
      inFlightRuns: createNeonInFlightRunRegistry({ gate: disabledGate }),
      sessionQueue: createNeonSessionActorQueue(),
      interruptRun: async () => {
        throw new Error("must not run");
      }
    });

    const result = await control.stopSession("session-a");
    const lateSignal = control.resolveAbortSignal("late", "session-a", "2020-01-01T00:00:00.000Z");

    assert.equal(result.state, "blocked");
    assert.equal(result.interruptsSent, 0);
    assert.equal(result.message, "Stop ist für diese Runtime nicht aktiviert.");
    assert.equal(lateSignal.aborted, false);
  });

  it("reuses the owner-bound component registry for a stop button", async () => {
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      createActionId: () => "stop-action"
    });
    const runControl = createNeonDiscordRunControl({
      inFlightRuns: createNeonInFlightRunRegistry({ gate: enabledGate }),
      sessionQueue: createNeonSessionActorQueue(),
      now: () => new Date("2026-07-10T00:00:01.000Z"),
      interruptRun: async () => undefined
    });
    const action = registerNeonDiscordStopAction({
      registry,
      runControl,
      ownerUserId: "operator",
      guildId: "guild",
      channelId: "channel",
      sessionKey: "session",
      expiresAt: "2026-07-10T00:01:00.000Z"
    });

    const foreign = await registry.dispatch({
      interactionId: "foreign",
      kind: "button",
      customId: action.customId,
      userId: "other",
      guildId: "guild",
      channelId: "channel",
      createdAt: "2026-07-10T00:00:01.000Z"
    });
    const owner = await registry.dispatch({
      interactionId: "owner",
      kind: "button",
      customId: action.customId,
      userId: "operator",
      guildId: "guild",
      channelId: "channel",
      createdAt: "2026-07-10T00:00:01.000Z"
    });

    assert.equal(foreign.state, "rejected");
    assert.equal(owner.state, "completed");
    assert.equal(owner.message, "Keine laufende Aufgabe in dieser Session.");
  });
});

function start(runId: string, sessionKey: string): INeonInFlightRunStart {
  return {
    runId,
    threadId: `thread-${runId}`,
    turnId: `turn-${runId}`,
    sessionKey,
    agentId: "chaty",
    channel: "discord"
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  if (!resolve) {
    throw new Error("Expected deferred resolve callback");
  }
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
