// Neon SDK — Gateway Client surface.
//
// Curated, stable contract for a client that talks to the Neon Gateway over the
// WS-JSON-RPC + SSE wire: frame shapes, the method/event vocabulary, protocol
// constants, and the frame builders/parsers/guards needed to encode requests
// and decode responses/events. This is a thin re-export facade over
// `gateway/protocol.ts` and the lifecycle event-stream frame — it adds no
// behavior and moves no code, mirroring how upstream `packages/gateway-client`
// re-exports `src/gateway-client/*`.
//
// Curation is the point: only the wire contract is surfaced here, not server
// internals. Implementations live in their original modules.

export {
  NEON_GATEWAY_MAX_BUFFERED_BYTES,
  NEON_GATEWAY_MAX_PAYLOAD_BYTES,
  NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION,
  NEON_GATEWAY_PROTOCOL_PATH,
  NEON_GATEWAY_PROTOCOL_VERSION,
  NEON_GATEWAY_WS_PATH,
  createNeonGatewayConnectChallenge,
  createNeonGatewayErrorResponseFrame,
  createNeonGatewayEventFrame,
  createNeonGatewayHelloOk,
  createNeonGatewayProtocolSnapshot,
  createNeonGatewayRequestFrame,
  createNeonGatewaySuccessResponseFrame,
  detectNeonGatewaySequenceGap,
  isNeonGatewayEventFrame,
  isNeonGatewayRequestFrame,
  isNeonGatewayResponseFrame,
  neonGatewayProtocolEvents,
  neonGatewayProtocolMethods,
  parseNeonGatewayFrame,
  parseNeonGatewayFrameJson,
  renderNeonGatewayProtocolReport
} from "../gateway/protocol.js";

export type {
  ICreateNeonGatewayProtocolSnapshotOptions,
  INeonGatewayEventFrame,
  INeonGatewayFrameError,
  INeonGatewayHelloOk,
  INeonGatewayHelloOkAuth,
  INeonGatewayProtocolSnapshot,
  INeonGatewayRequestFrame,
  INeonGatewayResponseFrame,
  INeonGatewaySequenceGap,
  INeonGatewayStateVersion,
  TNeonGatewayFrame,
  TNeonGatewayProtocolEvent,
  TNeonGatewayProtocolMethod
} from "../gateway/protocol.js";

// SSE event-stream frame a client receives from the gateway runtime lifecycle.
export {
  NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS,
  formatNeonGatewayEventStreamFrame
} from "../gateway/lifecycle.js";

export type {
  INeonGatewayRuntimeEventFrame,
  TNeonGatewayRuntimeEventName
} from "../gateway/lifecycle.js";
