import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch as readArch, homedir, platform as readPlatform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";

import {
  createNeonNodeRunnerSnapshot,
  writeNeonNodeRunnerControl,
  type INeonNodeRunnerSnapshot
} from "./neonNodeRunner.js";
import { type TCutoverStageId } from "../core/cutover.js";
import {
  createNeonCutoverGateSnapshot,
  type INeonCutoverGateSnapshot,
  type TNeonCutoverGateState,
  type TNeonCutoverReadinessState
} from "../core/cutoverGate.js";

export type TNeonNodeRunnerServiceState = "ready" | "blocked";
export type TNeonNodeRunnerServiceInstallState = "installed" | "not-installed";
export type TNeonNodeRunnerServiceManager = "launchd" | "manual";
export type TNeonNodeRunnerServiceCommandId = "install" | "restart" | "stop" | "logs" | "status";
export type TNeonNodeRunnerServiceActionKind = "install" | "restart" | "stop" | "start-runner";
export type TNeonNodeRunnerServiceActionState = "approval-required" | "blocked";
export type TNeonNodeRunnerServiceActionSnapshotState = "empty" | "needs-approval" | "ready" | "blocked";
export type TNeonNodeRunnerServiceActionDecision = "approve" | "reject";
export type TNeonNodeRunnerServiceActionExecutionState = "executed" | "blocked";
export type TNeonNodeRunnerServiceActionExecutionBlockReason =
  | "approval-rejected"
  | "command-not-recognized"
  | "executor-not-armed"
  | "request-blocked"
  | "rollback-missing"
  | "service-blocked"
  | "service-canary-blocked"
  | "service-mutation-disabled";
export type TNeonNodeRunnerServiceExecutorMode = "disabled" | "armed";
export type TNeonNodeRunnerServiceCanaryState = "ready" | "blocked";
export type TNeonNodeRunnerServiceBlockerId =
  | "unsupported-platform"
  | "cli-not-built"
  | "missing-session-env"
  | "runner-control-stopped"
  | "launch-agent-args-drift";
export type TNeonNodeRunnerServiceCanaryBlockerId =
  | "service-blocked"
  | "credentials-missing"
  | "runner-control-stopped"
  | "rollback-missing"
  | "executor-not-armed"
  | "cutover-stage-before-canary"
  | "cutover-gate-not-ready"
  | "pending-service-approvals"
  | "blocked-service-actions"
  | "blocked-service-executions";
type TNeonNodeRunnerServiceSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface ICreateNeonNodeRunnerServiceSnapshotOptions {
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
  readonly arch?: string;
  readonly homeDir?: string;
  readonly userId?: number;
  readonly maxLogBytes?: number;
}

export interface ICreateNeonNodeRunnerServiceCanarySnapshotOptions {
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly executorMode?: TNeonNodeRunnerServiceExecutorMode;
  readonly cutoverSnapshot?: INeonCutoverGateSnapshot;
  readonly serviceSnapshot?: INeonNodeRunnerServiceSnapshot;
  readonly actionSnapshot?: INeonNodeRunnerServiceActionSnapshot;
}

export interface INeonNodeRunnerServicePaths {
  readonly projectRoot: string;
  readonly cliPath: string;
  readonly launchAgentPath: string;
  readonly envPath: string;
  readonly logPath: string;
  readonly errorLogPath: string;
  readonly actionRequestPath: string;
  readonly actionApprovalPath: string;
  readonly actionExecutionPath: string;
}

export interface INeonNodeRunnerServiceCredentials {
  readonly source: "process-env" | "operator-env-file" | "missing";
  readonly sessionIdAvailable: boolean;
  readonly sessionSecretAvailable: boolean;
  readonly envFilePresent: boolean;
  readonly envFilePath: string;
}

export interface INeonNodeRunnerServiceCommand {
  readonly id: TNeonNodeRunnerServiceCommandId;
  readonly label: string;
  readonly command: string;
  readonly mutatesSystem: boolean;
  readonly requiresApproval: boolean;
}

export interface INeonNodeRunnerServiceBlocker {
  readonly id: TNeonNodeRunnerServiceBlockerId;
  readonly summary: string;
  readonly recovery: string;
}

export interface INeonNodeRunnerServiceCanaryBlocker {
  readonly id: TNeonNodeRunnerServiceCanaryBlockerId;
  readonly summary: string;
  readonly recovery: string;
}

export interface INeonNodeRunnerServiceSafety {
  readonly installExecuted: false;
  readonly restartExecuted: false;
  readonly stopExecuted: false;
  readonly launchAgentWritten: false;
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
}

export interface INeonNodeRunnerServiceSnapshot {
  readonly state: TNeonNodeRunnerServiceState;
  readonly generatedAt: string;
  readonly label: string;
  readonly manager: TNeonNodeRunnerServiceManager;
  readonly platform: string;
  readonly arch: string;
  readonly installState: TNeonNodeRunnerServiceInstallState;
  readonly runner: INeonNodeRunnerSnapshot;
  readonly paths: INeonNodeRunnerServicePaths;
  readonly credentials: INeonNodeRunnerServiceCredentials;
  readonly blockers: readonly INeonNodeRunnerServiceBlocker[];
  readonly commands: readonly INeonNodeRunnerServiceCommand[];
  readonly launchAgentPlist: string;
  readonly logTail: string;
  readonly safety: INeonNodeRunnerServiceSafety;
}

