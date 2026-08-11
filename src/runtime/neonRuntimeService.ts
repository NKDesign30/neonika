import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { redactSnapshotText } from "../harness/redaction.js";

export type TNeonRuntimeServiceManager = "launchd" | "systemd" | "unsupported";
export type TNeonRuntimeServiceMutationGateReason = "armed" | "invalid-value" | "not-configured";

export const NEON_RUNTIME_SERVICE_MUTATIONS_ENV = "NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED" as const;
export const NEON_PREDECESSOR_STAND_DOWN_ARGV_ENV = "NEON_PREDECESSOR_STAND_DOWN_ARGV" as const;
export const NEON_PREDECESSOR_ROLLBACK_ARGV_ENV = "NEON_PREDECESSOR_ROLLBACK_ARGV" as const;

export interface INeonRuntimeServiceMutationGate {
  readonly enabled: boolean;
  readonly envKey: typeof NEON_RUNTIME_SERVICE_MUTATIONS_ENV;
  readonly reason: TNeonRuntimeServiceMutationGateReason;
}

export interface ICreateNeonRuntimeServicePlanOptions {
  readonly arch?: string;
  readonly cliPath: string;
  readonly configRoot: string;
  readonly envFilePath: string;
  readonly homeDir: string;
  readonly label?: string;
  readonly nodePath: string;
  readonly platform: string;
  readonly userId: number;
}

export interface INeonRuntimeServicePaths {
  readonly definitionPath: string;
  readonly errorLogPath: string;
  readonly logPath: string;
  readonly manifestPath: string;
  readonly operationsPath: string;
  readonly previousDefinitionPath: string;
  readonly stateRoot: string;
}

export interface INeonRuntimeServiceSafety {
  readonly secretValuesPersisted: false;
  readonly shellUsed: false;
}

export interface INeonRuntimeServicePlan {
  readonly definition: string;
  readonly label: string;
  readonly manager: TNeonRuntimeServiceManager;
  readonly paths: INeonRuntimeServicePaths;
  readonly runtime: INeonRuntimeServiceRuntime;
  readonly supported: boolean;
  readonly safety: INeonRuntimeServiceSafety;
}

export interface INeonRuntimeServiceRuntime {
  readonly cliPath: string;
  readonly configRoot: string;
  readonly envFilePath: string;
  readonly nodePath: string;
  readonly userId: number;
}

export interface INeonRuntimeServiceCommand {
  readonly args: readonly string[];
  readonly command: string;
}

export interface INeonRuntimeServiceCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface INeonRuntimeServiceExecutor {
  run(command: INeonRuntimeServiceCommand): Promise<INeonRuntimeServiceCommandResult>;
}

export interface INeonRuntimeServiceHealth {
  readonly state: "ready" | "unavailable";
  readonly statusCode?: number;
}

export interface INeonRuntimeServiceOperationSafety {
  readonly backupCreated: boolean;
  readonly definitionRemoved: boolean;
  readonly definitionWritten: boolean;
  readonly predecessorMutationExecuted: boolean;
  readonly predecessorRecoveryConfigured: boolean;
  readonly secretValuesPersisted: false;
  readonly serviceMutationExecuted: boolean;
  readonly shellUsed: false;
}

export type TNeonRuntimeServiceOperation =
  | "install"
  | "restart"
  | "rollback"
  | "uninstall"
  | "stand-down"
  | "predecessor-restore";
export type TNeonRuntimeServiceOperationState = "blocked" | "executed" | "failed" | "rolled-back";

export interface INeonRuntimeServiceOperationResult {
  readonly diagnostics: readonly string[];
  readonly health: INeonRuntimeServiceHealth;
  readonly manager: TNeonRuntimeServiceManager;
  readonly operation: TNeonRuntimeServiceOperation;
  readonly safety: INeonRuntimeServiceOperationSafety;
  readonly state: TNeonRuntimeServiceOperationState;
}

export interface IExecuteNeonRuntimeServiceOperationOptions {
  readonly executor: INeonRuntimeServiceExecutor;
  readonly gate: INeonRuntimeServiceMutationGate;
  readonly healthAbsenceProbe?: () => Promise<INeonRuntimeServiceHealth>;
  readonly healthProbe: () => Promise<INeonRuntimeServiceHealth>;
  readonly now?: () => Date;
  readonly predecessor?: {
    readonly retireGateReady: boolean;
    readonly rollbackCommand?: INeonRuntimeServiceCommand;
    readonly standDownCommand?: INeonRuntimeServiceCommand;
  };
}

export type TNeonRuntimeServiceInstallState = "installed" | "not-installed";
export type TNeonRuntimeServiceDefinitionState = "current" | "drifted" | "missing";
export type TNeonRuntimeServiceProcessState = "running" | "stopped" | "unknown";
export type TNeonRuntimeServiceEnvironmentState = "ready" | "missing" | "unsafe";
export type TNeonRuntimeServiceBlockerId =
  | "definition-drift"
  | "environment-file-missing"
  | "environment-file-unsafe"
  | "health-unavailable"
  | "not-installed"
  | "process-not-running"
  | "unsupported-platform";

export interface INeonRuntimeServiceSnapshot {
  readonly blockers: readonly TNeonRuntimeServiceBlockerId[];
  readonly definitionState: TNeonRuntimeServiceDefinitionState;
  readonly environmentState: TNeonRuntimeServiceEnvironmentState;
  readonly generatedAt: string;
  readonly health: INeonRuntimeServiceHealth;
  readonly installState: TNeonRuntimeServiceInstallState;
  readonly label: string;
  readonly manager: TNeonRuntimeServiceManager;
  readonly processState: TNeonRuntimeServiceProcessState;
  readonly rollbackAvailable: boolean;
  readonly safety: INeonRuntimeServiceSafety;
  readonly state: "blocked" | "ready";
}

export interface ICreateNeonRuntimeServiceSnapshotOptions {
  readonly executor: INeonRuntimeServiceExecutor;
  readonly healthProbe: () => Promise<INeonRuntimeServiceHealth>;
  readonly now?: () => Date;
}

export type TNeonRuntimePredecessorCommandBlocker =
  | "stand-down-command-invalid"
  | "stand-down-command-missing"
  | "rollback-command-invalid"
  | "rollback-command-missing";

export interface INeonRuntimePredecessorCommands {
  readonly blockers: readonly TNeonRuntimePredecessorCommandBlocker[];
  readonly rollbackCommand?: INeonRuntimeServiceCommand;
  readonly rollbackConfigured: boolean;
  readonly standDownCommand?: INeonRuntimeServiceCommand;
  readonly standDownConfigured: boolean;
  readonly state: "blocked" | "ready";
}

