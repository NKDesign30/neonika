import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  codexAppServerMethods,
  deriveCodexSessionKey,
  evaluateNeonBindingResume,
  fingerprintSessionKey,
  parseCodexThreadBinding,
  readCodexThreadBinding,
  resolveBindingPath,
  resolveHarnessStatePaths,
  validateStartOptions,
  writeCodexThreadBinding,
  type ICodexSessionBinding
} from "../src/index.js";

const bindingInput: ICodexSessionBinding = {
  channel: "discord",
  accountId: "default",
  guildId: "guild-1",
  channelId: "channel-1",
  threadId: "thread-1",
  agentId: "chaty",
  workspaceRoot: "/Users/operator/neon-projects/neonika",
  mode: "write"
};

describe("Codex app-server contract", () => {
  it("keeps protocol method names explicit", () => {
    assert.deepEqual(Object.values(codexAppServerMethods), [
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/unsubscribe",
      "turn/start",
      "turn/interrupt"
    ]);
  });

  it("validates transport-specific start options", () => {
    assert.doesNotThrow(() =>
      validateStartOptions({
        transport: "stdio",
        command: "codex",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
        clearEnv: ["OPENAI_API_KEY"]
      })
    );
    assert.throws(
      () => validateStartOptions({ transport: "websocket", headers: {}, clearEnv: [] }),
      /requires a URL/
    );
  });

  it("resolves Neon-owned state paths under the project root", () => {
    const paths = resolveHarnessStatePaths("/tmp/neonika");
    const sessionKey = deriveCodexSessionKey(bindingInput);
    const bindingPath = resolveBindingPath("/tmp/neonika", sessionKey);

    assert.equal(paths.harnessRoot, "/tmp/neonika/state/codex-harness");
    assert.match(bindingPath, /^\/tmp\/neonika\/state\/codex-harness\/bindings\//);
    assert.match(bindingPath, new RegExp(fingerprintSessionKey(sessionKey)));
    assert.doesNotMatch(bindingPath, /channel-1/);
    assert.doesNotMatch(bindingPath, /Users/);
  });

  it("round-trips thread bindings without persisting secret-looking values", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-contract-"));
    const sessionKey = deriveCodexSessionKey(bindingInput);
    const written = await writeCodexThreadBinding(projectRoot, {
      sessionKey,
      threadId: "codex-thread-1",
      cwd: bindingInput.workspaceRoot,
      model: "gpt-5.5",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      memoryState: "attached",
      baseInstructionsHash: "base-instructions-hash"
    });
    const read = await readCodexThreadBinding(projectRoot, sessionKey);
    const raw = await readFile(resolveBindingPath(projectRoot, sessionKey), "utf8");

    assert.equal(read?.threadId, "codex-thread-1");
    assert.equal(read?.memoryState, "attached");
    assert.equal(read?.baseInstructionsHash, "base-instructions-hash");
    assert.equal(read?.createdAt, written.createdAt);
    assert.doesNotMatch(raw, /TOKEN|SECRET|API_KEY|sk-/i);
  });

  it("blocks thread resume when base instructions drift", () => {
    const persisted = parseCodexThreadBinding({
      schemaVersion: 1,
      sessionKey: "session",
      threadId: "thread",
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      memoryState: "attached",
      baseInstructionsHash: "old-base",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:00:00.000Z"
    });

    assert.ok(persisted);

    const fresh = evaluateNeonBindingResume(persisted, {
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      baseInstructionsHash: "new-base"
    });
    const matching = evaluateNeonBindingResume(persisted, {
      cwd: "/tmp",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      baseInstructionsHash: "old-base"
    });

    assert.equal(fresh.matches, false);
    assert.deepEqual(fresh.drift, ["baseInstructions"]);
    assert.equal(matching.matches, true);
  });

  it("rejects malformed persisted bindings", () => {
    assert.equal(parseCodexThreadBinding({ schemaVersion: 1, threadId: "missing" }), undefined);
    assert.equal(
      parseCodexThreadBinding({
        schemaVersion: 1,
        sessionKey: "session",
        threadId: "thread",
        cwd: "/tmp",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        memoryState: "skipped",
        createdAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:00:00.000Z"
      })?.threadId,
      "thread"
    );
  });

  it("returns undefined for corrupted binding files", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-corrupt-binding-"));
    const sessionKey = deriveCodexSessionKey(bindingInput);
    const path = resolveBindingPath(projectRoot, sessionKey);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json", "utf8");

    assert.equal(await readCodexThreadBinding(projectRoot, sessionKey), undefined);
  });
});