export interface INeonNodeRunnerServiceActionRequestInput {
  readonly action: TNeonNodeRunnerServiceActionKind;
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface INeonNodeRunnerServiceActionSafety {
  readonly serviceMutationExecuted: false;
  readonly launchAgentWritten: false;
  readonly runnerControlWritten: false;
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
}

export interface INeonNodeRunnerServiceActionRequestRecord {
  readonly actionRequestId: string;
  readonly action: TNeonNodeRunnerServiceActionKind;
  readonly state: TNeonNodeRunnerServiceActionState;
  readonly approvalPolicy: "required";
  readonly command: string;
  readonly blockers: readonly TNeonNodeRunnerServiceBlockerId[];
  readonly operatorId: string;
  readonly reason?: string;
  readonly requestedAt: string;
  readonly safety: INeonNodeRunnerServiceActionSafety;
}

export interface INeonNodeRunnerServiceActionApprovalInput {
  readonly actionRequestId: string;
  readonly decision: TNeonNodeRunnerServiceActionDecision;
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface INeonNodeRunnerServiceActionApprovalSafety {
  readonly executionEnabled: false;
  readonly serviceMutationExecuted: false;
  readonly launchAgentWritten: false;
  readonly runnerControlWritten: false;
  readonly requiresCanaryGate: true;
}

export interface INeonNodeRunnerServiceActionApprovalRecord {
  readonly approvalId: string;
  readonly actionRequestId: string;
  readonly action: TNeonNodeRunnerServiceActionKind;
  readonly decision: TNeonNodeRunnerServiceActionDecision;
  readonly operatorId: string;
  readonly reason?: string;
  readonly createdAt: string;
  readonly safety: INeonNodeRunnerServiceActionApprovalSafety;
}

export interface INeonNodeRunnerServiceActionExecutionInput {
  readonly approvalId: string;
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface INeonNodeRunnerServiceActionExecutionSafety {
  readonly executionEnabled: boolean;
  readonly serviceMutationExecuted: boolean;
  readonly launchAgentWritten: boolean;
  readonly runnerControlWritten: boolean;
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
  readonly requiresCanaryGate: true;
}

export interface INeonNodeRunnerServiceActionExecutionRecord {
  readonly executionId: string;
  readonly approvalId: string;
  readonly actionRequestId: string;
  readonly action: TNeonNodeRunnerServiceActionKind;
  readonly state: TNeonNodeRunnerServiceActionExecutionState;
  readonly blockReason?: TNeonNodeRunnerServiceActionExecutionBlockReason;
  readonly command: string;
  readonly rollbackCommand?: string;
  readonly executorMode: TNeonNodeRunnerServiceExecutorMode;
  readonly operatorId: string;
  readonly reason?: string;
  readonly executedAt: string;
  readonly safety: INeonNodeRunnerServiceActionExecutionSafety;
}

export interface INeonNodeRunnerServiceActionTotals {
  readonly requests: number;
  readonly approvalRequired: number;
  readonly blocked: number;
  readonly approvals: number;
  readonly approved: number;
  readonly rejected: number;
  readonly pendingApproval: number;
  readonly executions: number;
  readonly executed: number;
  readonly blockedExecutions: number;
}

export interface INeonNodeRunnerServiceActionSnapshot {
  readonly state: TNeonNodeRunnerServiceActionSnapshotState;
  readonly generatedAt: string;
  readonly service: INeonNodeRunnerServiceSnapshot;
  readonly requests: readonly INeonNodeRunnerServiceActionRequestRecord[];
  readonly approvals: readonly INeonNodeRunnerServiceActionApprovalRecord[];
  readonly executions: readonly INeonNodeRunnerServiceActionExecutionRecord[];
  readonly totals: INeonNodeRunnerServiceActionTotals;
  readonly source: {
    readonly requestPath: string;
    readonly approvalPath: string;
    readonly executionPath: string;
  };
}

export interface INeonNodeRunnerServiceCanarySafety {
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
  readonly launchAgentWritten: false;
  readonly serviceMutationExecuted: false;
  readonly canaryMutationAllowed: boolean;
}

export interface INeonNodeRunnerServiceCanarySnapshot {
  readonly state: TNeonNodeRunnerServiceCanaryState;
  readonly generatedAt: string;
  readonly serviceState: TNeonNodeRunnerServiceState;
  readonly serviceInstallState: TNeonNodeRunnerServiceInstallState;
  readonly credentialsSource: INeonNodeRunnerServiceCredentials["source"];
  readonly runnerControl: INeonNodeRunnerSnapshot["control"]["desiredState"];
  readonly executorMode: TNeonNodeRunnerServiceExecutorMode;
  readonly rollbackConfigured: boolean;
  readonly cutoverStage: TCutoverStageId;
  readonly cutoverState: TNeonCutoverReadinessState;
  readonly currentGateState: TNeonCutoverGateState | "missing";
  readonly actionState: TNeonNodeRunnerServiceActionSnapshotState;
  readonly totals: {
    readonly serviceBlockers: number;
    readonly pendingApprovals: number;
    readonly blockedActions: number;
    readonly blockedExecutions: number;
  };
  readonly blockers: readonly INeonNodeRunnerServiceCanaryBlocker[];
  readonly safety: INeonNodeRunnerServiceCanarySafety;
}

export interface INeonNodeRunnerServiceLaunchAgentExecutor {
  writeLaunchAgent(path: string, content: string): Promise<void>;
  runCommand(command: string): Promise<INeonNodeRunnerServiceCommandResult>;
}

export interface INeonNodeRunnerServiceCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface IResolvedServiceContext {
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly platform: string;
  readonly arch: string;
  readonly userId: number;
  readonly env: NodeJS.ProcessEnv;
  readonly paths: INeonNodeRunnerServicePaths;
}

const runnerServiceLabel = "com.neon.core.node-runner";
const defaultGatewayUrl = "http://127.0.0.1:8797";
const maxLogBytesDefault = 8192;
const serviceCommandPipeIdleMs = 100;
const serviceCommandPipeMaxDrainMs = 1_000;
const serviceActionRequestFile = "node-runner-service-actions.jsonl";
const serviceActionApprovalFile = "node-runner-service-action-approvals.jsonl";
const serviceActionExecutionFile = "node-runner-service-action-executions.jsonl";
const serviceCanaryStages: readonly TCutoverStageId[] = ["canary", "primary", "retire"];

export function resolveNeonNodeRunnerServicePaths(
  projectRoot: string,
  options: {
    readonly homeDir?: string;
  } = {}
): INeonNodeRunnerServicePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, "state", "nodes");
  const home = options.homeDir ?? homedir();