export interface INeonRuntimeServiceEnvironmentLoadResult {
  readonly loaded: true;
  readonly secretValuesReported: false;
}

export interface IProbeNeonRuntimeServiceHealthOptions {
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
}

const defaultLaunchdLabel = "com.neonika.runtime";
const defaultSystemdUnit = "neonika.service";
const launchctlPath = "/bin/launchctl";
const operationLockStaleMs = 5 * 60 * 1_000;
const systemctlPath = "/usr/bin/systemctl";

export function resolveNeonRuntimeServiceMutationGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonRuntimeServiceMutationGate {
  const value = env[NEON_RUNTIME_SERVICE_MUTATIONS_ENV]?.trim().toLowerCase();

  return {
    enabled: value === "ready",
    envKey: NEON_RUNTIME_SERVICE_MUTATIONS_ENV,
    reason: value === "ready" ? "armed" : value ? "invalid-value" : "not-configured"
  };
}

export function resolveNeonRuntimePredecessorCommands(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonRuntimePredecessorCommands {
  const blockers: TNeonRuntimePredecessorCommandBlocker[] = [];
  const standDown = parseStructuredCommandEnv(env[NEON_PREDECESSOR_STAND_DOWN_ARGV_ENV]);
  const rollback = parseStructuredCommandEnv(env[NEON_PREDECESSOR_ROLLBACK_ARGV_ENV]);

  if (standDown.state === "missing") {
    blockers.push("stand-down-command-missing");
  } else if (standDown.state === "invalid") {
    blockers.push("stand-down-command-invalid");
  }
  if (rollback.state === "missing") {
    blockers.push("rollback-command-missing");
  } else if (rollback.state === "invalid") {
    blockers.push("rollback-command-invalid");
  }

  return {
    blockers,
    ...(rollback.command ? { rollbackCommand: rollback.command } : {}),
    rollbackConfigured: rollback.command !== undefined,
    ...(standDown.command ? { standDownCommand: standDown.command } : {}),
    standDownConfigured: standDown.command !== undefined,
    state: blockers.length === 0 ? "ready" : "blocked"
  };
}

export async function loadNeonRuntimeServiceEnvironmentFile(
  path: string
): Promise<INeonRuntimeServiceEnvironmentLoadResult> {
  const resolvedPath = resolve(path);
  await assertPrivateRegularFile(resolvedPath, 0o600, "runtime environment file");
  process.loadEnvFile(resolvedPath);
  return {
    loaded: true,
    secretValuesReported: false
  };
}

export function createNeonRuntimeServicePlan(
  options: ICreateNeonRuntimeServicePlanOptions
): INeonRuntimeServicePlan {
  const manager = resolveManager(options.platform);
  const label = resolveServiceLabel(manager, options.label);
  const paths = resolveServicePaths(options, manager, label);
  const definition =
    manager === "launchd"
      ? renderLaunchdDefinition(options, paths, label)
      : manager === "systemd"
        ? renderSystemdDefinition(options, paths)
        : "";

  return {
    definition,
    label,
    manager,
    paths,
    runtime: {
      cliPath: resolve(options.cliPath),
      configRoot: resolve(options.configRoot),
      envFilePath: resolve(options.envFilePath),
      nodePath: resolve(options.nodePath),
      userId: options.userId
    },
    supported: manager !== "unsupported",
    safety: {
      secretValuesPersisted: false,
      shellUsed: false
    }
  };
}

export function createNeonRuntimeServiceExecutor(): INeonRuntimeServiceExecutor {
  return {
    run: async (command) => {
      validateStructuredCommand(command);
      return await new Promise<INeonRuntimeServiceCommandResult>((resolveResult) => {
        execFile(
          command.command,
          [...command.args],
          {
            encoding: "utf8",
            maxBuffer: 256 * 1024,
            timeout: 30_000
          },
          (error, stdout, stderr) => {
            resolveResult({
              exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
              stderr,
              stdout
            });
          }
        );
      });
    }
  };
}

export async function probeNeonRuntimeServiceHealth(
  url: string,
  options: IProbeNeonRuntimeServiceHealthOptions = {}
): Promise<INeonRuntimeServiceHealth> {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  ) {
    throw new Error("runtime service health probe requires a loopback HTTP URL");
  }
  const attempts = options.attempts ?? 15;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new Error("runtime service health probe attempts must be between 1 and 120");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error("runtime service health probe retry delay must be between 0 and 30000 ms");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("runtime service health probe timeout must be between 100 and 30000 ms");
  }

  let lastStatusCode: number | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs)
      });
      lastStatusCode = response.status;
      await response.body?.cancel();
      if (response.status === 200) {
        return { state: "ready", statusCode: 200 };
      }
    } catch {
      lastStatusCode = undefined;
    }
    if (attempt < attempts && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
  }
  return {
    state: "unavailable",
    ...(lastStatusCode !== undefined ? { statusCode: lastStatusCode } : {})
  };
}

export async function waitForNeonRuntimeServiceHealthUnavailable(
  url: string,
  options: IProbeNeonRuntimeServiceHealthOptions = {}
): Promise<INeonRuntimeServiceHealth> {
  const attempts = options.attempts ?? 30;
  const retryDelayMs = options.retryDelayMs ?? 250;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120) {
    throw new Error("runtime service health absence attempts must be between 1 and 120");
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
    throw new Error("runtime service health absence retry delay must be between 0 and 30000 ms");
  }
  let lastHealth: INeonRuntimeServiceHealth = { state: "unavailable" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastHealth = await probeNeonRuntimeServiceHealth(url, {
      attempts: 1,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    });
    if (lastHealth.state === "unavailable") {
      return lastHealth;
    }
    if (attempt < attempts && retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
  }
  return lastHealth;
}

