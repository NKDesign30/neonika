import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonCutoverGateSnapshot,
  evaluateCanaryExitGate,
  evaluateMirrorExitGate,
  evaluatePrimaryExitGate,
  evaluateRetireExitGate,
  evaluateShadowExitGate,
  renderNeonCutoverGateReport,
  writeNeonGatewayRun,
  writeNeonMirrorEvidence,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon Cutover gates", () => {
  it("keeps mirror and later stages locked without shadow runtime evidence", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonCutoverGateSnapshot(projectRoot, {
        env: {},
        now: () => new Date("2026-05-31T20:00:00.000Z")
      });

      assert.equal(snapshot.state, "needs-evidence");
      assert.equal(snapshot.currentStage, "shadow");
      assert.equal(snapshot.nextStage, "mirror");
      assert.equal(snapshot.gates.find((gate) => gate.id === "shadow")?.state, "warn");
      assert.equal(snapshot.gates.find((gate) => gate.id === "mirror")?.state, "locked");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("passes shadow and asks for mirror comparison evidence", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createCutoverRun("run-cutover-1"));

      const snapshot = await createNeonCutoverGateSnapshot(projectRoot, {
        env: createRouteReadyEnv(),
        now: () => new Date("2026-05-31T20:05:00.000Z")
      });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.gates.find((gate) => gate.id === "shadow")?.state, "pass");
      assert.equal(snapshot.gates.find((gate) => gate.id === "mirror")?.state, "warn");
      assert.ok(
        snapshot.gates
          .find((gate) => gate.id === "mirror")
          ?.recovery.some((entry) => entry.includes("mirror-record"))
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("passes primary only with approvals, rollback, clean Doctor, and stable runs", async () => {
    const projectRoot = await createTempProjectRoot();
    const secretToken = "discord-secret-cutover-value";

    try {
      for (let index = 1; index <= 5; index += 1) {
        await writeNeonGatewayRun(projectRoot, createCutoverRun(`run-cutover-${index}`));
      }
      await writeNeonMirrorEvidence(projectRoot, {
        evidenceId: "mirror-primary-pass",
        prompt: "Can Neonika answer with the same operational context?",
        legacyOutput: "Legacy path answers with Operator context and keeps delivery bounded.",
        neonOutput: "Neon path answers with Operator context and keeps delivery bounded.",
        verdict: "acceptable",
        legacyLatencyMs: 1400,
        neonLatencyMs: 900,
        reviewer: "chaty",
        now: () => new Date("2026-05-31T20:09:00.000Z")
      });

      const snapshot = await createNeonCutoverGateSnapshot(projectRoot, {
        currentStage: "primary",
        env: {
          ...createRouteReadyEnv(),
          NEON_CUTOVER_CANARY_APPROVED: "ready",
          NEON_CUTOVER_PRIMARY_APPROVED: "ready",
          NEON_CUTOVER_ROLLBACK_COMMAND: "switch-back-to-legacy",
          NEON_DISCORD_BOT_TOKEN: secretToken
        },
        now: () => new Date("2026-05-31T20:10:00.000Z")
      });
      const report = renderNeonCutoverGateReport(snapshot);
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.currentStage, "primary");
      assert.equal(snapshot.source.rollbackConfigured, true);
      assert.equal(snapshot.gates.find((gate) => gate.id === "mirror")?.state, "pass");
      assert.equal(snapshot.gates.find((gate) => gate.id === "canary")?.state, "pass");
      assert.equal(snapshot.gates.find((gate) => gate.id === "primary")?.state, "pass");
      assert.equal(snapshot.gates.find((gate) => gate.id === "retire")?.state, "warn");
      assert.doesNotMatch(report, new RegExp(secretToken));
      assert.doesNotMatch(serialized, new RegExp(secretToken));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("uses recent clean run evidence so historical failures do not keep primary blocked", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createFailedCutoverRun("run-cutover-old-failure"));
      for (let index = 1; index <= 50; index += 1) {
        await writeNeonGatewayRun(projectRoot, createCutoverRun(`run-cutover-recent-${index}`));
      }
      await writeNeonMirrorEvidence(projectRoot, {
        evidenceId: "mirror-primary-recent-pass",
        prompt: "Can Neonika answer with the same operational context?",
        legacyOutput: "Legacy path answers with Operator context and keeps delivery bounded.",
        neonOutput: "Neon path answers with Operator context and keeps delivery bounded.",
        verdict: "acceptable",
        legacyLatencyMs: 1400,
        neonLatencyMs: 900,
        reviewer: "chaty",
        now: () => new Date("2026-05-31T20:29:00.000Z")
      });

      const snapshot = await createNeonCutoverGateSnapshot(projectRoot, {
        currentStage: "primary",
        env: {
          ...createRouteReadyEnv(),
          NEON_CUTOVER_CANARY_APPROVED: "ready",
          NEON_CUTOVER_PRIMARY_APPROVED: "ready",
          NEON_CUTOVER_ROLLBACK_COMMAND: "switch-back-to-legacy"
        },
        now: () => new Date("2026-05-31T20:30:00.000Z")
      });
      const report = renderNeonCutoverGateReport(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.source.gatewayRuns, 51);
      assert.equal(snapshot.source.activeEvidenceRuns, 50);
      assert.equal(snapshot.gates.find((gate) => gate.id === "shadow")?.state, "pass");
      assert.equal(snapshot.gates.find((gate) => gate.id === "primary")?.state, "pass");
      assert.match(report, /Runs: 51 \(active evidence=50\)/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

describe("Shadow exit gate evidence", () => {
  it("is met when every shadow run keeps delivery suppressed", () => {
    const evidence = evaluateShadowExitGate({
      runCount: 3,
      shadowRunCount: 3,
      deliverySuppressedCount: 3,
      failedCount: 0
    });

    assert.equal(evidence.met, true);
    assert.ok(evidence.reasons.some((reason) => reason.includes("every shadow run kept delivery suppressed")));
  });

  it("stays met when intentional live deliveries are present alongside shadow runs", () => {
    // 102 shadow+suppressed runs plus 1 live+delivered run under a primary stage.
    const evidence = evaluateShadowExitGate({
      runCount: 103,
      shadowRunCount: 102,
      deliverySuppressedCount: 102,
      failedCount: 0
    });

    assert.equal(evidence.met, true);
    assert.ok(evidence.reasons.some((reason) => reason.includes("every shadow run kept delivery suppressed")));
  });

  it("is not met when a shadow run leaked an active delivery", () => {
    const evidence = evaluateShadowExitGate({
      runCount: 3,
      shadowRunCount: 3,
      deliverySuppressedCount: 2,
      failedCount: 0
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("shadow delivery leak detected")));
  });

  it("is not met when a gateway run failed", () => {
    const evidence = evaluateShadowExitGate({
      runCount: 4,
      shadowRunCount: 4,
      deliverySuppressedCount: 4,
      failedCount: 1
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("failed gateway runs present")));
  });

  it("is not met without any persisted shadow runs", () => {
    const evidence = evaluateShadowExitGate({
      runCount: 0,
      shadowRunCount: 0,
      deliverySuppressedCount: 0,
      failedCount: 0
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("no persisted shadow runs")));
  });

  it("is not met when only live deliveries are present", () => {
    const evidence = evaluateShadowExitGate({
      runCount: 5,
      shadowRunCount: 0,
      deliverySuppressedCount: 0,
      failedCount: 0
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("no persisted shadow runs")));
  });
});

describe("Mirror exit gate evidence", () => {
  it("is met when routes are scoped, memory passes, and mirror evidence is ready", () => {
    const evidence = evaluateMirrorExitGate({
      routeReady: true,
      memoryReady: true,
      mirrorEvidenceReady: true,
      mirrorAcceptedCount: 2
    });

    assert.equal(evidence.met, true);
    assert.ok(evidence.reasons.some((reason) => reason.includes("discord routes are scoped")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("mirror comparison evidence is ready")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("accepted=2")));
  });

  it("is not met when mirror evidence has not reached the ready state", () => {
    const evidence = evaluateMirrorExitGate({
      routeReady: true,
      memoryReady: true,
      mirrorEvidenceReady: false,
      mirrorAcceptedCount: 0
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("mirror comparison evidence is not ready")));
  });

  it("is not met when discord routes are not scoped", () => {
    const evidence = evaluateMirrorExitGate({
      routeReady: false,
      memoryReady: true,
      mirrorEvidenceReady: true,
      mirrorAcceptedCount: 1
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("discord routes are not scoped")));
  });

  it("is not met when the memory check does not pass", () => {
    const evidence = evaluateMirrorExitGate({
      routeReady: true,
      memoryReady: false,
      mirrorEvidenceReady: true,
      mirrorAcceptedCount: 1
    });

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("memory check does not pass")));
  });
});

describe("Canary exit gate evidence", () => {
  it("is met when mirror passed, rollback is configured, and canary is approved", () => {
    const evidence = evaluateCanaryExitGate(
      {
        rollbackConfigured: true,
        canaryApproved: true
      },
      "pass"
    );

    assert.equal(evidence.met, true);
    assert.ok(evidence.reasons.some((reason) => reason.includes("mirror gate passed")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("rollback configured")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("canary approved")));
  });

  it("is not met when the mirror gate has not passed", () => {
    const evidence = evaluateCanaryExitGate(
      {
        rollbackConfigured: true,
        canaryApproved: true
      },
      "warn"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("mirror gate not passed")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("state=warn")));
  });

  it("is not met when rollback is not configured", () => {
    const evidence = evaluateCanaryExitGate(
      {
        rollbackConfigured: false,
        canaryApproved: true
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("rollback not configured")));
  });

  it("is not met when canary is not approved", () => {
    const evidence = evaluateCanaryExitGate(
      {
        rollbackConfigured: true,
        canaryApproved: false
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("canary not approved")));
  });
});

describe("Primary exit gate evidence", () => {
  it("is met when canary passed, approval is set, doctor is clean, and runs are stable", () => {
    const evidence = evaluatePrimaryExitGate(
      {
        primaryApproved: true,
        doctorHasNoFailures: true,
        completedCount: 5,
        failedCount: 0
      },
      "pass"
    );

    assert.equal(evidence.met, true);
    assert.ok(evidence.reasons.some((reason) => reason.includes("canary gate passed")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("primary approved")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("doctor reports no failures")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("stable runs present")));
  });

  it("is not met when the canary gate has not passed", () => {
    const evidence = evaluatePrimaryExitGate(
      {
        primaryApproved: true,
        doctorHasNoFailures: true,
        completedCount: 5,
        failedCount: 0
      },
      "warn"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("canary gate not passed")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("state=warn")));
  });

  it("is not met without enough stable runs", () => {
    const evidence = evaluatePrimaryExitGate(
      {
        primaryApproved: true,
        doctorHasNoFailures: true,
        completedCount: 4,
        failedCount: 0
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("not enough stable runs")));
  });

  it("is not met when a run failed", () => {
    const evidence = evaluatePrimaryExitGate(
      {
        primaryApproved: true,
        doctorHasNoFailures: true,
        completedCount: 6,
        failedCount: 1
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("not enough stable runs")));
  });

  it("is not met when doctor reports failures", () => {
    const evidence = evaluatePrimaryExitGate(
      {
        primaryApproved: true,
        doctorHasNoFailures: false,
        completedCount: 5,
        failedCount: 0
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("doctor reports failures")));
  });

  it("is not met when primary is not approved", () => {
    const evidence = evaluatePrimaryExitGate(
      {
        primaryApproved: false,
        doctorHasNoFailures: true,
        completedCount: 5,
        failedCount: 0
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("primary not approved")));
  });
});

