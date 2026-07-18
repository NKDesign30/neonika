import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WebSocket from "ws";

import {
  NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  listenNeonGatewayHttpServer,
  resolveNeonGatewayHandshakeTimeoutMs
} from "../src/index.js";

test("resolveNeonGatewayHandshakeTimeoutMs uses the default and rejects junk", () => {
  assert.equal(resolveNeonGatewayHandshakeTimeoutMs({}), NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS);
  assert.equal(resolveNeonGatewayHandshakeTimeoutMs({ NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS: "200" }), 200);
  assert.equal(
    resolveNeonGatewayHandshakeTimeoutMs({ NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS: "0" }),
    NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS
  );
  assert.equal(
    resolveNeonGatewayHandshakeTimeoutMs({ NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS: "abc" }),
    NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS
  );
});

test("a socket that receives the challenge but never connects is force-closed (1008)", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-handshake-timeout-"));
  const prev = process.env["NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS"];
  process.env["NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS"] = "150";
  try {
    const handle = await listenNeonGatewayHttpServer({ projectRoot }, { host: "127.0.0.1", port: 0 });
    try {
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
      const closeCode = await new Promise<number>((resolve, reject) => {
        socket.on("close", (code) => resolve(code));
        socket.on("error", reject);
        const guard = setTimeout(() => reject(new Error("socket not closed within 2s")), 2000);
        guard.unref();
      });
      assert.equal(closeCode, 1008);
    } finally {
      await handle.close();
    }
  } finally {
    if (prev === undefined) {
      delete process.env["NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS"];
    } else {
      process.env["NEON_GATEWAY_HANDSHAKE_TIMEOUT_MS"] = prev;
    }
    await rm(projectRoot, { recursive: true, force: true });
  }
});