export async function executeNeonRuntimeServiceOperation(
  plan: INeonRuntimeServicePlan,
  operation: TNeonRuntimeServiceOperation,
  options: IExecuteNeonRuntimeServiceOperationOptions
): Promise<INeonRuntimeServiceOperationResult> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  if (!options.gate.enabled) {
    return {
      diagnostics: [`runtime service ${operation} blocked: ${options.gate.reason}`],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation,
      safety: operationSafety(),
      state: "blocked"
    };
  }
  if (!plan.supported) {
    return {
      diagnostics: [`runtime service ${operation} blocked: unsupported platform`],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation,
      safety: operationSafety(),
      state: "blocked"
    };
  }

  let lock: Awaited<ReturnType<typeof open>>;
  try {
    await validateConfigRoot(plan.runtime.configRoot);
    if (operation === "install" || operation === "restart") {
      await validateRuntimeInputs(plan);
    }
    await ensurePrivateStateRoot(plan.paths.stateRoot);
    lock = await acquireOperationLock(
      join(plan.paths.stateRoot, "operation.lock"),
      Date.parse(at)
    );
  } catch (error) {
    return createRuntimeServiceFailureResult(plan, operation, error);
  }

  try {
    if (operation === "restart") {
      return await restartRuntimeService(plan, options, at);
    }
    if (operation === "rollback") {
      return await rollbackRuntimeService(plan, options, at);
    }
    if (operation === "uninstall") {
      return await uninstallRuntimeService(plan, options, at);
    }
    if (operation === "stand-down") {
      return await standDownPredecessor(plan, options, at);
    }
    if (operation === "predecessor-restore") {
      return await restorePredecessor(plan, options, at);
    }
    const previousDefinition = await readExistingServiceDefinition(plan.paths.definitionPath);
    if (previousDefinition === undefined && options.healthAbsenceProbe) {
      const preflightHealth = await probeHealthSafely(options.healthAbsenceProbe);
      if (preflightHealth.state === "ready") {
        return await blockRuntimeServiceInstall(
          plan,
          at,
          preflightHealth,
          "runtime service install blocked: health endpoint is already occupied"
        );
      }
    }
    let supervisorStopHandled = false;
    if (previousDefinition !== undefined && options.healthAbsenceProbe) {
      supervisorStopHandled = true;
      const statusCommand = serviceStatusCommand(plan);
      const stopCommand = serviceStopCommand(plan);
      const supervisorRunning = statusCommand
        ? (await options.executor.run(statusCommand)).exitCode === 0
        : false;
      if (supervisorRunning && stopCommand) {
        await runRequiredCommand(options.executor, stopCommand, plan.manager === "launchd" ? 20 : 1);
      }
      const stoppedHealth = await probeHealthSafely(options.healthAbsenceProbe);
      if (stoppedHealth.state === "ready") {
        if (supervisorRunning) {
          return await recoverBlockedRuntimeServiceUpdate(plan, options, at);
        }
        return await blockRuntimeServiceInstall(
          plan,
          at,
          stoppedHealth,
          "runtime service update blocked: previous health endpoint did not stop"
        );
      }
    }
    if (previousDefinition !== undefined) {
      await writePrivateFileAtomically(plan.paths.previousDefinitionPath, previousDefinition);
      const stopCommand = serviceStopCommand(plan);
      if (stopCommand && !supervisorStopHandled) {
        await options.executor.run(stopCommand);
      }
    }
    await mkdir(dirname(plan.paths.definitionPath), { recursive: true });
    await writePrivateFileAtomically(plan.paths.definitionPath, `${plan.definition}\n`);
    const commands = installCommands(plan);
    try {
      await runInstallCommands(plan, options.executor);
    } catch {
      return await recoverFailedInstall(plan, options, at, previousDefinition);
    }
    const health = await probeHealthSafely(options.healthProbe);
    if (health.state !== "ready") {
      return await recoverFailedInstall(plan, options, at, previousDefinition);
    }
    await writeServiceManifest(plan, {
      at,
      currentDefinition: `${plan.definition}\n`,
      ...(previousDefinition !== undefined ? { previousDefinition } : {})
    });
    const safety: INeonRuntimeServiceOperationSafety = {
      backupCreated: previousDefinition !== undefined,
      definitionRemoved: false,
      definitionWritten: true,
      predecessorMutationExecuted: false,
      predecessorRecoveryConfigured: false,
      secretValuesPersisted: false,
      serviceMutationExecuted: commands.length > 0,
      shellUsed: false
    };
    await appendOperationEvidence(plan, {
      at,
      health,
      operation,
      safety,
      state: "executed"
    });

    return {
      diagnostics: ["runtime service definition installed and health verified"],
      health,
      manager: plan.manager,
      operation,
      safety,
      state: "executed"
    };
  } catch (error) {
    const diagnostics = [`runtime service ${operation} failed: ${redactRuntimeServiceDiagnostic(readErrorMessage(error))}`];
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation,
      safety: {
        backupCreated: false,
        definitionRemoved: false,
        definitionWritten: false,
        predecessorMutationExecuted: false,
        predecessorRecoveryConfigured: false,
        secretValuesPersisted: false,
        serviceMutationExecuted: false,
        shellUsed: false
      },
      state: "failed"
    });
    return {
      diagnostics,
      health: { state: "unavailable" },
      manager: plan.manager,
      operation,
      safety: operationSafety(),
      state: "failed"
    };
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(join(plan.paths.stateRoot, "operation.lock"), { force: true });
    }
  }
}

function createRuntimeServiceFailureResult(
  plan: INeonRuntimeServicePlan,
  operation: TNeonRuntimeServiceOperation,
  error: unknown
): INeonRuntimeServiceOperationResult {
  return {
    diagnostics: [
      `runtime service ${operation} failed: ${redactRuntimeServiceDiagnostic(readErrorMessage(error))}`
    ],
    health: { state: "unavailable" },
    manager: plan.manager,
    operation,
    safety: operationSafety(),
    state: "failed"
  };
}

async function recoverBlockedRuntimeServiceUpdate(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string
): Promise<INeonRuntimeServiceOperationResult> {
  await runInstallCommands(plan, options.executor);
  const health = await probeHealthSafely(options.healthProbe);
  const recovered = health.state === "ready";
  const safety: INeonRuntimeServiceOperationSafety = {
    ...operationSafety(),
    serviceMutationExecuted: true
  };
  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "install",
    safety,
    state: recovered ? "rolled-back" : "failed"
  });
  return {
    diagnostics: [recovered
      ? "runtime service update blocked because the previous endpoint did not stop; previous service restored"
      : "runtime service update blocked and previous service recovery failed"],
    health,
    manager: plan.manager,
    operation: "install",
    safety,
    state: recovered ? "rolled-back" : "failed"
  };
}

async function blockRuntimeServiceInstall(
  plan: INeonRuntimeServicePlan,
  at: string,
  health: INeonRuntimeServiceHealth,
  diagnostic: string
): Promise<INeonRuntimeServiceOperationResult> {
  const safety = operationSafety();
  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "install",
    safety,
    state: "blocked"
  });
  return {
    diagnostics: [diagnostic],
    health,
    manager: plan.manager,
    operation: "install",
    safety,
    state: "blocked"
  };
}

