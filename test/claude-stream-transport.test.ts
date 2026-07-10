import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { ClaudeStreamProcessTransport, type IStdioChildProcess } from "../src/index.js";

describe("Claude stream process transport", () => {
  it("parses newline-delimited stdout messages", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new ClaudeStreamProcessTransport(child);
    const messages: unknown[] = [];

    transport.onMessage((message) => {
      messages.push(message);
    });
    child.stdout.write("{\"type\":\"assistant\",\"text\":\"ok\"}\n");

    await waitForMicrotask();

    assert.deepEqual(messages, [
      {
        type: "assistant",
        text: "ok"
      }
    ]);
    await transport.close();
  });

  it("closes before buffering an oversized stdout line", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new ClaudeStreamProcessTransport(child, { maxStdoutLineBytes: 32 });
    const messages: unknown[] = [];
    const closeErrors: string[] = [];

    transport.onMessage((message) => {
      messages.push(message);
    });
    transport.onClose((error) => {
      closeErrors.push(error?.message ?? "");
    });

    child.stdout.write("{\"type\":\"assistant\",");
    child.stdout.write("\"text\":\"this line is too long without newline");

    await waitForMicrotask();

    assert.deepEqual(messages, []);
    assert.equal(child.killCount, 1);
    assert.equal(closeErrors.length, 1);
    assert.match(closeErrors[0] ?? "", /exceeded max stdout line size/u);
    assert.doesNotMatch(closeErrors[0] ?? "", /this line is too long/u);
    await transport.close();
  });

  it("records stderr stream errors without crashing or blocking stdout", async () => {
    const child = new FakeStdioChildProcess();
    const transport = new ClaudeStreamProcessTransport(child);
    const messages: unknown[] = [];

    transport.onMessage((message) => {
      messages.push(message);
    });

    assert.doesNotThrow(() => {
      child.stderr.emit("error", new Error("simulated stderr pipe error"));
    });
    child.stdout.write("{\"type\":\"assistant\",\"text\":\"after-error\"}\n");

    await waitForMicrotask();

    assert.match(transport.getStderrTailForTests(), /simulated stderr pipe error/u);
    assert.deepEqual(messages, [{ type: "assistant", text: "after-error" }]);
    await transport.close();
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
