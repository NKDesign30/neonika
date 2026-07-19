import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import { createNeonAgentsSnapshot, defaultNeonAgentId, resolveNeonAgentProfile } from "../agents/registry.js";
import { createNeonCronStoreAutomationSnapshot } from "../automation/cronStoreSnapshot.js";
import { resolveNeonHeartbeatAgentsFromEnv } from "../automation/heartbeatRuntimeConfig.js";
import { createNeonWorkspaceSnapshot } from "../workspace/workspaceNotes.js";
import { createNeonChannelRegistrySnapshot } from "../channels/channelRegistry.js";
import { createNeonCutoverGateSnapshot } from "../core/cutoverGate.js";
import { resolveNeonGatedSideEffectPosture } from "../core/gatedSideEffectsPosture.js";
import { createNeonBlockedRowReadinessSnapshot } from "../missionControl/blockedRowReadiness.js";
import { readNeonCanaryStabilityEvidence } from "./canaryStabilityEvidence.js";
import { createNeonLiveSessionReadinessSnapshot } from "./liveSessionReadiness.js";
import type { INeonInFlightRunRegistry, TNeonRunLifecycleAction } from "./inFlightRunRegistry.js";
import { createNeonMirrorEvidenceSnapshot } from "../core/mirrorEvidence.js";
import { createNeonDoctorSnapshot } from "../doctor/neonDoctor.js";
import { defaultNeonMemoryDbPath } from "../memory/neonMemoryDbProvider.js";
import { recallNeonMemory, resolveNeonMemoryRecallDbPath } from "../memory/memoryRecall.js";
import { createNeonOllamaEmbeddingProvider } from "../memory/neonEmbeddingProvider.js";
import { createNeonNodeActionRequestSnapshot } from "../nodes/neonNodeActionRequests.js";
import {
  createNeonNodeTransportSnapshot,
  recordNeonNodeTransportPoll,
  recordNeonNodeTransportResult
} from "../nodes/neonNodeTransport.js";
import { createNeonNodePairingSnapshot } from "../nodes/neonNodePairing.js";
import { createNeonNodePairingCanaryTokenSnapshot } from "../nodes/neonNodePairingCanaryTokens.js";
import { createNeonNodePairingTokenGateSnapshot } from "../nodes/neonNodePairingTokenGate.js";
import {
  createNeonNodeDeviceSessionSnapshot,
  verifyNeonNodeDeviceSessionSecret,
  type INeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSummary
} from "../nodes/neonNodeDeviceSessions.js";
import { createNeonNodeRunnerSnapshot } from "../nodes/neonNodeRunner.js";
import {
  approveNeonNodeRunnerServiceAction,
  createNeonNodeRunnerServiceActionSnapshot,
  createNeonNodeRunnerServiceCanarySnapshot,
  createNeonNodeRunnerServiceSnapshot,
  executeNeonNodeRunnerServiceAction,
  requestNeonNodeRunnerServiceAction
} from "../nodes/neonNodeRunnerService.js";
import { createNeonNodesSnapshot } from "../nodes/neonNodes.js";
import { createNeonOnboardingSnapshot } from "../onboarding/neonOnboarding.js";
import {
  createNeonPluginInventorySnapshot,
  resolveNeonPluginInstallPlan
} from "../plugins/index.js";
import {
  createNeonExtensionInventorySnapshot,
  createNeonSkillInventorySnapshot
} from "../skills/neonSkills.js";
import { resolveAgentSkillPolicy } from "../skills/skillPolicy.js";
import { loadNeonSkillPolicySource } from "../skills/skillPolicySource.js";
import { createNeonToolInventorySnapshot } from "../tools/neonTools.js";
import { createNeonActivitySnapshot } from "./activitySnapshot.js";
import { createNeonChatSnapshot } from "./chatTranscript.js";
import {
  submitNeonChatSend,
  NeonChatSendValidationError,
  type INeonChatSendInput
} from "./chatSend.js";
import { createNeonDeliveryQueueSnapshot, recordNeonDeliveryApproval } from "./deliveryQueue.js";
import { authorizeNeonHttpMutation } from "./httpMutationAuth.js";
import { createDryRunHarness } from "../harness/dryRunHarness.js";
import {
  createNeonGatewayRuntimeController,
  formatNeonGatewayEventStreamFrame,
  NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS,
  type INeonGatewayRuntimeController
} from "./lifecycle.js";
import { createNeonGatewayProtocolSnapshot } from "./protocol.js";
import { createNeonReplaySnapshot, paginateNeonReplayEvents } from "./replaySnapshot.js";
import {
  createNeonReplayStream,
  formatNeonReplayStreamFrame,
  type INeonReplayStreamFrame
} from "./replayStream.js";
import {
  createNeonActivityStream,
  formatNeonActivityStreamFrame,
  type INeonActivityStreamFrame
} from "./activityStream.js";
import { readNeonGatewayRuns, readNeonGatewayStatus } from "./runStore.js";
import { createNeonGatewayRouteInspectionSnapshot } from "./routeInspection.js";
import { createNeonSessionsSnapshot } from "./sessionSnapshot.js";
import { runNeonLiveIndexMemorySync } from "../indexer/liveIndexSync.js";
import {
  createNeonLiveIndexDaemon,
  resolveNeonLiveIndexDaemonOptionsFromEnv,
  type INeonLiveIndexDaemonService
} from "../indexer/liveIndexDaemon.js";
import { createNeonIndexerSnapshot } from "../indexer/indexerSnapshot.js";
import { createNeonTranscriptSnapshot } from "../indexer/transcriptSnapshot.js";
import { createMergedNeonMemoryProvider } from "../memory/mergedMemoryProvider.js";
import { resolveNeonMemoryDbWriteGate } from "../memory/neonMemoryDbWriter.js";
import { createNeonUsageSnapshot } from "./usageSnapshot.js";
import { createNeonSiteAnalyticsSnapshot, createNeonSitesSnapshot } from "./neonSites.js";
import { createNeonRunTaskProjection } from "../tasks/runTaskProjection.js";
import { extractNeonDocument, type INeonDocExtractProvider, type INeonDocExtractRequest } from "../tools/documentExtract.js";
import { createNeonPdfExtractProvider } from "../tools/pdfExtractProvider.js";
import { createNeonRoundtableRoomsSnapshot } from "../roundtable/roundtableRoomsSnapshot.js";
import { createNeonWorkboardSnapshot } from "../tasks/workboardSnapshot.js";
import { createNeonFlowsSnapshot, planNeonFlowExecution } from "../tasks/flowPlan.js";
import { readNeonFlow } from "../tasks/flowStore.js";
import { createNeonContextPack, type INeonContextPackRequest } from "../context/contextPack.js";
import {
  createNeonWorkboardSnapshot as createNeonWorkboardCardSnapshot
} from "../workboard/workboardStore.js";
import {
  parseNeonWorkboardRpcRequest,
  runNeonWorkboardGatewayMethod
} from "../workboard/workboardGateway.js";
import type { TNeonChannel } from "../harness/types.js";
import {
  attachNeonGatewayWebSocketServer,
  type INeonGatewayWebSocketServerHandle
} from "./webSocketServer.js";
import { createNeonMissionControlGatewaySnapshot } from "../missionControl/gatewaySnapshot.js";
import { readNeonMissionControlDiscordCockpitSnapshot } from "../missionControl/discordCockpitSnapshot.js";
import { createNeonCronDaemonStatusSnapshot } from "../missionControl/cronDaemonStatusPanel.js";
import { createNeonHeartbeatDaemonStatusSnapshot } from "../missionControl/heartbeatDaemonStatusPanel.js";
import {
  isNeonMissionControlPath,
  renderNeonMissionControlGatewayHtml,
  resolveNeonMissionControlViewFromPathname
} from "../missionControl/gatewayHtml.js";