async function recoverFailedInstall(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string,
  previousDefinition: string | undefined
): Promise<INeonRuntimeServiceOperationResult> {
  const stopCommand = serviceStopCommand(plan);
  if (stopCommand) {
    await options.executor.run(stopCommand);
  }
  if (previousDefinition === undefined) {
    await rm(plan.paths.definitionPath, { force: true });
    const safety: INeonRuntimeServiceOperationSafety = {
      backupCreated: false,
      definitionRemoved: true,
      definitionWritten: true,
      predecessorMutationExecuted: false,
      predecessorRecoveryConfigured: false,
      secretValuesPersisted: false,
      serviceMutationExecuted: true,
      shellUsed: false
    };
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation: "install",
      safety,
      state: "rolled-back"
    });
    return {
      diagnostics: ["runtime service install failed health verification and was removed"],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation: "install",
      safety,
      state: "rolled-back"
    };
  }

  await writePrivateFileAtomically(plan.paths.previousDefinitionPath, `${plan.definition}\n`);
  await writePrivateFileAtomically(plan.paths.definitionPath, previousDefinition);
  await runInstallCommands(plan, options.executor);
  const recoveryHealth = await probeHealthSafely(options.healthProbe);
  const recovered = recoveryHealth.state === "ready";
  if (recovered) {
    await writeServiceManifest(plan, {
      at,
      currentDefinition: previousDefinition,
      previousDefinition: `${plan.definition}\n`
    });
  }
  const safety: INeonRuntimeServiceOperationSafety = {
    backupCreated: true,
    definitionRemoved: false,
    definitionWritten: true,
    predecessorMutationExecuted: false,
    predecessorRecoveryConfigured: false,
    secretValuesPersisted: false,
    serviceMutationExecuted: true,
    shellUsed: false
  };
  await appendOperationEvidence(plan, {
    at,
    health: recoveryHealth,
    operation: "install",
    safety,
    state: recovered ? "rolled-back" : "failed"
  });
  return {
    diagnostics: [
      recovered
        ? "runtime service update failed health verification; previous service restored"
        : "runtime service update and automatic recovery both failed health verification"
    ],
    health: recoveryHealth,
    manager: plan.manager,
    operation: "install",
    safety,
    state: recovered ? "rolled-back" : "failed"
  };
}

export async function createNeonRuntimeServiceSnapshot(
  plan: INeonRuntimeServicePlan,
  options: ICreateNeonRuntimeServiceSnapshotOptions
): Promise<INeonRuntimeServiceSnapshot> {
  const definition = await inspectServiceDefinition(plan.paths.definitionPath);
  const installState: TNeonRuntimeServiceInstallState = definition.content === undefined && !definition.unsafe
    ? "not-installed"
    : "installed";
  const definitionState: TNeonRuntimeServiceDefinitionState =
    definition.unsafe
      ? "drifted"
      : definition.content === undefined
      ? "missing"
      : definition.content === `${plan.definition}\n`
        ? "current"
        : "drifted";
  const environmentState = await readEnvironmentState(plan.runtime.envFilePath);
  const rollbackAvailable = await privateRegularFileExists(plan.paths.previousDefinitionPath);
  const statusCommand = serviceStatusCommand(plan);
  const processState: TNeonRuntimeServiceProcessState = statusCommand
    ? (await options.executor.run(statusCommand)).exitCode === 0
      ? "running"
      : "stopped"
    : "unknown";
  const health =
    processState === "running"
      ? await probeHealthSafely(options.healthProbe)
      : { state: "unavailable" as const };
  const blockers = createSnapshotBlockers({
    definitionState,
    environmentState,
    health,
    installState,
    processState,
    supported: plan.supported
  });

  return {
    blockers,
    definitionState,
    environmentState,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    health,
    installState,
    label: plan.label,
    manager: plan.manager,
    processState,
    rollbackAvailable,
    safety: plan.safety,
    state: blockers.length === 0 ? "ready" : "blocked"
  };
}

export function renderNeonRuntimeServiceReport(snapshot: INeonRuntimeServiceSnapshot): string {
  return [
    `Neonika Runtime Service: ${snapshot.state}`,
    `Manager: ${snapshot.manager}`,
    `Install: ${snapshot.installState}`,
    `Definition: ${snapshot.definitionState}`,
    `Environment: ${snapshot.environmentState}`,
    `Process: ${snapshot.processState}`,
    `Health: ${snapshot.health.state}${snapshot.health.statusCode ? ` (${snapshot.health.statusCode})` : ""}`,
    `Rollback: ${snapshot.rollbackAvailable ? "available" : "unavailable"}`,
    `Secrets persisted: ${snapshot.safety.secretValuesPersisted}`,
    `Shell used: ${snapshot.safety.shellUsed}`,
    `Blockers: ${snapshot.blockers.length > 0 ? snapshot.blockers.join(", ") : "none"}`
  ].join("\n");
}

export function renderNeonRuntimeServiceOperationReport(result: INeonRuntimeServiceOperationResult): string {
  return [
    `Neonika Runtime Service Operation: ${result.state}`,
    `Operation: ${result.operation}`,
    `Manager: ${result.manager}`,
    `Health: ${result.health.state}${result.health.statusCode ? ` (${result.health.statusCode})` : ""}`,
    `Definition written: ${result.safety.definitionWritten}`,
    `Definition removed: ${result.safety.definitionRemoved}`,
    `Backup created: ${result.safety.backupCreated}`,
    `Service mutation executed: ${result.safety.serviceMutationExecuted}`,
    `Predecessor mutation executed: ${result.safety.predecessorMutationExecuted}`,
    `Predecessor recovery configured: ${result.safety.predecessorRecoveryConfigured}`,
    `Secrets persisted: ${result.safety.secretValuesPersisted}`,
    `Shell used: ${result.safety.shellUsed}`,
    `Diagnostics: ${result.diagnostics.join("; ")}`
  ].join("\n");
}

function resolveManager(platform: string): TNeonRuntimeServiceManager {
  if (platform === "darwin") {
    return "launchd";
  }
  if (platform === "linux") {
    return "systemd";
  }
  return "unsupported";
}

