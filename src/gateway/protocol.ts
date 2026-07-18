import { randomUUID } from "node:crypto";

import type { INeonGatewayRuntimeSnapshot, TNeonGatewayRuntimeEventName } from "./lifecycle.js";

export const NEON_GATEWAY_PROTOCOL_VERSION = 1;
export const NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION = 1;
export const NEON_GATEWAY_WS_PATH = "/api/neon-gateway/ws";
export const NEON_GATEWAY_PROTOCOL_PATH = "/api/neon-gateway/protocol";
export const NEON_GATEWAY_MAX_PAYLOAD_BYTES = 1_048_576;
export const NEON_GATEWAY_MAX_BUFFERED_BYTES = 4_194_304;

export const neonGatewayProtocolMethods = [
  "connect",
  "gateway.status",
  "gateway.runs",
  "gateway.lifecycle",
  "gateway.routes",
  "chat.conversations",
  "sessions.list",
  "activity.list",
  "replay.get",
  "delivery.queue",
  "delivery.approvals",
  "delivery.approval.record",
  "cutover.status",
  "mirror.evidence",
  "agents.list",
  "skills.list",
  "extensions.list",
  "doctor.status",
  "onboarding.status",
  "missionControl.gateway",
  "run.ack.set",
  "workboard.cards.list",
  "workboard.cards.read",
  "workboard.cards.stats",
  "workboard.cards.create",
  "workboard.cards.claim",
  "workboard.cards.heartbeat",
  "workboard.cards.complete",
  "workboard.cards.block",
  "workboard.cards.dispatch"
] as const;

export const neonGatewayProtocolEvents = [
  "connect.challenge",
  "neon.gateway.starting",
  "neon.gateway.ready",
  "neon.gateway.snapshot",
  "neon.gateway.heartbeat",
  "neon.gateway.closing",
  "neon.gateway.closed"
] as const;

export type TNeonGatewayProtocolMethod = (typeof neonGatewayProtocolMethods)[number];
export type TNeonGatewayProtocolEvent =
  | (typeof neonGatewayProtocolEvents)[number]
  | TNeonGatewayRuntimeEventName;

export interface INeonGatewayFrameError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export interface INeonGatewayStateVersion {
  readonly lifecycle?: number;
  readonly presence?: number;
  readonly health?: number;
}

