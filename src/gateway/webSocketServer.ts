import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { createNeonAgentsSnapshot, loadNeonAgentProfiles } from "../agents/registry.js";
import { createNeonCutoverGateSnapshot } from "../core/cutoverGate.js";
import { createNeonMirrorEvidenceSnapshot } from "../core/mirrorEvidence.js";
import { createNeonDoctorSnapshot } from "../doctor/neonDoctor.js";
import { createLiveNeonMissionControlGatewaySnapshot } from "../missionControl/gatewaySnapshot.js";
import { readNeonMissionControlDiscordCockpitSnapshot } from "../missionControl/discordCockpitSnapshot.js";
import { createNeonOnboardingSnapshot } from "../onboarding/neonOnboarding.js";
import {
  createNeonExtensionInventorySnapshot,
  createNeonSkillInventorySnapshot
} from "../skills/neonSkills.js";
import { createNeonActivitySnapshot } from "./activitySnapshot.js";
import { createNeonChatSnapshot } from "./chatTranscript.js";
import {
  createNeonDeliveryQueueSnapshot,
  readNeonDeliveryApprovalRecords,
  recordNeonDeliveryApproval
} from "./deliveryQueue.js";
import { recordNeonOperatorAck } from "./operatorAcks.js";
import {
  createNeonPreauthConnectionBudget,
  readNeonPreauthRemoteAddress,
  resolveNeonPreauthMaxConnectionsPerIp,
  type INeonPreauthConnectionBudget
} from "./preauthConnectionBudget.js";
import {
  createNeonUnauthorizedFloodGuard,
  resolveNeonGatewayMaxUnauthorizedFrames,
  type INeonUnauthorizedFloodGuard
} from "./unauthorizedFloodGuard.js";
import { resolveNeonGatewayConnectAuth } from "./connectAuth.js";
import {
  createNeonAuthRateLimiter,
  resolveNeonAuthRateLimitConfig,
  type INeonAuthRateLimiter
} from "./authRateLimit.js";
import { createNeonReplaySnapshot } from "./replaySnapshot.js";
import type { INeonGatewayRuntimeController } from "./lifecycle.js";
import {
  NEON_GATEWAY_MAX_BUFFERED_BYTES,
  NEON_GATEWAY_MAX_PAYLOAD_BYTES,
  NEON_GATEWAY_WS_PATH,
  createNeonGatewayConnectChallenge,
  createNeonGatewayErrorResponseFrame,
  createNeonGatewayHelloOk,
  createNeonGatewaySuccessResponseFrame,
  NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION,
  neonGatewayProtocolMethods,
  parseNeonGatewayFrameJson,
  type INeonGatewayHelloOkAuth,
  type INeonGatewayRequestFrame
} from "./protocol.js";
import { readNeonGatewayRuns, readNeonGatewayStatus } from "./runStore.js";
import { createNeonGatewayRouteInspectionSnapshot } from "./routeInspection.js";
import { createNeonSessionsSnapshot } from "./sessionSnapshot.js";
import {
  neonWorkboardWriteGatewayMethods,
  runNeonWorkboardGatewayMethod
} from "../workboard/workboardGateway.js";

export interface INeonGatewayWebSocketAttachOptions {
  readonly projectRoot: string;
  readonly runtime: INeonGatewayRuntimeController;
}

export interface INeonGatewayWebSocketServerHandle {
  readonly path: typeof NEON_GATEWAY_WS_PATH;
  readonly server: WebSocketServer;
  close(): Promise<void>;
}

interface INeonGatewayWebSocketConnectionState {
  readonly challengeNonce: string;
  connected: boolean;
  connId: string;
  role: INeonGatewayHelloOkAuth["role"];
  scopes: readonly string[];
  handshakeTimer?: ReturnType<typeof setTimeout> | undefined;
  keepaliveTimer?: ReturnType<typeof setInterval> | undefined;
  floodGuard: INeonUnauthorizedFloodGuard;
  remoteAddress: string | undefined;
  authRateLimiter: INeonAuthRateLimiter;
}