function resolveServiceLabel(manager: TNeonRuntimeServiceManager, configuredLabel?: string): string {
  const label = configuredLabel?.trim() || (manager === "launchd" ? defaultLaunchdLabel : defaultSystemdUnit);
  const valid = manager === "launchd"
    ? /^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/u.test(label) && !label.includes("..")
    : /^[A-Za-z0-9:_.@-]+\.service$/u.test(label) && !label.includes("..");
  if (!valid) {
    throw new Error(`invalid ${manager} runtime service label`);
  }
  return label;
}

function resolveServicePaths(
  options: ICreateNeonRuntimeServicePlanOptions,
  manager: TNeonRuntimeServiceManager,
  label: string
): INeonRuntimeServicePaths {
  const configRoot = resolve(options.configRoot);
  const stateRoot = join(configRoot, "state", "runtime-service");
  const definitionPath =
    manager === "launchd"
      ? join(resolve(options.homeDir), "Library", "LaunchAgents", `${label}.plist`)
      : join(resolve(options.homeDir), ".config", "systemd", "user", label);

  return {
    definitionPath,
    errorLogPath: join(stateRoot, "runtime.error.log"),
    logPath: join(stateRoot, "runtime.log"),
    manifestPath: join(stateRoot, "manifest.json"),
    operationsPath: join(stateRoot, "operations.jsonl"),
    previousDefinitionPath: join(stateRoot, "previous.definition"),
    stateRoot
  };
}

function renderLaunchdDefinition(
  options: ICreateNeonRuntimeServicePlanOptions,
  paths: INeonRuntimeServicePaths,
  label: string
): string {
  const argumentsList = serviceArguments(options);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argumentsList.map((argument) => `    <string>${escapeXml(argument)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(resolve(options.configRoot))}</string>`,
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(paths.logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(paths.errorLogPath)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "</dict>",
    "</plist>"
  ].join("\n");
}

function renderSystemdDefinition(
  options: ICreateNeonRuntimeServicePlanOptions,
  paths: INeonRuntimeServicePaths
): string {
  const execStart = serviceArguments(options).map(quoteSystemdArgument).join(" ");

  return [
    "[Unit]",
    "Description=Neonika Gateway and Mission Control",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${quoteSystemdArgument(resolve(options.configRoot))}`,
    `StandardOutput=append:${quoteSystemdArgument(paths.logPath)}`,
    `StandardError=append:${quoteSystemdArgument(paths.errorLogPath)}`,
    "Restart=on-failure",
    "RestartSec=2s",
    "UMask=0077",
    "NoNewPrivileges=true",
    "",
    "[Install]",
    "WantedBy=default.target"
  ].join("\n");
}

function serviceArguments(options: ICreateNeonRuntimeServicePlanOptions): readonly string[] {
  return [
    resolve(options.nodePath),
    resolve(options.cliPath),
    "runtime-service-run",
    "--config-root",
    resolve(options.configRoot),
    "--env-file",
    resolve(options.envFilePath)
  ];
}

function quoteSystemdArgument(value: string): string {
  const escaped = value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\$/gu, () => "$$")
    .replace(/%/gu, "%%");
  return `"${escaped}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

async function validateRuntimeInputs(plan: INeonRuntimeServicePlan): Promise<void> {
  await assertPrivateRegularFile(plan.runtime.envFilePath, 0o600, "runtime environment file");
  await assertReadableRegularFile(plan.runtime.nodePath, "Node executable", true);
  await assertReadableRegularFile(plan.runtime.cliPath, "Neonika CLI");
}

async function validateConfigRoot(path: string): Promise<void> {
  const configRoot = await lstat(path);
  if (!configRoot.isDirectory() || configRoot.isSymbolicLink() || (configRoot.mode & 0o777) !== 0o700) {
    throw new Error("Neonika config root must be a real 0700 directory");
  }
}

async function assertPrivateRegularFile(path: string, mode: number, label: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== mode) {
    throw new Error(`${label} must be a real ${mode.toString(8)} file`);
  }
}

async function assertReadableRegularFile(
  path: string,
  label: string,
  requireExecutable = false
): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real file`);
  }
  await access(path, constants.R_OK | (requireExecutable ? constants.X_OK : 0));
}

async function ensurePrivateStateRoot(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("runtime service state root must be a real directory");
  }
  await chmod(path, 0o700);
}

async function acquireOperationLock(
  path: string,
  nowMs: number
): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await createOperationLock(path, nowMs);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) {
      throw error;
    }
  }

  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
    throw new Error("runtime service operation lock is unsafe");
  }
  const metadata = parseOperationLockMetadata(await readFile(path, "utf8"));
  const acquiredAtMs = metadata?.acquiredAtMs ?? stats.mtimeMs;
  if (!Number.isFinite(nowMs) || nowMs - acquiredAtMs <= operationLockStaleMs) {
    throw new Error("another runtime service operation is already in progress");
  }
  await rm(path);
  return await createOperationLock(path, nowMs);
}

async function createOperationLock(
  path: string,
  nowMs: number
): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAtMs: nowMs })}\n`, "utf8");
    await handle.sync();
    return handle;
  } catch (error) {
    try {
      await handle.close();
    } finally {
      await rm(path, { force: true });
    }
    throw error;
  }
}

function parseOperationLockMetadata(value: string): {
  readonly acquiredAtMs: number;
  readonly pid: number;
} | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      typeof parsed["acquiredAtMs"] !== "number" ||
      !Number.isFinite(parsed["acquiredAtMs"]) ||
      typeof parsed["pid"] !== "number" ||
      !Number.isInteger(parsed["pid"])
    ) {
      return undefined;
    }
    return {
      acquiredAtMs: parsed["acquiredAtMs"],
      pid: parsed["pid"]
    };
  } catch {
    return undefined;
  }
}

async function readOptionalPrivateFile(path: string, label: string): Promise<string | undefined> {
  try {
    await assertPrivateRegularFile(path, 0o600, label);
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function inspectServiceDefinition(path: string): Promise<{
  readonly content?: string;
  readonly unsafe: boolean;
}> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0) {
      return { unsafe: true };
    }
    return { content: await readFile(path, "utf8"), unsafe: false };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { unsafe: false };
    }
    throw error;
  }
}

async function readExistingServiceDefinition(path: string): Promise<string | undefined> {
  const inspected = await inspectServiceDefinition(path);
  if (inspected.unsafe) {
    throw new Error("runtime service definition must be a real non-writable regular file");
  }
  return inspected.content;
}

