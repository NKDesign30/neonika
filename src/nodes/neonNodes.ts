import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { arch as readArch, hostname as readHostname, platform as readPlatform } from "node:os";
import { resolve } from "node:path";

import {
  createNeonNodeActionRequestSnapshot,
  type INeonNodeActionRequestSnapshot
} from "./neonNodeActionRequests.js";
import {
  createNeonNodeTransportSnapshot,
  type INeonNodeTransportSnapshot
} from "./neonNodeTransport.js";
import {
  createNeonNodePairingSnapshot,
  type INeonNodePairingApprovalRecord,
  type INeonNodePairingRequestSummary
} from "./neonNodePairing.js";
import {
  createNeonNodePairingTokenGateSnapshot,
  type INeonNodePairingTokenGateSnapshot
} from "./neonNodePairingTokenGate.js";
import {
  createNeonNodePairingCanaryTokenSnapshot,
  type INeonNodePairingCanaryTokenSnapshot
} from "./neonNodePairingCanaryTokens.js";
import {
  createNeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSnapshot
} from "./neonNodeDeviceSessions.js";
import {
  createNeonNodeRunnerSnapshot,
  type INeonNodeRunnerSnapshot
} from "./neonNodeRunner.js";
import {
  createNeonNodeRunnerServiceActionSnapshot,
  createNeonNodeRunnerServiceCanarySnapshot,
  createNeonNodeRunnerServiceSnapshot,
  type INeonNodeRunnerServiceActionSnapshot,
  type INeonNodeRunnerServiceCanarySnapshot,
  type INeonNodeRunnerServiceSnapshot
} from "./neonNodeRunnerService.js";

export type TNeonNodesSnapshotState = "ready" | "partial";
export type TNeonNodeHealth = "online" | "degraded";
export type TNeonNodeCapabilityState = "available" | "locked";
export type TNeonNodeCapabilityPolicy = "read-only" | "approval-required" | "disabled";
export type TNeonNodeSafeRootKind = "workspace";

export interface ICreateNeonNodesSnapshotOptions {
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly hostName?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly pid?: number;
  readonly gatewayUrl?: string;
  readonly homeDir?: string;
}

export interface INeonLocalNodeSummary {
  readonly nodeId: string;
  readonly displayName: string;
  readonly hostName: string;
  readonly platform: string;
  readonly arch: string;
  readonly processId: number;
  readonly health: TNeonNodeHealth;
  readonly heartbeatAt: string;
}

export interface INeonNodePairingPolicy {
  readonly state: "locked";
  readonly requestTtlMinutes: number;
  readonly approval: "operator-required";
  readonly tokenPersistence: "disabled";
  readonly source: string;
}

export interface INeonNodeCapability {
  readonly id: string;
  readonly label: string;
  readonly state: TNeonNodeCapabilityState;
  readonly policy: TNeonNodeCapabilityPolicy;
  readonly source: string;
  readonly summary: string;
}

export interface INeonNodeSafeRoot {
  readonly id: string;
  readonly kind: TNeonNodeSafeRootKind;
  readonly path: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly writeAccess: false;
}

export interface INeonNodesSource {
  readonly projectRoot: string;
  readonly referenceDevicePairSource: string;
  readonly referenceFileTransferSource: string;
}

export interface INeonNodesTotals {
  readonly nodes: number;
  readonly onlineNodes: number;
  readonly capabilities: number;
  readonly readOnlyCapabilities: number;
  readonly safeRoots: number;
  readonly pairingRequests: number;
  readonly pendingPairingRequests: number;
  readonly pairingApprovals: number;
  readonly pairingCanaryTokens: number;
  readonly deviceSessions: number;
  readonly actionRequests: number;
  readonly transportDispatches: number;
  readonly transportResults: number;
  readonly transportPolls: number;
  readonly runnerCycles: number;
  readonly runnerSubmitted: number;
  readonly runnerFailed: number;
  readonly runnerServiceBlockers: number;
  readonly runnerServiceCanaryBlockers: number;
  readonly runnerServiceActions: number;
  readonly runnerServicePendingApprovals: number;
  readonly runnerServiceExecutions: number;
}