interface INeonGatewayConnectParams {
  readonly nonce: string;
  readonly role: INeonGatewayHelloOkAuth["role"];
  readonly scopes: readonly string[];
  readonly lastSeq?: number;
  readonly clientVersion?: number;
  readonly authToken?: string;
}

interface INeonGatewayRpcAuthorization {
  readonly allowed: boolean;
  readonly missingScope?: string;
}

const NEON_GATEWAY_DEFAULT_OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.approvals"
] as const;

const NEON_GATEWAY_READ_COMPATIBLE_SCOPES = new Set([
  "operator.admin",
  "operator.read",
  "operator.write"
]);

const NEON_GATEWAY_APPROVAL_COMPATIBLE_SCOPES = new Set([
  "operator.admin",
  "operator.approvals"
]);

const NEON_GATEWAY_WRITE_COMPATIBLE_SCOPES = new Set([
  "operator.admin",
  "operator.write"
]);

const neonGatewayApprovalRpcMethods = new Set<string>([
  "delivery.approval.record"
]);

// DP-3: the first gated `operator.write` mutation method. Deny-by-default — a
// connection must carry operator.write (or operator.admin) for this to run.
const neonGatewayWriteRpcMethods = new Set<string>([
  "run.ack.set",
  ...neonWorkboardWriteGatewayMethods
]);

const neonGatewayReadRpcMethods = new Set<string>(
  neonGatewayProtocolMethods.filter((method) => (
    method !== "connect" &&
    !neonGatewayApprovalRpcMethods.has(method) &&
    !neonGatewayWriteRpcMethods.has(method)
  ))
);

export function attachNeonGatewayWebSocketServer(
  server: Server,
  options: INeonGatewayWebSocketAttachOptions
): INeonGatewayWebSocketServerHandle {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: NEON_GATEWAY_MAX_PAYLOAD_BYTES
  });

  // Read the configured browser-CSRF allowlist once (process-stable env).
  const allowedOrigins = resolveNeonGatewayAllowedOrigins();

  // Pre-auth connection budget: cap simultaneous un-connected upgrades per IP
  // (handshake-flood DoS hardening). Always on; the high default never trips
  // legitimate local clients. Acquired here on upgrade, released on close.
  const preauthBudget = createNeonPreauthConnectionBudget(resolveNeonPreauthMaxConnectionsPerIp());

  // Cross-connection auth-failure rate limiter (Z305): caps brute-force of
  // connect credentials across many sockets from one IP. Loopback-exempt, so
  // the Shadow loopback transport and local clients are never throttled.
  const authRateLimiter = createNeonAuthRateLimiter(resolveNeonAuthRateLimitConfig());

  const handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const requestUrl = createUpgradeUrl(request);

    if (!requestUrl || requestUrl.pathname !== NEON_GATEWAY_WS_PATH) {
      socket.destroy();
      return;
    }

    // Browser-CSRF boundary: when an allowlist is configured, reject upgrades
    // from origins not on it. No allowlist or no Origin header -> allowed
    // (opt-in enforcement, non-breaking for node/CLI clients without an Origin).
    if (
      !isNeonGatewayUpgradeOriginAllowed({
        origin: readUpgradeOrigin(request.headers.origin),
        allowedOrigins
      })
    ) {
      socket.destroy();
      return;
    }

    // Reject upgrades beyond the per-IP pre-auth budget before allocating a
    // WebSocket. The reserved slot is released when this connection closes.
    if (!preauthBudget.acquire(readNeonPreauthRemoteAddress(request))) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  };

  webSocketServer.on("connection", (webSocket, request: IncomingMessage) => {
    handleNeonGatewayWebSocketConnection(
      webSocket,
      options,
      preauthBudget,
      readNeonPreauthRemoteAddress(request),
      authRateLimiter
    );
  });
  const handleServerClose = (): void => {
    server.off("upgrade", handleUpgrade);
    webSocketServer.close();
  };

  server.on("upgrade", handleUpgrade);
  server.once("close", handleServerClose);

  return {
    path: NEON_GATEWAY_WS_PATH,
    server: webSocketServer,
    close: async () => {
      server.off("upgrade", handleUpgrade);
      server.off("close", handleServerClose);
      await closeWebSocketServer(webSocketServer);
    }
  };
}