async function writePrivateFileAtomically(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  const temporaryPath = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(parent, { recursive: true });
  const parentStats = await lstat(parent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("private file parent must be a real directory");
  }
  try {
    await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
    const handle = await open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    const directory = await open(parent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function installCommands(plan: INeonRuntimeServicePlan): readonly INeonRuntimeServiceCommand[] {
  if (plan.manager === "launchd") {
    return [
      {
        command: launchctlPath,
        args: ["bootstrap", `gui/${plan.runtime.userId}`, plan.paths.definitionPath]
      }
    ];
  }
  if (plan.manager === "systemd") {
    return [
      { command: systemctlPath, args: ["--user", "daemon-reload"] },
      { command: systemctlPath, args: ["--user", "enable", "--now", plan.label] }
    ];
  }
  return [];
}

async function restartRuntimeService(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string
): Promise<INeonRuntimeServiceOperationResult> {
  const definition = await readExistingServiceDefinition(plan.paths.definitionPath);
  if (definition !== `${plan.definition}\n`) {
    const safety = operationSafety();
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation: "restart",
      safety,
      state: "blocked"
    });
    return {
      diagnostics: [definition === undefined
        ? "runtime service restart blocked: definition is not installed"
        : "runtime service restart blocked: definition drift detected"],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation: "restart",
      safety,
      state: "blocked"
    };
  }
  const command = restartCommand(plan);
  if (!command) {
    throw new Error("runtime service restart is unsupported");
  }
  await runRequiredCommand(options.executor, command, plan.manager === "launchd" ? 20 : 1);
  const health = await probeHealthSafely(options.healthProbe);
  const ready = health.state === "ready";
  const safety: INeonRuntimeServiceOperationSafety = {
    backupCreated: false,
    definitionRemoved: false,
    definitionWritten: false,
    predecessorMutationExecuted: false,
    predecessorRecoveryConfigured: false,
    secretValuesPersisted: false,
    serviceMutationExecuted: true,
    shellUsed: false
  };
  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "restart",
    safety,
    state: ready ? "executed" : "failed"
  });
  return {
    diagnostics: [ready
      ? "runtime service restarted and health verified"
      : "runtime service restart failed health verification"],
    health,
    manager: plan.manager,
    operation: "restart",
    safety,
    state: ready ? "executed" : "failed"
  };
}

function restartCommand(plan: INeonRuntimeServicePlan): INeonRuntimeServiceCommand | undefined {
  if (plan.manager === "launchd") {
    return {
      command: launchctlPath,
      args: ["kickstart", "-k", `gui/${plan.runtime.userId}/${plan.label}`]
    };
  }
  if (plan.manager === "systemd") {
    return {
      command: systemctlPath,
      args: ["--user", "restart", plan.label]
    };
  }
  return undefined;
}

async function rollbackRuntimeService(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string
): Promise<INeonRuntimeServiceOperationResult> {
  const [currentDefinition, previousDefinition] = await Promise.all([
    readExistingServiceDefinition(plan.paths.definitionPath),
    readOptionalPrivateFile(plan.paths.previousDefinitionPath, "previous service definition")
  ]);
  if (currentDefinition === undefined || previousDefinition === undefined) {
    const safety = operationSafety();
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation: "rollback",
      safety,
      state: "blocked"
    });
    return {
      diagnostics: ["runtime service rollback blocked: previous definition is unavailable"],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation: "rollback",
      safety,
      state: "blocked"
    };
  }
  const stopCommand = serviceStopCommand(plan);
  if (stopCommand) {
    await options.executor.run(stopCommand);
  }
  await writePrivateFileAtomically(plan.paths.definitionPath, previousDefinition);
  await writePrivateFileAtomically(plan.paths.previousDefinitionPath, currentDefinition);
  await runInstallCommands(plan, options.executor);
  const health = await probeHealthSafely(options.healthProbe);
  const ready = health.state === "ready";
  if (!ready) {
    if (stopCommand) {
      await options.executor.run(stopCommand);
    }
    await writePrivateFileAtomically(plan.paths.definitionPath, currentDefinition);
    await writePrivateFileAtomically(plan.paths.previousDefinitionPath, previousDefinition);
    await runInstallCommands(plan, options.executor);
    const recoveryHealth = await probeHealthSafely(options.healthProbe);
    const recovered = recoveryHealth.state === "ready";
    if (recovered) {
      await writeServiceManifest(plan, {
        at,
        currentDefinition,
        previousDefinition
      });
    }
    const safety: INeonRuntimeServiceOperationSafety = {
      backupCreated: true,
      definitionRemoved: false,
      definitionWritten: true,
      predecessorMutationExecuted: false,
      predecessorRecoveryConfigured: false,
      secretValuesPersisted: false,
      serviceMutationExecuted: true,
      shellUsed: false
    };
    await appendOperationEvidence(plan, {
      at,
      health: recoveryHealth,
      operation: "rollback",
      safety,
      state: recovered ? "rolled-back" : "failed"
    });
    return {
      diagnostics: [recovered
        ? "runtime service rollback target failed health verification; current service restored"
        : "runtime service rollback target and automatic recovery both failed health verification"],
      health: recoveryHealth,
      manager: plan.manager,
      operation: "rollback",
      safety,
      state: recovered ? "rolled-back" : "failed"
    };
  }
  await writeServiceManifest(plan, {
    at,
    currentDefinition: previousDefinition,
    previousDefinition: currentDefinition
  });
  const safety: INeonRuntimeServiceOperationSafety = {
    backupCreated: true,
    definitionRemoved: false,
    definitionWritten: true,
    predecessorMutationExecuted: false,
    predecessorRecoveryConfigured: false,
    secretValuesPersisted: false,
    serviceMutationExecuted: true,
    shellUsed: false
  };
  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "rollback",
    safety,
    state: "executed"
  });
  return {
    diagnostics: ["runtime service previous definition restored and health verified"],
    health,
    manager: plan.manager,
    operation: "rollback",
    safety,
    state: "executed"
  };
}