export interface INeonNodesSnapshot {
  readonly state: TNeonNodesSnapshotState;
  readonly generatedAt: string;
  readonly source: INeonNodesSource;
  readonly gatewayUrl?: string;
  readonly localNode: INeonLocalNodeSummary;
  readonly pairing: INeonNodePairingPolicy;
  readonly pairingTokenGate: INeonNodePairingTokenGateSnapshot;
  readonly pairingCanaryTokens: INeonNodePairingCanaryTokenSnapshot;
  readonly deviceSessions: INeonNodeDeviceSessionSnapshot;
  readonly actionRequests: INeonNodeActionRequestSnapshot;
  readonly transport: INeonNodeTransportSnapshot;
  readonly runner: INeonNodeRunnerSnapshot;
  readonly runnerService: INeonNodeRunnerServiceSnapshot;
  readonly runnerServiceActions: INeonNodeRunnerServiceActionSnapshot;
  readonly runnerServiceCanary: INeonNodeRunnerServiceCanarySnapshot;
  readonly pairingRequests: readonly INeonNodePairingRequestSummary[];
  readonly pairingApprovals: readonly INeonNodePairingApprovalRecord[];
  readonly capabilities: readonly INeonNodeCapability[];
  readonly safeRoots: readonly INeonNodeSafeRoot[];
  readonly totals: INeonNodesTotals;
  readonly recovery: readonly string[];
}

// Public provenance links, not local checkout paths — these strings are served
// in the nodes snapshot over HTTP.
const referenceExtensions = "https://github.com/openclaw/openclaw/tree/main/extensions";
const referenceDevicePairSource = `${referenceExtensions}/device-pair`;
const referenceFileTransferSource = `${referenceExtensions}/file-transfer`;
const referencePairingTtlMinutes = 5;

