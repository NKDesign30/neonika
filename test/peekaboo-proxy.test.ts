import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  listenNeonPeekabooProxy,
  NEON_PEEKABOO_PROXY_MAX_JSON_BYTES,
  NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES,
  renderNeonPeekabooProxyShimScript,
  requestNeonPeekabooProxy,
  resolveNeonPeekabooProxySocketPath,
  resolveNeonPeekabooProxyTcpUrl
} from "../src/index.js";

describe("Neonika Peekaboo proxy", () => {
  it("resolves a project-local Unix socket path", () => {
    assert.equal(
      resolveNeonPeekabooProxySocketPath("/tmp/neonika"),
      join("/tmp/neonika", "state", "gateway", "peekaboo-proxy.sock")
    );
    assert.equal(resolveNeonPeekabooProxyTcpUrl(), "tcp://127.0.0.1:18790");
  });

  it("proxies argv to a fixed binary over a local Unix socket", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-peekaboo-proxy-"));
    const socketPath = join(tmpdir(), `neon-peekaboo-proxy-${process.pid}-${Date.now()}.sock`);
    const handle = await listenNeonPeekabooProxy({
      projectRoot,
      socketPath,
      tcpPort: 0,
      targetBin: "/bin/echo",
      env: {}
    });

    try {
      const response = await requestNeonPeekabooProxy({
        socketPath,
        args: ["hello", "peekaboo"]
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.stdout, "hello peekaboo\n");
      assert.equal(response.stderr, "");
      assert.match(handle.tcpUrl, /^tcp:\/\/127\.0\.0\.1:\d+$/u);
    } finally {
      await handle.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("bounds large child stdout and stderr with utf8-safe tails", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-peekaboo-proxy-"));
    const socketPath = join(tmpdir(), `neon-peekaboo-proxy-${process.pid}-${Date.now()}-large.sock`);
    const handle = await listenNeonPeekabooProxy({
      projectRoot,
      socketPath,
      tcpPort: 0,
      targetBin: process.execPath,
      env: process.env
    });

    try {
      const response = await requestNeonPeekabooProxy({
        socketPath,
        args: [
          "-e",
          [
            "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '✅');",
            "process.stderr.write('y'.repeat(2 * 1024 * 1024) + '✅');"
          ].join("")
        ]
      });

      assert.equal(response.exitCode, 0);
      assert.ok(Buffer.byteLength(response.stdout, "utf8") <= NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES);
      assert.ok(Buffer.byteLength(response.stderr, "utf8") <= NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES);
      assert.match(response.stdout, /^\.\.\. \(truncated\) /u);
      assert.match(response.stderr, /^\.\.\. \(truncated\) /u);
      assert.match(response.stdout, /✅$/u);
      assert.match(response.stderr, /✅$/u);
    } finally {
      await handle.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects oversized proxy responses before timeout", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => {
        socket.write("x".repeat(NEON_PEEKABOO_PROXY_MAX_JSON_BYTES + 1));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as AddressInfo;

    try {
      await assert.rejects(
        () =>
          requestNeonPeekabooProxy({
            tcpUrl: `tcp://127.0.0.1:${address.port}`,
            args: ["oversize"],
            timeoutMs: 5_000
          }),
        /response exceeded/u
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("proxies argv over loopback TCP for sandboxed app-server turns", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-peekaboo-proxy-"));
    const socketPath = join(tmpdir(), `neon-peekaboo-proxy-${process.pid}-${Date.now()}-tcp.sock`);
    const handle = await listenNeonPeekabooProxy({
      projectRoot,
      socketPath,
      tcpPort: 0,
      targetBin: "/bin/echo",
      env: {}
    });

    try {
      const response = await requestNeonPeekabooProxy({
        tcpUrl: handle.tcpUrl,
        args: ["tcp", "peekaboo"]
      });

      assert.equal(response.exitCode, 0);
      assert.equal(response.stdout, "tcp peekaboo\n");
      assert.equal(response.stderr, "");
    } finally {
      await handle.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a shim that prefers loopback TCP, then socket, then the real Peekaboo binary", () => {
    const script = renderNeonPeekabooProxyShimScript({
      projectRoot: "/Users/operator/neonika",
      socketPath: "/Users/operator/neonika/state/gateway/peekaboo-proxy.sock",
      tcpUrl: "tcp://127.0.0.1:18790",
      nodePath: "/opt/homebrew/bin/node",
      targetBin: "/opt/homebrew/bin/peekaboo"
    });

    assert.match(script, /NEON_PEEKABOO_PROXY_URL/u);
    assert.match(script, /NEON_PEEKABOO_PROXY_SOCKET/u);
    assert.match(script, /peekaboo-proxy-client "\$@"/u);
    assert.match(script, /exec "\/opt\/homebrew\/bin\/peekaboo" "\$@"/u);
    assert.doesNotMatch(script, /token|secret|jq -r/iu);
  });
});