async function uninstallRuntimeService(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string
): Promise<INeonRuntimeServiceOperationResult> {
  const definition = await readExistingServiceDefinition(plan.paths.definitionPath);
  const definitionInstalled = definition !== undefined;
  let serviceMutationExecuted = false;

  if (definitionInstalled) {
    const stopCommand = uninstallCommand(plan);
    if (stopCommand) {
      const stopResult = await options.executor.run(stopCommand);
      serviceMutationExecuted = true;
      if (stopResult.exitCode !== 0) {
        const safety: INeonRuntimeServiceOperationSafety = {
          ...operationSafety(),
          serviceMutationExecuted: true
        };
        const detail = redactRuntimeServiceDiagnostic(
          stopResult.stderr.trim() || stopResult.stdout.trim() || `exit ${stopResult.exitCode}`
        );
        await appendOperationEvidence(plan, {
          at,
          health: { state: "unavailable" },
          operation: "uninstall",
          safety,
          state: "failed"
        });
        return {
          diagnostics: [`runtime service uninstall failed before definition removal: ${detail}`],
          health: { state: "unavailable" },
          manager: plan.manager,
          operation: "uninstall",
          safety,
          state: "failed"
        };
      }
    }
    await rm(plan.paths.definitionPath, { force: true });
    if (plan.manager === "systemd") {
      await runRequiredCommand(options.executor, {
        command: systemctlPath,
        args: ["--user", "daemon-reload"]
      });
    }
  }
  const safety: INeonRuntimeServiceOperationSafety = {
    backupCreated: false,
    definitionRemoved: definitionInstalled,
    definitionWritten: false,
    predecessorMutationExecuted: false,
    predecessorRecoveryConfigured: false,
    secretValuesPersisted: false,
    serviceMutationExecuted,
    shellUsed: false
  };
  const health: INeonRuntimeServiceHealth = { state: "unavailable" };
  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "uninstall",
    safety,
    state: "executed"
  });
  return {
    diagnostics: [definitionInstalled
      ? "runtime service supervisor definition removed; private audit and rollback state preserved"
      : "runtime service supervisor definition was already absent"],
    health,
    manager: plan.manager,
    operation: "uninstall",
    safety,
    state: "executed"
  };
}

async function standDownPredecessor(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string
): Promise<INeonRuntimeServiceOperationResult> {
  const predecessor = options.predecessor;
  const standDownCommand = predecessor?.standDownCommand;
  const rollbackCommand = predecessor?.rollbackCommand;
  const blockedReason = !predecessor?.retireGateReady
    ? "Retire gate is not ready"
    : !standDownCommand
      ? "stand-down command is not configured"
      : !rollbackCommand
        ? "predecessor recovery command is not configured"
        : undefined;
  if (blockedReason || !standDownCommand || !rollbackCommand) {
    const safety = operationSafety();
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation: "stand-down",
      safety,
      state: "blocked"
    });
    return {
      diagnostics: [`predecessor stand-down blocked: ${blockedReason}`],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation: "stand-down",
      safety,
      state: "blocked"
    };
  }

  validateStructuredCommand(standDownCommand);
  validateStructuredCommand(rollbackCommand);
  const standDownResult = await options.executor.run(standDownCommand);
  const baseSafety: INeonRuntimeServiceOperationSafety = {
    backupCreated: false,
    definitionRemoved: false,
    definitionWritten: false,
    predecessorMutationExecuted: true,
    predecessorRecoveryConfigured: true,
    secretValuesPersisted: false,
    serviceMutationExecuted: false,
    shellUsed: false
  };
  if (standDownResult.exitCode !== 0) {
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation: "stand-down",
      safety: baseSafety,
      state: "failed"
    });
    return {
      diagnostics: ["predecessor stand-down command failed"],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation: "stand-down",
      safety: baseSafety,
      state: "failed"
    };
  }

  const health = await probeHealthSafely(options.healthProbe);
  if (health.state !== "ready") {
    const recoveryResult = await options.executor.run(rollbackCommand);
    const recovered = recoveryResult.exitCode === 0;
    await appendOperationEvidence(plan, {
      at,
      health,
      operation: "stand-down",
      safety: baseSafety,
      state: recovered ? "rolled-back" : "failed"
    });
    return {
      diagnostics: [
        recovered
          ? "predecessor stand-down was reversed because Neonika health was unavailable"
          : "predecessor stand-down and automatic recovery both failed"
      ],
      health,
      manager: plan.manager,
      operation: "stand-down",
      safety: baseSafety,
      state: recovered ? "rolled-back" : "failed"
    };
  }

  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "stand-down",
    safety: baseSafety,
    state: "executed"
  });
  return {
    diagnostics: ["predecessor stood down after Retire readiness and Neonika health verification"],
    health,
    manager: plan.manager,
    operation: "stand-down",
    safety: baseSafety,
    state: "executed"
  };
}

async function restorePredecessor(
  plan: INeonRuntimeServicePlan,
  options: IExecuteNeonRuntimeServiceOperationOptions,
  at: string
): Promise<INeonRuntimeServiceOperationResult> {
  const rollbackCommand = options.predecessor?.rollbackCommand;
  if (!rollbackCommand) {
    const safety = operationSafety();
    await appendOperationEvidence(plan, {
      at,
      health: { state: "unavailable" },
      operation: "predecessor-restore",
      safety,
      state: "blocked"
    });
    return {
      diagnostics: ["predecessor restore blocked: recovery command is not configured"],
      health: { state: "unavailable" },
      manager: plan.manager,
      operation: "predecessor-restore",
      safety,
      state: "blocked"
    };
  }
  validateStructuredCommand(rollbackCommand);
  const commandResult = await options.executor.run(rollbackCommand);
  const health = await probeHealthSafely(options.healthProbe);
  const executed = commandResult.exitCode === 0;
  const safety: INeonRuntimeServiceOperationSafety = {
    backupCreated: false,
    definitionRemoved: false,
    definitionWritten: false,
    predecessorMutationExecuted: true,
    predecessorRecoveryConfigured: true,
    secretValuesPersisted: false,
    serviceMutationExecuted: false,
    shellUsed: false
  };
  await appendOperationEvidence(plan, {
    at,
    health,
    operation: "predecessor-restore",
    safety,
    state: executed ? "executed" : "failed"
  });
  return {
    diagnostics: [executed
      ? "predecessor recovery command executed"
      : "predecessor recovery command failed"],
    health,
    manager: plan.manager,
    operation: "predecessor-restore",
    safety,
    state: executed ? "executed" : "failed"
  };
}

function validateStructuredCommand(command: INeonRuntimeServiceCommand): void {
  if (!isAbsolute(command.command) || command.command.includes("\0") || command.command.includes("\n")) {
    throw new Error("runtime service commands require an absolute executable path");
  }
  if (command.args.length > 32) {
    throw new Error("runtime service commands support at most 32 arguments");
  }
  if (command.args.some((argument) => argument.length === 0 || argument.length > 4096 || /[\0\n]/u.test(argument))) {
    throw new Error("runtime service command arguments must be non-empty bounded single-line strings");
  }
}