export async function createNeonNodesSnapshot(
  projectRoot: string,
  options: ICreateNeonNodesSnapshotOptions = {}
): Promise<INeonNodesSnapshot> {
  const resolvedProjectRoot = resolve(projectRoot);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const hostName = options.hostName ?? readHostname();
  const localNode = createLocalNodeSummary({
    arch: options.arch ?? readArch(),
    generatedAt,
    hostName,
    pid: options.pid ?? process.pid,
    platform: options.platform ?? readPlatform(),
    projectRoot: resolvedProjectRoot
  });
  const safeRoots = [await createWorkspaceSafeRoot(resolvedProjectRoot)];
  const pairingSnapshot = await createNeonNodePairingSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now,
          maxApprovals: 20,
          maxRequests: 20
        }
      : {
          maxApprovals: 20,
          maxRequests: 20
        }
  );
  const pairingTokenGate = await createNeonNodePairingTokenGateSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now,
          pairingSnapshot
        }
      : {
          pairingSnapshot
        }
  );
  const pairingCanaryTokens = await createNeonNodePairingCanaryTokenSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now,
          tokenGateSnapshot: pairingTokenGate
        }
      : {
          tokenGateSnapshot: pairingTokenGate
      }
  );
  const deviceSessions = await createNeonNodeDeviceSessionSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now,
          canaryTokenSnapshot: pairingCanaryTokens
        }
      : {
          canaryTokenSnapshot: pairingCanaryTokens
      }
  );
  const actionRequests = await createNeonNodeActionRequestSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now,
          deviceSessionSnapshot: deviceSessions
        }
      : {
          deviceSessionSnapshot: deviceSessions
        }
  );
  const transport = await createNeonNodeTransportSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now,
          deviceSessionSnapshot: deviceSessions,
          actionRequestSnapshot: actionRequests
        }
      : {
          deviceSessionSnapshot: deviceSessions,
          actionRequestSnapshot: actionRequests
      }
  );
  const runner = await createNeonNodeRunnerSnapshot(
    resolvedProjectRoot,
    options.now
      ? {
          now: options.now
        }
      : {}
  );
  const runnerService = await createNeonNodeRunnerServiceSnapshot(
    resolvedProjectRoot,
    {
      ...(options.now ? { now: options.now } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.arch ? { arch: options.arch } : {}),
      ...(options.homeDir ? { homeDir: options.homeDir } : {})
    }
  );
  const runnerServiceActions = await createNeonNodeRunnerServiceActionSnapshot(
    resolvedProjectRoot,
    {
      ...(options.now ? { now: options.now } : {}),
      serviceSnapshot: runnerService
    }
  );
  const runnerServiceCanary = await createNeonNodeRunnerServiceCanarySnapshot(
    resolvedProjectRoot,
    {
      ...(options.now ? { now: options.now } : {}),
      ...(options.env ? { env: options.env } : {}),
      serviceSnapshot: runnerService,
      actionSnapshot: runnerServiceActions
    }
  );
  const capabilities = createNodeCapabilities();
  const recovery = createNodeRecovery(safeRoots);
  const snapshotBase: Omit<INeonNodesSnapshot, "gatewayUrl"> = {
    state: recovery.length === 0 ? "ready" : "partial",
    generatedAt,
    source: {
      projectRoot: resolvedProjectRoot,
      referenceDevicePairSource,
      referenceFileTransferSource
    },
    localNode,
    pairing: {
      state: "locked",
      requestTtlMinutes: referencePairingTtlMinutes,
      approval: "operator-required",
      tokenPersistence: "disabled",
      source: "upstream device-pair pattern, Neon writes disabled"
    },
    pairingTokenGate,
    pairingCanaryTokens,
    deviceSessions,
    actionRequests,
    transport,
    runner,
    runnerService,
    runnerServiceActions,
    runnerServiceCanary,
    pairingRequests: pairingSnapshot.requests,
    pairingApprovals: pairingSnapshot.approvals,
    capabilities,
    safeRoots,
    totals: {
      nodes: 1,
      onlineNodes: localNode.health === "online" ? 1 : 0,
      capabilities: capabilities.length,
      readOnlyCapabilities: capabilities.filter((capability) => capability.policy === "read-only").length,
      safeRoots: safeRoots.length,
      pairingRequests: pairingSnapshot.totals.requests,
      pendingPairingRequests: pairingSnapshot.totals.pending,
      pairingApprovals: pairingSnapshot.totals.approvals,
      pairingCanaryTokens: pairingCanaryTokens.totals.issued,
      deviceSessions: deviceSessions.totals.sessions,
      actionRequests: actionRequests.totals.requests,
      transportDispatches: transport.totals.dispatches,
      transportResults: transport.totals.results,
      transportPolls: transport.totals.polls,
      runnerCycles: runner.totals.cycles,
      runnerSubmitted: runner.totals.submitted,
      runnerFailed: runner.totals.failed,
      runnerServiceBlockers: runnerService.blockers.length,
      runnerServiceCanaryBlockers: runnerServiceCanary.blockers.length,
      runnerServiceActions: runnerServiceActions.totals.requests,
      runnerServicePendingApprovals: runnerServiceActions.totals.pendingApproval,
      runnerServiceExecutions: runnerServiceActions.totals.executions
    },
    recovery
  };

  return options.gatewayUrl
    ? {
        ...snapshotBase,
        gatewayUrl: options.gatewayUrl
      }
    : snapshotBase;
}