const handshakeTimeoutMsEnvKey = "NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS";
export const NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Pre-connect handshake timeout: a socket that receives the challenge but never
 * sends `connect` is force-closed after this window (hardening against sockets
 * that open and idle). Env override, positive integer only.
 */
export function resolveNeonGatewayHandshakeTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[handshakeTimeoutMsEnvKey];
  if (raw === undefined) {
    return NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS;
}

function clearNeonGatewayHandshakeTimer(state: INeonGatewayWebSocketConnectionState): void {
  if (state.handshakeTimer !== undefined) {
    clearTimeout(state.handshakeTimer);
    state.handshakeTimer = undefined;
  }
}

const keepaliveIntervalMsEnvKey = "NEON_GATEWAY_KEEPALIVE_INTERVAL_MS";
export const NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS = 25_000;

/**
 * Server keepalive ping interval. After a client connects the server pings it
 * periodically so dead/half-open sockets surface and intermediaries keep the
 * connection warm. Env override, positive integer only.
 */
export function resolveNeonGatewayKeepaliveIntervalMs(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[keepaliveIntervalMsEnvKey];
  if (raw === undefined) {
    return NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS;
}

function clearNeonGatewayKeepaliveTimer(state: INeonGatewayWebSocketConnectionState): void {
  if (state.keepaliveTimer !== undefined) {
    clearInterval(state.keepaliveTimer);
    state.keepaliveTimer = undefined;
  }
}

function handleNeonGatewayWebSocketConnection(
  webSocket: WebSocket,
  options: INeonGatewayWebSocketAttachOptions,
  preauthBudget: INeonPreauthConnectionBudget,
  remoteAddress: string,
  authRateLimiter: INeonAuthRateLimiter
): void {
  const state: INeonGatewayWebSocketConnectionState = {
    challengeNonce: cryptoRandomId(),
    connected: false,
    connId: cryptoRandomId(),
    role: "operator",
    scopes: NEON_GATEWAY_DEFAULT_OPERATOR_SCOPES,
    floodGuard: createNeonUnauthorizedFloodGuard(resolveNeonGatewayMaxUnauthorizedFrames()),
    remoteAddress,
    authRateLimiter
  };
  const unsubscribe = options.runtime.subscribe((event) => {
    if (state.connected) {
      sendJson(webSocket, event);
    }
  });

  // Release the pre-auth slot exactly once when the socket goes away (close and
  // error can both fire; guard against the double release).
  let preauthReleased = false;
  const releasePreauthSlot = (): void => {
    if (!preauthReleased) {
      preauthReleased = true;
      preauthBudget.release(remoteAddress);
    }
  };

  webSocket.on("error", () => {
    unsubscribe();
    releasePreauthSlot();
    clearNeonGatewayHandshakeTimer(state);
    clearNeonGatewayKeepaliveTimer(state);
  });
  webSocket.on("close", () => {
    unsubscribe();
    releasePreauthSlot();
    clearNeonGatewayHandshakeTimer(state);
    clearNeonGatewayKeepaliveTimer(state);
  });
  webSocket.on("message", (data) => {
    void handleNeonGatewayWebSocketMessage(webSocket, options, state, rawDataToString(data));
  });

  // Force-close a socket that receives the challenge but never connects. The
  // timer is unref'd so it never keeps the process alive, and is cleared on
  // connect/close/error.
  const handshakeTimer = setTimeout(() => {
    if (!state.connected) {
      try {
        webSocket.close(1008, "handshake timeout");
      } catch {
        // The socket may already be closing; nothing to do.
      }
    }
  }, resolveNeonGatewayHandshakeTimeoutMs());
  handshakeTimer.unref();
  state.handshakeTimer = handshakeTimer;

  sendJson(webSocket, createNeonGatewayConnectChallenge(state.challengeNonce));
}

/**
 * Send a rejection frame and enforce the per-connection flood guard. Every
 * rejected frame is counted; once the limit is reached the socket is closed
 * with 1008 so a peer cannot hold a connection open while spamming rejections.
 */
function rejectNeonGatewayFrame(
  webSocket: WebSocket,
  state: INeonGatewayWebSocketConnectionState,
  frameId: string,
  error: Parameters<typeof createNeonGatewayErrorResponseFrame>[1]
): void {
  sendJson(webSocket, createNeonGatewayErrorResponseFrame(frameId, error));
  if (state.floodGuard.register()) {
    try {
      webSocket.close(1008, "too many unauthorized requests");
    } catch {
      // The socket may already be closing; nothing to do.
    }
  }
}

async function handleNeonGatewayWebSocketMessage(
  webSocket: WebSocket,
  options: INeonGatewayWebSocketAttachOptions,
  state: INeonGatewayWebSocketConnectionState,
  raw: string
): Promise<void> {
  let frame: ReturnType<typeof parseNeonGatewayFrameJson>;

  try {
    frame = parseNeonGatewayFrameJson(raw);
  } catch {
    rejectNeonGatewayFrame(webSocket, state, "unknown", {
      code: "NEON_GATEWAY_BAD_FRAME",
      message: "Invalid Neonika Gateway frame",
      retryable: false
    });
    return;
  }

  if (frame.type !== "req") {
    return;
  }

  try {
    if (frame.method === "connect") {
      const connectParams = readConnectParams(frame.params);
      if (connectParams.nonce !== state.challengeNonce) {
        rejectNeonGatewayFrame(webSocket, state, frame.id, {
          code: "NEON_GATEWAY_AUTH_DENIED",
          message: "Neonika Gateway connect challenge nonce missing or invalid",
          retryable: false
        });
        return;
      }

      // Enforce the declared minimum client protocol version. A client that
      // declares a version below the floor is provably incompatible and is
      // rejected; a client that declares no version is left to connect
      // (backward-compatible, matches the prior no-enforcement behavior).
      if (
        connectParams.clientVersion !== undefined &&
        connectParams.clientVersion < NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION
      ) {
        rejectNeonGatewayFrame(webSocket, state, frame.id, {
          code: "NEON_GATEWAY_CLIENT_VERSION_MISMATCH",
          message: `Neonika Gateway requires client protocol version >= ${NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION}`,
          retryable: false
        });
        return;
      }

      // Z305: cross-connection auth-failure rate limit. Locked IPs are
      // rejected before the credential check; loopback is exempt so local
      // clients never lock out. Real-time clock here (unit tests inject it).
      const authNow = Date.now();
      const rateDecision = state.authRateLimiter.check(state.remoteAddress, authNow);
      if (!rateDecision.allowed) {
        rejectNeonGatewayFrame(webSocket, state, frame.id, {
          code: "NEON_GATEWAY_RATE_LIMITED",
          message: `Too many failed connect attempts; retry after ${rateDecision.retryAfterMs}ms`,
          retryable: true
        });
        return;
      }

      // Z303: shared-token connect auth. Backward-compatible — no configured
      // token + loopback stays authorized (today's Shadow behaviour); once
      // NEON_GATEWAY_HTTP_MUTATION_TOKEN is set the connect frame must present
      // it. Reuses the HTTP mutation token + loopback helpers so the two
      // surfaces never drift.
      const connectAuth = resolveNeonGatewayConnectAuth({
        presentedToken: connectParams.authToken,
        remoteAddress: state.remoteAddress
      });
      if (connectAuth.state !== "authorized") {
        state.authRateLimiter.recordFailure(state.remoteAddress, authNow);
        rejectNeonGatewayFrame(webSocket, state, frame.id, {
          code: "NEON_GATEWAY_AUTH_DENIED",
          message: "Neonika Gateway connect requires a valid credential",
          retryable: false
        });
        return;
      }
      state.authRateLimiter.reset(state.remoteAddress);

      state.connected = true;
      clearNeonGatewayHandshakeTimer(state);
      const keepaliveTimer = setInterval(() => {
        try {
          webSocket.ping();
        } catch {
          // The socket may already be closing; nothing to do.
        }
      }, resolveNeonGatewayKeepaliveIntervalMs());
      keepaliveTimer.unref();
      state.keepaliveTimer = keepaliveTimer;
      state.role = connectParams.role;
      state.scopes = connectParams.scopes;
      sendJson(
        webSocket,
        createNeonGatewaySuccessResponseFrame(
          frame.id,
          createNeonGatewayHelloOk({
            snapshot: options.runtime.getSnapshot(),
            connId: state.connId,
            role: state.role,
            scopes: state.scopes
          })
        )
      );
      sendConnectReplayOrSnapshot(webSocket, options, connectParams);
      return;
    }

    if (!state.connected) {
      rejectNeonGatewayFrame(webSocket, state, frame.id, {
        code: "NEON_GATEWAY_NOT_CONNECTED",
        message: "Send connect before RPC requests",
        retryable: true
      });
      return;
    }

    const authorization = authorizeGatewayRpc(frame.method, state);
    if (!authorization.allowed) {
      rejectNeonGatewayFrame(webSocket, state, frame.id, {
        code: "NEON_GATEWAY_SCOPE_DENIED",
        message: `Missing scope for Neonika Gateway RPC: ${authorization.missingScope ?? "operator.read"}`,
        retryable: false
      });
      return;
    }

    sendJson(
      webSocket,
      createNeonGatewaySuccessResponseFrame(frame.id, await resolveGatewayRpcPayload(frame, options))
    );
  } catch (error) {
    sendJson(
      webSocket,
      createNeonGatewayErrorResponseFrame(frame.id, {
        code: "NEON_GATEWAY_RPC_ERROR",
        message: error instanceof Error ? error.message : "Neonika Gateway RPC failed",
        retryable: false
      })
    );
  }
}

function sendConnectReplayOrSnapshot(
  webSocket: WebSocket,
  options: INeonGatewayWebSocketAttachOptions,
  params: INeonGatewayConnectParams
): void {
  const replayFrames = params.lastSeq === undefined ? [] : options.runtime.getEventsAfter(params.lastSeq);

  if (replayFrames.length === 0) {
    sendJson(webSocket, options.runtime.createFrame("neon.gateway.snapshot"));
    return;
  }

  for (const replayFrame of replayFrames) {
    sendJson(webSocket, replayFrame);
  }
}

async function resolveGatewayRpcPayload(
  frame: INeonGatewayRequestFrame,
  options: INeonGatewayWebSocketAttachOptions
): Promise<unknown> {
  const limit = readRpcLimit(frame.params);

  switch (frame.method) {
    case "gateway.status":
      return await readNeonGatewayStatus(options.projectRoot);
    case "gateway.runs":
      return {
        runs: await readNeonGatewayRuns(options.projectRoot, limit ? { maxRuns: limit } : {})
      };
    case "gateway.lifecycle":
      return options.runtime.getSnapshot();
    case "gateway.routes":
      return await createNeonGatewayRouteInspectionSnapshot(options.projectRoot);
    case "chat.conversations":
      return await createNeonChatSnapshot(options.projectRoot, limit ? { maxRuns: limit } : {});
    case "sessions.list":
      return await createNeonSessionsSnapshot(options.projectRoot, limit ? { maxRuns: limit } : {});
    case "activity.list":
      return await createNeonActivitySnapshot(
        options.projectRoot,
        limit ? { maxRuns: limit, maxEntries: limit } : {}
      );
    case "replay.get": {
      const runId = readRpcTextParam(frame.params, "runId");
      const sessionKey = readRpcTextParam(frame.params, "sessionKey");
      const conversationId = readRpcTextParam(frame.params, "conversationId");
      const channelId = readRpcTextParam(frame.params, "channelId");

      return await createNeonReplaySnapshot(options.projectRoot, {
        ...(limit ? { maxRuns: limit } : {}),
        ...(runId ? { runId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(channelId ? { channelId } : {})
      });
    }
    case "delivery.queue":
      return await createNeonDeliveryQueueSnapshot(
        options.projectRoot,
        limit ? { maxCandidates: limit } : {}
      );
    case "delivery.approvals":
      return {
        approvals: await readNeonDeliveryApprovalRecords(
          options.projectRoot,
          limit ? { maxApprovals: limit } : {}
        )
      };
    case "delivery.approval.record":
      return await recordNeonDeliveryApproval(options.projectRoot, frame.params);
    case "run.ack.set":
      return await recordNeonOperatorAck(options.projectRoot, frame.params);
    case "cutover.status":
      return await createNeonCutoverGateSnapshot(options.projectRoot);
    case "mirror.evidence":
      return await createNeonMirrorEvidenceSnapshot(options.projectRoot, limit ? { maxRecords: limit } : {});
    case "agents.list":
      return createNeonAgentsSnapshot((await loadNeonAgentProfiles(options.projectRoot)).profiles);
    case "skills.list":
      return await createNeonSkillInventorySnapshot(options.projectRoot);
    case "extensions.list":
      return await createNeonExtensionInventorySnapshot(options.projectRoot);
    case "doctor.status":
      return await createNeonDoctorSnapshot(options.projectRoot);
    case "onboarding.status":
      return await createNeonOnboardingSnapshot(options.projectRoot);
    case "missionControl.gateway": {
      const [runs, discordCockpit] = await Promise.all([
        readNeonGatewayRuns(options.projectRoot, limit ? { maxRuns: limit } : {}),
        readNeonMissionControlDiscordCockpitSnapshot(options.projectRoot)
      ]);

      return await createLiveNeonMissionControlGatewaySnapshot(
        options.projectRoot,
        await readNeonGatewayStatus(options.projectRoot),
        runs,
        { discordCockpit }
      );
    }
    case "workboard.cards.list":
    case "workboard.cards.read":
    case "workboard.cards.stats":
    case "workboard.cards.create":
    case "workboard.cards.claim":
    case "workboard.cards.heartbeat":
    case "workboard.cards.complete":
    case "workboard.cards.block":
    case "workboard.cards.dispatch":
      return await runNeonWorkboardGatewayMethod(options.projectRoot, frame.method, frame.params);
    default:
      throw new Error(`Unsupported Neonika Gateway RPC method: ${frame.method}`);
  }
}

function readRpcLimit(params: unknown): number | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const value = params["limit"] ?? params["maxRuns"] ?? params["maxEntries"] ?? params["maxCandidates"];

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return undefined;
  }

  return Math.min(value, 200);
}

function readRpcTextParam(params: unknown, key: string): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }

  const value = params[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed ? trimmed : undefined;
}

