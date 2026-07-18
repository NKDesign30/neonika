import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import WebSocket, { type RawData as WsRawData } from "ws";

import {
  listenNeonGatewayHttpServer,
  parseNeonGatewayFrameJson,
  resolveNeonGatewayConnectAuth,
  type TNeonGatewayFrame
} from "../src/index.js";

const TOKEN_ENV = "NEON_GATEWAY_HTTP_MUTATION_TOKEN";
const TEST_TOKEN = "connect-token-SHOULD-NEVER-LEAK-xyz789";

describe("Neonika Gateway connect-credential auth (Z303)", () => {
  it("authorizes loopback with no configured token (backward-compatible)", () => {
    const decision = resolveNeonGatewayConnectAuth({ env: {}, remoteAddress: "127.0.0.1" });
    assert.equal(decision.state, "authorized");
    assert.equal(decision.mode, "loopback-compat");
  });

  it("requires auth for a remote peer when no token is configured", () => {
    const decision = resolveNeonGatewayConnectAuth({ env: {}, remoteAddress: "203.0.113.7" });
    assert.equal(decision.state, "auth-required");
  });

  it("requires auth when remote address is unknown and no token configured", () => {
    const decision = resolveNeonGatewayConnectAuth({ env: {}, remoteAddress: undefined });
    assert.equal(decision.state, "auth-required");
  });

  it("authorizes the matching token regardless of remote address", () => {
    const decision = resolveNeonGatewayConnectAuth({
      env: { [TOKEN_ENV]: TEST_TOKEN },
      presentedToken: TEST_TOKEN,
      remoteAddress: "203.0.113.7"
    });
    assert.equal(decision.state, "authorized");
    assert.equal(decision.mode, "configured-token");
  });

  it("denies a wrong token", () => {
    const decision = resolveNeonGatewayConnectAuth({
      env: { [TOKEN_ENV]: TEST_TOKEN },
      presentedToken: "wrong",
      remoteAddress: "127.0.0.1"
    });
    assert.equal(decision.state, "auth-denied");
  });

  it("requires auth when a token is configured but none is presented", () => {
    const decision = resolveNeonGatewayConnectAuth({
      env: { [TOKEN_ENV]: TEST_TOKEN },
      remoteAddress: "127.0.0.1"
    });
    assert.equal(decision.state, "auth-required");
  });

  it("connects on loopback with no configured token (live backward-compat)", async () => {
    const previous = process.env[TOKEN_ENV];
    delete process.env[TOKEN_ENV];
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-connect-auth-"));
    try {
      const response = await runConnect(projectRoot, {});
      assert.equal(response.type, "res");
      assert.equal(response.ok, true);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
      restoreEnv(previous);
    }
  });

  it("denies a live connect with AUTH_DENIED when a token is configured but absent", async () => {
    const previous = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = TEST_TOKEN;
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-connect-auth-"));
    try {
      const response = await runConnect(projectRoot, {});
      assert.equal(response.type, "res");
      assert.equal(response.ok, false);
      assert.equal(response.errorCode, "NEON_GATEWAY_AUTH_DENIED");
      assert.doesNotMatch(response.serialized, /SHOULD-NEVER-LEAK/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
      restoreEnv(previous);
    }
  });

  it("connects live with the matching token in auth.token", async () => {
    const previous = process.env[TOKEN_ENV];
    process.env[TOKEN_ENV] = TEST_TOKEN;
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-connect-auth-"));
    try {
      const response = await runConnect(projectRoot, { auth: { token: TEST_TOKEN } });
      assert.equal(response.type, "res");
      assert.equal(response.ok, true);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
      restoreEnv(previous);
    }
  });
});

function restoreEnv(previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[TOKEN_ENV];
  } else {
    process.env[TOKEN_ENV] = previous;
  }
}

/**
 * Open a gateway socket, read the challenge, send a connect frame with the
 * given extra params, and resolve with the connect response frame. Always
 * tears the socket + server down.
 */
interface IConnectResult {
  readonly type: string;
  readonly ok: boolean;
  readonly errorCode: string | undefined;
  readonly serialized: string;
}

async function runConnect(
  projectRoot: string,
  extraParams: Record<string, unknown>
): Promise<IConnectResult> {
  const handle = await listenNeonGatewayHttpServer({ projectRoot }, { host: "127.0.0.1", port: 0 });
  const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
  const reader = createFrameReader(socket);
  try {
    await waitForWebSocketOpen(socket);
    const challenge = await reader.read();
    if (challenge.type !== "event") {
      throw new Error(`expected connect challenge event, got ${challenge.type}`);
    }
    const nonce = (challenge.payload as { readonly nonce?: unknown }).nonce;
    assert.equal(typeof nonce, "string");
    socket.send(
      JSON.stringify({ type: "req", id: "connect-auth-test", method: "connect", params: { nonce, ...extraParams } })
    );
    const frame = await reader.read();
    const record = frame as {
      readonly type?: unknown;
      readonly ok?: unknown;
      readonly error?: { readonly code?: unknown };
    };
    return {
      type: typeof record.type === "string" ? record.type : "",
      ok: record.ok === true,
      errorCode: typeof record.error?.code === "string" ? record.error.code : undefined,
      serialized: JSON.stringify(frame)
    };
  } finally {
    reader.close();
    socket.close(1000, "test complete");
    await handle.close();
  }
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === socket.OPEN) {
      resolve();
      return;
    }
    socket.once("open", () => resolve());
    socket.once("error", (error) => reject(error));
  });
}

interface IFrameReader {
  read(): Promise<TNeonGatewayFrame>;
  close(): void;
}

function createFrameReader(socket: WebSocket): IFrameReader {
  const queue: TNeonGatewayFrame[] = [];
  const pending: Array<{ resolve: (f: TNeonGatewayFrame) => void; reject: (e: unknown) => void }> = [];
  const onMessage = (data: WsRawData): void => {
    try {
      const frame = parseNeonGatewayFrameJson(data.toString());
      const waiter = pending.shift();
      if (waiter) {
        waiter.resolve(frame);
      } else {
        queue.push(frame);
      }
    } catch (error) {
      const waiter = pending.shift();
      if (waiter) {
        waiter.reject(error);
      }
    }
  };
  socket.on("message", onMessage);
  return {
    read(): Promise<TNeonGatewayFrame> {
      const frame = queue.shift();
      if (frame) {
        return Promise.resolve(frame);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("frame read timeout")), 3000);
        timer.unref();
        pending.push({
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
          reject
        });
      });
    },
    close(): void {
      socket.off("message", onMessage);
    }
  };
}