export function renderNeonNodesReport(snapshot: INeonNodesSnapshot): string {
  const capabilityLines = snapshot.capabilities.map(
    (capability) => `- ${capability.id}: ${capability.state} / ${capability.policy} / ${capability.summary}`
  );
  const rootLines = snapshot.safeRoots.map(
    (root) => `- ${root.id}: readable=${root.readable ? "yes" : "no"} write=no ${root.path}`
  );
  const pairingLines =
    snapshot.pairingRequests.length > 0
      ? snapshot.pairingRequests.map(
          (request) => `- ${request.requestId}: ${request.state} / ${request.deviceId} / tokenIssued=${request.tokenIssued}`
        )
      : ["- none"];
  const tokenGateBlockerLines =
    snapshot.pairingTokenGate.blockers.length > 0
      ? snapshot.pairingTokenGate.blockers.map((blocker) => `- ${blocker.id}: ${blocker.summary}`)
      : ["- none"];
  const canaryTokenLines =
    snapshot.pairingCanaryTokens.issues.length > 0
      ? snapshot.pairingCanaryTokens.issues.map(
          (issue) => `- ${issue.tokenIssueId}: ${issue.deviceId} / secretPersisted=${issue.secretPersisted}`
        )
      : ["- none"];
  const deviceSessionLines =
    snapshot.deviceSessions.sessions.length > 0
      ? snapshot.deviceSessions.sessions.map(
          (session) => `- ${session.sessionId}: ${session.state} / ${session.deviceId} / scopes=${session.grantedScopes.join(",")}`
        )
      : ["- none"];
  const actionRequestLines =
    snapshot.actionRequests.requests.length > 0
      ? snapshot.actionRequests.requests.map(
          (request) => `- ${request.requestId}: ${request.kind} / ${request.state} / executed=${request.sideEffectExecuted}`
        )
      : ["- none"];
  const transportDispatchLines =
    snapshot.transport.dispatches.length > 0
      ? snapshot.transport.dispatches.map(
          (dispatch) => `- ${dispatch.dispatchId}: ${dispatch.kind} / ${dispatch.deviceId}`
        )
      : ["- none"];
  const runnerServiceActionLines =
    snapshot.runnerServiceActions.requests.length > 0
      ? snapshot.runnerServiceActions.requests.map(
          (request) => `- ${request.actionRequestId}: ${request.action} / ${request.state} / mutation=${request.safety.serviceMutationExecuted}`
        )
      : ["- none"];
  const runnerServiceExecutionLines =
    snapshot.runnerServiceActions.executions.length > 0
      ? snapshot.runnerServiceActions.executions.map(
          (execution) => `- ${execution.executionId}: ${execution.action} / ${execution.state} / runnerControl=${execution.safety.runnerControlWritten}`
        )
      : ["- none"];
  const runnerServiceCanaryLines =
    snapshot.runnerServiceCanary.blockers.length > 0
      ? snapshot.runnerServiceCanary.blockers.map((blocker) => `- ${blocker.id}: ${blocker.summary}`)
      : ["- none"];
  const recoveryLines = snapshot.recovery.length > 0 ? snapshot.recovery.map((step) => `- ${step}`) : ["- none"];

  return [
    `Neonika Nodes: ${snapshot.state}`,
    `Local: ${snapshot.localNode.displayName} ${snapshot.localNode.nodeId} ${snapshot.localNode.health}`,
    `Gateway: ${snapshot.gatewayUrl ?? "local-runtime"}`,
    `Pairing: ${snapshot.pairing.state} / ${snapshot.pairing.approval} / ttl=${snapshot.pairing.requestTtlMinutes}m`,
    `Token Gate: ${snapshot.pairingTokenGate.state} / blockers=${snapshot.pairingTokenGate.totals.blockers}`,
    `Canary Tokens: ${snapshot.pairingCanaryTokens.state} / issued=${snapshot.pairingCanaryTokens.totals.issued}`,
    `Device Sessions: ${snapshot.deviceSessions.state} / active=${snapshot.deviceSessions.totals.active}`,
    `Action Requests: ${snapshot.actionRequests.state} / approval=${snapshot.actionRequests.totals.approvalRequired} / blocked=${snapshot.actionRequests.totals.blocked}`,
    `Transport: ${snapshot.transport.state} / dispatches=${snapshot.transport.totals.dispatches} / results=${snapshot.transport.totals.results} / polls=${snapshot.transport.totals.polls} / blockers=${snapshot.transport.totals.blockers}`,
    `Runner: ${snapshot.runner.state} / control=${snapshot.runner.control.desiredState} / cycles=${snapshot.runner.totals.cycles} / submitted=${snapshot.runner.totals.submitted} / failed=${snapshot.runner.totals.failed}`,
    `Runner Service: ${snapshot.runnerService.state} / install=${snapshot.runnerService.installState} / blockers=${snapshot.runnerService.blockers.length}`,
    `Runner Service Actions: ${snapshot.runnerServiceActions.state} / pending=${snapshot.runnerServiceActions.totals.pendingApproval} / blocked=${snapshot.runnerServiceActions.totals.blocked} / executions=${snapshot.runnerServiceActions.totals.executions}`,
    `Runner Service Canary: ${snapshot.runnerServiceCanary.state} / executor=${snapshot.runnerServiceCanary.executorMode} / rollback=${snapshot.runnerServiceCanary.rollbackConfigured} / cutover=${snapshot.runnerServiceCanary.cutoverStage}:${snapshot.runnerServiceCanary.currentGateState} / blockers=${snapshot.runnerServiceCanary.blockers.length}`,
    "Capabilities:",
    ...capabilityLines,
    "Pairing requests:",
    ...pairingLines,
    "Token gate blockers:",
    ...tokenGateBlockerLines,
    "Canary token issues:",
    ...canaryTokenLines,
    "Device sessions:",
    ...deviceSessionLines,
    "Action requests:",
    ...actionRequestLines,
    "Transport dispatches:",
    ...transportDispatchLines,
    "Runner service actions:",
    ...runnerServiceActionLines,
    "Runner service executions:",
    ...runnerServiceExecutionLines,
    "Runner service canary blockers:",
    ...runnerServiceCanaryLines,
    "Safe roots:",
    ...rootLines,
    "Recovery:",
    ...recoveryLines
  ].join("\n");
}