  return {
    projectRoot: resolvedProjectRoot,
    cliPath: join(resolvedProjectRoot, "dist", "src", "cli.js"),
    launchAgentPath: join(home, "Library", "LaunchAgents", `${runnerServiceLabel}.plist`),
    envPath: join(stateRoot, "node-runner.env"),
    logPath: join(stateRoot, "node-runner-service.log"),
    errorLogPath: join(stateRoot, "node-runner-service.error.log"),
    actionRequestPath: join(stateRoot, serviceActionRequestFile),
    actionApprovalPath: join(stateRoot, serviceActionApprovalFile),
    actionExecutionPath: join(stateRoot, serviceActionExecutionFile)
  };
}

export async function createNeonNodeRunnerServiceSnapshot(
  projectRoot: string,
  options: ICreateNeonNodeRunnerServiceSnapshotOptions = {}
): Promise<INeonNodeRunnerServiceSnapshot> {
  const context = createServiceContext(projectRoot, options);
  const runner = await createNeonNodeRunnerSnapshot(
    context.projectRoot,
    options.now
      ? {
          now: options.now
        }
      : {}
  );
  const cliReady = await fileIsReadable(context.paths.cliPath);
  const launchAgentInstalled = await fileIsReadable(context.paths.launchAgentPath);
  const installedLaunchAgentPlist = launchAgentInstalled
    ? await readInstalledLaunchAgentPlist(context.paths.launchAgentPath)
    : undefined;
  const envFilePresent = await fileIsReadable(context.paths.envPath);
  const credentials = createServiceCredentials(context.env, context.paths.envPath, envFilePresent);
  const blockers = createServiceBlockers({
    context,
    cliReady,
    credentials,
    runner,
    ...(installedLaunchAgentPlist !== undefined ? { installedLaunchAgentPlist } : {})
  });
  const launchAgentPlist = renderNeonNodeRunnerServicePlist(context);
  const logTail = await readBoundedServiceLog(context.paths.logPath, options.maxLogBytes ?? maxLogBytesDefault);

  return {
    state: blockers.length === 0 ? "ready" : "blocked",
    generatedAt: context.generatedAt,
    label: runnerServiceLabel,
    manager: context.platform === "darwin" ? "launchd" : "manual",
    platform: context.platform,
    arch: context.arch,
    installState: launchAgentInstalled ? "installed" : "not-installed",
    runner,
    paths: context.paths,
    credentials,
    blockers,
    commands: createServiceCommands(context),
    launchAgentPlist,
    logTail,
    safety: createServiceSafety()
  };
}

export function renderNeonNodeRunnerServicePlist(
  context: IResolvedServiceContext | {
    readonly projectRoot: string;
    readonly paths: INeonNodeRunnerServicePaths;
  }
): string {
  const projectRoot = context.projectRoot;
  const paths = context.paths;
  const runnerCommand = [
    "set -a",
    `[ -f ${quoteShell(paths.envPath)} ] && . ${quoteShell(paths.envPath)}`,
    "set +a",
    `exec node ${quoteShell(paths.cliPath)} node-runner-loop`
  ].join("; ");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(runnerServiceLabel)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/zsh</string>",
    "    <string>-lc</string>",
    `    <string>${escapeXml(runnerCommand)}</string>`,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(projectRoot)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>NEON_NODE_GATEWAY_URL</key>",
    `    <string>${escapeXml(defaultGatewayUrl)}</string>`,
    "    <key>NEON_NODE_PROJECT_ROOT</key>",
    `    <string>${escapeXml(projectRoot)}</string>`,
    "    <key>NEON_NODE_RUNNER_ENV_FILE</key>",
    `    <string>${escapeXml(paths.envPath)}</string>`,
    "  </dict>",
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

export function renderNeonNodeRunnerServiceReport(snapshot: INeonNodeRunnerServiceSnapshot): string {
  const blockerLines =
    snapshot.blockers.length > 0
      ? snapshot.blockers.map((blocker) => `- ${blocker.id}: ${blocker.summary}`)
      : ["- none"];
  const commandLines = snapshot.commands.map((command) => `- ${command.id}: ${command.command}`);

  return [
    `Neon Node Runner Service: ${snapshot.state}`,
    `Manager: ${snapshot.manager}`,
    `Install: ${snapshot.installState}`,
    `Runner: ${snapshot.runner.state} / control=${snapshot.runner.control.desiredState}`,
    `Credentials: ${snapshot.credentials.source}`,
    `LaunchAgent: ${snapshot.paths.launchAgentPath}`,
    `Env file: ${snapshot.paths.envPath}`,
    `Logs: ${snapshot.paths.logPath}`,
    `Secrets persisted: ${snapshot.safety.sessionSecretPersisted || snapshot.safety.rawTokenPersisted}`,
    "Blockers:",
    ...blockerLines,
    "Commands:",
    ...commandLines
  ].join("\n");
}

export function renderNeonNodeRunnerServiceCanaryReport(snapshot: INeonNodeRunnerServiceCanarySnapshot): string {
  const blockerLines =
    snapshot.blockers.length > 0
      ? snapshot.blockers.map((blocker) => `- ${blocker.id}: ${blocker.summary}`)
      : ["- none"];

  return [
    `Neon Node Runner Service Canary: ${snapshot.state}`,
    `Service: ${snapshot.serviceState} / install=${snapshot.serviceInstallState}`,
    `Credentials: ${snapshot.credentialsSource}`,
    `Runner control: ${snapshot.runnerControl}`,
    `Executor: ${snapshot.executorMode}`,
    `Rollback configured: ${snapshot.rollbackConfigured}`,
    `Cutover: ${snapshot.cutoverStage} / ${snapshot.cutoverState} / gate=${snapshot.currentGateState}`,
    `Actions: ${snapshot.actionState} / pending=${snapshot.totals.pendingApprovals} / blocked=${snapshot.totals.blockedActions} / blocked executions=${snapshot.totals.blockedExecutions}`,
    `Canary mutation allowed: ${snapshot.safety.canaryMutationAllowed}`,
    `Secrets persisted: ${snapshot.safety.sessionSecretPersisted || snapshot.safety.rawTokenPersisted}`,
    "Blockers:",
    ...blockerLines
  ].join("\n");
}

export async function requestNeonNodeRunnerServiceAction(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
    readonly serviceSnapshot?: INeonNodeRunnerServiceSnapshot;
  } = {}
): Promise<INeonNodeRunnerServiceActionRequestRecord> {
  const normalized = parseServiceActionRequestInput(input);
  const now = options.now ?? (() => new Date());
  const requestedAt = now().toISOString();
  const service = options.serviceSnapshot ?? (await createNeonNodeRunnerServiceSnapshot(projectRoot, { now }));
  const blockers = createServiceActionBlockers(service, normalized.action);
  const record: INeonNodeRunnerServiceActionRequestRecord = {
    actionRequestId: `node-runner-service-action-${randomUUID()}`,
    action: normalized.action,
    state: blockers.length > 0 ? "blocked" : "approval-required",
    approvalPolicy: "required",
    command: createServiceActionCommand(service, normalized.action),
    blockers,
    operatorId: normalized.operatorId ?? "operator",
    ...(normalized.reason ? { reason: normalized.reason } : {}),
    requestedAt,
    safety: createServiceActionSafety()
  };

  await mkdir(dirname(service.paths.actionRequestPath), { recursive: true });
  await appendFile(service.paths.actionRequestPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function approveNeonNodeRunnerServiceAction(
  projectRoot: string,
  input: unknown,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodeRunnerServiceActionApprovalRecord> {
  const normalized = parseServiceActionApprovalInput(input);
  const [requests, approvals] = await Promise.all([
    readNeonNodeRunnerServiceActionRequests(projectRoot),
    readNeonNodeRunnerServiceActionApprovals(projectRoot)
  ]);
  const request = requests.find((entry) => entry.actionRequestId === normalized.actionRequestId);

  if (!request) {
    throw new Error("Neon Node Runner service action request not found");
  }

  if (request.state !== "approval-required") {
    throw new Error("Neon Node Runner service action request is not queued for operator approval");
  }

  if (approvals.some((approval) => approval.actionRequestId === request.actionRequestId)) {
    throw new Error("Neon Node Runner service action request already has an approval record");
  }

  const createdAt = (options.now?.() ?? new Date()).toISOString();
  const record: INeonNodeRunnerServiceActionApprovalRecord = {
    approvalId: `node-runner-service-approval-${randomUUID()}`,
    actionRequestId: request.actionRequestId,
    action: request.action,
    decision: normalized.decision,
    operatorId: normalized.operatorId ?? "operator",
    ...(normalized.reason ? { reason: normalized.reason } : {}),
    createdAt,
    safety: {
      executionEnabled: false,
      serviceMutationExecuted: false,
      launchAgentWritten: false,
      runnerControlWritten: false,
      requiresCanaryGate: true
    }
  };
  const paths = resolveNeonNodeRunnerServicePaths(projectRoot);

  await mkdir(dirname(paths.actionApprovalPath), { recursive: true });
  await appendFile(paths.actionApprovalPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function executeNeonNodeRunnerServiceAction(
  projectRoot: string,
  input: unknown,
  options: {
    readonly cutoverSnapshot?: INeonCutoverGateSnapshot;
    readonly env?: NodeJS.ProcessEnv;
    readonly executor?: INeonNodeRunnerServiceLaunchAgentExecutor;
    readonly executorMode?: TNeonNodeRunnerServiceExecutorMode;
    readonly launchAgentSpawn?: TNeonNodeRunnerServiceSpawn;
    readonly now?: () => Date;
    readonly serviceSnapshot?: INeonNodeRunnerServiceSnapshot;
  } = {}
): Promise<INeonNodeRunnerServiceActionExecutionRecord> {
  const normalized = parseServiceActionExecutionInput(input);
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const executorMode = options.executorMode ?? readServiceExecutorMode(env);
  const rollbackCommand = readOptionalText(env["NEON_CUTOVER_ROLLBACK_COMMAND"]);
  const [requests, approvals, executions, service] = await Promise.all([
    readNeonNodeRunnerServiceActionRequests(projectRoot),
    readNeonNodeRunnerServiceActionApprovals(projectRoot),
    readNeonNodeRunnerServiceActionExecutions(projectRoot),
    options.serviceSnapshot ?? createNeonNodeRunnerServiceSnapshot(projectRoot, { now })
  ]);
  const approval = approvals.find((entry) => entry.approvalId === normalized.approvalId);

  if (!approval) {
    throw new Error("Neon Node Runner service action approval not found");
  }

  if (executions.some((execution) => execution.approvalId === approval.approvalId)) {
    throw new Error("Neon Node Runner service action approval already has an execution record");
  }

  const request = requests.find((entry) => entry.actionRequestId === approval.actionRequestId);

  if (!request) {
    throw new Error("Neon Node Runner service action request not found");
  }

  const executedAt = now().toISOString();
  const operatorId = normalized.operatorId ?? "operator";
  const actionSnapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
    now,
    serviceSnapshot: service
  });
  const canary = await createNeonNodeRunnerServiceCanarySnapshot(projectRoot, {
    now,
    env,
    executorMode,
    ...(options.cutoverSnapshot ? { cutoverSnapshot: options.cutoverSnapshot } : {}),
    serviceSnapshot: service,
    actionSnapshot
  });
  const decision = await decideServiceActionExecution(projectRoot, {
    approval,
    canary,
    executedAt,
    executor:
      options.executor ??
      createDefaultLaunchAgentExecutor(options.launchAgentSpawn ? { spawnCommand: options.launchAgentSpawn } : {}),
    executorMode,
    operatorId,
    request,
    ...(rollbackCommand ? { rollbackCommand } : {}),
    service
  });
  const record: INeonNodeRunnerServiceActionExecutionRecord = {
    executionId: `node-runner-service-execution-${randomUUID()}`,
    approvalId: approval.approvalId,
    actionRequestId: request.actionRequestId,
    action: request.action,
    state: decision.state,
    ...(decision.blockReason ? { blockReason: decision.blockReason } : {}),
    command: request.command,
    ...(rollbackCommand ? { rollbackCommand } : {}),
    executorMode,
    operatorId,
    ...(normalized.reason ? { reason: normalized.reason } : {}),
    executedAt,
    safety: decision.safety
  };
  const paths = resolveNeonNodeRunnerServicePaths(projectRoot);

  await mkdir(dirname(paths.actionExecutionPath), { recursive: true });
  await appendFile(paths.actionExecutionPath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function createNeonNodeRunnerServiceActionSnapshot(
  projectRoot: string,
  options: {
    readonly now?: () => Date;
    readonly serviceSnapshot?: INeonNodeRunnerServiceSnapshot;
  } = {}
): Promise<INeonNodeRunnerServiceActionSnapshot> {
  const now = options.now ?? (() => new Date());
  const [service, requests, approvals, executions] = await Promise.all([
    options.serviceSnapshot ?? createNeonNodeRunnerServiceSnapshot(projectRoot, { now }),
    readNeonNodeRunnerServiceActionRequests(projectRoot),
    readNeonNodeRunnerServiceActionApprovals(projectRoot),
    readNeonNodeRunnerServiceActionExecutions(projectRoot)
  ]);
  const totals = summarizeServiceActions(requests, approvals, executions);

  return {
    state:
      totals.blocked > 0 || totals.blockedExecutions > 0
        ? "blocked"
        : totals.pendingApproval > 0
          ? "needs-approval"
          : totals.requests > 0 || totals.executions > 0
            ? "ready"
            : "empty",
    generatedAt: now().toISOString(),
    service,
    requests,
    approvals,
    executions,
    totals,
    source: {
      requestPath: service.paths.actionRequestPath,
      approvalPath: service.paths.actionApprovalPath,
      executionPath: service.paths.actionExecutionPath
    }
  };
}

export async function createNeonNodeRunnerServiceCanarySnapshot(
  projectRoot: string,
  options: ICreateNeonNodeRunnerServiceCanarySnapshotOptions = {}
): Promise<INeonNodeRunnerServiceCanarySnapshot> {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const service =
    options.serviceSnapshot ??
    (await createNeonNodeRunnerServiceSnapshot(projectRoot, {
      now,
      env
    }));
  const actions =
    options.actionSnapshot ??
    (await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
      now,
      serviceSnapshot: service
    }));
  const cutover =
    options.cutoverSnapshot ??
    (await createNeonCutoverGateSnapshot(projectRoot, {
      now,
      env
    }));
  const currentGate = cutover.gates.find((gate) => gate.id === cutover.currentStage);
  const currentGateState = currentGate?.state ?? "missing";
  const executorMode = options.executorMode ?? readServiceExecutorMode(env);
  const rollbackConfigured = Boolean(readOptionalText(env["NEON_CUTOVER_ROLLBACK_COMMAND"]));
  const blockers = createServiceCanaryBlockers({
    actions,
    currentGateState,
    cutover,
    executorMode,
    rollbackConfigured,
    service
  });

  return {
    state: blockers.length === 0 ? "ready" : "blocked",
    generatedAt: now().toISOString(),
    serviceState: service.state,
    serviceInstallState: service.installState,
    credentialsSource: service.credentials.source,
    runnerControl: service.runner.control.desiredState,
    executorMode,
    rollbackConfigured,
    cutoverStage: cutover.currentStage,
    cutoverState: cutover.state,
    currentGateState,
    actionState: actions.state,
    totals: {
      serviceBlockers: service.blockers.length,
      pendingApprovals: actions.totals.pendingApproval,
      blockedActions: actions.totals.blocked,
      blockedExecutions: actions.totals.blockedExecutions
    },
    blockers,
    safety: {
      rawTokenPersisted: false,
      sessionSecretPersisted: false,
      launchAgentWritten: false,
      serviceMutationExecuted: false,
      canaryMutationAllowed: executorMode === "armed" && rollbackConfigured && blockers.length === 0
    }
  };
}

export async function readNeonNodeRunnerServiceActionRequests(
  projectRoot: string
): Promise<readonly INeonNodeRunnerServiceActionRequestRecord[]> {
  return await readJsonlFile(
    resolveNeonNodeRunnerServicePaths(projectRoot).actionRequestPath,
    parseServiceActionRequestRecord
  );
}

export async function readNeonNodeRunnerServiceActionApprovals(
  projectRoot: string
): Promise<readonly INeonNodeRunnerServiceActionApprovalRecord[]> {
  return await readJsonlFile(
    resolveNeonNodeRunnerServicePaths(projectRoot).actionApprovalPath,
    parseServiceActionApprovalRecord
  );
}

export async function readNeonNodeRunnerServiceActionExecutions(
  projectRoot: string
): Promise<readonly INeonNodeRunnerServiceActionExecutionRecord[]> {
  return await readJsonlFile(
    resolveNeonNodeRunnerServicePaths(projectRoot).actionExecutionPath,
    parseServiceActionExecutionRecord
  );
}

function createServiceContext(
  projectRoot: string,
  options: ICreateNeonNodeRunnerServiceSnapshotOptions
): IResolvedServiceContext {
  const resolvedProjectRoot = resolve(projectRoot);

  return {
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    projectRoot: resolvedProjectRoot,
    platform: options.platform ?? readPlatform(),
    arch: options.arch ?? readArch(),
    userId: options.userId ?? safeUserId(),
    env: options.env ?? process.env,
    paths: resolveNeonNodeRunnerServicePaths(
      resolvedProjectRoot,
      options.homeDir
        ? {
            homeDir: options.homeDir
          }
        : {}
    )
  };
}

function createServiceActionBlockers(
  service: INeonNodeRunnerServiceSnapshot,
  action: TNeonNodeRunnerServiceActionKind
): readonly TNeonNodeRunnerServiceBlockerId[] {
  if (action === "stop") {
    return service.platform === "darwin" ? [] : ["unsupported-platform"];
  }

  if (action === "start-runner") {
    return service.credentials.source === "missing" ? ["missing-session-env"] : [];
  }

  return service.blockers.map((blocker) => blocker.id);
}

function createServiceCanaryBlockers(params: {
  readonly actions: INeonNodeRunnerServiceActionSnapshot;
  readonly currentGateState: TNeonCutoverGateState | "missing";
  readonly cutover: INeonCutoverGateSnapshot;
  readonly executorMode: TNeonNodeRunnerServiceExecutorMode;
  readonly rollbackConfigured: boolean;
  readonly service: INeonNodeRunnerServiceSnapshot;
}): readonly INeonNodeRunnerServiceCanaryBlocker[] {
  const blockers: INeonNodeRunnerServiceCanaryBlocker[] = [];

  if (params.service.credentials.source === "missing") {
    blockers.push({
      id: "credentials-missing",
      summary: "Runner service credentials are not available.",
      recovery: "Inject NEON_NODE_SESSION_ID and NEON_NODE_SESSION_SECRET via process env or the operator env file."
    });
  }

  if (params.service.runner.control.desiredState !== "running") {
    blockers.push({
      id: "runner-control-stopped",
      summary: "Runner control is not set to running.",
      recovery: "Run node dist/src/cli.js node-runner-start before arming service canary execution."
    });
  }

  const unmappedServiceBlockers = params.service.blockers.filter(
    (blocker) => blocker.id !== "missing-session-env" && blocker.id !== "runner-control-stopped"
  );
  for (const blocker of unmappedServiceBlockers) {
    blockers.push({
      id: "service-blocked",
      summary: blocker.summary,
      recovery: blocker.recovery
    });
  }

  if (!params.rollbackConfigured) {
    blockers.push({
      id: "rollback-missing",
      summary: "No rollback command is configured for service canary execution.",
      recovery: "Set NEON_CUTOVER_ROLLBACK_COMMAND before arming service mutations."
    });
  }

  if (params.executorMode !== "armed") {
    blockers.push({
      id: "executor-not-armed",
      summary: "Service executor mode is disabled.",
      recovery: "Set NEON_NODE_SERVICE_EXECUTOR_MODE=armed only for a deliberate local canary."
    });
  }

  if (!serviceCanaryStages.includes(params.cutover.currentStage)) {
    blockers.push({
      id: "cutover-stage-before-canary",
      summary: `Current cutover stage is ${params.cutover.currentStage}, not canary or later.`,
      recovery: "Keep service mutations disabled until mirror evidence unlocks canary."
    });
  }

  if (params.cutover.state !== "ready" || params.currentGateState !== "pass") {
    blockers.push({
      id: "cutover-gate-not-ready",
      summary: `Cutover gate is ${params.cutover.state} with current gate ${params.currentGateState}.`,
      recovery: "Run Doctor, mirror evidence, rollback config, and canary approval gates until the current gate passes."
    });
  }

  if (params.actions.totals.pendingApproval > 0) {
    blockers.push({
      id: "pending-service-approvals",
      summary: "Service action approvals are still pending.",
      recovery: "Approve or reject queued service actions before canary execution."
    });
  }

  if (params.actions.totals.blocked > 0) {
    blockers.push({
      id: "blocked-service-actions",
      summary: "Blocked service action requests exist.",
      recovery: "Clear the readiness blockers and request a fresh service action."
    });
  }

  if (params.actions.totals.blockedExecutions > 0) {
    blockers.push({
      id: "blocked-service-executions",
      summary: "Blocked service execution records exist.",
      recovery: "Review blocked executions before retrying a canary service mutation."
    });
  }

  return blockers;
}

function createServiceActionCommand(
  service: INeonNodeRunnerServiceSnapshot,
  action: TNeonNodeRunnerServiceActionKind
): string {
  if (action === "start-runner") {
    return "node dist/src/cli.js node-runner-start";
  }

  return service.commands.find((command) => command.id === action)?.command ?? `unsupported service action: ${action}`;
}

function serviceActionCommandIsRecognized(
  service: INeonNodeRunnerServiceSnapshot,
  request: INeonNodeRunnerServiceActionRequestRecord
): boolean {
  return request.command === createServiceActionCommand(service, request.action);
}

function createServiceActionSafety(): INeonNodeRunnerServiceActionSafety {
  return {
    serviceMutationExecuted: false,
    launchAgentWritten: false,
    runnerControlWritten: false,
    rawTokenPersisted: false,
    sessionSecretPersisted: false
  };
}

async function decideServiceActionExecution(
  projectRoot: string,
  input: {
    readonly approval: INeonNodeRunnerServiceActionApprovalRecord;
    readonly canary: INeonNodeRunnerServiceCanarySnapshot;
    readonly executedAt: string;
    readonly executor: INeonNodeRunnerServiceLaunchAgentExecutor;
    readonly executorMode: TNeonNodeRunnerServiceExecutorMode;
    readonly operatorId: string;
    readonly request: INeonNodeRunnerServiceActionRequestRecord;
    readonly rollbackCommand?: string;
    readonly service: INeonNodeRunnerServiceSnapshot;
  }
): Promise<{
  readonly state: TNeonNodeRunnerServiceActionExecutionState;
  readonly blockReason?: TNeonNodeRunnerServiceActionExecutionBlockReason;
  readonly safety: INeonNodeRunnerServiceActionExecutionSafety;
}> {
  if (input.approval.decision !== "approve") {
    return createBlockedServiceActionExecution("approval-rejected");
  }

  if (input.request.state !== "approval-required") {
    return createBlockedServiceActionExecution("request-blocked");
  }

  if (input.request.action !== "start-runner") {
    if (input.executorMode !== "armed") {
      return createBlockedServiceActionExecution("executor-not-armed");
    }

    if (!input.rollbackCommand) {
      return createBlockedServiceActionExecution("rollback-missing");
    }

    if (input.service.state !== "ready" && input.request.action !== "stop") {
      return createBlockedServiceActionExecution("service-blocked");
    }

    if (input.canary.state !== "ready" || !input.canary.safety.canaryMutationAllowed) {
      return createBlockedServiceActionExecution("service-canary-blocked");
    }

    // Last line of defense before the shell spawn: the command persisted on the
    // request record must still match the fixed service catalog for its action.
    // Requests only ever store catalog commands, but the JSONL record is parsed
    // permissively, so a tampered/forged record could otherwise route arbitrary
    // text into spawn("/bin/zsh", ["-lc", command]). Block instead of spawning.
    if (!serviceActionCommandIsRecognized(input.service, input.request)) {
      return createBlockedServiceActionExecution("command-not-recognized");
    }

    const result = await executeLaunchAgentServiceAction(input);

    if (result.exitCode !== 0) {
      return createBlockedServiceActionExecution("service-blocked");
    }

    return {
      state: "executed",
      safety: {
        executionEnabled: true,
        serviceMutationExecuted: true,
        launchAgentWritten: input.request.action === "install",
        runnerControlWritten: false,
        rawTokenPersisted: false,
        sessionSecretPersisted: false,
        requiresCanaryGate: true
      }
    };
  }

  const blockers = createServiceActionBlockers(input.service, input.request.action);

  if (blockers.length > 0) {
    return createBlockedServiceActionExecution("service-blocked");
  }

  await writeNeonNodeRunnerControl(
    projectRoot,
    {
      desiredState: "running",
      operatorId: input.operatorId,
      reason: "Approved Neon Node Runner service start action."
    },
    {
      now: () => new Date(input.executedAt)
    }
  );

  return {
    state: "executed",
    safety: {
      executionEnabled: true,
      serviceMutationExecuted: false,
      launchAgentWritten: false,
      runnerControlWritten: true,
      rawTokenPersisted: false,
      sessionSecretPersisted: false,
      requiresCanaryGate: true
    }
  };
}

async function executeLaunchAgentServiceAction(input: {
  readonly executor: INeonNodeRunnerServiceLaunchAgentExecutor;
  readonly request: INeonNodeRunnerServiceActionRequestRecord;
  readonly service: INeonNodeRunnerServiceSnapshot;
}): Promise<INeonNodeRunnerServiceCommandResult> {
  if (input.request.action === "install") {
    await input.executor.writeLaunchAgent(input.service.paths.launchAgentPath, input.service.launchAgentPlist);
    return await input.executor.runCommand(
      `launchctl bootstrap gui/${safeUserId()} ${quoteShell(input.service.paths.launchAgentPath)}`
    );
  }

  return await input.executor.runCommand(input.request.command);
}

function createBlockedServiceActionExecution(
  blockReason: TNeonNodeRunnerServiceActionExecutionBlockReason
): {
  readonly state: "blocked";
  readonly blockReason: TNeonNodeRunnerServiceActionExecutionBlockReason;
  readonly safety: INeonNodeRunnerServiceActionExecutionSafety;
} {
  return {
    state: "blocked",
    blockReason,
    safety: {
      executionEnabled: false,
      serviceMutationExecuted: false,
      launchAgentWritten: false,
      runnerControlWritten: false,
      rawTokenPersisted: false,
      sessionSecretPersisted: false,
      requiresCanaryGate: true
    }
  };
}

function createDefaultLaunchAgentExecutor(
  options: { readonly spawnCommand?: TNeonNodeRunnerServiceSpawn } = {}
): INeonNodeRunnerServiceLaunchAgentExecutor {
  return {
    writeLaunchAgent: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    },
    runCommand: async (command) => await runShellCommand(command, options)
  };
}

function runShellCommand(
  command: string,
  options: { readonly spawnCommand?: TNeonNodeRunnerServiceSpawn } = {}
): Promise<INeonNodeRunnerServiceCommandResult> {
  const spawnCommand =
    options.spawnCommand ??
    ((shellCommand: string, args: readonly string[], spawnOptions: SpawnOptions) =>
      spawn(shellCommand, args, spawnOptions));

  return awaitableCommand(command, spawnCommand);
}

function awaitableCommand(
  command: string,
  spawnCommand: TNeonNodeRunnerServiceSpawn
): Promise<INeonNodeRunnerServiceCommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawnCommand("/bin/zsh", ["-lc", command], {
      stdio: ["ignore", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let exited = false;
    let exitCode = 1;
    let idleTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const clearTimers = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    };

    const resolveOnce = (code: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      child.stdout.removeListener("data", recordStdout);
      child.stderr.removeListener("data", recordStderr);
      child.stdout.removeListener("error", recordStreamError);
      child.stderr.removeListener("error", recordStreamError);
      child.stdout.destroy();
      child.stderr.destroy();
      resolveCommand({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    };

    const armIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => resolveOnce(exitCode), serviceCommandPipeIdleMs);
    };

    const notePostExitData = () => {
      if (exited && !settled) {
        armIdleTimer();
      }
    };
    const recordStdout = (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      notePostExitData();
    };
    const recordStderr = (chunk: Buffer) => {
      stderrChunks.push(chunk);
      notePostExitData();
    };
    const recordStreamError = (error: Error) => {
      stderrChunks.push(Buffer.from(`${error.message}\n`, "utf8"));
      notePostExitData();
    };

    child.stdout.on("data", recordStdout);
    child.stderr.on("data", recordStderr);
    child.stdout.on("error", recordStreamError);
    child.stderr.on("error", recordStreamError);
    child.on("error", (error) => {
      stderrChunks.push(Buffer.from(`${error.message}\n`, "utf8"));
      resolveOnce(1);
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code ?? 1;
      deadlineTimer = setTimeout(() => resolveOnce(exitCode), serviceCommandPipeMaxDrainMs);
      armIdleTimer();
    });
    child.on("close", (code) => {
      resolveOnce(code ?? exitCode);
    });
  });
}

function readServiceExecutorMode(env: NodeJS.ProcessEnv): TNeonNodeRunnerServiceExecutorMode {
  return env["NEON_NODE_SERVICE_EXECUTOR_MODE"] === "armed" ? "armed" : "disabled";
}

function summarizeServiceActions(
  requests: readonly INeonNodeRunnerServiceActionRequestRecord[],
  approvals: readonly INeonNodeRunnerServiceActionApprovalRecord[],
  executions: readonly INeonNodeRunnerServiceActionExecutionRecord[]
): INeonNodeRunnerServiceActionTotals {
  const approvalRequestIds = new Set(approvals.map((approval) => approval.actionRequestId));
  const approvalRequired = requests.filter((request) => request.state === "approval-required").length;

  return {
    requests: requests.length,
    approvalRequired,
    blocked: requests.filter((request) => request.state === "blocked").length,
    approvals: approvals.length,
    approved: approvals.filter((approval) => approval.decision === "approve").length,
    rejected: approvals.filter((approval) => approval.decision === "reject").length,
    pendingApproval: requests.filter(
      (request) => request.state === "approval-required" && !approvalRequestIds.has(request.actionRequestId)
    ).length,
    executions: executions.length,
    executed: executions.filter((execution) => execution.state === "executed").length,
    blockedExecutions: executions.filter((execution) => execution.state === "blocked").length
  };
}

function parseServiceActionRequestInput(input: unknown): INeonNodeRunnerServiceActionRequestInput {
  if (!isRecord(input)) {
    throw new Error("Service action request must be an object");
  }

  const action = parseServiceActionKind(input["action"]);

  return {
    action,
    ...readOptionalTextFields(input, ["operatorId", "reason"])
  };
}

function parseServiceActionApprovalInput(input: unknown): INeonNodeRunnerServiceActionApprovalInput {
  if (!isRecord(input)) {
    throw new Error("Service action approval must be an object");
  }

  const actionRequestId = readRequiredText(input["actionRequestId"], "actionRequestId");
  const decision = parseServiceActionDecision(input["decision"]);

  return {
    actionRequestId,
    decision,
    ...readOptionalTextFields(input, ["operatorId", "reason"])
  };
}

function parseServiceActionExecutionInput(input: unknown): INeonNodeRunnerServiceActionExecutionInput {
  if (!isRecord(input)) {
    throw new Error("Service action execution must be an object");
  }

  const approvalId = readRequiredText(input["approvalId"], "approvalId");

  return {
    approvalId,
    ...readOptionalTextFields(input, ["operatorId", "reason"])
  };
}

function parseServiceActionRequestRecord(value: unknown): INeonNodeRunnerServiceActionRequestRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const actionRequestId = readOptionalText(value["actionRequestId"]);
  const action = parseOptionalServiceActionKind(value["action"]);
  const state =
    value["state"] === "approval-required" || value["state"] === "blocked" ? value["state"] : undefined;
  const command = readOptionalText(value["command"]);
  const operatorId = readOptionalText(value["operatorId"]);
  const requestedAt = readOptionalText(value["requestedAt"]);
  const reason = readOptionalText(value["reason"]);

  if (!actionRequestId || !action || !state || !command || !operatorId || !requestedAt) {
    return undefined;
  }

  return {
    actionRequestId,
    action,
    state,
    approvalPolicy: "required",
    command,
    blockers: parseServiceBlockerIds(value["blockers"]),
    operatorId,
    ...(reason ? { reason } : {}),
    requestedAt,
    safety: createServiceActionSafety()
  };
}

function parseServiceActionApprovalRecord(value: unknown): INeonNodeRunnerServiceActionApprovalRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const approvalId = readOptionalText(value["approvalId"]);
  const actionRequestId = readOptionalText(value["actionRequestId"]);
  const action = parseOptionalServiceActionKind(value["action"]);
  const decision = parseOptionalServiceActionDecision(value["decision"]);
  const operatorId = readOptionalText(value["operatorId"]);
  const createdAt = readOptionalText(value["createdAt"]);
  const reason = readOptionalText(value["reason"]);

