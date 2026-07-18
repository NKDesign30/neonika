import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonPeekabooAppServerEnv,
  getNeonPeekabooBridgeSocketCandidates,
  renderNeonPeekabooBridgeSocketExportShell,
  resolveNeonPeekabooBin,
  resolveNeonPeekabooBridgeSocket,
  resolveNeonPeekabooPathPrepend
} from "../src/index.js";

describe("Neonika Peekaboo runtime", () => {
  it("mirrors Peekaboo/upstream bridge socket discovery candidates", () => {
    const candidates = getNeonPeekabooBridgeSocketCandidates("/Users/operator");

    assert.deepEqual(candidates, [
      join("/Users/operator", "Library", "Application Support", "Peekaboo", "bridge.sock"),
      join("/Users/operator", "Library", "Application Support", "Claude", "bridge.sock"),
      join("/Users/operator", "Library", "Application Support", "OpenClaw", "bridge.sock"),
      join("/Users/operator", "Library", "Application Support", "clawdbot", "bridge.sock"),
      join("/Users/operator", "Library", "Application Support", "clawdis", "bridge.sock"),
      join("/Users/operator", "Library", "Application Support", "moltbot", "bridge.sock")
    ]);
  });

  it("prefers explicit bridge socket env without probing the filesystem", () => {
    const resolution = resolveNeonPeekabooBridgeSocket({
      env: {
        HOME: "/Users/operator",
        PEEKABOO_BRIDGE_SOCKET: "/tmp/custom-bridge.sock"
      },
      exists: () => {
        throw new Error("explicit env must not probe candidates");
      }
    });

    assert.equal(resolution.source, "env");
    assert.equal(resolution.socketPath, "/tmp/custom-bridge.sock");
  });

  it("selects the first existing bridge socket candidate", () => {
    const selected = join("/Users/operator", "Library", "Application Support", "OpenClaw", "bridge.sock");
    const resolution = resolveNeonPeekabooBridgeSocket({
      homeDir: "/Users/operator",
      env: {},
      exists: (candidate) => candidate === selected
    });

    assert.equal(resolution.source, "candidate");
    assert.equal(resolution.socketPath, selected);
  });

  it("builds app-server env with bin, PATH prepend, and bridge socket when available", () => {
    const selected = join("/Users/operator", "Library", "Application Support", "clawdbot", "bridge.sock");
    const env = createNeonPeekabooAppServerEnv({
      basePath: "/safe/bin:/usr/bin:/bin",
      pathPrefix: ["/op-shim"],
      env: {
        HOME: "/Users/operator",
        PEEKABOO_BIN: "/custom/bin/peekaboo"
      },
      exists: (candidate) => candidate === selected
    });

    assert.equal(env.PEEKABOO_BIN, "/custom/bin/peekaboo");
    assert.equal(env.PEEKABOO_BRIDGE_SOCKET, selected);
    assert.match(env.PATH, /^\/op-shim:\/custom\/bin:\/safe\/bin:\/usr\/bin:\/bin$/u);
    assert.equal(resolveNeonPeekabooBin({ PEEKABOO_BIN: "peekaboo" }), "peekaboo");
    assert.equal(resolveNeonPeekabooPathPrepend("peekaboo"), undefined);
  });

  it("renders a launchd-safe bridge socket export snippet", () => {
    const snippet = renderNeonPeekabooBridgeSocketExportShell("/Users/operator");

    assert.match(snippet, /PEEKABOO_BRIDGE_SOCKET/u);
    assert.match(snippet, /Application Support\/OpenClaw\/bridge\.sock/u);
    assert.match(snippet, /Application Support\/clawdbot\/bridge\.sock/u);
    assert.match(snippet, /export PEEKABOO_BRIDGE_SOCKET="\$socket"; break; fi; done; fi/u);
    assert.doesNotMatch(snippet, /token|secret|jq -r/iu);
  });
});