function readConnectParams(params: unknown): INeonGatewayConnectParams {
  if (!isRecord(params)) {
    return {
      nonce: "",
      role: "operator",
      scopes: NEON_GATEWAY_DEFAULT_OPERATOR_SCOPES
    };
  }

  const nonce = readConnectNonce(params["nonce"] ?? params["challengeNonce"]);
  const role = readConnectRole(params["role"]);
  const scopes = readConnectScopes(params["scopes"], role);
  const lastSeq = readConnectLastSeq(params["lastSeq"] ?? params["sinceSeq"]);
  const clientVersion = readConnectClientVersion(params);
  const authToken = readConnectAuthToken(params);

  return {
    nonce,
    role,
    scopes,
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    ...(authToken === undefined ? {} : { authToken })
  };
}

function readConnectAuthToken(params: Record<string, unknown>): string | undefined {
  const auth = params["auth"];
  if (isRecord(auth)) {
    const nested = auth["token"];
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  const direct = params["authToken"] ?? params["token"];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  return undefined;
}

function readConnectNonce(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim();
}

function readConnectRole(input: unknown): INeonGatewayHelloOkAuth["role"] {
  if (input === "agent" || input === "node" || input === "operator") {
    return input;
  }

  return "operator";
}

function readConnectScopes(
  input: unknown,
  role: INeonGatewayHelloOkAuth["role"]
): readonly string[] {
  if (input === undefined) {
    return role === "operator" ? NEON_GATEWAY_DEFAULT_OPERATOR_SCOPES : [];
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return [...new Set(input.filter(isNonEmptyString).map((scope) => scope.trim()))].slice(0, 32);
}

function readConnectLastSeq(input: unknown): number | undefined {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    return undefined;
  }

  return input;
}

// Reads the client-declared protocol version from any of the accepted shapes
// (clientVersion / protocolVersion / client.version). Absent or malformed ->
// undefined, which leaves the connection un-gated (backward compatible).
function readConnectClientVersion(params: Record<string, unknown>): number | undefined {
  const direct = params["clientVersion"] ?? params["protocolVersion"];
  if (typeof direct === "number" && Number.isSafeInteger(direct) && direct >= 0) {
    return direct;
  }
  const client = params["client"];
  if (isRecord(client)) {
    const nested = client["version"];
    if (typeof nested === "number" && Number.isSafeInteger(nested) && nested >= 0) {
      return nested;
    }
  }
  return undefined;
}

// Browser-CSRF origin allowlist for the WS upgrade. Opt-in: configured via
// NEON_GATEWAY_ALLOWED_ORIGINS (comma-separated). Empty -> no enforcement.
export function resolveNeonGatewayAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  const raw = env["NEON_GATEWAY_ALLOWED_ORIGINS"];
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function isNeonGatewayUpgradeOriginAllowed(params: {
  readonly origin: string | undefined;
  readonly allowedOrigins: readonly string[];
}): boolean {
  // No configured allowlist -> enforcement off (backward compatible).
  if (params.allowedOrigins.length === 0) {
    return true;
  }
  // No Origin header -> non-browser client (node ws / CLI), not a CSRF vector.
  if (params.origin === undefined || params.origin === "") {
    return true;
  }
  return params.allowedOrigins.includes(params.origin);
}

function readUpgradeOrigin(input: string | string[] | undefined): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input[0];
  }
  return undefined;
}