export interface INeonGatewayRequestFrame {
  readonly type: "req";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface INeonGatewayResponseFrame {
  readonly type: "res";
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: INeonGatewayFrameError;
}

export interface INeonGatewayEventFrame {
  readonly type: "event";
  readonly event: string;
  readonly payload?: unknown;
  readonly seq?: number;
  readonly stateVersion?: INeonGatewayStateVersion;
}

export type TNeonGatewayFrame =
  | INeonGatewayRequestFrame
  | INeonGatewayResponseFrame
  | INeonGatewayEventFrame;

export interface INeonGatewayHelloOkAuth {
  readonly role: "operator" | "agent" | "node";
  readonly scopes: readonly string[];
  readonly issuedAtMs: number;
  readonly deviceToken?: string;
}

export interface INeonGatewayHelloOk {
  readonly type: "hello-ok";
  readonly protocol: typeof NEON_GATEWAY_PROTOCOL_VERSION;
  readonly server: {
    readonly version: string;
    readonly connId: string;
  };
  readonly features: {
    readonly methods: readonly string[];
    readonly events: readonly string[];
  };
  readonly snapshot: INeonGatewayRuntimeSnapshot;
  readonly auth: INeonGatewayHelloOkAuth;
  readonly policy: {
    readonly maxPayload: number;
    readonly maxBufferedBytes: number;
    readonly tickIntervalMs: number;
    readonly outboundDelivery: "suppressed-until-canary";
  };
}

export interface INeonGatewayProtocolSnapshot {
  readonly generatedAt: string;
  readonly source: "neonika";
  readonly referenceImplementation: "gateway-protocol";
  readonly protocol: {
    readonly version: typeof NEON_GATEWAY_PROTOCOL_VERSION;
    readonly minClientVersion: typeof NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION;
    readonly transport: "websocket-json-rpc";
    readonly eventFrame: "event";
    readonly requestFrame: "req";
    readonly responseFrame: "res";
  };
  readonly endpoints: {
    readonly webSocketPath: typeof NEON_GATEWAY_WS_PATH;
    readonly protocolPath: typeof NEON_GATEWAY_PROTOCOL_PATH;
    readonly snapshotPath: INeonGatewayRuntimeSnapshot["protocol"]["snapshotPath"];
    readonly eventStreamPath: INeonGatewayRuntimeSnapshot["protocol"]["eventStreamPath"];
  };
  readonly features: {
    readonly methods: readonly string[];
    readonly events: readonly string[];
  };
  readonly auth: {
    readonly role: INeonGatewayHelloOkAuth["role"];
    readonly scopes: readonly string[];
  };
  readonly policy: INeonGatewayHelloOk["policy"];
  readonly hello: INeonGatewayHelloOk;
}

interface ICreateNeonGatewayHelloOkOptions {
  readonly snapshot: INeonGatewayRuntimeSnapshot;
  readonly connId?: string;
  readonly issuedAtMs?: number;
  readonly role?: INeonGatewayHelloOkAuth["role"];
  readonly scopes?: readonly string[];
  readonly methods?: readonly string[];
  readonly events?: readonly string[];
}

export interface ICreateNeonGatewayProtocolSnapshotOptions {
  readonly snapshot: INeonGatewayRuntimeSnapshot;
  readonly connId?: string;
  readonly now?: () => Date;
}

export interface INeonGatewaySequenceGap {
  readonly expected: number;
  readonly received: number;
}

export function createNeonGatewayConnectChallenge(
  nonce: string = randomUUID(),
  now: () => Date = () => new Date()
): INeonGatewayEventFrame {
  return createNeonGatewayEventFrame({
    event: "connect.challenge",
    payload: {
      nonce,
      ts: now().getTime()
    }
  });
}

export function createNeonGatewayHelloOk(
  options: ICreateNeonGatewayHelloOkOptions
): INeonGatewayHelloOk {
  const methods = options.methods ?? neonGatewayProtocolMethods;
  const events = options.events ?? neonGatewayProtocolEvents;
  const role = options.role ?? "operator";
  const scopes = options.scopes ?? ["operator.read", "operator.write", "operator.approvals"];

  return {
    type: "hello-ok",
    protocol: NEON_GATEWAY_PROTOCOL_VERSION,
    server: {
      version: "neonika/0.1.0",
      connId: options.connId ?? randomUUID()
    },
    features: {
      methods,
      events
    },
    snapshot: options.snapshot,
    auth: {
      role,
      scopes,
      issuedAtMs: options.issuedAtMs ?? Date.now()
    },
    policy: {
      maxPayload: NEON_GATEWAY_MAX_PAYLOAD_BYTES,
      maxBufferedBytes: NEON_GATEWAY_MAX_BUFFERED_BYTES,
      tickIntervalMs: options.snapshot.protocol.heartbeatMs,
      outboundDelivery: "suppressed-until-canary"
    }
  };
}

export function createNeonGatewayProtocolSnapshot(
  options: ICreateNeonGatewayProtocolSnapshotOptions
): INeonGatewayProtocolSnapshot {
  const now = options.now?.() ?? new Date();
  const hello = createNeonGatewayHelloOk({
    snapshot: options.snapshot,
    issuedAtMs: now.getTime(),
    ...(options.connId !== undefined ? { connId: options.connId } : {})
  });

  return {
    generatedAt: now.toISOString(),
    source: "neonika",
    referenceImplementation: "gateway-protocol",
    protocol: {
      version: NEON_GATEWAY_PROTOCOL_VERSION,
      minClientVersion: NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION,
      transport: "websocket-json-rpc",
      eventFrame: "event",
      requestFrame: "req",
      responseFrame: "res"
    },
    endpoints: {
      webSocketPath: NEON_GATEWAY_WS_PATH,
      protocolPath: NEON_GATEWAY_PROTOCOL_PATH,
      snapshotPath: options.snapshot.protocol.snapshotPath,
      eventStreamPath: options.snapshot.protocol.eventStreamPath
    },
    features: hello.features,
    auth: {
      role: hello.auth.role,
      scopes: hello.auth.scopes
    },
    policy: hello.policy,
    hello
  };
}

export function createNeonGatewayRequestFrame(
  id: string,
  method: string,
  params?: unknown
): INeonGatewayRequestFrame {
  return {
    type: "req",
    id,
    method,
    ...(params !== undefined ? { params } : {})
  };
}

export function createNeonGatewaySuccessResponseFrame(
  id: string,
  payload?: unknown
): INeonGatewayResponseFrame {
  return {
    type: "res",
    id,
    ok: true,
    ...(payload !== undefined ? { payload } : {})
  };
}

export function createNeonGatewayErrorResponseFrame(
  id: string,
  error: INeonGatewayFrameError
): INeonGatewayResponseFrame {
  return {
    type: "res",
    id,
    ok: false,
    error
  };
}

export function createNeonGatewayEventFrame(input: {
  readonly event: string;
  readonly payload?: unknown;
  readonly seq?: number;
  readonly stateVersion?: INeonGatewayStateVersion;
}): INeonGatewayEventFrame {
  return {
    type: "event",
    event: input.event,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.seq !== undefined ? { seq: input.seq } : {}),
    ...(input.stateVersion !== undefined ? { stateVersion: input.stateVersion } : {})
  };
}