  if (!approvalId || !actionRequestId || !action || !decision || !operatorId || !createdAt) {
    return undefined;
  }

  return {
    approvalId,
    actionRequestId,
    action,
    decision,
    operatorId,
    ...(reason ? { reason } : {}),
    createdAt,
    safety: {
      executionEnabled: false,
      serviceMutationExecuted: false,
      launchAgentWritten: false,
      runnerControlWritten: false,
      requiresCanaryGate: true
    }
  };
}

function parseServiceActionExecutionRecord(value: unknown): INeonNodeRunnerServiceActionExecutionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const executionId = readOptionalText(value["executionId"]);
  const approvalId = readOptionalText(value["approvalId"]);
  const actionRequestId = readOptionalText(value["actionRequestId"]);
  const action = parseOptionalServiceActionKind(value["action"]);
  const state = parseOptionalServiceActionExecutionState(value["state"]);
  const command = readOptionalText(value["command"]);
  const executorMode = parseOptionalServiceExecutorMode(value["executorMode"]) ?? "disabled";
  const operatorId = readOptionalText(value["operatorId"]);
  const executedAt = readOptionalText(value["executedAt"]);
  const reason = readOptionalText(value["reason"]);
  const rollbackCommand = readOptionalText(value["rollbackCommand"]);
  const blockReason = parseOptionalServiceActionExecutionBlockReason(value["blockReason"]);
  const safety = parseServiceActionExecutionSafety(value["safety"]);

  if (!executionId || !approvalId || !actionRequestId || !action || !state || !command || !operatorId || !executedAt) {
    return undefined;
  }

  return {
    executionId,
    approvalId,
    actionRequestId,
    action,
    state,
    ...(blockReason ? { blockReason } : {}),
    command,
    ...(rollbackCommand ? { rollbackCommand } : {}),
    executorMode,
    operatorId,
    ...(reason ? { reason } : {}),
    executedAt,
    safety
  };
}

