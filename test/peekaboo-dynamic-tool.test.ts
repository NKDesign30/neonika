import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  executeNeonPeekabooDynamicToolCall,
  listenNeonPeekabooProxy,
  neonPeekabooDynamicToolSpec
} from "../src/index.js";

describe("Neon Peekaboo dynamic tool", () => {
  it("advertises a host-side peekaboo tool", () => {
    assert.equal(neonPeekabooDynamicToolSpec.name, "peekaboo");
    assert.match(neonPeekabooDynamicToolSpec.description, /Neon host/u);
    assert.doesNotMatch(JSON.stringify(neonPeekabooDynamicToolSpec), /token|secret|api_key/iu);
  });

  it("routes image requests through the local Peekaboo proxy", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-peekaboo-tool-"));
    const socketPath = join(tmpdir(), `neon-peekaboo-tool-${process.pid}-${Date.now()}.sock`);
    const handle = await listenNeonPeekabooProxy({
      projectRoot,
      socketPath,
      tcpPort: 0,
      targetBin: "/bin/echo",
      env: {}
    });

    try {
      const response = await executeNeonPeekabooDynamicToolCall(
        {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          tool: "peekaboo",
          arguments: {
            command: "image",
            mode: "screen",
            path: "screen.png"
          }
        },
        {
          projectRoot,
          tcpUrl: handle.tcpUrl,
          socketPath
        }
      );
      const item = response.contentItems[0];

      assert.equal(response.success, true);
      assert.ok(item && "type" in item && item.type === "inputText" && "text" in item);
      const text = item.text;
      assert.ok(typeof text === "string");
      assert.match(text, /stdout:\nimage --mode screen --path/u);
      assert.match(text, /screen\.png --json/u);
      assert.doesNotMatch(text, /token|secret|api_key/iu);
    } finally {
      await handle.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("fails closed for unknown tools", async () => {
    const response = await executeNeonPeekabooDynamicToolCall(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "shell"
      },
      {
        projectRoot: "/tmp/neonika"
      }
    );
    const item = response.contentItems[0];

    assert.equal(response.success, false);
    assert.ok(item && "type" in item && item.type === "inputText" && "text" in item);
    const text = item.text;
    assert.ok(typeof text === "string");
    assert.match(text, /Unknown Neon host tool/u);
  });
});