export interface INeonGatewayHttpServerOptions {
  readonly projectRoot: string;
  /**
   * Absolute path to the packaged Vite build. Kept separate from projectRoot
   * so a globally installed CLI can serve its bundled dashboard while reading
   * runtime state from the operator's current workspace.
   */
  readonly controlUiDir?: string;
  readonly runControl?: INeonGatewayRunControlRuntime;
  /**
   * Transcript-indexer ingest root (~/.claude/projects by default). An injection
   * seam for the transcript-smoke harness — NOT a request param, so the HTTP API
   * can never be steered to read an arbitrary directory.
   */
  readonly transcriptProjectsDir?: string;
  readonly liveIndexCodexSessionsDir?: string;
}

export type TNeonGatewayRunControlHttpAction = Extract<TNeonRunLifecycleAction, "abort" | "stop">;

export interface INeonGatewayRunControlHttpRequest {
  readonly action: TNeonGatewayRunControlHttpAction;
  readonly runId: string;
  readonly operatorId?: string;
}

export type TNeonGatewayRunControlHttpState = "accepted" | "blocked" | "not-found" | "plan-only";

export interface INeonGatewayRunControlHttpResult {
  readonly state: TNeonGatewayRunControlHttpState;
  readonly action: TNeonGatewayRunControlHttpAction;
  readonly runId: string;
  readonly reason: string;
  readonly interruptSent: boolean;
  readonly localAbortSent: boolean;
  readonly activeRuns: number;
  readonly safety: {
    readonly outboundSent: false;
    readonly primaryCutover: false;
  };
}

export interface INeonGatewayRunControlRuntime {
  readonly registry?: INeonInFlightRunRegistry;
  control(request: INeonGatewayRunControlHttpRequest): Promise<INeonGatewayRunControlHttpResult>;
}

export interface INeonGatewayHttpListenOptions {
  readonly host: string;
  readonly port: number;
}

export interface INeonGatewayHttpServerHandle {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

interface IRouteContext {
  readonly projectRoot: string;
  readonly runtime: INeonGatewayRuntimeController;
  readonly requestUrl: URL;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
}

type TJsonBodyResult =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly statusCode: 400 | 413;
      readonly error: "invalid-json-body" | "json-body-too-large";
    };

type TNodeSessionAuthResult =
  | {
      readonly ok: true;
      readonly deviceSessions: INeonNodeDeviceSessionSnapshot;
      readonly session: INeonNodeDeviceSessionSummary;
    }
  | {
      readonly ok: false;
      readonly statusCode: 401 | 403;
      readonly error: "node-session-auth-required" | "node-session-auth-denied";
    };

export function createNeonGatewayHttpServer(options: INeonGatewayHttpServerOptions): Server {
  const runtime = createNeonGatewayRuntimeController(options.projectRoot);
  const liveIndexDbPath = process.env["NEON_LIVE_INDEX_MEMORY_DB_PATH"]?.trim();
  const liveIndexMemoryGate = resolveNeonMemoryDbWriteGate(process.env);
  const liveIndexDaemon = createNeonLiveIndexDaemon({
    ...resolveNeonLiveIndexDaemonOptionsFromEnv(options.projectRoot),
    ...(options.transcriptProjectsDir ? { transcriptProjectsDir: options.transcriptProjectsDir } : {}),
    ...(options.liveIndexCodexSessionsDir ? { codexSessionsDir: options.liveIndexCodexSessionsDir } : {}),
    ...(liveIndexDbPath ? { memoryDbPath: liveIndexDbPath, memoryGate: liveIndexMemoryGate } : {}),
    // Canonical 768d embedder - see memoryRecall.ts; local hash vectors would
    // silently break hybrid recall (dimension mismatch with the query).
    ...(liveIndexDbPath && liveIndexMemoryGate.enabled ? { embedder: createNeonOllamaEmbeddingProvider({ model: "nomic-embed-text" }) } : {}),
    allowRealMemoryDb: isEnabledEnv(process.env["NEON_LIVE_INDEX_ALLOW_REAL_DB"])
  });
  if (liveIndexDaemon.enabled) {
    void liveIndexDaemon.start();
  }
  const server = createServer((request, response) => {
    void handleGatewayRequest(options, runtime, liveIndexDaemon, request, response);
  });
  const webSocketHandle = attachNeonGatewayWebSocketServer(server, {
    projectRoot: options.projectRoot,
    runtime
  });

  runtimeByServer.set(server, runtime);
  webSocketByServer.set(server, webSocketHandle);
  liveIndexDaemonByServer.set(server, liveIndexDaemon);

  return server;
}

export async function listenNeonGatewayHttpServer(
  options: INeonGatewayHttpServerOptions,
  listenOptions: INeonGatewayHttpListenOptions
): Promise<INeonGatewayHttpServerHandle> {
  const server = createNeonGatewayHttpServer(options);

  server.listen(listenOptions.port, listenOptions.host);
  await waitForServerListening(server);

  const address = server.address();

  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Neonika Gateway HTTP server did not expose a TCP address");
  }

  const handle = {
    server,
    url: `http://${listenOptions.host}:${address.port}`,
    close: async () => {
      const runtime = getRuntimeController(server);
      runtime?.markClosing();
      await webSocketByServer.get(server)?.close();
      await liveIndexDaemonByServer.get(server)?.stop();
      await closeServer(server);
      runtime?.markClosed();
    }
  };
  getRuntimeController(server)?.markReady({
    host: listenOptions.host,
    port: address.port,
    url: handle.url
  });

  return handle;
}

const runtimeByServer = new WeakMap<Server, INeonGatewayRuntimeController>();
const webSocketByServer = new WeakMap<Server, INeonGatewayWebSocketServerHandle>();
const liveIndexDaemonByServer = new WeakMap<Server, INeonLiveIndexDaemonService>();
const maxJsonBodyBytes = 64 * 1024;

