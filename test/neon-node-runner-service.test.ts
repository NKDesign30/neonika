import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  approveNeonNodeRunnerServiceAction,
  createNeonNodeRunnerServiceActionSnapshot,
  createNeonNodeRunnerServiceCanarySnapshot,
  createNeonNodeRunnerServiceSnapshot,
  executeNeonNodeRunnerServiceAction,
  renderNeonNodeRunnerServicePlist,
  renderNeonNodeRunnerServiceCanaryReport,
  renderNeonNodeRunnerServiceReport,
  requestNeonNodeRunnerServiceAction,
  readNeonNodeRunnerControl,
  writeNeonNodeRunnerControl,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot
} from "../src/index.js";

describe("Neon Node Runner Service", () => {
  it("renders a LaunchAgent plan without executing service mutations or exposing secrets", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
      await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "service unit"
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );

      const snapshot = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:01:00.000Z"),
        env: {
          NEON_NODE_SESSION_ID: "service-session-unit",
          NEON_NODE_SESSION_SECRET: "service-secret-unit"
        },
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const plist = renderNeonNodeRunnerServicePlist({
        projectRoot: snapshot.paths.projectRoot,
        paths: snapshot.paths
      });
      const report = renderNeonNodeRunnerServiceReport(snapshot);
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.manager, "launchd");
      assert.equal(snapshot.installState, "not-installed");
      assert.equal(snapshot.credentials.source, "process-env");
      assert.equal(snapshot.blockers.length, 0);
      assert.equal(snapshot.safety.installExecuted, false);
      assert.equal(snapshot.safety.restartExecuted, false);
      assert.equal(snapshot.safety.stopExecuted, false);
      assert.equal(snapshot.safety.launchAgentWritten, false);
      assert.equal(snapshot.safety.sessionSecretPersisted, false);
      assert.match(plist, /com\.neon\.core\.node-runner/u);
      assert.match(plist, /node-runner-loop/u);
      assert.match(plist, /NEON_NODE_RUNNER_ENV_FILE/u);
      assert.equal(snapshot.commands.some((command) => command.id === "restart" && command.requiresApproval), true);
      assert.doesNotMatch(plist, /service-secret-unit/u);
      assert.doesNotMatch(report, /service-secret-unit/u);
      assert.doesNotMatch(serialized, /service-secret-unit/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks service readiness until build, credentials, and runner control are ready", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:02:00.000Z"),
        env: {},
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });

      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "cli-not-built"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "missing-session-env"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "runner-control-stopped"), true);
      assert.equal(snapshot.safety.sessionSecretPersisted, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks service canary until credentials, runner control, rollback, and executor arm are ready", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:21:00.000Z"),
        env: {},
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const snapshot = await createNeonNodeRunnerServiceCanarySnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:22:00.000Z"),
        env: {},
        serviceSnapshot: service
      });

      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.credentialsSource, "missing");
      assert.equal(snapshot.executorMode, "disabled");
      assert.equal(snapshot.rollbackConfigured, false);
      assert.equal(snapshot.cutoverStage, "shadow");
      assert.notEqual(snapshot.currentGateState, "pass");
      assert.equal(snapshot.safety.canaryMutationAllowed, false);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "credentials-missing"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "runner-control-stopped"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "rollback-missing"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "executor-not-armed"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "cutover-stage-before-canary"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "cutover-gate-not-ready"), true);
      assert.equal(snapshot.blockers.some((blocker) => blocker.id === "service-blocked"), true);
      assert.equal(snapshot.safety.serviceMutationExecuted, false);
      assert.equal(snapshot.safety.rawTokenPersisted, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reports service canary ready without serializing session secrets", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
      await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "service canary unit"
        },
        {
          now: () => new Date("2026-06-01T00:23:00.000Z")
        }
      );

      const env = {
        NEON_NODE_SESSION_ID: "service-canary-unit",
        NEON_NODE_SESSION_SECRET: "service-canary-secret-unit",
        NEON_NODE_SERVICE_EXECUTOR_MODE: "armed",
        NEON_CUTOVER_ROLLBACK_COMMAND: "node dist/src/cli.js node-runner-stop"
      };
      const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:24:00.000Z"),
        env,
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const snapshot = await createNeonNodeRunnerServiceCanarySnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:25:00.000Z"),
        env,
        cutoverSnapshot: createServiceCanaryCutoverSnapshot(projectRoot),
        serviceSnapshot: service
      });
      const report = renderNeonNodeRunnerServiceCanaryReport(snapshot);
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.serviceState, "ready");
      assert.equal(snapshot.credentialsSource, "process-env");
      assert.equal(snapshot.runnerControl, "running");
      assert.equal(snapshot.executorMode, "armed");
      assert.equal(snapshot.rollbackConfigured, true);
      assert.equal(snapshot.cutoverStage, "canary");
      assert.equal(snapshot.currentGateState, "pass");
      assert.equal(snapshot.safety.canaryMutationAllowed, true);
      assert.equal(snapshot.safety.serviceMutationExecuted, false);
      assert.equal(snapshot.blockers.length, 0);
      assert.doesNotMatch(report, /service-canary-secret-unit/u);
      assert.doesNotMatch(serialized, /service-canary-secret-unit/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records approval-gated service action requests without executing launchctl", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
      await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "service action unit"
        },
        {
          now: () => new Date("2026-06-01T00:03:00.000Z")
        }
      );

      const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:04:00.000Z"),
        env: {
          NEON_NODE_SESSION_ID: "service-action-unit",
          NEON_NODE_SESSION_SECRET: "service-action-value"
        },
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart after canary env"
        },
        {
          now: () => new Date("2026-06-01T00:05:00.000Z"),
          serviceSnapshot: service
        }
      );
      const approval = await approveNeonNodeRunnerServiceAction(
        projectRoot,
        {
          actionRequestId: request.actionRequestId,
          decision: "approve",
          operatorId: "chaty",
          reason: "approved for later execution gate"
        },
        {
          now: () => new Date("2026-06-01T00:06:00.000Z")
        }
      );
      const execution = await executeNeonNodeRunnerServiceAction(
        projectRoot,
        {
          approvalId: approval.approvalId,
          operatorId: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:06:30.000Z"),
          serviceSnapshot: service
        }
      );
      const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:07:00.000Z"),
        serviceSnapshot: service
      });
      const serialized = JSON.stringify(snapshot);

      assert.equal(request.state, "approval-required");
      assert.equal(request.blockers.length, 0);
      assert.match(request.command, /launchctl kickstart/u);
      assert.equal(request.safety.serviceMutationExecuted, false);
      assert.equal(request.safety.launchAgentWritten, false);
      assert.equal(approval.decision, "approve");
      assert.equal(approval.safety.executionEnabled, false);
      assert.equal(approval.safety.serviceMutationExecuted, false);
      assert.equal(execution.state, "blocked");
      assert.equal(execution.blockReason, "executor-not-armed");
      assert.equal(execution.safety.serviceMutationExecuted, false);
      assert.equal(execution.safety.launchAgentWritten, false);
      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.totals.requests, 1);
      assert.equal(snapshot.totals.approvals, 1);
      assert.equal(snapshot.totals.pendingApproval, 0);
      assert.equal(snapshot.totals.blockedExecutions, 1);
      assert.doesNotMatch(serialized, /service-action-value/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks armed LaunchAgent execution until the cutover canary gate passes", async () => {
    const projectRoot = await createTempProjectRoot();
    const commands: string[] = [];

    try {
      await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
      await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "pre-canary restart unit"
        },
        {
          now: () => new Date("2026-06-01T00:26:00.000Z")
        }
      );

      const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:27:00.000Z"),
        env: {
          NEON_NODE_SESSION_ID: "service-pre-canary-unit",
          NEON_NODE_SESSION_SECRET: "service-pre-canary-value"
        },
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart before cutover gate"
        },
        {
          now: () => new Date("2026-06-01T00:28:00.000Z"),
          serviceSnapshot: service
        }
      );
      const approval = await approveNeonNodeRunnerServiceAction(
        projectRoot,
        {
          actionRequestId: request.actionRequestId,
          decision: "approve",
          operatorId: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:29:00.000Z")
        }
      );
      const execution = await executeNeonNodeRunnerServiceAction(
        projectRoot,
        {
          approvalId: approval.approvalId,
          operatorId: "chaty"
        },
        {
          env: {
            NEON_CUTOVER_ROLLBACK_COMMAND: "node dist/src/cli.js node-runner-stop"
          },
          executor: {
            writeLaunchAgent: async () => undefined,
            runCommand: async (command) => {
              commands.push(command);
              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            }
          },
          executorMode: "armed",
          now: () => new Date("2026-06-01T00:30:00.000Z"),
          serviceSnapshot: service
        }
      );
      const serialized = JSON.stringify(execution);

      assert.equal(execution.state, "blocked");
      assert.equal(execution.blockReason, "service-canary-blocked");
      assert.equal(execution.safety.serviceMutationExecuted, false);
      assert.equal(execution.safety.launchAgentWritten, false);
      assert.equal(commands.length, 0);
      assert.doesNotMatch(serialized, /service-pre-canary-value/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("executes armed LaunchAgent restart through an injected executor when rollback is configured", async () => {
    const projectRoot = await createTempProjectRoot();
    const commands: string[] = [];

    try {
      await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
      await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "armed restart unit"
        },
        {
          now: () => new Date("2026-06-01T00:15:00.000Z")
        }
      );

      const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:16:00.000Z"),
        env: {
          NEON_NODE_SESSION_ID: "service-armed-unit",
          NEON_NODE_SESSION_SECRET: "service-armed-value"
        },
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart through executor"
        },
        {
          now: () => new Date("2026-06-01T00:17:00.000Z"),
          serviceSnapshot: service
        }
      );
      const approval = await approveNeonNodeRunnerServiceAction(
        projectRoot,
        {
          actionRequestId: request.actionRequestId,
          decision: "approve",
          operatorId: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:18:00.000Z")
        }
      );
      const execution = await executeNeonNodeRunnerServiceAction(
        projectRoot,
        {
          approvalId: approval.approvalId,
          operatorId: "chaty"
        },
        {
          env: {
            NEON_CUTOVER_ROLLBACK_COMMAND: "node dist/src/cli.js node-runner-stop"
          },
          cutoverSnapshot: createServiceCanaryCutoverSnapshot(projectRoot),
          executor: {
            writeLaunchAgent: async () => undefined,
            runCommand: async (command) => {
              commands.push(command);
              return {
                exitCode: 0,
                stdout: "ok",
                stderr: ""
              };
            }
          },
          executorMode: "armed",
          now: () => new Date("2026-06-01T00:19:00.000Z"),
          serviceSnapshot: service
        }
      );
      const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:20:00.000Z"),
        serviceSnapshot: service
      });
      const serialized = JSON.stringify(snapshot);

      assert.equal(execution.state, "executed");
      assert.equal(execution.executorMode, "armed");
      assert.equal(execution.rollbackCommand, "node dist/src/cli.js node-runner-stop");
      assert.equal(execution.safety.serviceMutationExecuted, true);
      assert.equal(execution.safety.launchAgentWritten, false);
      assert.equal(execution.safety.runnerControlWritten, false);
      assert.equal(commands.length, 1);
      assert.match(commands[0] ?? "", /launchctl kickstart/u);
      assert.equal(snapshot.totals.executed, 1);
      assert.doesNotMatch(serialized, /service-armed-value/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("executes approved start-runner actions by writing only Neon runner control", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
      await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");

      const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:10:00.000Z"),
        env: {
          NEON_NODE_SESSION_ID: "service-execution-unit",
          NEON_NODE_SESSION_SECRET: "service-execution-value"
        },
        platform: "darwin",
        arch: "arm64",
        homeDir: join(projectRoot, "home"),
        userId: 501
      });
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "start-runner",
          operatorId: "chaty",
          reason: "start the supervised runner"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z"),
          serviceSnapshot: service
        }
      );
      const approval = await approveNeonNodeRunnerServiceAction(
        projectRoot,
        {
          actionRequestId: request.actionRequestId,
          decision: "approve",
          operatorId: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const execution = await executeNeonNodeRunnerServiceAction(
        projectRoot,
        {
          approvalId: approval.approvalId,
          operatorId: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:13:00.000Z"),
          serviceSnapshot: service
        }
      );
      const control = await readNeonNodeRunnerControl(projectRoot);
      const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:14:00.000Z"),
        serviceSnapshot: service
      });
      const serialized = JSON.stringify(snapshot);

      assert.equal(execution.state, "executed");
      assert.equal(execution.safety.executionEnabled, true);
      assert.equal(execution.safety.runnerControlWritten, true);
      assert.equal(execution.safety.serviceMutationExecuted, false);
      assert.equal(execution.safety.launchAgentWritten, false);
      assert.equal(control.desiredState, "running");
      assert.equal(control.safety.sessionSecretPersisted, false);
      assert.equal(snapshot.totals.executions, 1);
      assert.equal(snapshot.totals.executed, 1);
      assert.equal(snapshot.totals.blockedExecutions, 0);
      assert.doesNotMatch(serialized, /service-execution-value/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks service action requests when service readiness is blocked", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "install",
          operatorId: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:08:00.000Z")
        }
      );
      const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:09:00.000Z")
      });

      assert.equal(request.state, "blocked");
      assert.equal(request.blockers.includes("cli-not-built"), true);
      assert.equal(request.blockers.includes("missing-session-env"), true);
      assert.equal(request.blockers.includes("runner-control-stopped"), true);
      assert.equal(request.safety.serviceMutationExecuted, false);
      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.totals.blocked, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-node-runner-service-test-"));
}