async function readJsonlFile<T>(path: string, parseRecord: (value: unknown) => T | undefined): Promise<readonly T[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => parseJsonLine(line))
      .flatMap((value) => {
        const record = parseRecord(value);
        return record ? [record] : [];
      });
  } catch {
    return [];
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function parseServiceActionKind(value: unknown): TNeonNodeRunnerServiceActionKind {
  const action = parseOptionalServiceActionKind(value);

  if (!action) {
    throw new Error("Unsupported Neon Node Runner service action");
  }

  return action;
}

function parseOptionalServiceActionKind(value: unknown): TNeonNodeRunnerServiceActionKind | undefined {
  return value === "install" || value === "restart" || value === "stop" || value === "start-runner"
    ? value
    : undefined;
}

function parseServiceActionDecision(value: unknown): TNeonNodeRunnerServiceActionDecision {
  const decision = parseOptionalServiceActionDecision(value);

  if (!decision) {
    throw new Error("Unsupported Neon Node Runner service action decision");
  }

  return decision;
}

function parseOptionalServiceActionDecision(value: unknown): TNeonNodeRunnerServiceActionDecision | undefined {
  return value === "approve" || value === "reject" ? value : undefined;
}

function parseOptionalServiceActionExecutionState(value: unknown): TNeonNodeRunnerServiceActionExecutionState | undefined {
  return value === "executed" || value === "blocked" ? value : undefined;
}

function parseOptionalServiceActionExecutionBlockReason(
  value: unknown
): TNeonNodeRunnerServiceActionExecutionBlockReason | undefined {
  return value === "approval-rejected" ||
    value === "command-not-recognized" ||
    value === "executor-not-armed" ||
    value === "request-blocked" ||
    value === "rollback-missing" ||
    value === "service-blocked" ||
    value === "service-canary-blocked" ||
    value === "service-mutation-disabled"
    ? value
    : undefined;
}

function parseOptionalServiceExecutorMode(value: unknown): TNeonNodeRunnerServiceExecutorMode | undefined {
  return value === "armed" || value === "disabled" ? value : undefined;
}

function parseServiceActionExecutionSafety(value: unknown): INeonNodeRunnerServiceActionExecutionSafety {
  if (!isRecord(value)) {
    return createBlockedServiceActionExecution("service-blocked").safety;
  }

  return {
    executionEnabled: value["executionEnabled"] === true,
    serviceMutationExecuted: false,
    launchAgentWritten: false,
    runnerControlWritten: value["runnerControlWritten"] === true,
    rawTokenPersisted: false,
    sessionSecretPersisted: false,
    requiresCanaryGate: true
  };
}

function parseServiceBlockerIds(value: unknown): readonly TNeonNodeRunnerServiceBlockerId[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (
      entry === "unsupported-platform" ||
      entry === "cli-not-built" ||
      entry === "missing-session-env" ||
      entry === "runner-control-stopped"
    ) {
      return [entry];
    }

    return [];
  });
}