function parseStructuredCommandEnv(value: string | undefined): {
  readonly command?: INeonRuntimeServiceCommand;
  readonly state: "invalid" | "missing" | "ready";
} {
  if (!value?.trim()) {
    return { state: "missing" };
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isStringArray(parsed) || parsed.length === 0) {
      return { state: "invalid" };
    }
    const [command, ...args] = parsed;
    if (!command) {
      return { state: "invalid" };
    }
    const structured: INeonRuntimeServiceCommand = { command, args };
    validateStructuredCommand(structured);
    return { command: structured, state: "ready" };
  } catch {
    return { state: "invalid" };
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uninstallCommand(plan: INeonRuntimeServicePlan): INeonRuntimeServiceCommand | undefined {
  if (plan.manager === "launchd") {
    return serviceStopCommand(plan);
  }
  if (plan.manager === "systemd") {
    return {
      command: systemctlPath,
      args: ["--user", "disable", "--now", plan.label]
    };
  }
  return undefined;
}

function serviceStopCommand(plan: INeonRuntimeServicePlan): INeonRuntimeServiceCommand | undefined {
  if (plan.manager === "launchd") {
    return {
      command: launchctlPath,
      args: ["bootout", `gui/${plan.runtime.userId}/${plan.label}`]
    };
  }
  if (plan.manager === "systemd") {
    return {
      command: systemctlPath,
      args: ["--user", "stop", plan.label]
    };
  }
  return undefined;
}

function serviceStatusCommand(plan: INeonRuntimeServicePlan): INeonRuntimeServiceCommand | undefined {
  if (plan.manager === "launchd") {
    return {
      command: launchctlPath,
      args: ["print", `gui/${plan.runtime.userId}/${plan.label}`]
    };
  }
  if (plan.manager === "systemd") {
    return {
      command: systemctlPath,
      args: ["--user", "is-active", "--quiet", plan.label]
    };
  }
  return undefined;
}

async function readEnvironmentState(path: string): Promise<TNeonRuntimeServiceEnvironmentState> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
      return "unsafe";
    }
    return "ready";
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return "missing";
    }
    return "unsafe";
  }
}

async function privateRegularFileExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o777) === 0o600;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return false;
    }
    return false;
  }
}

async function probeHealthSafely(
  probe: () => Promise<INeonRuntimeServiceHealth>
): Promise<INeonRuntimeServiceHealth> {
  try {
    return await probe();
  } catch {
    return { state: "unavailable" };
  }
}

function createSnapshotBlockers(input: {
  readonly definitionState: TNeonRuntimeServiceDefinitionState;
  readonly environmentState: TNeonRuntimeServiceEnvironmentState;
  readonly health: INeonRuntimeServiceHealth;
  readonly installState: TNeonRuntimeServiceInstallState;
  readonly processState: TNeonRuntimeServiceProcessState;
  readonly supported: boolean;
}): readonly TNeonRuntimeServiceBlockerId[] {
  const blockers: TNeonRuntimeServiceBlockerId[] = [];
  if (!input.supported) {
    blockers.push("unsupported-platform");
  }
  if (input.installState !== "installed") {
    blockers.push("not-installed");
  }
  if (input.definitionState === "drifted") {
    blockers.push("definition-drift");
  }
  if (input.environmentState === "missing") {
    blockers.push("environment-file-missing");
  } else if (input.environmentState === "unsafe") {
    blockers.push("environment-file-unsafe");
  }
  if (input.processState !== "running") {
    blockers.push("process-not-running");
  }
  if (input.health.state !== "ready") {
    blockers.push("health-unavailable");
  }
  return blockers;
}

async function runRequiredCommand(
  executor: INeonRuntimeServiceExecutor,
  command: INeonRuntimeServiceCommand,
  attempts = 1
): Promise<void> {
  let result: INeonRuntimeServiceCommandResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await executor.run(command);
    if (result.exitCode === 0) {
      return;
    }
    if (attempt < attempts) {
      await delay(100);
    }
  }
  const detail = redactRuntimeServiceDiagnostic(
    result?.stderr.trim() || result?.stdout.trim() || `exit ${result?.exitCode ?? 1}`
  );
  throw new Error(`${command.command} failed: ${detail}`);
}

async function runInstallCommands(
  plan: INeonRuntimeServicePlan,
  executor: INeonRuntimeServiceExecutor
): Promise<void> {
  for (const command of installCommands(plan)) {
    const attempts = command.command === launchctlPath && command.args[0] === "bootstrap" ? 20 : 1;
    await runRequiredCommand(executor, command, attempts);
  }
}

async function appendOperationEvidence(
  plan: INeonRuntimeServicePlan,
  input: {
    readonly at: string;
    readonly health: INeonRuntimeServiceHealth;
    readonly operation: TNeonRuntimeServiceOperation;
    readonly safety: INeonRuntimeServiceOperationSafety;
    readonly state: TNeonRuntimeServiceOperationState;
  }
): Promise<void> {
  await assertPrivateAppendTarget(plan.paths.operationsPath);
  const record = {
    version: 1,
    at: input.at,
    operation: input.operation,
    state: input.state,
    manager: plan.manager,
    label: plan.label,
    health: input.health,
    safety: input.safety
  } as const;
  await appendFile(plan.paths.operationsPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(plan.paths.operationsPath, 0o600);
}

async function assertPrivateAppendTarget(path: string): Promise<void> {
  try {
    await assertPrivateRegularFile(path, 0o600, "runtime service operation history");
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function writeServiceManifest(
  plan: INeonRuntimeServicePlan,
  input: {
    readonly at: string;
    readonly currentDefinition: string;
    readonly previousDefinition?: string;
  }
): Promise<void> {
  const manifest = {
    version: 1,
    manager: plan.manager,
    label: plan.label,
    currentDefinitionDigest: hashText(input.currentDefinition),
    previousDefinitionDigest: input.previousDefinition === undefined ? null : hashText(input.previousDefinition),
    previousDefinitionPresent: input.previousDefinition !== undefined,
    installedAt: input.at
  } as const;
  await writePrivateFileAtomically(plan.paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function operationSafety(): INeonRuntimeServiceOperationSafety {
  return {
    backupCreated: false,
    definitionRemoved: false,
    definitionWritten: false,
    predecessorMutationExecuted: false,
    predecessorRecoveryConfigured: false,
    secretValuesPersisted: false,
    serviceMutationExecuted: false,
    shellUsed: false
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactRuntimeServiceDiagnostic(value: string): string {
  return redactSnapshotText(value, { previewLimit: 512 });
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
