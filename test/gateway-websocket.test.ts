import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import WebSocket, { type RawData as WsRawData } from "ws";

import {
  listenNeonGatewayHttpServer,
  parseNeonGatewayFrameJson,
  writeNeonCutoverPromotion,
  type TNeonGatewayFrame
} from "../src/index.js";
import {
  isNeonGatewayUpgradeOriginAllowed,
  resolveNeonGatewayAllowedOrigins
} from "../src/gateway/webSocketServer.js";

describe("Neonika Gateway WebSocket transport", () => {
  it("performs challenge, hello, snapshot event, and read-only RPC", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);

        const challenge = await reader.read();
        const nonce = readConnectChallengeNonce(challenge);

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-test",
            method: "connect",
            params: {
              nonce
            }
          })
        );

        const hello = await reader.read();
        const snapshot = await reader.read();

        assert.equal(hello.type, "res");
        assert.equal(hello.id, "connect-test");
        assert.equal(hello.ok, true);
        assert.ok(isHelloPayload(hello.payload));
        assert.equal(hello.payload.type, "hello-ok");
        assert.equal(hello.payload.snapshot.state, "ready");
        assert.equal(hello.payload.auth.role, "operator");
        assert.ok(hello.payload.auth.scopes.includes("operator.read"));
        assert.equal(snapshot.type, "event");
        assert.equal(snapshot.event, "neon.gateway.snapshot");

        socket.send(
          JSON.stringify({
            type: "req",
            id: "status-test",
            method: "gateway.status"
          })
        );

        const status = await reader.read();
        assert.equal(status.type, "res");
        assert.equal(status.id, "status-test");
        assert.equal(status.ok, true);
        assert.ok(isStatusPayload(status.payload));
        assert.equal(status.payload.runCount, 0);

        socket.send(
          JSON.stringify({
            type: "req",
            id: "replay-test",
            method: "replay.get",
            params: {
              limit: 1
            }
          })
        );

        const replay = await reader.read();
        assert.equal(replay.type, "res");
        assert.equal(replay.id, "replay-test");
        assert.equal(replay.ok, true);
        assert.ok(isReplayPayload(replay.payload));
        assert.equal(replay.payload.state, "empty");
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("returns the authoritative persisted outbound arm from missionControl.gateway", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));
    const previousOutbound = process.env["NEON_CUTOVER_OUTBOUND_ENABLED"];
    const previousStage = process.env["NEON_CUTOVER_STAGE"];
    const previousApproval = process.env["NEON_CUTOVER_CANARY_APPROVED"];
    const previousChannels = process.env["NEON_CUTOVER_CANARY_CHANNELS"];
    const previousToken = process.env["NEON_DISCORD_BOT_TOKEN"];
    const token = "websocket-token-must-not-leak";

    try {
      process.env["NEON_CUTOVER_STAGE"] = "canary";
      process.env["NEON_CUTOVER_CANARY_APPROVED"] = "ready";
      process.env["NEON_CUTOVER_OUTBOUND_ENABLED"] = "disabled";
      process.env["NEON_CUTOVER_CANARY_CHANNELS"] = "900000000000000005";
      process.env["NEON_DISCORD_BOT_TOKEN"] = token;
      await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
        NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005"
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(JSON.stringify({
          type: "req",
          id: "connect-mission-control",
          method: "connect",
          params: { nonce }
        }));
        await reader.read();
        await reader.read();

        socket.send(JSON.stringify({
          type: "req",
          id: "mission-control-gateway",
          method: "missionControl.gateway"
        }));

        const response = await reader.read();
        assert.equal(response.type, "res");
        assert.equal(response.id, "mission-control-gateway");
        assert.equal(response.ok, true);
        assert.ok(isMissionControlGatewayPayload(response.payload));
        assert.equal(response.payload.canaryPosture.outboundEnabled, true);
        assert.equal(response.payload.canaryPosture.ready, true);
        assert.doesNotMatch(JSON.stringify(response.payload), new RegExp(token, "u"));
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      restoreEnv("NEON_CUTOVER_OUTBOUND_ENABLED", previousOutbound);
      restoreEnv("NEON_CUTOVER_STAGE", previousStage);
      restoreEnv("NEON_CUTOVER_CANARY_APPROVED", previousApproval);
      restoreEnv("NEON_CUTOVER_CANARY_CHANNELS", previousChannels);
      restoreEnv("NEON_DISCORD_BOT_TOKEN", previousToken);
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects connect requests without the echoed challenge nonce", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-missing-nonce",
            method: "connect"
          })
        );

        const missingNonce = await reader.read();
        assert.equal(missingNonce.type, "res");
        assert.equal(missingNonce.id, "connect-missing-nonce");
        assert.equal(missingNonce.ok, false);
        assert.equal(missingNonce.error?.code, "NEON_GATEWAY_AUTH_DENIED");

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-wrong-nonce",
            method: "connect",
            params: {
              nonce: "not-the-issued-nonce"
            }
          })
        );

        const wrongNonce = await reader.read();
        assert.equal(wrongNonce.type, "res");
        assert.equal(wrongNonce.id, "connect-wrong-nonce");
        assert.equal(wrongNonce.ok, false);
        assert.equal(wrongNonce.error?.code, "NEON_GATEWAY_AUTH_DENIED");
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects a connect that declares a client protocol version below the minimum", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        // A declared version below the floor (min 1) is provably incompatible.
        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-old-version",
            method: "connect",
            params: {
              nonce,
              clientVersion: 0
            }
          })
        );

        const rejected = await reader.read();
        assert.equal(rejected.type, "res");
        assert.equal(rejected.id, "connect-old-version");
        assert.equal(rejected.ok, false);
        assert.equal(rejected.error?.code, "NEON_GATEWAY_CLIENT_VERSION_MISMATCH");

        // A version at or above the floor connects normally (nonce unchanged).
        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-ok-version",
            method: "connect",
            params: {
              nonce,
              clientVersion: 1
            }
          })
        );

        const hello = await reader.read();
        assert.equal(hello.type, "res");
        assert.equal(hello.id, "connect-ok-version");
        assert.equal(hello.ok, true);
        assert.ok(isHelloPayload(hello.payload));
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("replays lifecycle frames after the requested sequence", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-replay",
            method: "connect",
            params: {
              nonce,
              lastSeq: 0
            }
          })
        );

        const hello = await reader.read();
        const replay = await reader.read();

        assert.equal(hello.type, "res");
        assert.equal(hello.id, "connect-replay");
        assert.equal(hello.ok, true);
        assert.equal(replay.type, "event");
        assert.equal(replay.event, "neon.gateway.ready");
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("honors explicit connect scopes and denies scoped RPCs without read access", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-no-scope",
            method: "connect",
            params: {
              nonce,
              scopes: []
            }
          })
        );

        const hello = await reader.read();
        await reader.read();

        assert.equal(hello.type, "res");
        assert.ok(isHelloPayload(hello.payload));
        assert.deepEqual(hello.payload.auth.scopes, []);

        socket.send(
          JSON.stringify({
            type: "req",
            id: "status-no-scope",
            method: "gateway.status"
          })
        );

        const response = await reader.read();
        assert.equal(response.type, "res");
        assert.equal(response.id, "status-no-scope");
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, "NEON_GATEWAY_SCOPE_DENIED");
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("requires approval scope for delivery approval mutation RPCs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-read-only",
            method: "connect",
            params: {
              nonce,
              scopes: ["operator.read"]
            }
          })
        );

        await reader.read();
        await reader.read();

        socket.send(
          JSON.stringify({
            type: "req",
            id: "approval-denied",
            method: "delivery.approval.record",
            params: {
              candidateId: "missing-candidate",
              decision: "approve-canary"
            }
          })
        );

        const response = await reader.read();
        assert.equal(response.type, "res");
        assert.equal(response.id, "approval-denied");
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, "NEON_GATEWAY_SCOPE_DENIED");
        assert.match(response.error?.message ?? "", /operator\.approvals/);
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("denies unknown RPC methods by default", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-unknown-rpc",
            method: "connect",
            params: {
              nonce
            }
          })
        );

        await reader.read();
        await reader.read();

        socket.send(
          JSON.stringify({
            type: "req",
            id: "unknown-rpc",
            method: "gateway.unknown"
          })
        );

        const response = await reader.read();
        assert.equal(response.type, "res");
        assert.equal(response.id, "unknown-rpc");
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, "NEON_GATEWAY_SCOPE_DENIED");
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects RPC requests before connect", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        await reader.read();

        socket.send(
          JSON.stringify({
            type: "req",
            id: "status-before-connect",
            method: "gateway.status"
          })
        );

        const response = await reader.read();
        assert.equal(response.type, "res");
        assert.equal(response.id, "status-before-connect");
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, "NEON_GATEWAY_NOT_CONNECTED");
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("denies the run.ack.set write mutation to a read-only operator", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-read-only-write",
            method: "connect",
            params: { nonce, scopes: ["operator.read"] }
          })
        );

        await reader.read();
        await reader.read();

        socket.send(
          JSON.stringify({
            type: "req",
            id: "ack-denied",
            method: "run.ack.set",
            params: { runId: "neon-shadow-test", ackedBy: "operator" }
          })
        );

        const response = await reader.read();
        assert.equal(response.type, "res");
        assert.equal(response.id, "ack-denied");
        assert.equal(response.ok, false);
        assert.equal(response.error?.code, "NEON_GATEWAY_SCOPE_DENIED");
        assert.match(response.error?.message ?? "", /operator\.write/);
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("accepts run.ack.set with operator.write and stays idempotent over the wire", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-gateway-ws-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const reader = createGatewayWebSocketFrameReader(socket);

      try {
        await waitForWebSocketOpen(socket);
        const nonce = readConnectChallengeNonce(await reader.read());

        socket.send(
          JSON.stringify({
            type: "req",
            id: "connect-write",
            method: "connect",
            params: { nonce, scopes: ["operator.write"] }
          })
        );

        await reader.read();
        await reader.read();

        const ackParams = { runId: "neon-shadow-ack", ackedBy: "operator", note: "looked at it" };

        socket.send(JSON.stringify({ type: "req", id: "ack-first", method: "run.ack.set", params: ackParams }));
        const first = await reader.read();
        assert.equal(first.type, "res");
        assert.equal(first.ok, true);
        assert.ok(isOperatorAckRecordPayload(first.payload));
        assert.equal(first.payload.ack.runId, "neon-shadow-ack");
        assert.equal(first.payload.created, true);
        assert.equal(first.payload.safety.outboundSent, false);

        socket.send(JSON.stringify({ type: "req", id: "ack-second", method: "run.ack.set", params: ackParams }));
        const second = await reader.read();
        assert.equal(second.type, "res");
        assert.equal(second.ok, true);
        assert.ok(isOperatorAckRecordPayload(second.payload));
        assert.equal(second.payload.created, false);
      } finally {
        reader.close();
        socket.close(1000, "test complete");
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function readConnectChallengeNonce(frame: TNeonGatewayFrame): string {
  assert.equal(frame.type, "event");
  assert.equal(frame.event, "connect.challenge");

  const payload = frame.payload;
  assert.equal(typeof payload, "object");
  assert.notEqual(payload, null);
  assert.equal(Array.isArray(payload), false);

  const nonce = (payload as { readonly nonce?: unknown }).nonce;
  if (typeof nonce !== "string") {
    throw new TypeError("Gateway connect challenge nonce must be a string");
  }
  assert.ok(nonce.trim().length > 0);

  return nonce;
}

interface IGatewayWebSocketFrameReader {
  read(): Promise<TNeonGatewayFrame>;
  close(): void;
}

interface IPendingGatewayWebSocketFrame {
  readonly resolve: (frame: TNeonGatewayFrame) => void;
  readonly reject: (error: unknown) => void;
}

function createGatewayWebSocketFrameReader(socket: WebSocket): IGatewayWebSocketFrameReader {
  const queue: TNeonGatewayFrame[] = [];
  const pending: IPendingGatewayWebSocketFrame[] = [];

  const onMessage = (data: WsRawData): void => {
    try {
      const frame = parseNeonGatewayFrameJson(rawDataToString(data));
      const waiter = pending.shift();

      if (waiter) {
        waiter.resolve(frame);
        return;
      }

      queue.push(frame);
    } catch (error) {
      const waiter = pending.shift();

      if (waiter) {
        waiter.reject(error);
      }
    }
  };
  const onError = (error: Error): void => {
    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  };

  socket.on("message", onMessage);
  socket.on("error", onError);

  return {
    read: () => {
      const frame = queue.shift();

      if (frame) {
        return Promise.resolve(frame);
      }

      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    close: () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      for (const waiter of pending.splice(0)) {
        waiter.reject(new Error("Gateway WebSocket reader closed"));
      }
    }
  };
}

function rawDataToString(data: WsRawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return data.toString("utf8");
}

function isHelloPayload(
  input: unknown
): input is {
  readonly type: "hello-ok";
  readonly snapshot: { readonly state: string };
  readonly auth: { readonly role: string; readonly scopes: readonly string[] };
} {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (input as { readonly type?: unknown }).type === "hello-ok" &&
    typeof (input as { readonly snapshot?: { readonly state?: unknown } }).snapshot?.state === "string" &&
    typeof (input as { readonly auth?: { readonly role?: unknown } }).auth?.role === "string" &&
    Array.isArray((input as { readonly auth?: { readonly scopes?: unknown } }).auth?.scopes)
  );
}

function isOperatorAckRecordPayload(
  input: unknown
): input is {
  readonly ack: { readonly runId: string; readonly ackedBy: string };
  readonly created: boolean;
  readonly safety: { readonly outboundSent: boolean };
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const ack = (input as { readonly ack?: unknown }).ack;
  const safety = (input as { readonly safety?: unknown }).safety;

  return (
    typeof ack === "object" &&
    ack !== null &&
    typeof (ack as { readonly runId?: unknown }).runId === "string" &&
    typeof (ack as { readonly ackedBy?: unknown }).ackedBy === "string" &&
    typeof (input as { readonly created?: unknown }).created === "boolean" &&
    typeof safety === "object" &&
    safety !== null &&
    typeof (safety as { readonly outboundSent?: unknown }).outboundSent === "boolean"
  );
}

function isMissionControlGatewayPayload(
  input: unknown
): input is {
  readonly canaryPosture: {
    readonly outboundEnabled: boolean;
    readonly ready: boolean;
  };
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  const canaryPosture = (input as { readonly canaryPosture?: unknown }).canaryPosture;
  return (
    typeof canaryPosture === "object" &&
    canaryPosture !== null &&
    typeof (canaryPosture as { readonly outboundEnabled?: unknown }).outboundEnabled === "boolean" &&
    typeof (canaryPosture as { readonly ready?: unknown }).ready === "boolean"
  );
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function isStatusPayload(input: unknown): input is { readonly runCount: number } {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { readonly runCount?: unknown }).runCount === "number"
  );
}