function createServiceCanaryCutoverSnapshot(projectRoot: string): INeonCutoverGateSnapshot {
  const gates: readonly INeonCutoverGate[] = [
    createServiceCanaryGate("shadow", "Shadow", "pass"),
    createServiceCanaryGate("mirror", "Mirror", "pass"),
    createServiceCanaryGate("canary", "Canary", "pass"),
    createServiceCanaryGate("primary", "Primary", "locked"),
    createServiceCanaryGate("retire", "Retire", "locked")
  ];

  return {
    state: "ready",
    generatedAt: "2026-06-01T00:25:00.000Z",
    currentStage: "canary",
    nextStage: "primary",
    gates,
    source: {
      projectRoot,
      doctorState: "pass",
      routeState: "ready",
      mirrorEvidenceState: "ready",
      mirrorAcceptedCount: 2,
      gatewayRuns: 5,
      latestRunId: "run-service-canary",
      rollbackConfigured: true
    }
  };
}

function createServiceCanaryGate(
  id: INeonCutoverGate["id"],
  label: string,
  state: INeonCutoverGate["state"]
): INeonCutoverGate {
  return {
    id,
    label,
    state,
    summary: `${label} ${state}`,
    requiredEvidence: ["service canary unit"],
    evidence: ["evidence"],
    recovery: state === "pass" ? [] : ["keep previous stage"],
    rollback: "Keep previous route active."
  };
}