describe("Retire exit gate evidence", () => {
  it("is met when primary passed, retire evidence is ready, and rollback is configured", () => {
    const evidence = evaluateRetireExitGate(
      {
        retireEvidenceReady: true,
        rollbackConfigured: true
      },
      "pass"
    );

    assert.equal(evidence.met, true);
    assert.ok(evidence.reasons.some((reason) => reason.includes("primary gate passed")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("retire evidence ready")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("rollback configured")));
  });

  it("is not met when the primary gate has not passed", () => {
    const evidence = evaluateRetireExitGate(
      {
        retireEvidenceReady: true,
        rollbackConfigured: true
      },
      "warn"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("primary gate not passed")));
    assert.ok(evidence.reasons.some((reason) => reason.includes("state=warn")));
  });

  it("is not met when retire evidence is not ready", () => {
    const evidence = evaluateRetireExitGate(
      {
        retireEvidenceReady: false,
        rollbackConfigured: true
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("retire evidence not ready")));
  });

  it("is not met when rollback is not configured", () => {
    const evidence = evaluateRetireExitGate(
      {
        retireEvidenceReady: true,
        rollbackConfigured: false
      },
      "pass"
    );

    assert.equal(evidence.met, false);
    assert.ok(evidence.reasons.some((reason) => reason.includes("rollback not configured")));
  });
});

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-cutover-"));
}

function createRouteReadyEnv(): Readonly<Record<string, string | undefined>> {
  return {
    NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005",
    NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
    NEON_DISCORD_BOT_USER_ID: "900000000000000010"
  };
}

function createCutoverRun(runId: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Cutover gate evidence",
      receivedAt: "2026-05-31T20:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: `neon:codex:chaty:discord:default:channel:${runId}:read-only`,
    memoryState: "attached",
    events: [
      {
        kind: "final",
        text: "Cutover proof complete."
      }
    ],
    finalText: "Cutover proof complete.",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "Cutover proof complete."
    },
    startedAt: "2026-05-31T20:00:00.000Z",
    completedAt: "2026-05-31T20:00:01.000Z"
  };
}

function createFailedCutoverRun(runId: string): INeonGatewayShadowRun {
  const run = createCutoverRun(runId);

  return {
    ...run,
    status: "failed",
    events: [
      ...run.events,
      {
        kind: "failed",
        message: "Historical failure before the active cutover evidence window."
      }
    ]
  };
}