function readOptionalTextFields(
  value: Record<string, unknown>,
  keys: readonly ["operatorId" | "reason", ...("operatorId" | "reason")[]]
): {
  readonly operatorId?: string;
  readonly reason?: string;
} {
  const fields: {
    operatorId?: string;
    reason?: string;
  } = {};

  for (const key of keys) {
    const text = readOptionalText(value[key]);

    if (text) {
      fields[key] = text;
    }
  }

  return fields;
}

function readRequiredText(value: unknown, fieldName: string): string {
  const text = readOptionalText(value);

  if (!text) {
    throw new Error(`${fieldName} is required`);
  }

  return text;
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createServiceCredentials(
  env: NodeJS.ProcessEnv,
  envPath: string,
  envFilePresent: boolean
): INeonNodeRunnerServiceCredentials {
  const sessionIdAvailable = hasEnvValue(env["NEON_NODE_SESSION_ID"]);
  const sessionSecretAvailable = hasEnvValue(env["NEON_NODE_SESSION_SECRET"]);
  const source =
    sessionIdAvailable && sessionSecretAvailable
      ? "process-env"
      : envFilePresent
        ? "operator-env-file"
        : "missing";

  return {
    source,
    sessionIdAvailable: sessionIdAvailable || envFilePresent,
    sessionSecretAvailable: sessionSecretAvailable || envFilePresent,
    envFilePresent,
    envFilePath: envPath
  };
}

/**
 * Detect a stale LaunchAgent: an installed plist whose ProgramArguments no
 * longer reference the current cli path (e.g. a rebuild moved dist, or the
 * project was relocated). A missing install is not drift. Read-only — the
 * caller reads the plist, this never writes it.
 */
export function detectNeonNodeRunnerPlistArgsDrift(params: {
  readonly installedLaunchAgentPlist: string | undefined;
  readonly expectedCliPath: string;
}): boolean {
  if (params.installedLaunchAgentPlist === undefined) {
    return false;
  }
  return !params.installedLaunchAgentPlist.includes(params.expectedCliPath);
}

async function readInstalledLaunchAgentPlist(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function createServiceBlockers(params: {
  readonly context: IResolvedServiceContext;
  readonly cliReady: boolean;
  readonly credentials: INeonNodeRunnerServiceCredentials;
  readonly runner: INeonNodeRunnerSnapshot;
  readonly installedLaunchAgentPlist?: string;
}): readonly INeonNodeRunnerServiceBlocker[] {
  const blockers: INeonNodeRunnerServiceBlocker[] = [];

  if (params.context.platform !== "darwin") {
    blockers.push({
      id: "unsupported-platform",
      summary: `Service manager ${params.context.platform} is not wired yet.`,
      recovery: "Use manual node-runner-loop on this platform until the service adapter lands."
    });
  }

  if (!params.cliReady) {
    blockers.push({
      id: "cli-not-built",
      summary: "dist/src/cli.js is missing.",
      recovery: "Run npm run build before writing or loading the LaunchAgent."
    });
  }

  if (!params.credentials.sessionIdAvailable || !params.credentials.sessionSecretAvailable) {
    blockers.push({
      id: "missing-session-env",
      summary: "Runner session env is missing.",
      recovery: "Approve canary credentials, then inject NEON_NODE_SESSION_ID and NEON_NODE_SESSION_SECRET via runtime env or the operator env file."
    });
  }

  if (params.runner.control.desiredState !== "running") {
    blockers.push({
      id: "runner-control-stopped",
      summary: "Runner control is stopped.",
      recovery: "Run node dist/src/cli.js node-runner-start before loading the service."
    });
  }

  if (
    detectNeonNodeRunnerPlistArgsDrift({
      installedLaunchAgentPlist: params.installedLaunchAgentPlist,
      expectedCliPath: params.context.paths.cliPath
    })
  ) {
    blockers.push({
      id: "launch-agent-args-drift",
      summary: "Installed LaunchAgent ProgramArguments no longer reference the current cli path.",
      recovery: "Reinstall the service so the LaunchAgent points at the rebuilt cli path (node dist/src/cli.js node-runner-service-plist)."
    });
  }

  return blockers;
}

function createServiceCommands(context: IResolvedServiceContext): readonly INeonNodeRunnerServiceCommand[] {
  const launchTarget = `gui/${context.userId}/${runnerServiceLabel}`;

  return [
    {
      id: "install",
      label: "Write plist and bootstrap LaunchAgent",
      command: `node dist/src/cli.js node-runner-service-plist > ${quoteShell(context.paths.launchAgentPath)} && launchctl bootstrap gui/${context.userId} ${quoteShell(context.paths.launchAgentPath)}`,
      mutatesSystem: true,
      requiresApproval: true
    },
    {
      id: "restart",
      label: "Restart LaunchAgent",
      command: `launchctl kickstart -k ${quoteShell(launchTarget)}`,
      mutatesSystem: true,
      requiresApproval: true
    },
    {
      id: "stop",
      label: "Stop LaunchAgent",
      command: `launchctl bootout ${quoteShell(launchTarget)}`,
      mutatesSystem: true,
      requiresApproval: true
    },
    {
      id: "logs",
      label: "Read service logs",
      command: `tail -n 80 ${quoteShell(context.paths.logPath)} ${quoteShell(context.paths.errorLogPath)}`,
      mutatesSystem: false,
      requiresApproval: false
    },
    {
      id: "status",
      label: "Read service snapshot",
      command: "node dist/src/cli.js node-runner-service",
      mutatesSystem: false,
      requiresApproval: false
    }
  ];
}

function createServiceSafety(): INeonNodeRunnerServiceSafety {
  return {
    installExecuted: false,
    restartExecuted: false,
    stopExecuted: false,
    launchAgentWritten: false,
    rawTokenPersisted: false,
    sessionSecretPersisted: false
  };
}

async function fileIsReadable(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      return false;
    }
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readBoundedServiceLog(path: string, maxBytes: number): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.slice(Math.max(0, raw.length - maxBytes));
  } catch {
    return "";
  }
}

function hasEnvValue(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function safeUserId(): number {
  const uid = userInfo().uid;
  return Number.isInteger(uid) && uid >= 0 ? uid : 0;
}
