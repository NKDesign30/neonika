import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  CodexStdioJsonRpcTransport,
  createCodexStdioTransport,
  resolveCodexStdioEnvironment,
  type ICodexAppServerRequest,
  type ICodexAppServerStartOptions,
  type ICodexStdioSpawnOptions,
  type IStdioChildProcess
} from "../src/index.js";

const baseOptions: ICodexAppServerStartOptions = {
  transport: "stdio",
  command: "codex",
  args: ["app-server", "--listen", "stdio://"],
  headers: {},
  clearEnv: []
};

describe("Codex stdio JSON-RPC transport", () => {
  it("writes newline-delimited JSON-RPC frames to stdin", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new CodexStdioJsonRpcTransport(child);
    const writes: string[] = [];

    child.stdin.on("data", (chunk: Buffer) => {
      writes.push(chunk.toString("utf8"));
    });

    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    });

    assert.equal(writes.join(""), "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n");
    await transport.close();
  });

  it("parses newline-delimited stdout messages", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new CodexStdioJsonRpcTransport(child);
    const messages: unknown[] = [];

    transport.onMessage((message) => {
      messages.push(message);
    });
    child.stdout.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"ok\"}\n");

    await waitForMicrotask();

    assert.deepEqual(messages, [
      {
        jsonrpc: "2.0",
        id: 1,
        result: "ok"
      }
    ]);
    await transport.close();
  });

  it("closes before buffering an oversized stdout line", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new CodexStdioJsonRpcTransport(child, { maxStdoutLineBytes: 32 });
    const messages: unknown[] = [];
    const closeErrors: string[] = [];

    transport.onMessage((message) => {
      messages.push(message);
    });
    transport.onClose((error) => {
      closeErrors.push(error?.message ?? "");
    });

    child.stdout.write("{\"jsonrpc\":\"2.0\",");
    child.stdout.write("\"result\":\"this line is too long without newline");

    await waitForMicrotask();

    assert.deepEqual(messages, []);
    assert.equal(child.killCount, 1);
    assert.equal(closeErrors.length, 1);
    assert.match(closeErrors[0] ?? "", /exceeded max stdout line size/u);
    assert.doesNotMatch(closeErrors[0] ?? "", /this line is too long/u);
    await transport.close();
  });

  it("closes with redacted stderr tail when the process exits unexpectedly", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new CodexStdioJsonRpcTransport(child);
    const closeErrors: string[] = [];

    transport.onClose((error) => {
      closeErrors.push(error?.message ?? "");
    });
    child.stderr.write("failed with token sk-test-secret-value\n");
    child.emitExit(1, null);

    assert.equal(child.killCount, 0);
    assert.equal(closeErrors.length, 1);
    assert.match(closeErrors[0] ?? "", /code=1/);
    assert.doesNotMatch(closeErrors[0] ?? "", /sk-test-secret-value/);
    assert.match(closeErrors[0] ?? "", /\[REDACTED_SECRET\]/);
  });

  it("records stderr stream errors without crashing or blocking stdout", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new CodexStdioJsonRpcTransport(child);
    const messages: unknown[] = [];

    transport.onMessage((message) => {
      messages.push(message);
    });

    assert.doesNotThrow(() => {
      child.stderr.emit("error", new Error("simulated stderr pipe error"));
    });
    child.stdout.write("{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"after-error\"}\n");

    await waitForMicrotask();

    assert.match(transport.getStderrTailForTests(), /simulated stderr pipe error/u);
    assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 2, result: "after-error" }]);
    await transport.close();
  });

  it("uses a safe env allowlist by default", () => {
    const env = resolveCodexStdioEnvironment(
      {
        ...baseOptions,
        env: {
          NEONIKA_MODE: "shadow",
          OPENAI_API_KEY: "explicit-key"
        },
        clearEnv: ["OPENAI_API_KEY"]
      },
      {
        HOME: "/Users/operator",
        PATH: "/usr/bin",
        OPENAI_API_KEY: "base-secret",
        SOME_TOKEN: "base-token"
      },
      "darwin"
    );

    assert.equal(env["HOME"], "/Users/operator");
    assert.equal(env["PATH"], "/usr/bin");
    assert.equal(env["NEONIKA_MODE"], "shadow");
    assert.equal(env["OPENAI_API_KEY"], undefined);
    assert.equal(env["SOME_TOKEN"], undefined);
  });

  it("spawns from start options without inheriting secrets by default", () => {
    const child = new FakeStdioChildProcess();
    let spawnOptions: ICodexStdioSpawnOptions | undefined;
    const transport = createCodexStdioTransport(
      {
        ...baseOptions,
        cwd: "/tmp/neonika"
      },
      {
        baseEnv: {
          HOME: "/Users/operator",
          OPENAI_API_KEY: "base-secret",
          PATH: "/usr/bin"
        },
        platform: "darwin",
        spawn: (_command, _args, options) => {
          spawnOptions = options;
          return child;
        }
      }
    );

    assert.equal(spawnOptions?.cwd, "/tmp/neonika");
    assert.equal(spawnOptions?.detached, true);
    assert.equal(spawnOptions?.env["OPENAI_API_KEY"], undefined);
    assert.equal(spawnOptions?.env["HOME"], "/Users/operator");
    void transport.close();
  });

  it("rejects sends after close", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new CodexStdioJsonRpcTransport(child);

    await transport.close();

    await assert.rejects(
      transport.send({
        id: 1,
        method: "initialize"
      }),
      /transport is closed/
    );
  });
});

class FakeStdioChildProcess extends EventEmitter implements IStdioChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCount = 0;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.killCount += 1;

    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

async function waitForMicrotask(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
