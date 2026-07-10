export type TNeonGatewayRuntimeState = "starting" | "ready" | "closing" | "closed";

export type TNeonGatewayRuntimeEventName =
  | "neon.gateway.starting"
  | "neon.gateway.ready"
  | "neon.gateway.snapshot"
  | "neon.gateway.heartbeat"
  | "neon.gateway.closing"
  | "neon.gateway.closed";

export interface INeonGatewayRuntimeNetwork {
  readonly host?: string;
  readonly port?: number;
  readonly url?: string;
}

export interface INeonGatewayRuntimeTiming {
  readonly startedAt: string;
  readonly readyAt?: string;
  readonly closingAt?: string;
  readonly closedAt?: string;
  readonly uptimeMs: number;
}

export interface INeonGatewayRuntimeProtocol {
  readonly apiVersion: 1;
  readonly snapshotPath: "/api/neon-gateway/lifecycle";
  readonly eventStreamPath: "/api/neon-gateway/events";
  readonly eventStream: "sse";
  readonly heartbeatMs: number;
}

export interface INeonGatewayRuntimeSnapshot {
  readonly state: TNeonGatewayRuntimeState;
  readonly projectRoot: string;
  readonly process: {
    readonly pid: number;
    readonly platform: NodeJS.Platform;
    readonly node: string;
  };
  readonly network: INeonGatewayRuntimeNetwork;
  readonly timing: INeonGatewayRuntimeTiming;
  readonly protocol: INeonGatewayRuntimeProtocol;
  readonly eventSeq: number;
  readonly subscriberCount: number;
}

export interface INeonGatewayRuntimeEventFrame {
  readonly type: "event";
  readonly event: TNeonGatewayRuntimeEventName;
  readonly seq: number;
  readonly emittedAt: string;
  readonly stateVersion: {
    readonly lifecycle: number;
  };
  readonly payload: INeonGatewayRuntimeSnapshot;
}