function isReplayPayload(input: unknown): input is { readonly state: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    typeof (input as { readonly state?: unknown }).state === "string"
  );
}

describe("Neonika Gateway WS upgrade origin policy", () => {
  it("resolves a comma-separated allowlist and trims entries", () => {
    const resolved = resolveNeonGatewayAllowedOrigins({
      NEON_GATEWAY_ALLOWED_ORIGINS: " https://control.neon ,, http://localhost:5173 "
    });

    assert.deepEqual(resolved, ["https://control.neon", "http://localhost:5173"]);
  });

  it("treats an unset or blank allowlist as no enforcement", () => {
    assert.deepEqual(resolveNeonGatewayAllowedOrigins({}), []);
    assert.deepEqual(resolveNeonGatewayAllowedOrigins({ NEON_GATEWAY_ALLOWED_ORIGINS: "   " }), []);
  });

  it("allows every origin when no allowlist is configured (backward compatible)", () => {
    assert.equal(
      isNeonGatewayUpgradeOriginAllowed({ origin: "https://evil.example", allowedOrigins: [] }),
      true
    );
  });

  it("allows origin-less upgrades even with an allowlist (node/CLI clients)", () => {
    const allowedOrigins = ["https://control.neon"];

    assert.equal(isNeonGatewayUpgradeOriginAllowed({ origin: undefined, allowedOrigins }), true);
    assert.equal(isNeonGatewayUpgradeOriginAllowed({ origin: "", allowedOrigins }), true);
  });

  it("permits a listed origin and rejects an unlisted one when enforced", () => {
    const allowedOrigins = ["https://control.neon", "http://localhost:5173"];

    assert.equal(
      isNeonGatewayUpgradeOriginAllowed({ origin: "https://control.neon", allowedOrigins }),
      true
    );
    assert.equal(
      isNeonGatewayUpgradeOriginAllowed({ origin: "https://evil.example", allowedOrigins }),
      false
    );
  });
});
