import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  approveNeonNodeRunnerServiceAction,
  createNeonNodeRunnerServiceSnapshot,
  executeNeonNodeRunnerServiceAction,
  requestNeonNodeRunnerServiceAction,
  resolveNeonNodeRunnerServicePaths,
  writeNeonNodeRunnerControl,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot
} from "../src/index.js";

describe("Neon Node Runner Service — command injection guard", () => {
  it("blocks execution and never spawns when the persisted command is tampered after approval", async () => {
    const projectRoot = await createTempProjectRoot();
    const commands: string[] = [];

    try {
      const service = await createArmedService(projectRoot);
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart through executor"
        },
        {
          now: () => new Date("2026-06-01T01:01:00.000Z"),
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
          now: () => new Date("2026-06-01T01:02:00.000Z")
        }
      );

      // Forge the persisted request record so the execution path would otherwise
      // shell out arbitrary text via spawn("/bin/zsh", ["-lc", command]).
      const injectedCommand = "touch /tmp/neonika-command-guard-pwn; echo injected";
      await tamperPersistedRequestCommand(projectRoot, request.actionRequestId, injectedCommand);

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
          now: () => new Date("2026-06-01T01:03:00.000Z"),
          serviceSnapshot: service
        }
      );

      assert.equal(execution.state, "blocked");
      assert.equal(execution.blockReason, "command-not-recognized");
      assert.equal(execution.safety.serviceMutationExecuted, false);
      assert.equal(execution.safety.launchAgentWritten, false);
      assert.equal(commands.length, 0, "tampered command must never reach the shell executor");
      // The blocked execution record intentionally keeps the rejected command for
      // audit; that is not a leak — the only guarantee that matters is no spawn.
      assert.equal(execution.command, "touch /tmp/neonika-command-guard-pwn; echo injected");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("never invokes the executor while the service executor mode is disabled", async () => {
    const projectRoot = await createTempProjectRoot();
    const commands: string[] = [];

    try {
      const service = await createArmedService(projectRoot);
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart with disabled executor"
        },
        {
          now: () => new Date("2026-06-01T01:11:00.000Z"),
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
          now: () => new Date("2026-06-01T01:12:00.000Z")
        }
      );
      const execution = await executeNeonNodeRunnerServiceAction(
        projectRoot,
        {
          approvalId: approval.approvalId,
          operatorId: "chaty"
        },
        {
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
          executorMode: "disabled",
          now: () => new Date("2026-06-01T01:13:00.000Z"),
          serviceSnapshot: service
        }
      );

      assert.equal(execution.state, "blocked");
      assert.equal(execution.blockReason, "executor-not-armed");
      assert.equal(commands.length, 0, "disabled executor mode must never spawn");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps the default LaunchAgent executor alive when child pipes emit errors", async () => {
    const projectRoot = await createTempProjectRoot();
    const spawnedChildren: TMutableFakeChildProcess[] = [];

    try {
      const service = await createArmedService(projectRoot);
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart through default executor"
        },
        {
          now: () => new Date("2026-06-01T01:21:00.000Z"),
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
          now: () => new Date("2026-06-01T01:22:00.000Z")
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
          executorMode: "armed",
          launchAgentSpawn: (command, args) => {
            const child = createFakeSpawnedChild();
            spawnedChildren.push(child);
            assert.equal(command, "/bin/zsh");
            assert.deepEqual(args, ["-lc", request.command]);
            queueMicrotask(() => {
              child.stdout.emit("error", new Error("simulated stdout pipe error"));
              child.stderr.emit("error", new Error("simulated stderr pipe error"));
              child.stdout.write("ok");
              child.stdout.end();
              child.stderr.end();
              child.emit("close", 0);
            });
            return child as unknown as ChildProcess;
          },
          now: () => new Date("2026-06-01T01:23:00.000Z"),
          serviceSnapshot: service
        }
      );

      assert.equal(execution.state, "executed");
      assert.equal(execution.safety.serviceMutationExecuted, true);
      assert.equal(spawnedChildren.length, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("finishes a LaunchAgent command after exit even when descendant pipes stay open", async () => {
    const projectRoot = await createTempProjectRoot();
    const spawnedChildren: TMutableFakeChildProcess[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const service = await createArmedService(projectRoot);
      const request = await requestNeonNodeRunnerServiceAction(
        projectRoot,
        {
          action: "restart",
          operatorId: "chaty",
          reason: "restart through default executor"
        },
        {
          now: () => new Date("2026-06-01T01:31:00.000Z"),
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
          now: () => new Date("2026-06-01T01:32:00.000Z")
        }
      );
      const executionPromise = executeNeonNodeRunnerServiceAction(
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
          executorMode: "armed",
          launchAgentSpawn: () => {
            const child = createFakeSpawnedChild();
            spawnedChildren.push(child);
            queueMicrotask(() => {
              child.stdout.write("before-exit\n");
              child.emit("exit", 0);
              setTimeout(() => {
                child.stdout.write("after-exit\n");
              }, 10);
            });
            return child as unknown as ChildProcess;
          },
          now: () => new Date("2026-06-01T01:33:00.000Z"),
          serviceSnapshot: service
        }
      );
      const execution = await Promise.race([
        executionPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("LaunchAgent command did not settle after child exit"));
          }, 750);
        })
      ]);

      assert.equal(execution.state, "executed");
      assert.equal(execution.safety.serviceMutationExecuted, true);
      assert.equal(spawnedChildren.length, 1);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

type TMutableFakeChildProcess = EventEmitter & {
  killed: boolean;
  kill: () => boolean;
  stderr: PassThrough;
  stdin: PassThrough;
  stdout: PassThrough;
};

function createFakeSpawnedChild(): TMutableFakeChildProcess {
  const child = new EventEmitter() as TMutableFakeChildProcess;
  child.killed = false;
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {
    child.killed = true;
    return true;
  };

  return child;
}

async function createArmedService(projectRoot: string) {
  await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
  await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
  await writeNeonNodeRunnerControl(
    projectRoot,
    {
      desiredState: "running",
      operatorId: "chaty",
      reason: "command guard unit"
    },
    {
      now: () => new Date("2026-06-01T01:00:00.000Z")
    }
  );

  return await createNeonNodeRunnerServiceSnapshot(projectRoot, {
    now: () => new Date("2026-06-01T01:00:30.000Z"),
    env: {
      NEON_NODE_SESSION_ID: "command-guard-session",
      NEON_NODE_SESSION_SECRET: "command-guard-secret"
    },
    platform: "darwin",
    arch: "arm64",
    homeDir: join(projectRoot, "home"),
    userId: 501
  });
}

async function tamperPersistedRequestCommand(
  projectRoot: string,
  actionRequestId: string,
  command: string
): Promise<void> {
  const requestPath = resolveNeonNodeRunnerServicePaths(projectRoot).actionRequestPath;
  const raw = await readFile(requestPath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const record = JSON.parse(line) as { actionRequestId?: string };
      if (record.actionRequestId === actionRequestId) {
        return JSON.stringify({ ...record, command });
      }
      return line;
    });
  await writeFile(requestPath, `${lines.join("\n")}\n`, "utf8");
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-node-runner-command-guard-"));
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
    generatedAt: "2026-06-01T01:00:45.000Z",
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
      latestRunId: "run-command-guard-canary",
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
    requiredEvidence: ["command guard unit"],
    evidence: ["evidence"],
    recovery: state === "pass" ? [] : ["keep previous stage"],
    rollback: "Keep previous route active."
  };
}