async function handleGatewayRequest(
  options: INeonGatewayHttpServerOptions,
  runtime: INeonGatewayRuntimeController,
  liveIndexDaemon: INeonLiveIndexDaemonService,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = createRequestUrl(request);

  if (!requestUrl) {
    writeJson(response, 400, {
      error: "invalid-request-url"
    });
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-nodes/transport/results") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    await handleNeonNodeTransportResultSubmit(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-nodes/runner/service/actions") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonNodeRunnerServiceActionRequest(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-nodes/runner/service/actions/approvals") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonNodeRunnerServiceActionApproval(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-nodes/runner/service/actions/executions") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonNodeRunnerServiceActionExecution(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-delivery/approval") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonDeliveryApproval(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-tools/document-extract") {
    // Read-only content extraction over bytes provided in the body. No state change,
    // no send, no network -> no mutation authorization required.
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    await handleNeonDocumentExtract(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-chat/send") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonChatSend(context);
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/neon-runs/control") {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonRunControl(context, options);
    return;
  }

  if (
    request.method === "POST" &&
    (requestUrl.pathname === "/api/workboard/rpc" || requestUrl.pathname === "/api/neon-workboard/rpc")
  ) {
    const context: IRouteContext = {
      projectRoot: options.projectRoot,
      runtime,
      requestUrl,
      request,
      response
    };

    if (!authorizeHttpMutation(context)) {
      return;
    }

    await handleNeonWorkboardCardRpc(context);
    return;
  }

  if (request.method !== "GET") {
    writeJson(response, 405, {
      error: "method-not-allowed"
    });
    return;
  }

  const context: IRouteContext = {
    projectRoot: options.projectRoot,
    runtime,
    requestUrl,
    request,
    response
  };

  try {
    if (requestUrl.pathname === "/api/neon-gateway/status") {
      await handleGatewayStatus(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-roundtable") {
      await handleNeonRoundtable(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-gateway/runs") {
      await handleGatewayRuns(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-gateway/lifecycle") {
      handleGatewayLifecycle(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-gateway/protocol") {
      handleGatewayProtocol(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-gateway/events") {
      handleGatewayEvents(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-gateway/routes") {
      await handleGatewayRoutes(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-channels") {
      await handleNeonChannels(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-tools") {
      handleNeonTools(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-chat/conversations") {
      await handleNeonChat(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-sessions") {
      await handleNeonSessions(context);
      return;
    }

    if (requestUrl.pathname === "/api/memory/v3/search") {
      await handleMemorySearch(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-indexer") {
      await handleNeonIndexer(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-live-index-sync") {
      await handleNeonLiveIndexSync(context, options);
      return;
    }

    if (requestUrl.pathname === "/api/neon-live-index-daemon") {
      await handleNeonLiveIndexDaemon(context, liveIndexDaemon);
      return;
    }

    if (requestUrl.pathname === "/api/neon-transcript") {
      await handleNeonTranscript(context, options);
      return;
    }

    if (requestUrl.pathname === "/api/neon-usage") {
      await handleNeonUsage(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-sites/analytics") {
      await handleNeonSiteAnalytics(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-sites") {
      handleNeonSites(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-run-tasks") {
      await handleNeonRunTasks(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-workboard") {
      await handleNeonWorkboard(context);
      return;
    }

    if (requestUrl.pathname === "/api/workboard/cards") {
      await handleNeonWorkboardCards(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-flows/plan") {
      await handleNeonFlowPlan(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-flows") {
      await handleNeonFlows(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-context/pack") {
      await handleNeonContextPack(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-activity/stream") {
      handleNeonActivityStream(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-activity") {
      await handleNeonActivity(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-replay/stream") {
      handleNeonReplayStream(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-replay/page") {
      await handleNeonReplayPage(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-replay") {
      await handleNeonReplay(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-delivery/queue") {
      await handleNeonDeliveryQueue(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-cutover") {
      await handleNeonCutover(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-gates") {
      handleNeonGates(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-blocked-readiness") {
      handleNeonBlockedReadiness(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-canary-stability") {
      await handleNeonCanaryStability(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-live-session-readiness") {
      handleNeonLiveSessionReadiness(context, options);
      return;
    }

    if (requestUrl.pathname === "/api/neon-mirror/evidence") {
      await handleNeonMirrorEvidence(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-agents") {
      await handleNeonAgents(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-automation") {
      await handleNeonAutomation(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-cron") {
      await handleNeonCron(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-heartbeat") {
      await handleNeonHeartbeat(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-workspace") {
      await handleNeonWorkspace(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes") {
      await handleNeonNodes(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/pairing") {
      await handleNeonNodePairing(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/pairing/token-gate") {
      await handleNeonNodePairingTokenGate(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/pairing/canary-tokens") {
      await handleNeonNodePairingCanaryTokens(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/device-sessions") {
      await handleNeonNodeDeviceSessions(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/action-requests") {
      await handleNeonNodeActionRequests(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/transport") {
      await handleNeonNodeTransport(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/transport/poll") {
      await handleNeonNodeTransportPoll(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/runner") {
      await handleNeonNodeRunner(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/runner/service") {
      await handleNeonNodeRunnerService(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/runner/service/actions") {
      await handleNeonNodeRunnerServiceActions(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-nodes/runner/service/canary") {
      await handleNeonNodeRunnerServiceCanary(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-doctor") {
      await handleNeonDoctor(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-onboarding") {
      await handleNeonOnboarding(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-skills/policy") {
      await handleNeonSkillPolicy(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-skills") {
      await handleNeonSkills(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-extensions") {
      await handleNeonExtensions(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-plugins/install-plan") {
      await handleNeonPluginInstallPlan(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-plugins") {
      await handleNeonPlugins(context);
      return;
    }

    if (requestUrl.pathname === "/api/neon-mission-control/gateway") {
      await handleMissionControlGateway(context);
      return;
    }

    if (requestUrl.pathname.startsWith("/control-ui/")) {
      await handleControlUiAsset(context, options);
      return;
    }

    if (isNeonMissionControlPath(requestUrl.pathname)) {
      await handleMissionControlGatewayHtml(context, options);
      return;
    }

    writeJson(response, 404, {
      error: "not-found"
    });
  } catch (error) {
    writeJson(response, 500, {
      error: "gateway-http-error",
      message: error instanceof Error ? error.message : "Unknown gateway HTTP error"
    });
  }
}

function getRuntimeController(server: Server): INeonGatewayRuntimeController | undefined {
  return runtimeByServer.get(server);
}

function authorizeHttpMutation(context: IRouteContext): boolean {
  const decision = authorizeNeonHttpMutation({
    headers: context.request.headers,
    ...(context.request.socket.remoteAddress
      ? { remoteAddress: context.request.socket.remoteAddress }
      : {})
  });

  if (decision.state === "authorized") {
    return true;
  }

  writeJson(context.response, decision.statusCode ?? 401, {
    error: decision.error ?? "neon-http-mutation-auth-required"
  });

  return false;
}

async function handleGatewayStatus(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await readNeonGatewayStatus(context.projectRoot));
}

// Read-only Neonika Roundtable rooms projection (spec #15, ticket #22): the
// running (or last) round with a bounded, redacted turn log. Leak-safe by
// construction — the snapshot carries no filesystem paths and every turn is
// re-run through the redaction seam.
async function handleNeonRoundtable(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonRoundtableRoomsSnapshot(context.projectRoot));
}

async function handleGatewayRuns(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl);
  const runs = await readNeonGatewayRuns(context.projectRoot, limit ? { maxRuns: limit } : {});

  writeJson(context.response, 200, {
    runs
  });
}

function handleGatewayLifecycle(context: IRouteContext): void {
  writeJson(context.response, 200, context.runtime.getSnapshot());
}

function handleGatewayProtocol(context: IRouteContext): void {
  writeJson(
    context.response,
    200,
    createNeonGatewayProtocolSnapshot({
      snapshot: context.runtime.getSnapshot()
    })
  );
}

function handleGatewayEvents(context: IRouteContext): void {
  context.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  context.response.write("retry: 2000\n\n");

  const writeFrame = (frame: ReturnType<INeonGatewayRuntimeController["createFrame"]>): void => {
    if (context.response.destroyed) {
      return;
    }

    context.response.write(formatNeonGatewayEventStreamFrame(frame));
  };
  const unsubscribe = context.runtime.subscribe(writeFrame);
  const heartbeat = setInterval(() => {
    writeFrame(context.runtime.createFrame("neon.gateway.heartbeat"));
  }, context.runtime.heartbeatMs);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };

  context.request.once("close", cleanup);
  writeFrame(context.runtime.createFrame("neon.gateway.snapshot"));
}

function handleNeonReplayStream(context: IRouteContext): void {
  context.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  context.response.write("retry: 2000\n\n");

  const writeFrame = (frame: INeonReplayStreamFrame): void => {
    if (context.response.destroyed) {
      return;
    }

    context.response.write(formatNeonReplayStreamFrame(frame));
  };
  const stream = createNeonReplayStream(context.projectRoot, { onFrame: writeFrame });
  const heartbeat = setInterval(() => {
    if (context.response.destroyed) {
      return;
    }

    context.response.write("event: neon.replay.heartbeat\ndata: {}\n\n");
  }, NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    stream.close();
  };

  context.request.once("close", cleanup);
  void stream.start();
}

function handleNeonActivityStream(context: IRouteContext): void {
  context.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  context.response.write("retry: 2000\n\n");

  const writeFrame = (frame: INeonActivityStreamFrame): void => {
    if (context.response.destroyed) {
      return;
    }

    context.response.write(formatNeonActivityStreamFrame(frame));
  };
  const stream = createNeonActivityStream(context.projectRoot, { onFrame: writeFrame });
  const heartbeat = setInterval(() => {
    if (context.response.destroyed) {
      return;
    }

    context.response.write("event: neon.activity.heartbeat\ndata: {}\n\n");
  }, NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS);
  const cleanup = (): void => {
    clearInterval(heartbeat);
    stream.close();
  };

  context.request.once("close", cleanup);
  void stream.start();
}

async function handleNeonAgents(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, createNeonAgentsSnapshot());
}

async function handleNeonAutomation(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonCronStoreAutomationSnapshot(context.projectRoot));
}

async function handleNeonCron(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonCronDaemonStatusSnapshot(context.projectRoot));
}

async function handleNeonHeartbeat(context: IRouteContext): Promise<void> {
  writeJson(
    context.response,
    200,
    await createNeonHeartbeatDaemonStatusSnapshot(context.projectRoot, {
      agents: resolveNeonHeartbeatAgentsFromEnv(process.env)
    })
  );
}

async function handleNeonWorkspace(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonWorkspaceSnapshot(context.projectRoot));
}

async function handleNeonNodes(context: IRouteContext): Promise<void> {
  const gatewayUrl = context.runtime.getSnapshot().network.url;

  writeJson(
    context.response,
    200,
    await createNeonNodesSnapshot(context.projectRoot, gatewayUrl ? { gatewayUrl } : {})
  );
}

async function handleNeonNodePairing(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodePairingSnapshot(context.projectRoot));
}

async function handleNeonNodePairingTokenGate(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodePairingTokenGateSnapshot(context.projectRoot));
}

async function handleNeonNodePairingCanaryTokens(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodePairingCanaryTokenSnapshot(context.projectRoot));
}

async function handleNeonNodeDeviceSessions(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeDeviceSessionSnapshot(context.projectRoot));
}

async function handleNeonNodeActionRequests(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeActionRequestSnapshot(context.projectRoot));
}

async function handleNeonNodeTransport(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeTransportSnapshot(context.projectRoot));
}

async function handleNeonNodeRunner(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeRunnerSnapshot(context.projectRoot));
}

async function handleNeonNodeRunnerService(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeRunnerServiceSnapshot(context.projectRoot));
}

async function handleNeonNodeRunnerServiceActions(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeRunnerServiceActionSnapshot(context.projectRoot));
}

async function handleNeonNodeRunnerServiceCanary(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonNodeRunnerServiceCanarySnapshot(context.projectRoot));
}

async function handleNeonNodeRunnerServiceActionRequest(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  try {
    const record = await requestNeonNodeRunnerServiceAction(context.projectRoot, body.value);

    writeJson(context.response, 201, {
      state: "accepted",
      request: record
    });
  } catch {
    writeJson(context.response, 400, {
      error: "invalid-node-runner-service-action"
    });
  }
}

async function handleNeonNodeRunnerServiceActionApproval(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  try {
    const approval = await approveNeonNodeRunnerServiceAction(context.projectRoot, body.value);

    writeJson(context.response, 201, {
      state: "accepted",
      approval
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runner service action approval error";

    if (message.includes("not found")) {
      writeJson(context.response, 404, {
        error: "node-runner-service-action-not-found"
      });
      return;
    }

    if (message.includes("already has an approval")) {
      writeJson(context.response, 409, {
        error: "node-runner-service-action-approval-duplicate"
      });
      return;
    }

    writeJson(context.response, 400, {
      error: "invalid-node-runner-service-action-approval"
    });
  }
}

async function handleNeonChatSend(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  const input = parseNeonChatSendBody(body.value);

  if (!input) {
    writeJson(context.response, 400, {
      error: "invalid-chat-send-body"
    });
    return;
  }

  try {
    const result = await submitNeonChatSend(context.projectRoot, input, {
      harness: createDryRunHarness()
    });

    writeJson(context.response, 201, {
      state: "accepted",
      chat: result
    });
  } catch (error) {
    if (error instanceof NeonChatSendValidationError) {
      writeJson(context.response, 400, {
        error: "invalid-chat-send",
        field: error.field
      });
      return;
    }

    writeJson(context.response, 400, {
      error: "invalid-chat-send"
    });
  }
}

async function handleNeonRunControl(
  context: IRouteContext,
  options: INeonGatewayHttpServerOptions
): Promise<void> {
  if (!options.runControl) {
    writeJson(context.response, 503, {
      error: "runtime-control-unavailable"
    });
    return;
  }

  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  const input = parseNeonRunControlBody(body.value);

  if (!input) {
    writeJson(context.response, 400, {
      error: "invalid-run-control-body"
    });
    return;
  }

  const result = await options.runControl.control(input);
  const statusCode = result.state === "accepted" ? 202 : result.state === "not-found" ? 404 : 409;

  writeJson(context.response, statusCode, {
    state: result.state,
    control: result
  });
}

async function handleNeonDeliveryApproval(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  try {
    const approval = await recordNeonDeliveryApproval(context.projectRoot, body.value);

    writeJson(context.response, 201, {
      state: "accepted",
      approval
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delivery approval error";

    if (message.includes("not found")) {
      writeJson(context.response, 404, {
        error: "delivery-candidate-not-found"
      });
      return;
    }

    if (message.includes("not queued")) {
      writeJson(context.response, 409, {
        error: "delivery-candidate-not-queued"
      });
      return;
    }

    writeJson(context.response, 400, {
      error: "invalid-delivery-approval"
    });
  }
}

async function handleNeonNodeRunnerServiceActionExecution(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  try {
    const execution = await executeNeonNodeRunnerServiceAction(context.projectRoot, body.value);

    writeJson(context.response, 201, {
      state: "accepted",
      execution
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runner service action execution error";

    if (message.includes("not found")) {
      writeJson(context.response, 404, {
        error: "node-runner-service-action-approval-not-found"
      });
      return;
    }

    if (message.includes("already has an execution")) {
      writeJson(context.response, 409, {
        error: "node-runner-service-action-execution-duplicate"
      });
      return;
    }

    writeJson(context.response, 400, {
      error: "invalid-node-runner-service-action-execution"
    });
  }
}

async function handleNeonNodeTransportPoll(context: IRouteContext): Promise<void> {
  const sessionAuth = await resolveNodeSessionAuth(context);

  if (!sessionAuth.ok) {
    writeJson(context.response, sessionAuth.statusCode, {
      error: sessionAuth.error
    });
    return;
  }

  const cursor = context.requestUrl.searchParams.get("cursor") ?? undefined;
  const result = await recordNeonNodeTransportPoll(
    context.projectRoot,
    {
      sessionId: sessionAuth.session.sessionId,
      ...(cursor ? { cursor } : {})
    },
    {
      deviceSessionSnapshot: sessionAuth.deviceSessions,
      session: sessionAuth.session
    }
  );

  writeJson(context.response, 200, result);
}

async function handleNeonNodeTransportResultSubmit(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, {
      error: body.error
    });
    return;
  }

  const dispatchId = readBodyText(body.value, "dispatchId");

  if (!dispatchId) {
    writeJson(context.response, 400, {
      error: "invalid-node-transport-result"
    });
    return;
  }

  const sessionAuth = await resolveNodeSessionAuth(context);

  if (!sessionAuth.ok) {
    writeJson(context.response, sessionAuth.statusCode, {
      error: sessionAuth.error
    });
    return;
  }

  const transportSnapshot = await createNeonNodeTransportSnapshot(context.projectRoot, {
    deviceSessionSnapshot: sessionAuth.deviceSessions
  });
  const dispatch = transportSnapshot.dispatches.find((candidate) => candidate.dispatchId === dispatchId);

  if (dispatch && dispatch.sessionId !== sessionAuth.session.sessionId) {
    writeJson(context.response, 403, {
      error: "node-session-dispatch-mismatch"
    });
    return;
  }

  try {
    const result = await recordNeonNodeTransportResult(context.projectRoot, body.value, {
      transportSnapshot
    });

    writeJson(context.response, 201, {
      state: "accepted",
      result
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown node transport result error";

    if (message.includes("already has an ingested result")) {
      writeJson(context.response, 409, {
        error: "node-transport-result-duplicate"
      });
      return;
    }

    if (message.includes("Ready node transport dispatch not found")) {
      writeJson(context.response, 404, {
        error: "node-transport-dispatch-not-found"
      });
      return;
    }

    writeJson(context.response, 400, {
      error: "invalid-node-transport-result"
    });
  }
}

async function handleNeonDoctor(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonDoctorSnapshot(context.projectRoot));
}

async function handleNeonOnboarding(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonOnboardingSnapshot(context.projectRoot));
}

async function handleNeonSkills(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonSkillInventorySnapshot(context.projectRoot));
}

function handleNeonTools(context: IRouteContext): void {
  // Read-only inventory: reads only env-var PRESENCE (never values) to derive
  // provider readiness; the snapshot carries no secret values and runs no tool.
  writeJson(context.response, 200, createNeonToolInventorySnapshot({ env: process.env }));
}

// Memory autarky: serves the same `/api/memory/v3/search` contract the previous runtime
// exposes, but reads the semantic memory DB directly (read-only, redacted). This
// is what lets the previous runtime be retired without taking Neonika's memory with it.
//
// Default is hybrid FTS5 + Ollama-vector search (v3 parity). If Ollama is
// unreachable the search degrades to FTS5-only with a diagnostic rather than
// failing. `?vector=0` forces the fast FTS5-only path for latency-sensitive
// callers (~24ms vs ~100ms hybrid).
async function handleMemorySearch(context: IRouteContext): Promise<void> {
  const query = readQueryText(context.requestUrl, "q");
  if (!query || !query.trim()) {
    writeJson(context.response, 400, { ok: false, error: "Query parameter q ist Pflicht" });
    return;
  }

  const limit = readPositiveInteger(context.requestUrl, "limit");
  const agent = readQueryText(context.requestUrl, "agent");
  const category = readQueryText(context.requestUrl, "category");
  const vectorParam = readQueryText(context.requestUrl, "vector");
  const ftsOnly = vectorParam === "0" || vectorParam === "false" || vectorParam === "off";

  const ftsOptions = {
    ...(limit ? { limit } : {}),
    ...(agent ? { agent } : {}),
    ...(category ? { category } : {})
  };

  // One recall seam (memory cutover, Slice K1): primary DB via
  // NEON_MEMORY_DB_PATH (canonically neonika data/semantic-memory.db, armed
  // by the mission-control plist), frozen v2 DB merged in as read-only archive.
  // Access tracking (Ebbinghaus feed, Slice K2) runs against the primary only
  // and self-blocks while the primary still points at the v2 archive.
  const primaryDbPath = resolveNeonMemoryRecallDbPath(process.env);
  try {
    const recall = await recallNeonMemory(query, {
      primaryDbPath,
      archiveDbPath: defaultNeonMemoryDbPath,
      ...ftsOptions,
      ...(ftsOnly ? {} : { embedder: createNeonOllamaEmbeddingProvider({ model: "nomic-embed-text" }) }),
      trackingGate: resolveNeonMemoryDbWriteGate(process.env)
    });

    writeJson(context.response, 200, {
      ok: true,
      results: recall.results,
      total: recall.results.length,
      mode: recall.mode,
      primaryHits: recall.primaryHits,
      archiveHits: recall.archiveHits,
      ...(recall.accessTracking
        ? {
            accessTracking: {
              state: recall.accessTracking.state,
              updatedRows: recall.accessTracking.updatedRows
            }
          }
        : {})
    });
  } catch {
    // DB absent or unreadable: report unavailability without leaking the path.
    writeJson(context.response, 503, { ok: false, error: "memory backend unavailable" });
  }
}

async function handleNeonSkillPolicy(context: IRouteContext): Promise<void> {
  const agentId = readQueryText(context.requestUrl, "agent") ?? defaultNeonAgentId;
  const inventory = await createNeonSkillInventorySnapshot(context.projectRoot);
  // Read-only declarative policy source: a missing or invalid file yields an
  // empty config, so the reference-only default-allow baseline stays stable.
  const policySource = await loadNeonSkillPolicySource(context.projectRoot);
  const policy = resolveAgentSkillPolicy(agentId, inventory.skills, policySource.config, {
    resolveAgentId: (candidate) => resolveNeonAgentProfile(candidate)?.id
  });

  writeJson(context.response, 200, {
    generatedAt: inventory.generatedAt,
    inventoryState: inventory.state,
    policySource: {
      state: policySource.state,
      relativePath: policySource.relativePath
    },
    policy
  });
}

async function handleNeonExtensions(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonExtensionInventorySnapshot(context.projectRoot));
}

async function handleNeonPlugins(context: IRouteContext): Promise<void> {
  const allowlist = parseCommaSeparatedQuery(context.requestUrl.searchParams.get("allow"));
  writeJson(
    context.response,
    200,
    await createNeonPluginInventorySnapshot(context.projectRoot, {
      ...(allowlist.length > 0 ? { allowlist } : {})
    })
  );
}

async function handleNeonPluginInstallPlan(context: IRouteContext): Promise<void> {
  const pluginId = context.requestUrl.searchParams.get("id")?.trim();
  if (!pluginId) {
    writeJson(context.response, 400, { error: "missing-plugin-id", detail: "query parameter ?id= is required" });
    return;
  }

  const action = context.requestUrl.searchParams.get("action")?.trim();
  const allowlist = parseCommaSeparatedQuery(context.requestUrl.searchParams.get("allow"));
  const result = await resolveNeonPluginInstallPlan({
    pluginId,
    ...(action === "enable" || action === "load" || action === "install" ? { action } : {}),
    ...(allowlist.length > 0 ? { allowlist } : {})
  });

  writeJson(context.response, result.found ? 200 : 404, result);
}

function parseCommaSeparatedQuery(value: string | null): readonly string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function handleGatewayRoutes(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonGatewayRouteInspectionSnapshot(context.projectRoot));
}

async function handleNeonChannels(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonChannelRegistrySnapshot(context.projectRoot));
}

async function handleNeonChat(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 40;
  const channelId = readQueryText(context.requestUrl, "channelId");
  const conversationId = readQueryText(context.requestUrl, "conversationId");
  const runId = readQueryText(context.requestUrl, "runId");
  const sessionKey = readQueryText(context.requestUrl, "sessionKey");
  const agentId = readQueryText(context.requestUrl, "agentId");

  writeJson(
    context.response,
    200,
    await createNeonChatSnapshot(context.projectRoot, {
      maxRuns: limit,
      ...(channelId ? { channelId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(runId ? { runId } : {}),
      ...(sessionKey ? { sessionKey } : {}),
      ...(agentId ? { agentId } : {})
    })
  );
}

async function handleNeonSessions(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 100;

  writeJson(
    context.response,
    200,
    await createNeonSessionsSnapshot(context.projectRoot, {
      maxRuns: limit
    })
  );
}

async function handleNeonIndexer(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 100;

  writeJson(
    context.response,
    200,
    await createNeonIndexerSnapshot(context.projectRoot, {
      maxRuns: limit
    })
  );
}

async function handleNeonLiveIndexSync(
  context: IRouteContext,
  options: INeonGatewayHttpServerOptions
): Promise<void> {
  const dbPath = process.env["NEON_LIVE_INDEX_MEMORY_DB_PATH"]?.trim();
  const gate = resolveNeonMemoryDbWriteGate(process.env);

  writeJson(
    context.response,
    200,
    await runNeonLiveIndexMemorySync({
      projectRoot: context.projectRoot,
      gate,
      allowRealDb: isEnabledEnv(process.env["NEON_LIVE_INDEX_ALLOW_REAL_DB"]),
      ...(dbPath ? { dbPath } : {}),
      ...(options.transcriptProjectsDir ? { transcriptProjectsDir: options.transcriptProjectsDir } : {}),
      ...(options.liveIndexCodexSessionsDir ? { codexSessionsDir: options.liveIndexCodexSessionsDir } : {}),
      ...(dbPath && gate.enabled ? { embedder: createNeonOllamaEmbeddingProvider({ model: "nomic-embed-text" }) } : {})
    })
  );
}

async function handleNeonLiveIndexDaemon(
  context: IRouteContext,
  liveIndexDaemon: INeonLiveIndexDaemonService
): Promise<void> {
  const scan = context.requestUrl.searchParams.get("scan");
  writeJson(
    context.response,
    200,
    scan === "0" ? liveIndexDaemon.getSnapshot() : await liveIndexDaemon.scanNow("api")
  );
}

async function handleNeonTranscript(
  context: IRouteContext,
  options: INeonGatewayHttpServerOptions
): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 100;

  writeJson(
    context.response,
    200,
    await createNeonTranscriptSnapshot({
      maxSessions: limit,
      ...(options.transcriptProjectsDir ? { projectsDir: options.transcriptProjectsDir } : {})
    })
  );
}

async function handleNeonUsage(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 100;
  const runs = await readNeonGatewayRuns(context.projectRoot, { maxRuns: limit });

  writeJson(context.response, 200, createNeonUsageSnapshot(runs));
}

function handleNeonSites(context: IRouteContext): void {
  writeJson(context.response, 200, createNeonSitesSnapshot());
}

async function handleNeonSiteAnalytics(context: IRouteContext): Promise<void> {
  const result = await createNeonSiteAnalyticsSnapshot(
    readQueryText(context.requestUrl, "property"),
    readQueryText(context.requestUrl, "days")
  );

  if (!result.ok) {
    writeJson(context.response, result.status, { error: result.error });
    return;
  }

  writeJson(context.response, 200, result.value);
}

async function handleNeonRunTasks(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 100;
  const runs = await readNeonGatewayRuns(context.projectRoot, { maxRuns: limit });

  writeJson(context.response, 200, createNeonRunTaskProjection(runs));
}

async function handleNeonDocumentExtract(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);
  if (!body.ok) {
    writeJson(context.response, body.statusCode, { error: body.error });
    return;
  }

  const contentBase64 = readBodyText(body.value, "contentBase64");
  const text = readBodyText(body.value, "text");
  const mimeType = readBodyText(body.value, "mimeType");
  const fileName = readBodyText(body.value, "fileName");
  const extractRequest: INeonDocExtractRequest = {
    ...(contentBase64 ? { contentBase64 } : {}),
    ...(text ? { text } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(fileName ? { fileName } : {})
  };

  writeJson(context.response, 200, await extractNeonDocument(extractRequest, neonDocumentExtractProviders));
}

// PDF/Docx provider seam, registered once. PDF is backed by unpdf; Docx stays
// provider-not-configured until a parser is added.
const neonDocumentExtractProviders: readonly INeonDocExtractProvider[] = [createNeonPdfExtractProvider()];

async function handleNeonActivity(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 100;

  writeJson(
    context.response,
    200,
    await createNeonActivitySnapshot(context.projectRoot, {
      maxEntries: limit,
      maxRuns: limit
    })
  );
}

async function handleNeonReplay(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 20;
  const events = readPositiveInteger(context.requestUrl, "events") ?? 50;
  const channelId = readQueryText(context.requestUrl, "channelId");
  const conversationId = readQueryText(context.requestUrl, "conversationId");
  const runId = readQueryText(context.requestUrl, "runId");
  const sessionKey = readQueryText(context.requestUrl, "sessionKey");

  writeJson(
    context.response,
    200,
    await createNeonReplaySnapshot(context.projectRoot, {
      maxRuns: limit,
      maxEventsPerRun: events,
      ...(channelId ? { channelId } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(runId ? { runId } : {}),
      ...(sessionKey ? { sessionKey } : {})
    })
  );
}

async function handleNeonReplayPage(context: IRouteContext): Promise<void> {
  const maxRuns = readLimit(context.requestUrl) ?? 50;
  const events = readPositiveInteger(context.requestUrl, "events") ?? 50;
  const channelId = readQueryText(context.requestUrl, "channelId");
  const conversationId = readQueryText(context.requestUrl, "conversationId");
  const runId = readQueryText(context.requestUrl, "runId");
  const sessionKey = readQueryText(context.requestUrl, "sessionKey");
  const after = readQueryText(context.requestUrl, "after");
  const pageLimit = readPositiveInteger(context.requestUrl, "pageLimit");

  const snapshot = await createNeonReplaySnapshot(context.projectRoot, {
    maxRuns,
    maxEventsPerRun: events,
    ...(channelId ? { channelId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {})
  });

  writeJson(
    context.response,
    200,
    paginateNeonReplayEvents(snapshot, {
      ...(after ? { afterMessageSeq: after } : {}),
      ...(pageLimit ? { limit: pageLimit } : {})
    })
  );
}

async function handleNeonDeliveryQueue(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 50;

  writeJson(
    context.response,
    200,
    await createNeonDeliveryQueueSnapshot(context.projectRoot, {
      maxCandidates: limit
    })
  );
}

async function handleNeonCutover(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await createNeonCutoverGateSnapshot(context.projectRoot));
}

function handleNeonBlockedReadiness(context: IRouteContext): void {
  writeJson(context.response, 200, createNeonBlockedRowReadinessSnapshot());
}

async function handleNeonCanaryStability(context: IRouteContext): Promise<void> {
  writeJson(context.response, 200, await readNeonCanaryStabilityEvidence(context.projectRoot));
}

function handleNeonLiveSessionReadiness(
  context: IRouteContext,
  options: INeonGatewayHttpServerOptions
): void {
  writeJson(
    context.response,
    200,
    createNeonLiveSessionReadinessSnapshot({
      ...(options.runControl?.registry ? { runtimeSnapshot: options.runControl.registry.snapshot() } : {})
    })
  );
}

function handleNeonGates(context: IRouteContext): void {
  writeJson(context.response, 200, resolveNeonGatedSideEffectPosture());
}

async function handleNeonMirrorEvidence(context: IRouteContext): Promise<void> {
  const limit = Number(context.requestUrl.searchParams.get("limit") ?? "20");

  writeJson(
    context.response,
    200,
    await createNeonMirrorEvidenceSnapshot(context.projectRoot, {
      maxRecords: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 50) : 20
    })
  );
}

async function handleMissionControlGateway(context: IRouteContext): Promise<void> {
  const limit = readLimit(context.requestUrl) ?? 10;
  const [status, runs, discordCockpit] = await Promise.all([
    readNeonGatewayStatus(context.projectRoot),
    readNeonGatewayRuns(context.projectRoot, {
      maxRuns: limit
    }),
    readNeonMissionControlDiscordCockpitSnapshot(context.projectRoot)
  ]);

  writeJson(
    context.response,
    200,
    createNeonMissionControlGatewaySnapshot(status, runs, { discordCockpit })
  );
}

// The built control UI lives in dist/control-ui (vite build, base "/control-ui/").
const CONTROL_UI_DIR_NAME = "dist/control-ui";

const CONTROL_UI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

// Map a /control-ui/<rel> request to an absolute file path inside dist/control-ui,
// rejecting anything that would escape the directory (path-traversal guard).
function resolveControlUiDir(options: INeonGatewayHttpServerOptions): string {
  return resolve(options.controlUiDir ?? resolve(options.projectRoot, CONTROL_UI_DIR_NAME));
}

function resolveControlUiAssetPath(
  options: INeonGatewayHttpServerOptions,
  pathname: string
): string | undefined {
  const relative = pathname.slice("/control-ui/".length);

  if (relative === "" || relative.includes("\0")) {
    return undefined;
  }

  const baseDir = resolveControlUiDir(options);
  const candidate = resolve(baseDir, relative);

  if (candidate !== baseDir && !candidate.startsWith(baseDir + sep)) {
    return undefined;
  }

  return candidate;
}

async function handleControlUiAsset(
  context: IRouteContext,
  options: INeonGatewayHttpServerOptions
): Promise<void> {
  const filePath = resolveControlUiAssetPath(options, context.requestUrl.pathname);

  if (!filePath) {
    writeJson(context.response, 404, { error: "not-found" });
    return;
  }

  let data: Buffer;

  try {
    data = await readFile(filePath);
  } catch {
    writeJson(context.response, 404, { error: "not-found" });
    return;
  }

  const contentType = CONTROL_UI_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";

  context.response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": data.byteLength,
    "Cache-Control": "no-cache"
  });
  context.response.end(data);
}

// Returns the built SPA index.html when the control UI has been built, else
// undefined so callers fall back to the server-rendered gateway HTML.
async function readControlUiIndexHtml(
  options: INeonGatewayHttpServerOptions
): Promise<string | undefined> {
  try {
    return await readFile(resolve(resolveControlUiDir(options), "index.html"), "utf8");
  } catch {
    return undefined;
  }
}

async function handleMissionControlGatewayHtml(
  context: IRouteContext,
  options: INeonGatewayHttpServerOptions
): Promise<void> {
  // Every Mission Control route serves the same built SPA when present. The
  // server-rendered surface remains the zero-build fallback for source trees.
  const indexHtml = await readControlUiIndexHtml(options);

  if (indexHtml !== undefined) {
    writeHtml(context.response, 200, indexHtml);
    return;
  }

  const limit = readLimit(context.requestUrl) ?? 8;
  const [status, runs, discordCockpit, workboard, cronDaemon, heartbeatDaemon, roundtable] = await Promise.all([
    readNeonGatewayStatus(context.projectRoot),
    readNeonGatewayRuns(context.projectRoot, {
      maxRuns: limit
    }),
    readNeonMissionControlDiscordCockpitSnapshot(context.projectRoot),
    createNeonWorkboardSnapshot(context.projectRoot, { maxRecords: 200 }),
    createNeonCronDaemonStatusSnapshot(context.projectRoot),
    createNeonHeartbeatDaemonStatusSnapshot(context.projectRoot, {
      agents: resolveNeonHeartbeatAgentsFromEnv(process.env)
    }),
    createNeonRoundtableRoomsSnapshot(context.projectRoot)
  ]);
  const snapshot = createNeonMissionControlGatewaySnapshot(status, runs, { discordCockpit });
  const initialView = resolveNeonMissionControlViewFromPathname(context.requestUrl.pathname) ?? "chat";
  // Wire the real run-control registry into the server-rendered live-session
  // panel so active runningRunIds + Stop/Abort controls reflect the live
  // runtime. Without an injected registry the panel renders its architectural
  // (no-runtime) snapshot.
  const liveSessionReadiness = createNeonLiveSessionReadinessSnapshot(
    options.runControl?.registry ? { runtimeSnapshot: options.runControl.registry.snapshot() } : {}
  );
  writeHtml(
    context.response,
    200,
    renderNeonMissionControlGatewayHtml(snapshot, {
      initialView,
      workboard,
      cronDaemon,
      heartbeatDaemon,
      liveSessionReadiness,
      roundtable,
    })
  );
}

async function resolveNodeSessionAuth(context: IRouteContext): Promise<TNodeSessionAuthResult> {
  const sessionId = readHeader(context.request, "x-neon-node-session-id");
  const sessionSecret = readHeader(context.request, "x-neon-node-session-secret");

  if (!sessionId || !sessionSecret) {
    return {
      ok: false,
      statusCode: 401,
      error: "node-session-auth-required"
    };
  }

  const deviceSessions = await createNeonNodeDeviceSessionSnapshot(context.projectRoot);
  const session = deviceSessions.sessions.find((candidate) => candidate.sessionId === sessionId);

  if (!session || session.state !== "active" || !verifyNeonNodeDeviceSessionSecret(session, sessionSecret)) {
    return {
      ok: false,
      statusCode: 403,
      error: "node-session-auth-denied"
    };
  }

  return {
    ok: true,
    deviceSessions,
    session
  };
}

function readLimit(requestUrl: URL): number | undefined {
  const value = requestUrl.searchParams.get("limit");

  if (!value) {
    return undefined;
  }

  return parseStrictPositiveInteger(value, 100);
}

function readPositiveInteger(requestUrl: URL, key: string): number | undefined {
  const value = requestUrl.searchParams.get(key);

  if (!value) {
    return undefined;
  }

  return parseStrictPositiveInteger(value, 100);
}

function parseStrictPositiveInteger(value: string, max: number): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.min(parsed, max);
}

function readQueryText(requestUrl: URL, key: string): string | undefined {
  const value = requestUrl.searchParams.get(key)?.trim();

  return value ? value : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<TJsonBodyResult> {
  const chunks: Buffer[] = [];
  let byteLength = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);

    byteLength += buffer.byteLength;

    if (byteLength > maxJsonBodyBytes) {
      return {
        ok: false,
        statusCode: 413,
        error: "json-body-too-large"
      };
    }

    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();

  if (!raw) {
    return {
      ok: false,
      statusCode: 400,
      error: "invalid-json-body"
    };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(raw) as unknown
    };
  } catch {
    return {
      ok: false,
      statusCode: 400,
      error: "invalid-json-body"
    };
  }
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  const firstValue = Array.isArray(value) ? value[0] : value;

  if (typeof firstValue !== "string") {
    return undefined;
  }

  const trimmed = firstValue.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function readBodyText(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const field = value[key];

  if (typeof field !== "string") {
    return undefined;
  }

  const trimmed = field.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

const NEON_CHAT_SEND_CHANNELS: readonly TNeonChannel[] = [
  "discord",
  "telegram",
  "whatsapp",
  "webchat",
  "cli",
  "device"
];

function readBodyChannel(value: unknown): TNeonChannel | undefined {
  const channel = readBodyText(value, "channel");
  return NEON_CHAT_SEND_CHANNELS.find((known) => known === channel);
}

// Parses the chat-send JSON body. Returns undefined only for a non-object body
// (-> 400 invalid-chat-send-body); empty required fields are left for
// submitNeonChatSend to reject with a field-specific 400.
function parseNeonChatSendBody(value: unknown): INeonChatSendInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const channel = readBodyChannel(value);
  const accountId = readBodyText(value, "accountId");
  const threadId = readBodyText(value, "threadId");
  const agentId = readBodyText(value, "agentId");
  const userId = readBodyText(value, "userId");
  const userDisplayName = readBodyText(value, "userDisplayName");

  return {
    channelId: readBodyText(value, "channelId") ?? "",
    text: readBodyText(value, "text") ?? "",
    ...(channel ? { channel } : {}),
    ...(accountId ? { accountId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(userId ? { userId } : {}),
    ...(userDisplayName ? { userDisplayName } : {})
  };
}

function parseNeonRunControlBody(value: unknown): INeonGatewayRunControlHttpRequest | undefined {
  const action = readBodyText(value, "action");
  const runId = readBodyText(value, "runId");
  const operatorId = readBodyText(value, "operatorId");

  if ((action !== "stop" && action !== "abort") || !runId) {
    return undefined;
  }

  return {
    action,
    runId,
    ...(operatorId ? { operatorId } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function createRequestUrl(request: IncomingMessage): URL | undefined {
  if (!request.url) {
    return undefined;
  }

  return new URL(request.url, "http://127.0.0.1");
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function isEnabledEnv(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "ready" || normalized === "on";
}

function writeHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(html);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function waitForServerListening(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function handleNeonWorkboard(context: IRouteContext): Promise<void> {
  const limit = readPositiveInteger(context.requestUrl, "limit");
  const snapshot = await createNeonWorkboardSnapshot(
    context.projectRoot,
    limit ? { maxRecords: limit } : {}
  );

  writeJson(context.response, 200, snapshot);
}

async function handleNeonWorkboardCards(context: IRouteContext): Promise<void> {
  const limit = readPositiveInteger(context.requestUrl, "limit");

  writeJson(
    context.response,
    200,
    await createNeonWorkboardCardSnapshot(context.projectRoot, limit ? { maxRecords: limit } : {})
  );
}

async function handleNeonWorkboardCardRpc(context: IRouteContext): Promise<void> {
  const body = await readJsonBody(context.request);

  if (!body.ok) {
    writeJson(context.response, body.statusCode, { error: body.error });
    return;
  }

  const request = parseNeonWorkboardRpcRequest(body.value);

  if (!request) {
    writeJson(context.response, 400, { error: "invalid-workboard-rpc-body" });
    return;
  }

  try {
    writeJson(
      context.response,
      200,
      await runNeonWorkboardGatewayMethod(context.projectRoot, request.method, request.params)
    );
  } catch (error) {
    writeJson(context.response, 400, {
      error: "workboard-rpc-failed",
      detail: error instanceof Error ? error.message : "unknown error"
    });
  }
}

async function handleNeonFlows(context: IRouteContext): Promise<void> {
  const limit = readPositiveInteger(context.requestUrl, "limit");
  const snapshot = await createNeonFlowsSnapshot(
    context.projectRoot,
    limit ? { maxRecords: limit } : {}
  );

  writeJson(context.response, 200, snapshot);
}

async function handleNeonFlowPlan(context: IRouteContext): Promise<void> {
  const flowId = readQueryText(context.requestUrl, "flowId");

  if (!flowId) {
    writeJson(context.response, 400, {
      error: "flow-id-required"
    });
    return;
  }

  const flow = await readNeonFlow(context.projectRoot, flowId);

  if (!flow) {
    writeJson(context.response, 404, {
      error: "flow-not-found"
    });
    return;
  }

  writeJson(context.response, 200, planNeonFlowExecution(flow));
}

const neonContextChannelSet = new Set<TNeonChannel>([
  "discord",
  "telegram",
  "whatsapp",
  "webchat",
  "cli",
  "device"
]);

function isNeonContextChannel(value: string | undefined): value is TNeonChannel {
  return value !== undefined && neonContextChannelSet.has(value as TNeonChannel);
}

async function handleNeonContextPack(context: IRouteContext): Promise<void> {
  const agentId = readQueryText(context.requestUrl, "agentId");
  const channel = context.requestUrl.searchParams.get("channel") ?? undefined;

  if (!agentId) {
    writeJson(context.response, 400, {
      error: "agent-id-required"
    });
    return;
  }

  if (!isNeonContextChannel(channel)) {
    writeJson(context.response, 400, {
      error: "invalid-channel"
    });
    return;
  }

  const channelId = readQueryText(context.requestUrl, "channelId");
  const taskId = readQueryText(context.requestUrl, "taskId");
  const query = readQueryText(context.requestUrl, "query");
  const maxItems = readPositiveInteger(context.requestUrl, "maxItems");

  const request: INeonContextPackRequest = {
    agentId,
    channel,
    ...(channelId ? { channelId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(query ? { query } : {}),
    ...(maxItems ? { maxItems } : {})
  };

  const pack = await createNeonContextPack(context.projectRoot, request, {
    maxRuns: 50,
    memoryProvider: createMergedNeonMemoryProvider()
  });

  writeJson(context.response, 200, pack);
}
