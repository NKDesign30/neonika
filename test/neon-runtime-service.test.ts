import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonRuntimeServiceExecutor,
  createNeonRuntimeServiceSnapshot,
  createNeonRuntimeServicePlan,
  executeNeonRuntimeServiceOperation,
  loadNeonRuntimeServiceEnvironmentFile,
  probeNeonRuntimeServiceHealth,
  renderNeonRuntimeServiceOperationReport,
  renderNeonRuntimeServiceReport,
  resolveNeonRuntimePredecessorCommands,
  resolveNeonRuntimeServiceMutationGate,
  type INeonRuntimeServiceCommand,
  type INeonRuntimeServicePlan
} from "../src/index.js";

describe("Neonika runtime service", () => {
  it("renders package-relative launchd and systemd user-service definitions without secret values", () => {
    const common = {
      cliPath: "/opt/neonika/dist/src/cli.js",
      configRoot: "/srv/neonika-private",
      envFilePath: "/run/operator/neonika.env",
      homeDir: "/home/operator",
      nodePath: "/opt/node/bin/node"
    } as const;

    const launchd = createNeonRuntimeServicePlan({ ...common, platform: "darwin", userId: 501 });
    const systemd = createNeonRuntimeServicePlan({ ...common, platform: "linux", userId: 1000 });

    assertServicePlan(launchd, "launchd", "com.neonika.runtime");
    assert.match(launchd.definition, /<key>ProgramArguments<\/key>/u);
    assert.match(launchd.definition, /<string>\/opt\/node\/bin\/node<\/string>/u);
    assert.match(launchd.definition, /<string>\/opt\/neonika\/dist\/src\/cli\.js<\/string>/u);
    assert.match(launchd.definition, /<string>runtime-service-run<\/string>/u);
    assert.match(launchd.definition, /<key>KeepAlive<\/key>/u);

    assertServicePlan(systemd, "systemd", "neonika.service");
    assert.match(systemd.definition, /^\[Service\]$/mu);
    assert.match(systemd.definition, /ExecStart=.*runtime-service-run/u);
    assert.match(systemd.definition, /Restart=on-failure/u);
    assert.match(systemd.definition, /WantedBy=default\.target/u);

    for (const plan of [launchd, systemd]) {
      assert.match(plan.definition, /\/run\/operator\/neonika\.env/u);
      assert.doesNotMatch(plan.definition, /secret-value-must-not-persist/u);
      assert.equal(plan.safety.secretValuesPersisted, false);
      assert.equal(plan.safety.shellUsed, false);
    }
  });

  it("keeps every service mutation closed until the exact ready value is present", () => {
    const missing = resolveNeonRuntimeServiceMutationGate({});
    const truthy = resolveNeonRuntimeServiceMutationGate({
      NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "true"
    });
    const armed = resolveNeonRuntimeServiceMutationGate({
      NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
    });

    assert.equal(missing.enabled, false);
    assert.equal(missing.reason, "not-configured");
    assert.equal(truthy.enabled, false);
    assert.equal(truthy.reason, "invalid-value");
    assert.equal(armed.enabled, true);
    assert.equal(armed.reason, "armed");
  });

  it("installs one private launchd definition and records only leak-safe operation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-service-"));
    const homeDir = join(root, "home");
    const configRoot = join(root, "config");
    const envFilePath = join(root, "operator.env");
    const nodePath = join(root, "bin", "node");
    const cliPath = join(root, "package", "dist", "src", "cli.js");
    const sensitiveMarker = "secret-value-must-not-persist";
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(join(root, "bin"), { recursive: true });
      await mkdir(join(root, "package", "dist", "src"), { recursive: true });
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      await writeFile(envFilePath, `NEON_DISCORD_BOT_TOKEN=${sensitiveMarker}\n`, { mode: 0o600 });
      const plan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });

      const result = await executeNeonRuntimeServiceOperation(plan, "install", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 }),
        now: () => new Date("2026-08-11T20:00:00.000Z")
      });

      assert.equal(result.state, "executed");
      assert.equal(result.operation, "install");
      assert.equal(result.health.state, "ready");
      assert.equal(result.safety.definitionWritten, true);
      assert.equal(result.safety.serviceMutationExecuted, true);
      assert.deepEqual(commands, [
        {
          command: "/bin/launchctl",
          args: ["bootstrap", "gui/501", plan.paths.definitionPath]
        }
      ]);
      assert.equal(await readFile(plan.paths.definitionPath, "utf8"), `${plan.definition}\n`);
      assert.equal((await stat(plan.paths.stateRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(plan.paths.definitionPath)).mode & 0o777, 0o600);
      assert.equal((await stat(plan.paths.manifestPath)).mode & 0o777, 0o600);
      assert.equal((await stat(plan.paths.operationsPath)).mode & 0o777, 0o600);

      const persisted = `${await readFile(plan.paths.manifestPath, "utf8")}\n${await readFile(plan.paths.operationsPath, "utf8")}`;
      assert.doesNotMatch(persisted, new RegExp(escapeRegExp(root), "u"));
      assert.doesNotMatch(persisted, new RegExp(sensitiveMarker, "u"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reports installed supervisor and HTTP health without exposing host paths or command output", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-status-"));
    const configRoot = join(root, "config");
    const envFilePath = join(root, "operator.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    const sensitiveMarker = "status-secret-must-not-leak";

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(envFilePath, `TOKEN=${sensitiveMarker}\n`, { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const plan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath,
        homeDir: join(root, "home"),
        nodePath,
        platform: "darwin",
        userId: 501
      });
      await mkdir(join(root, "home", "Library", "LaunchAgents"), { recursive: true });
      await writeFile(plan.paths.definitionPath, `${plan.definition}\n`, { mode: 0o600 });

      const snapshot = await createNeonRuntimeServiceSnapshot(plan, {
        executor: {
          run: async (command) => {
            assert.deepEqual(command, {
              command: "/bin/launchctl",
              args: ["print", "gui/501/com.neonika.runtime"]
            });
            return {
              exitCode: 0,
              stdout: `running from ${root}`,
              stderr: sensitiveMarker
            };
          }
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 }),
        now: () => new Date("2026-08-11T20:05:00.000Z")
      });
      const report = renderNeonRuntimeServiceReport(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.installState, "installed");
      assert.equal(snapshot.definitionState, "current");
      assert.equal(snapshot.processState, "running");
      assert.equal(snapshot.health.state, "ready");
      assert.equal(snapshot.rollbackAvailable, false);
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(escapeRegExp(root), "u"));
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(sensitiveMarker, "u"));
      assert.doesNotMatch(report, new RegExp(escapeRegExp(root), "u"));
      assert.doesNotMatch(report, new RegExp(sensitiveMarker, "u"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restarts an installed launchd service without rewriting its definition", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-restart-"));
    const configRoot = join(root, "config");
    const envFilePath = join(root, "operator.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(envFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const plan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath,
        homeDir: join(root, "home"),
        nodePath,
        platform: "darwin",
        userId: 501
      });
      await mkdir(join(root, "home", "Library", "LaunchAgents"), { recursive: true });
      await writeFile(plan.paths.definitionPath, `${plan.definition}\n`, { mode: 0o600 });

      const result = await executeNeonRuntimeServiceOperation(plan, "restart", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 })
      });

      assert.equal(result.state, "executed");
      assert.equal(result.operation, "restart");
      assert.equal(result.safety.definitionWritten, false);
      assert.deepEqual(commands, [
        {
          command: "/bin/launchctl",
          args: ["kickstart", "-k", "gui/501/com.neonika.runtime"]
        }
      ]);
      assert.equal(await readFile(plan.paths.definitionPath, "utf8"), `${plan.definition}\n`);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("updates an installed definition and can atomically swap back to the previous service", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-rollback-"));
    const configRoot = join(root, "config");
    const firstEnvFilePath = join(root, "first.env");
    const secondEnvFilePath = join(root, "second.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    const homeDir = join(root, "home");
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(firstEnvFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(secondEnvFilePath, "NEONIKA_PORT=8799\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const firstPlan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath: firstEnvFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });
      const secondPlan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath: secondEnvFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });
      await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
      await writeFile(firstPlan.paths.definitionPath, `${firstPlan.definition}\n`, { mode: 0o600 });
      const options = {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command: INeonRuntimeServiceCommand) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "ready" as const, statusCode: 200 })
      };

      const update = await executeNeonRuntimeServiceOperation(secondPlan, "install", options);

      assert.equal(update.state, "executed");
      assert.equal(update.safety.backupCreated, true);
      assert.equal(await readFile(secondPlan.paths.definitionPath, "utf8"), `${secondPlan.definition}\n`);
      assert.equal(await readFile(secondPlan.paths.previousDefinitionPath, "utf8"), `${firstPlan.definition}\n`);
      assert.deepEqual(commands, [
        {
          command: "/bin/launchctl",
          args: ["bootout", "gui/501/com.neonika.runtime"]
        },
        {
          command: "/bin/launchctl",
          args: ["bootstrap", "gui/501", secondPlan.paths.definitionPath]
        }
      ]);

      commands.length = 0;
      const rollback = await executeNeonRuntimeServiceOperation(secondPlan, "rollback", options);

      assert.equal(rollback.state, "executed");
      assert.equal(rollback.operation, "rollback");
      assert.equal(rollback.health.state, "ready");
      assert.equal(await readFile(secondPlan.paths.definitionPath, "utf8"), `${firstPlan.definition}\n`);
      assert.equal(await readFile(secondPlan.paths.previousDefinitionPath, "utf8"), `${secondPlan.definition}\n`);
      assert.deepEqual(commands, [
        {
          command: "/bin/launchctl",
          args: ["bootout", "gui/501/com.neonika.runtime"]
        },
        {
          command: "/bin/launchctl",
          args: ["bootstrap", "gui/501", secondPlan.paths.definitionPath]
        }
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("automatically restores the previous healthy service when an update fails its HTTP probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-recovery-"));
    const configRoot = join(root, "config");
    const firstEnvFilePath = join(root, "first.env");
    const secondEnvFilePath = join(root, "second.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    const homeDir = join(root, "home");
    const commands: INeonRuntimeServiceCommand[] = [];
    let probes = 0;

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(firstEnvFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(secondEnvFilePath, "NEONIKA_PORT=8799\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const firstPlan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath: firstEnvFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });
      const secondPlan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath: secondEnvFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });
      await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
      await writeFile(firstPlan.paths.definitionPath, `${firstPlan.definition}\n`, { mode: 0o600 });

      const result = await executeNeonRuntimeServiceOperation(secondPlan, "install", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => {
          probes += 1;
          return probes === 1
            ? { state: "unavailable" }
            : { state: "ready", statusCode: 200 };
        }
      });

      assert.equal(result.state, "rolled-back");
      assert.equal(result.health.state, "ready");
      assert.equal(await readFile(secondPlan.paths.definitionPath, "utf8"), `${firstPlan.definition}\n`);
      assert.equal(await readFile(secondPlan.paths.previousDefinitionPath, "utf8"), `${secondPlan.definition}\n`);
      assert.deepEqual(commands, [
        { command: "/bin/launchctl", args: ["bootout", "gui/501/com.neonika.runtime"] },
        { command: "/bin/launchctl", args: ["bootstrap", "gui/501", secondPlan.paths.definitionPath] },
        { command: "/bin/launchctl", args: ["bootout", "gui/501/com.neonika.runtime"] },
        { command: "/bin/launchctl", args: ["bootstrap", "gui/501", secondPlan.paths.definitionPath] }
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uninstalls the supervisor definition but preserves private rollback and audit state", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-uninstall-"));
    const configRoot = join(root, "config");
    const plan = createNeonRuntimeServicePlan({
      cliPath: join(root, "missing-after-upgrade", "cli.js"),
      configRoot,
      envFilePath: join(root, "missing-after-upgrade.env"),
      homeDir: join(root, "home"),
      nodePath: join(root, "missing-after-upgrade", "node"),
      platform: "darwin",
      userId: 501
    });
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await mkdir(join(root, "home", "Library", "LaunchAgents"), { recursive: true });
      await mkdir(plan.paths.stateRoot, { mode: 0o700, recursive: true });
      await writeFile(plan.paths.definitionPath, `${plan.definition}\n`, { mode: 0o600 });
      await writeFile(plan.paths.previousDefinitionPath, "previous service\n", { mode: 0o600 });
      await writeFile(plan.paths.manifestPath, "{}\n", { mode: 0o600 });

      const result = await executeNeonRuntimeServiceOperation(plan, "uninstall", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "unavailable" })
      });

      assert.equal(result.state, "executed");
      assert.equal(result.operation, "uninstall");
      assert.equal(result.safety.definitionRemoved, true);
      assert.deepEqual(commands, [
        {
          command: "/bin/launchctl",
          args: ["bootout", "gui/501/com.neonika.runtime"]
        }
      ]);
      await assert.rejects(readFile(plan.paths.definitionPath, "utf8"), /ENOENT/u);
      assert.equal(await readFile(plan.paths.previousDefinitionPath, "utf8"), "previous service\n");
      assert.equal(await readFile(plan.paths.manifestPath, "utf8"), "{}\n");
      assert.match(await readFile(plan.paths.operationsPath, "utf8"), /"operation":"uninstall"/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the definition installed when the supervisor refuses to stop", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-uninstall-failure-"));
    const configRoot = join(root, "config");
    const plan = createNeonRuntimeServicePlan({
      cliPath: join(root, "cli.js"),
      configRoot,
      envFilePath: join(root, "runtime.env"),
      homeDir: join(root, "home"),
      nodePath: join(root, "node"),
      platform: "darwin",
      userId: 501
    });

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await mkdir(join(root, "home", "Library", "LaunchAgents"), { recursive: true });
      await writeFile(plan.paths.definitionPath, `${plan.definition}\n`, { mode: 0o600 });
      const result = await executeNeonRuntimeServiceOperation(plan, "uninstall", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async () => ({ exitCode: 5, stderr: "stop failed", stdout: "" })
        },
        healthProbe: async () => ({ state: "unavailable" })
      });

      assert.equal(result.state, "failed");
      assert.equal(result.safety.serviceMutationExecuted, true);
      assert.equal(await readFile(plan.paths.definitionPath, "utf8"), `${plan.definition}\n`);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reclaims a private stale operation lock and releases the fresh lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-stale-lock-"));
    const configRoot = join(root, "config");
    const envFilePath = join(root, "runtime.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(envFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const plan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath,
        homeDir: join(root, "home"),
        nodePath,
        platform: "darwin",
        userId: 501
      });
      await mkdir(plan.paths.stateRoot, { mode: 0o700, recursive: true });
      await writeFile(
        join(plan.paths.stateRoot, "operation.lock"),
        `${JSON.stringify({ pid: 1234, acquiredAtMs: Date.parse("2026-08-11T19:00:00.000Z") })}\n`,
        { mode: 0o600 }
      );

      const result = await executeNeonRuntimeServiceOperation(plan, "install", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async () => ({ exitCode: 0, stderr: "", stdout: "" })
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 }),
        now: () => new Date("2026-08-11T20:00:00.000Z")
      });

      assert.equal(result.state, "executed");
      await assert.rejects(
        readFile(join(plan.paths.stateRoot, "operation.lock"), "utf8"),
        /ENOENT/u
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("executes predecessor stand-down only after Retire is ready and keeps command data out of evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-stand-down-"));
    const configRoot = join(root, "config");
    const sensitiveMarker = "predecessor-command-secret-must-not-leak";
    const standDownCommand: INeonRuntimeServiceCommand = {
      command: join(root, "bin", "legacy-control"),
      args: ["stand-down", sensitiveMarker]
    };
    const rollbackCommand: INeonRuntimeServiceCommand = {
      command: join(root, "bin", "legacy-control"),
      args: ["restore"]
    };
    const commands: INeonRuntimeServiceCommand[] = [];
    let healthSamples = 0;

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      const plan = createNeonRuntimeServicePlan({
        cliPath: join(root, "unused-cli.js"),
        configRoot,
        envFilePath: join(root, "unused.env"),
        homeDir: join(root, "home"),
        nodePath: join(root, "unused-node"),
        platform: "darwin",
        userId: 501
      });
      const common = {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command: INeonRuntimeServiceCommand) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => {
          healthSamples += 1;
          return { state: "ready" as const, statusCode: 200 };
        },
        predecessorObservation: {
          delay: async () => undefined,
          intervalMs: 0,
          sampleCount: 3
        },
        predecessor: {
          rollbackCommand,
          standDownCommand
        }
      };

      const blocked = await executeNeonRuntimeServiceOperation(plan, "stand-down", {
        ...common,
        predecessor: { ...common.predecessor, retireGateReady: false }
      });
      assert.equal(blocked.state, "blocked");
      assert.equal(commands.length, 0);

      const invalidObservation = await executeNeonRuntimeServiceOperation(plan, "stand-down", {
        ...common,
        predecessor: { ...common.predecessor, retireGateReady: true },
        predecessorObservation: { sampleCount: 1 }
      });
      assert.equal(invalidObservation.state, "failed");
      assert.match(invalidObservation.diagnostics.join(" "), /sample count must be between 2 and 60/u);
      assert.equal(commands.length, 0);

      const executed = await executeNeonRuntimeServiceOperation(plan, "stand-down", {
        ...common,
        predecessor: { ...common.predecessor, retireGateReady: true }
      });
      assert.equal(executed.state, "executed");
      assert.equal(executed.operation, "stand-down");
      assert.equal(executed.safety.predecessorMutationExecuted, true);
      assert.equal(executed.safety.predecessorRecoveryConfigured, true);
      assert.deepEqual(executed.observation, {
        durationMs: 0,
        samplesPassed: 3,
        samplesRequired: 3,
        state: "ready"
      });
      assert.equal(healthSamples, 3);
      assert.deepEqual(commands, [standDownCommand]);

      const evidence = await readFile(plan.paths.operationsPath, "utf8");
      assert.match(evidence, /"samplesRequired":3/u);
      assert.match(evidence, /"samplesPassed":3/u);
      assert.match(renderNeonRuntimeServiceOperationReport(executed), /Observation: ready \(3\/3 samples, 0 ms\)/u);
      assert.doesNotMatch(evidence, new RegExp(escapeRegExp(root), "u"));
      assert.doesNotMatch(evidence, new RegExp(sensitiveMarker, "u"));
      assert.doesNotMatch(evidence, /legacy-control/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("automatically restores the predecessor when a later observation sample degrades", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-stand-down-recovery-"));
    const configRoot = join(root, "config");
    const standDownCommand: INeonRuntimeServiceCommand = {
      command: join(root, "bin", "legacy-control"),
      args: ["stand-down"]
    };
    const rollbackCommand: INeonRuntimeServiceCommand = {
      command: join(root, "bin", "legacy-control"),
      args: ["restore"]
    };
    const commands: INeonRuntimeServiceCommand[] = [];
    let healthSamples = 0;

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      const plan = createNeonRuntimeServicePlan({
        cliPath: join(root, "unused-cli.js"),
        configRoot,
        envFilePath: join(root, "unused.env"),
        homeDir: join(root, "home"),
        nodePath: join(root, "unused-node"),
        platform: "darwin",
        userId: 501
      });
      const result = await executeNeonRuntimeServiceOperation(plan, "stand-down", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => {
          healthSamples += 1;
          return healthSamples === 2
            ? { state: "unavailable" as const }
            : { state: "ready" as const, statusCode: 200 };
        },
        predecessor: {
          retireGateReady: true,
          rollbackCommand,
          standDownCommand
        },
        predecessorObservation: {
          delay: async () => undefined,
          intervalMs: 0,
          sampleCount: 3
        }
      });

      assert.equal(result.state, "rolled-back");
      assert.deepEqual(result.observation, {
        durationMs: 0,
        samplesPassed: 1,
        samplesRequired: 3,
        state: "degraded"
      });
      assert.deepEqual(commands, [standDownCommand, rollbackCommand]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores the predecessor when final operation evidence cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-stand-down-evidence-failure-"));
    const configRoot = join(root, "config");
    const standDownCommand: INeonRuntimeServiceCommand = {
      command: join(root, "bin", "legacy-control"),
      args: ["stand-down"]
    };
    const rollbackCommand: INeonRuntimeServiceCommand = {
      command: join(root, "bin", "legacy-control"),
      args: ["restore"]
    };
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      const plan = createNeonRuntimeServicePlan({
        cliPath: join(root, "unused-cli.js"),
        configRoot,
        envFilePath: join(root, "unused.env"),
        homeDir: join(root, "home"),
        nodePath: join(root, "unused-node"),
        platform: "darwin",
        userId: 501
      });
      await mkdir(plan.paths.stateRoot, { mode: 0o700, recursive: true });
      await writeFile(plan.paths.operationsPath, "", { mode: 0o600 });
      await chmod(plan.paths.operationsPath, 0o644);

      const result = await executeNeonRuntimeServiceOperation(plan, "stand-down", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 }),
        predecessor: {
          retireGateReady: true,
          rollbackCommand,
          standDownCommand
        },
        predecessorObservation: {
          delay: async () => undefined,
          intervalMs: 0,
          sampleCount: 3
        }
      });

      assert.equal(result.state, "rolled-back");
      assert.deepEqual(commands, [standDownCommand, rollbackCommand]);
      assert.match(result.diagnostics.join(" "), /operation evidence could not be persisted/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("parses structured predecessor commands and restores the fallback without a Retire prerequisite", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-predecessor-restore-"));
    const configRoot = join(root, "config");
    const executable = join(root, "bin", "legacy-control");
    const resolved = resolveNeonRuntimePredecessorCommands({
      NEON_PREDECESSOR_STAND_DOWN_ARGV: JSON.stringify([executable, "stand-down"]),
      NEON_PREDECESSOR_ROLLBACK_ARGV: JSON.stringify([executable, "restore"])
    });
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      assert.equal(resolved.state, "ready");
      assert.deepEqual(resolved.standDownCommand, {
        command: executable,
        args: ["stand-down"]
      });
      assert.deepEqual(resolved.rollbackCommand, {
        command: executable,
        args: ["restore"]
      });
      const plan = createNeonRuntimeServicePlan({
        cliPath: join(root, "unused-cli.js"),
        configRoot,
        envFilePath: join(root, "unused.env"),
        homeDir: join(root, "home"),
        nodePath: join(root, "unused-node"),
        platform: "darwin",
        userId: 501
      });
      const result = await executeNeonRuntimeServiceOperation(plan, "predecessor-restore", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 }),
        predecessor: {
          retireGateReady: false,
          ...(resolved.rollbackCommand ? { rollbackCommand: resolved.rollbackCommand } : {}),
          ...(resolved.standDownCommand ? { standDownCommand: resolved.standDownCommand } : {})
        }
      });

      assert.equal(result.state, "executed");
      assert.equal(result.operation, "predecessor-restore");
      assert.equal(result.safety.predecessorMutationExecuted, true);
      assert.deepEqual(commands, [{ command: executable, args: ["restore"] }]);
      assert.doesNotMatch(await readFile(plan.paths.operationsPath, "utf8"), /legacy-control/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("loads a real 0600 operator environment file without returning or persisting its values", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-env-"));
    const envFilePath = join(root, "runtime.env");
    const envKey = "NEON_RUNTIME_SERVICE_TEST_SECRET";
    const sensitiveMarker = "runtime-env-secret-must-not-leak";
    const previous = process.env[envKey];

    try {
      delete process.env[envKey];
      await writeFile(envFilePath, `${envKey}=${sensitiveMarker}\n`, { mode: 0o600 });
      const result = await loadNeonRuntimeServiceEnvironmentFile(envFilePath);

      assert.equal(result.loaded, true);
      assert.equal(result.secretValuesReported, false);
      assert.equal(process.env[envKey], sensitiveMarker);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sensitiveMarker, "u"));
    } finally {
      if (previous === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = previous;
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores the current definition when an explicit rollback target fails health verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-rollback-recovery-"));
    const configRoot = join(root, "config");
    const currentEnvFilePath = join(root, "current.env");
    const previousEnvFilePath = join(root, "previous.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    const homeDir = join(root, "home");
    const commands: INeonRuntimeServiceCommand[] = [];
    let probes = 0;

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(currentEnvFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(previousEnvFilePath, "NEONIKA_PORT=8799\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const currentPlan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath: currentEnvFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });
      const previousPlan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath: previousEnvFilePath,
        homeDir,
        nodePath,
        platform: "darwin",
        userId: 501
      });
      await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
      await mkdir(currentPlan.paths.stateRoot, { mode: 0o700, recursive: true });
      await writeFile(currentPlan.paths.definitionPath, `${currentPlan.definition}\n`, { mode: 0o600 });
      await writeFile(currentPlan.paths.previousDefinitionPath, `${previousPlan.definition}\n`, { mode: 0o600 });

      const result = await executeNeonRuntimeServiceOperation(currentPlan, "rollback", {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => {
          probes += 1;
          return probes === 1 ? { state: "unavailable" } : { state: "ready", statusCode: 200 };
        }
      });

      assert.equal(result.state, "rolled-back");
      assert.equal(result.health.state, "ready");
      assert.equal(await readFile(currentPlan.paths.definitionPath, "utf8"), `${currentPlan.definition}\n`);
      assert.equal(await readFile(currentPlan.paths.previousDefinitionPath, "utf8"), `${previousPlan.definition}\n`);
      assert.equal(commands.length, 4);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("uses an isolated label and absolute systemd user-manager commands for the full lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-systemd-"));
    const configRoot = join(root, "config");
    const envFilePath = join(root, "operator.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    const commands: INeonRuntimeServiceCommand[] = [];

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(envFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const plan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath,
        homeDir: join(root, "home"),
        label: "neonika-smoke.service",
        nodePath,
        platform: "linux",
        userId: 1000
      });
      const options = {
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        executor: {
          run: async (command: INeonRuntimeServiceCommand) => {
            commands.push(command);
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        healthProbe: async () => ({ state: "ready" as const, statusCode: 200 })
      };

      const install = await executeNeonRuntimeServiceOperation(plan, "install", options);
      const restart = await executeNeonRuntimeServiceOperation(plan, "restart", options);
      const uninstall = await executeNeonRuntimeServiceOperation(plan, "uninstall", options);

      assert.equal(plan.label, "neonika-smoke.service");
      assert.equal(plan.paths.definitionPath, join(root, "home", ".config", "systemd", "user", plan.label));
      assert.equal(install.state, "executed");
      assert.equal(restart.state, "executed");
      assert.equal(uninstall.state, "executed");
      assert.deepEqual(commands, [
        { command: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] },
        { command: "/usr/bin/systemctl", args: ["--user", "enable", "--now", plan.label] },
        { command: "/usr/bin/systemctl", args: ["--user", "restart", plan.label] },
        { command: "/usr/bin/systemctl", args: ["--user", "disable", "--now", plan.label] },
        { command: "/usr/bin/systemctl", args: ["--user", "daemon-reload"] }
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("runs only absolute executables in the production executor", async () => {
    const executor = createNeonRuntimeServiceExecutor();
    const result = await executor.run({ command: process.execPath, args: ["-e", "void 0"] });

    assert.equal(result.exitCode, 0);
    await assert.rejects(
      executor.run({ command: "true", args: [] }),
      /absolute executable path/u
    );
  });

  it("reports a symlinked supervisor definition as drift instead of following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-definition-symlink-"));
    const configRoot = join(root, "config");
    const envFilePath = join(root, "operator.env");
    const plan = createNeonRuntimeServicePlan({
      cliPath: join(root, "cli.js"),
      configRoot,
      envFilePath,
      homeDir: join(root, "home"),
      nodePath: join(root, "node"),
      platform: "darwin",
      userId: 501
    });

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await mkdir(join(root, "home", "Library", "LaunchAgents"), { recursive: true });
      await writeFile(envFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      const target = join(root, "untrusted.plist");
      await writeFile(target, `${plan.definition}\n`, { mode: 0o600 });
      await symlink(target, plan.paths.definitionPath);

      const snapshot = await createNeonRuntimeServiceSnapshot(plan, {
        executor: {
          run: async () => ({ exitCode: 1, stderr: "", stdout: "" })
        },
        healthProbe: async () => ({ state: "ready", statusCode: 200 })
      });

      assert.equal(snapshot.installState, "installed");
      assert.equal(snapshot.definitionState, "drifted");
      assert.ok(snapshot.blockers.includes("definition-drift"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("probes only a loopback HTTP health endpoint", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"state":"ready"}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("health test server did not expose a TCP port");
      }
      const health = await probeNeonRuntimeServiceHealth(
        `http://127.0.0.1:${address.port}/api/neon-mission-control/gateway`,
        { attempts: 1 }
      );

      assert.deepEqual(health, { state: "ready", statusCode: 200 });
      await assert.rejects(
        probeNeonRuntimeServiceHealth("https://example.com/health", { attempts: 1 }),
        /loopback HTTP URL/u
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    }
  });

  it("blocks a first install when the configured health endpoint is already occupied", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-runtime-occupied-health-"));
    const configRoot = join(root, "config");
    const envFilePath = join(root, "operator.env");
    const nodePath = join(root, "node");
    const cliPath = join(root, "cli.js");
    let supervisorCommands = 0;

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await writeFile(envFilePath, "NEONIKA_PORT=8798\n", { mode: 0o600 });
      await writeFile(nodePath, "node", { mode: 0o755 });
      await writeFile(cliPath, "cli", { mode: 0o755 });
      const plan = createNeonRuntimeServicePlan({
        cliPath,
        configRoot,
        envFilePath,
        homeDir: join(root, "home"),
        nodePath,
        platform: "darwin",
        userId: 501
      });
      const result = await executeNeonRuntimeServiceOperation(plan, "install", {
        executor: {
          run: async () => {
            supervisorCommands += 1;
            return { exitCode: 0, stderr: "", stdout: "" };
          }
        },
        gate: resolveNeonRuntimeServiceMutationGate({
          NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED: "ready"
        }),
        healthAbsenceProbe: async () => ({ state: "ready", statusCode: 200 }),
        healthProbe: async () => ({ state: "ready", statusCode: 200 })
      });

      assert.equal(result.state, "blocked");
      assert.equal(result.safety.serviceMutationExecuted, false);
      assert.equal(supervisorCommands, 0);
      await assert.rejects(readFile(plan.paths.definitionPath, "utf8"), /ENOENT/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function assertServicePlan(
  plan: INeonRuntimeServicePlan,
  manager: INeonRuntimeServicePlan["manager"],
  label: string
): void {
  assert.equal(plan.manager, manager);
  assert.equal(plan.label, label);
  assert.equal(plan.supported, true);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