export interface INeonGatewayRuntimeReadyInput {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

export interface INeonGatewayRuntimeController {
  readonly heartbeatMs: number;
  getSnapshot(): INeonGatewayRuntimeSnapshot;
  getEventsAfter(seq: number): readonly INeonGatewayRuntimeEventFrame[];
  createFrame(event: TNeonGatewayRuntimeEventName): INeonGatewayRuntimeEventFrame;
  markReady(input: INeonGatewayRuntimeReadyInput): INeonGatewayRuntimeEventFrame;
  markClosing(): INeonGatewayRuntimeEventFrame;
  markClosed(): INeonGatewayRuntimeEventFrame;
  subscribe(listener: (frame: INeonGatewayRuntimeEventFrame) => void): () => void;
}

interface INeonGatewayRuntimeMutableState {
  state: TNeonGatewayRuntimeState;
  network: INeonGatewayRuntimeNetwork;
  startedAtMs: number;
  startedAt: string;
  readyAt?: string;
  closingAt?: string;
  closedAt?: string;
  eventSeq: number;
  eventHistory: INeonGatewayRuntimeEventFrame[];
}

export const NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS = 5_000;
export const NEON_GATEWAY_EVENT_HISTORY_LIMIT = 200;

export function createNeonGatewayRuntimeController(
  projectRoot: string,
  options: {
    readonly now?: () => Date;
    readonly heartbeatMs?: number;
  } = {}
): INeonGatewayRuntimeController {
  const now = options.now ?? (() => new Date());
  const initialNow = now();
  const heartbeatMs = options.heartbeatMs ?? NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS;
  const state: INeonGatewayRuntimeMutableState = {
    state: "starting",
    network: {},
    startedAtMs: initialNow.getTime(),
    startedAt: initialNow.toISOString(),
    eventSeq: 0,
    eventHistory: []
  };
  const subscribers = new Set<(frame: INeonGatewayRuntimeEventFrame) => void>();

  const controller: INeonGatewayRuntimeController = {
    heartbeatMs,
    getSnapshot: () => createSnapshot(projectRoot, state, subscribers.size, heartbeatMs, now),
    getEventsAfter: (seq) => readEventsAfter(state, seq),
    createFrame: (event) => createFrame(projectRoot, state, subscribers.size, heartbeatMs, event, now),
    markReady: (input) => {
      state.state = "ready";
      state.network = {
        host: input.host,
        port: input.port,
        url: input.url
      };
      state.readyAt = now().toISOString();

      return emitFrame(
        projectRoot,
        state,
        subscribers,
        heartbeatMs,
        "neon.gateway.ready",
        now
      );
    },
    markClosing: () => {
      if (state.state !== "closed") {
        state.state = "closing";
        state.closingAt = now().toISOString();
      }

      return emitFrame(
        projectRoot,
        state,
        subscribers,
        heartbeatMs,
        "neon.gateway.closing",
        now
      );
    },
    markClosed: () => {
      state.state = "closed";
      state.closedAt = now().toISOString();

      return emitFrame(
        projectRoot,
        state,
        subscribers,
        heartbeatMs,
        "neon.gateway.closed",
        now
      );
    },
    subscribe: (listener) => {
      subscribers.add(listener);

      return () => {
        subscribers.delete(listener);
      };
    }
  };

  return controller;
}

export function formatNeonGatewayEventStreamFrame(
  frame: INeonGatewayRuntimeEventFrame
): string {
  return [
    `id: ${frame.seq}`,
    `event: ${frame.event}`,
    `data: ${JSON.stringify(frame)}`,
    "",
    ""
  ].join("\n");
}

function emitFrame(
  projectRoot: string,
  state: INeonGatewayRuntimeMutableState,
  subscribers: Set<(frame: INeonGatewayRuntimeEventFrame) => void>,
  heartbeatMs: number,
  event: TNeonGatewayRuntimeEventName,
  now: () => Date
): INeonGatewayRuntimeEventFrame {
  const frame = createFrame(projectRoot, state, subscribers.size, heartbeatMs, event, now);
  rememberFrame(state, frame);

  for (const subscriber of subscribers) {
    subscriber(frame);
  }

  return frame;
}

function createFrame(
  projectRoot: string,
  state: INeonGatewayRuntimeMutableState,
  subscriberCount: number,
  heartbeatMs: number,
  event: TNeonGatewayRuntimeEventName,
  now: () => Date
): INeonGatewayRuntimeEventFrame {
  state.eventSeq += 1;
  const seq = state.eventSeq;

  return {
    type: "event",
    event,
    seq,
    emittedAt: now().toISOString(),
    stateVersion: {
      lifecycle: seq
    },
    payload: createSnapshot(projectRoot, state, subscriberCount, heartbeatMs, now)
  };
}

function createSnapshot(
  projectRoot: string,
  state: INeonGatewayRuntimeMutableState,
  subscriberCount: number,
  heartbeatMs: number,
  now: () => Date
): INeonGatewayRuntimeSnapshot {
  return {
    state: state.state,
    projectRoot,
    process: {
      pid: process.pid,
      platform: process.platform,
      node: process.version
    },
    network: state.network,
    timing: {
      startedAt: state.startedAt,
      ...(state.readyAt ? { readyAt: state.readyAt } : {}),
      ...(state.closingAt ? { closingAt: state.closingAt } : {}),
      ...(state.closedAt ? { closedAt: state.closedAt } : {}),
      uptimeMs: Math.max(0, now().getTime() - state.startedAtMs)
    },
    protocol: {
      apiVersion: 1,
      snapshotPath: "/api/neon-gateway/lifecycle",
      eventStreamPath: "/api/neon-gateway/events",
      eventStream: "sse",
      heartbeatMs
    },
    eventSeq: state.eventSeq,
    subscriberCount
  };
}

function rememberFrame(
  state: INeonGatewayRuntimeMutableState,
  frame: INeonGatewayRuntimeEventFrame
): void {
  state.eventHistory.push(frame);

  if (state.eventHistory.length > NEON_GATEWAY_EVENT_HISTORY_LIMIT) {
    state.eventHistory.splice(0, state.eventHistory.length - NEON_GATEWAY_EVENT_HISTORY_LIMIT);
  }
}

function readEventsAfter(
  state: INeonGatewayRuntimeMutableState,
  seq: number
): readonly INeonGatewayRuntimeEventFrame[] {
  if (!Number.isInteger(seq) || seq < 0) {
    return [];
  }

  return state.eventHistory.filter((frame) => frame.seq > seq);
}