function createLocalNodeSummary(input: {
  readonly arch: string;
  readonly generatedAt: string;
  readonly hostName: string;
  readonly pid: number;
  readonly platform: string;
  readonly projectRoot: string;
}): INeonLocalNodeSummary {
  return {
    nodeId: createLocalNodeId(input.hostName, input.projectRoot),
    displayName: `${input.hostName} Neonika`,
    hostName: input.hostName,
    platform: input.platform,
    arch: input.arch,
    processId: input.pid,
    health: "online",
    heartbeatAt: input.generatedAt
  };
}

async function createWorkspaceSafeRoot(projectRoot: string): Promise<INeonNodeSafeRoot> {
  const exists = await stat(projectRoot)
    .then((entry) => entry.isDirectory())
    .catch(() => false);

  return {
    id: "workspace",
    kind: "workspace",
    path: projectRoot,
    exists,
    readable: exists,
    writeAccess: false
  };
}

function createNodeCapabilities(): readonly INeonNodeCapability[] {
  return [
    {
      id: "device-pair",
      label: "Device Pairing",
      state: "locked",
      policy: "approval-required",
      source: referenceDevicePairSource,
      summary: "Pairing model is visible; token issuance stays disabled until canary."
    },
    {
      id: "file-transfer",
      label: "File Transfer",
      state: "available",
      policy: "read-only",
      source: referenceFileTransferSource,
      summary: "Workspace root is listed as a safe read-only root; writes are blocked."
    },
    {
      id: "phone-control",
      label: "Phone Control",
      state: "locked",
      policy: "disabled",
      source: `${referenceExtensions}/phone-control`,
      summary: "High-risk device actions require a later explicit approval gate."
    }
  ];
}

function createNodeRecovery(safeRoots: readonly INeonNodeSafeRoot[]): readonly string[] {
  const recovery: string[] = [];

  if (!safeRoots.some((root) => root.readable)) {
    recovery.push("Make the Neonika workspace readable before file-transfer inventory can be shown.");
  }

  return recovery;
}

function createLocalNodeId(hostName: string, projectRoot: string): string {
  const digest = createHash("sha256")
    .update(`${hostName}:${projectRoot}`)
    .digest("hex")
    .slice(0, 12);

  return `local-${digest}`;
}