function authorizeGatewayRpc(
  method: string,
  state: INeonGatewayWebSocketConnectionState
): INeonGatewayRpcAuthorization {
  if (neonGatewayReadRpcMethods.has(method)) {
    return authorizeOperatorScopedRpc(state, NEON_GATEWAY_READ_COMPATIBLE_SCOPES, "operator.read");
  }

  if (neonGatewayApprovalRpcMethods.has(method)) {
    return authorizeOperatorScopedRpc(state, NEON_GATEWAY_APPROVAL_COMPATIBLE_SCOPES, "operator.approvals");
  }

  if (neonGatewayWriteRpcMethods.has(method)) {
    return authorizeOperatorScopedRpc(state, NEON_GATEWAY_WRITE_COMPATIBLE_SCOPES, "operator.write");
  }

  return {
    allowed: false,
    missingScope: "operator.read"
  };
}

function authorizeOperatorScopedRpc(
  state: INeonGatewayWebSocketConnectionState,
  compatibleScopes: ReadonlySet<string>,
  missingScope: string
): INeonGatewayRpcAuthorization {
  if (state.role !== "operator") {
    return {
      allowed: false,
      missingScope
    };
  }

  if (state.scopes.some((scope) => compatibleScopes.has(scope))) {
    return { allowed: true };
  }

  return {
    allowed: false,
    missingScope
  };
}

function createUpgradeUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", "ws://127.0.0.1");
  } catch {
    return null;
  }
}

/**
 * Whether a socket's buffered outbound bytes exceed the slow-consumer ceiling.
 * A peer that cannot drain its buffer would otherwise grow it without bound.
 */
export function isNeonGatewaySlowConsumer(
  bufferedAmount: number,
  maxBufferedBytes: number = NEON_GATEWAY_MAX_BUFFERED_BYTES
): boolean {
  return bufferedAmount > maxBufferedBytes;
}

function sendJson(webSocket: WebSocket, payload: unknown): void {
  if (webSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  // Slow-consumer backpressure: close (1008) instead of letting an undrained
  // send buffer grow unbounded (mirrors upstream server-broadcast).
  if (isNeonGatewaySlowConsumer(webSocket.bufferedAmount)) {
    try {
      webSocket.close(1008, "slow consumer");
    } catch {
      // The socket may already be closing; nothing to do.
    }
    return;
  }

  webSocket.send(JSON.stringify(payload));
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return data.toString("utf8");
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) {
    client.terminate();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function cryptoRandomId(): string {
  return randomUUID();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
