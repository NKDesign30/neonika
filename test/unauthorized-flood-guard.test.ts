import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import WebSocket from "ws";

import {
  NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES,
  createNeonUnauthorizedFloodGuard,
  listenNeonGatewayHttpServer,
  resolveNeonGatewayMaxUnauthorizedFrames
} from "../src/index.js";

describe("Neon Gateway unauthorized-frame flood guard", () => {
  it("resolves the limit from env and falls back to the default on junk", () => {
    assert.equal(resolveNeonGatewayMaxUnauthorizedFrames({}), NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES);
    assert.equal(resolveNeonGatewayMaxUnauthorizedFrames({ NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES: "5" }), 5);
    assert.equal(
      resolveNeonGatewayMaxUnauthorizedFrames({ NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES: "0" }),
      NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES
    );
    assert.equal(
      resolveNeonGatewayMaxUnauthorizedFrames({ NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES: "-4" }),
      NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES
    );
    assert.equal(
      resolveNeonGatewayMaxUnauthorizedFrames({ NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES: "nope" }),
      NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES
    );
  });

  it("signals close exactly when the count reaches the limit", () => {
    const guard = createNeonUnauthorizedFloodGuard(3);
    assert.equal(guard.register(), false);
    assert.equal(guard.count, 1);
    assert.equal(guard.register(), false);
    assert.equal(guard.count, 2);
    assert.equal(guard.register(), true);
    assert.equal(guard.count, 3);
    // Stays tripped on subsequent frames.
    assert.equal(guard.register(), true);
    assert.equal(guard.count, 4);
  });

  it("clamps a junk injected limit to the default", () => {
    const guard = createNeonUnauthorizedFloodGuard(0);
    let tripped = false;
    for (let i = 0; i < NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES - 1; i++) {
      tripped = guard.register();
    }
    assert.equal(tripped, false);
    assert.equal(guard.register(), true);
  });

  it("closes the WebSocket with 1008 once the unauthorized-frame limit is hit", async () => {
    const previous = process.env["NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES"];
    process.env["NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES"] = "3";
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-flood-"));

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );
      const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);

      try {
        const closeCode = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("socket did not close on flood")), 5000);
          timer.unref();
          socket.on("open", () => {
            // RPC before connect -> NOT_CONNECTED rejection per frame. The
            // limit is 3, so the 3rd rejection trips the guard and the server
            // closes the socket; extra frames are harmless if they race in.
            for (let i = 0; i < 5; i += 1) {
              socket.send(JSON.stringify({ type: "req", id: `flood-${i}`, method: "gateway.status" }));
            }
          });
          socket.on("close", (code: number) => {
            clearTimeout(timer);
            resolve(code);
          });
          socket.on("error", () => {
            // A 1008 close can surface as a socket error in ws; the close
            // handler resolves the assertion, so swallow it here.
          });
        });

        assert.equal(closeCode, 1008);
      } finally {
        socket.close();
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
      if (previous === undefined) {
        delete process.env["NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES"];
      } else {
        process.env["NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES"] = previous;
      }
    }
  });
});
