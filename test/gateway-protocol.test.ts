import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NEON_GATEWAY_MAX_BUFFERED_BYTES,
  NEON_GATEWAY_MAX_PAYLOAD_BYTES,
  NEON_GATEWAY_PROTOCOL_PATH,
  NEON_GATEWAY_PROTOCOL_VERSION,
  NEON_GATEWAY_WS_PATH,
  createNeonGatewayConnectChallenge,
  createNeonGatewayErrorResponseFrame,
  createNeonGatewayEventFrame,
  createNeonGatewayProtocolSnapshot,
  createNeonGatewayRequestFrame,
  createNeonGatewayRuntimeController,
  createNeonGatewaySuccessResponseFrame,
  detectNeonGatewaySequenceGap,
  isNeonGatewayEventFrame,
  isNeonGatewayRequestFrame,
  isNeonGatewayResponseFrame,
  parseNeonGatewayFrame,
  parseNeonGatewayFrameJson,
  renderNeonGatewayProtocolReport
} from "../src/index.js";

describe("Neon Gateway protocol", () => {
  it("builds an upstream-shaped hello contract with Neon policy", () => {
    const runtime = createNeonGatewayRuntimeController("/tmp/neonika", {
      heartbeatMs: 2_500,
      now: () => new Date("2026-06-01T10:00:00.000Z")
    });
    runtime.markReady({
      host: "127.0.0.1",
      port: 8797,
      url: "http://127.0.0.1:8797"
    });

    const snapshot = createNeonGatewayProtocolSnapshot({
      snapshot: runtime.getSnapshot(),
      connId: "conn-neon-test",
      now: () => new Date("2026-06-01T10:01:00.000Z")
    });

    assert.equal(snapshot.protocol.version, NEON_GATEWAY_PROTOCOL_VERSION);
    assert.equal(snapshot.protocol.transport, "websocket-json-rpc");
    assert.equal(snapshot.endpoints.webSocketPath, NEON_GATEWAY_WS_PATH);
    assert.equal(snapshot.endpoints.protocolPath, NEON_GATEWAY_PROTOCOL_PATH);
    assert.equal(snapshot.hello.type, "hello-ok");
    assert.equal(snapshot.hello.server.connId, "conn-neon-test");
    assert.equal(snapshot.hello.snapshot.state, "ready");
    assert.equal(snapshot.hello.policy.maxPayload, NEON_GATEWAY_MAX_PAYLOAD_BYTES);
    assert.equal(snapshot.hello.policy.maxBufferedBytes, NEON_GATEWAY_MAX_BUFFERED_BYTES);
    assert.equal(snapshot.hello.policy.tickIntervalMs, 2_500);
    assert.equal(snapshot.hello.policy.outboundDelivery, "suppressed-until-canary");
    assert.ok(snapshot.features.methods.includes("connect"));
    assert.ok(snapshot.features.methods.includes("delivery.queue"));
    assert.ok(snapshot.features.methods.includes("replay.get"));
    assert.ok(snapshot.features.events.includes("connect.challenge"));
    assert.match(renderNeonGatewayProtocolReport(snapshot), /Neon Gateway Protocol/);
  });

  it("parses request, response, and event frames without widening to loose shapes", () => {
    const request = createNeonGatewayRequestFrame("req-1", "gateway.status", { verbose: true });
    const success = createNeonGatewaySuccessResponseFrame("req-1", { ok: true });
    const failure = createNeonGatewayErrorResponseFrame("req-2", {
      code: "NEON_GATEWAY_DENIED",
      message: "Denied by policy",
      retryable: false
    });
    const event = createNeonGatewayEventFrame({
      event: "neon.gateway.ready",
      seq: 7,
      stateVersion: {
        lifecycle: 7
      }
    });

    assert.equal(parseNeonGatewayFrame(request).type, "req");
    assert.equal(parseNeonGatewayFrame(success).type, "res");
    assert.equal(parseNeonGatewayFrame(failure).type, "res");
    assert.equal(parseNeonGatewayFrame(event).type, "event");
    assert.ok(isNeonGatewayRequestFrame(request));
    assert.ok(isNeonGatewayResponseFrame(success));
    assert.ok(isNeonGatewayResponseFrame(failure));
    assert.ok(isNeonGatewayEventFrame(event));
    assert.equal(parseNeonGatewayFrameJson(JSON.stringify(request)).type, "req");
    assert.throws(() => parseNeonGatewayFrame({ type: "req", id: "", method: "gateway.status" }));
    assert.throws(() => parseNeonGatewayFrameJson("{"));
  });

  it("creates challenge frames and detects sequence gaps", () => {
    const challenge = createNeonGatewayConnectChallenge(
      "nonce-123",
      () => new Date("2026-06-01T10:02:00.000Z")
    );

    assert.equal(challenge.type, "event");
    assert.equal(challenge.event, "connect.challenge");
    assert.deepEqual(challenge.payload, {
      nonce: "nonce-123",
      ts: 1_780_308_120_000
    });
    assert.equal(detectNeonGatewaySequenceGap(null, 1), null);
    assert.equal(detectNeonGatewaySequenceGap(4, 5), null);
    assert.deepEqual(detectNeonGatewaySequenceGap(4, 8), {
      expected: 5,
      received: 8
    });
  });

  it("keeps a bounded lifecycle replay history for reconnects", () => {
    const runtime = createNeonGatewayRuntimeController("/tmp/neonika", {
      now: () => new Date("2026-06-01T10:03:00.000Z")
    });
    const ready = runtime.markReady({
      host: "127.0.0.1",
      port: 8797,
      url: "http://127.0.0.1:8797"
    });

    assert.deepEqual(runtime.getEventsAfter(0).map((frame) => frame.event), [
      "neon.gateway.ready"
    ]);
    assert.deepEqual(runtime.getEventsAfter(ready.seq), []);
    assert.deepEqual(runtime.getEventsAfter(-1), []);
  });
});