export function parseNeonGatewayFrameJson(input: string): TNeonGatewayFrame {
  return parseNeonGatewayFrame(JSON.parse(input) as unknown);
}

export function parseNeonGatewayFrame(input: unknown): TNeonGatewayFrame {
  if (isNeonGatewayRequestFrame(input)) {
    return input;
  }
  if (isNeonGatewayResponseFrame(input)) {
    return input;
  }
  if (isNeonGatewayEventFrame(input)) {
    return input;
  }

  throw new Error("Invalid Neonika Gateway frame");
}

export function isNeonGatewayRequestFrame(input: unknown): input is INeonGatewayRequestFrame {
  if (!isRecord(input)) {
    return false;
  }

  return input["type"] === "req" && isNonEmptyString(input["id"]) && isNonEmptyString(input["method"]);
}

export function isNeonGatewayResponseFrame(input: unknown): input is INeonGatewayResponseFrame {
  if (!isRecord(input)) {
    return false;
  }

  if (input["type"] !== "res" || !isNonEmptyString(input["id"]) || typeof input["ok"] !== "boolean") {
    return false;
  }

  return input["error"] === undefined || isNeonGatewayFrameError(input["error"]);
}

export function isNeonGatewayEventFrame(input: unknown): input is INeonGatewayEventFrame {
  if (!isRecord(input)) {
    return false;
  }

  if (input["type"] !== "event" || !isNonEmptyString(input["event"])) {
    return false;
  }

  if (input["seq"] !== undefined && !isNonNegativeInteger(input["seq"])) {
    return false;
  }

  return input["stateVersion"] === undefined || isNeonGatewayStateVersion(input["stateVersion"]);
}

export function detectNeonGatewaySequenceGap(
  previousSeq: number | null,
  receivedSeq: number
): INeonGatewaySequenceGap | null {
  if (previousSeq === null || receivedSeq <= previousSeq + 1) {
    return null;
  }

  return {
    expected: previousSeq + 1,
    received: receivedSeq
  };
}

export function renderNeonGatewayProtocolReport(snapshot: INeonGatewayProtocolSnapshot): string {
  return [
    "Neonika Gateway Protocol",
    `Generated: ${snapshot.generatedAt}`,
    `Transport: ${snapshot.protocol.transport}`,
    `Version: ${snapshot.protocol.version} (min client ${snapshot.protocol.minClientVersion})`,
    `WebSocket: ${snapshot.endpoints.webSocketPath}`,
    `Protocol API: ${snapshot.endpoints.protocolPath}`,
    `Snapshot: ${snapshot.endpoints.snapshotPath}`,
    `Events: ${snapshot.endpoints.eventStreamPath}`,
    `Methods: ${snapshot.features.methods.length}`,
    `Event types: ${snapshot.features.events.length}`,
    `Auth role: ${snapshot.auth.role}`,
    `Scopes: ${snapshot.auth.scopes.join(", ")}`,
    `Delivery: ${snapshot.policy.outboundDelivery}`
  ].join("\n");
}

function isNeonGatewayFrameError(input: unknown): input is INeonGatewayFrameError {
  if (!isRecord(input)) {
    return false;
  }

  if (!isNonEmptyString(input["code"]) || !isNonEmptyString(input["message"])) {
    return false;
  }

  if (input["retryable"] !== undefined && typeof input["retryable"] !== "boolean") {
    return false;
  }

  return input["retryAfterMs"] === undefined || isNonNegativeInteger(input["retryAfterMs"]);
}

function isNeonGatewayStateVersion(input: unknown): input is INeonGatewayStateVersion {
  if (!isRecord(input)) {
    return false;
  }

  return (
    (input["lifecycle"] === undefined || isNonNegativeInteger(input["lifecycle"])) &&
    (input["presence"] === undefined || isNonNegativeInteger(input["presence"])) &&
    (input["health"] === undefined || isNonNegativeInteger(input["health"]))
  );
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonEmptyString(input: unknown): input is string {
  return typeof input === "string" && input.trim().length > 0;
}

function isNonNegativeInteger(input: unknown): input is number {
  return typeof input === "number" && Number.isInteger(input) && input >= 0;
}
