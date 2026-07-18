import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildClaudeStreamArgs,
  createClaudeCliHarness,
  deriveCodexSessionKey,
  resolveNeonAgentAttachment,
  type IClaudeStreamTransport,
  type ICodexSessionBinding
} from "../src/index.js";

const baseBinding: ICodexSessionBinding = {
  channel: "discord",
  accountId: "default",
  guildId: "900000000000000001",
  channelId: "900000000000000005",
  threadId: "main",
  agentId: "chaty",
  workspaceRoot: "/Users/operator/neon-projects/neonika",
  mode: "read-only"
};

describe("Claude CLI harness", () => {
  it("runs a read-only turn from assistant text to a final event", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "assistant",
          session_id: "sess-1",
          message: { role: "assistant", content: [{ type: "text", text: "Hallo Operator." }] }
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Hallo Operator.",
          session_id: "sess-1",
          usage: { input_tokens: 5, output_tokens: 3 }
        }
      ]
    });
    let capturedSpec: { readonly systemPrompt: string } | undefined;
    const harness = createClaudeCliHarness({
      acquireTransport: (spec) => {
        capturedSpec = { systemPrompt: spec.systemPrompt };
        return {
          transport,
          release: async () => {
            transport.released = true;
          }
        };
      },
      turnCompletionTimeoutMs: 500
    });

    const agent = resolveNeonAgentAttachment("chaty");
    assert.ok(agent);

    const result = await harness.run({
      prompt: "Say hi",
      binding: baseBinding,
      agent,
      memory: { state: "attached", hitCount: 1, note: "operator profile" }
    });

    assert.equal(harness.id, "claude-cli");
    assert.equal(result.memoryState, "attached");
    assert.equal(result.finalText, "Hallo Operator.");
    assert.equal(result.sessionKey, deriveCodexSessionKey(baseBinding));
    assert.equal(transport.released, true);
    assert.deepEqual(
      result.events.map((event) => event.kind),
      ["assistant-delta", "token-usage", "final"]
    );

    const userFrame = JSON.parse(transport.sent[0]?.trim() ?? "{}") as Record<string, unknown>;
    const message = userFrame["message"] as Record<string, unknown>;
    assert.match(String(message["content"]), /Neon Agent: Chaty/);
    assert.match(String(message["content"]), /Neon Memory: attached; hits=1/);
    assert.match(capturedSpec?.systemPrompt ?? "", /newline-separated Markdown list items/u);
    assert.match(capturedSpec?.systemPrompt ?? "", /never leave bare inline numbers after a colon/u);
    assert.match(capturedSpec?.systemPrompt ?? "", /do not emit Cyrillic homoglyphs/u);
  });

  it("streams projected events through the optional callback before returning", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "streamed" }] }
        },
        { type: "result", is_error: false, result: "streamed" }
      ]
    });
    const streamed: string[] = [];
    let runReturned = false;
    let sawDeltaBeforeReturn = false;
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      onEvent: (event) => {
        streamed.push(event.kind);

        if (!runReturned && event.kind === "assistant-delta") {
          sawDeltaBeforeReturn = true;
        }
      },
      prompt: "stream",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "stream" }
    });
    runReturned = true;

    assert.equal(sawDeltaBeforeReturn, true);
    assert.deepEqual(
      streamed,
      result.events.map((event) => event.kind)
    );
    assert.deepEqual(streamed, ["assistant-delta", "final"]);
  });

  it("maps tool_use and tool_result blocks to tool events", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "x" } }]
          }
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }]
          }
        },
        { type: "result", is_error: false, result: "done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "read a file",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "tools" }
    });

    assert.deepEqual(
      result.events.map((event) => event.kind),
      ["tool-start", "tool-output", "final"]
    );
    assert.equal(result.events[1]?.kind, "tool-output");
    assert.equal(result.events[1]?.output, "ok");
  });

  it("preserves primitive tool_result content as visible tool output", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_count", content: 0 },
              { type: "tool_result", tool_use_id: "toolu_bool", content: false },
              { type: "tool_result", tool_use_id: "toolu_null", content: null }
            ]
          }
        },
        { type: "result", is_error: false, result: "done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "read primitive tool results",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "primitive-tools" }
    });

    assert.deepEqual(
      result.events.filter((event) => event.kind === "tool-output").map((event) => event.output),
      ["0", "false", "null"]
    );
  });

  it("redacts primitive inline data URI tool_result content without hiding data-prefixed text", async () => {
    const inlineData = "data:text/plain;base64,abcdefghijklmnopqrstuvwxyz0123456789";
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_inline", content: inlineData },
              { type: "tool_result", tool_use_id: "toolu_data_text", content: 'data: {"status":"ok"}' }
            ]
          }
        },
        { type: "result", is_error: false, result: "done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "read data tool results",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "data-tools" }
    });

    assert.deepEqual(
      result.events.filter((event) => event.kind === "tool-output").map((event) => event.output),
      [`[inline data URI: ${inlineData.length} chars]`, 'data: {"status":"ok"}']
    );
  });

  it("maps provider-shaped toolcall aliases through the live harness projection", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "toolcall", toolCallId: "toolu_alias", name: "Bash", args: { command: "pwd" } }]
          }
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_alias", content: "ok" }]
          }
        },
        { type: "result", is_error: false, result: "done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "run pwd",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "tool alias" }
    });

    assert.deepEqual(result.events.slice(0, 2), [
      { kind: "tool-start", toolName: "Bash", toolCallId: "toolu_alias" },
      { kind: "tool-output", toolName: "claude-cli", toolCallId: "toolu_alias", output: "ok" }
    ]);
  });

  it("denies can_use_tool control requests in read-only mode", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        { type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool" } },
        { type: "result", is_error: false, result: "done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    await harness.run({
      prompt: "try a tool",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "control" }
    });

    const denyFrame = transport.sent
      .map((line) => JSON.parse(line.trim()) as Record<string, unknown>)
      .find((frame) => frame["type"] === "control_response");

    assert.ok(denyFrame, "expected a control_response to be sent");
    const response = denyFrame["response"] as Record<string, unknown>;
    const inner = response["response"] as Record<string, unknown>;
    assert.equal(response["request_id"], "req-1");
    assert.equal(inner["behavior"], "deny");
  });

  it("allows can_use_tool control requests in write mode", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        { type: "control_request", request_id: "req-1", request: { subtype: "can_use_tool" } },
        { type: "result", is_error: false, result: "done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    await harness.run({
      prompt: "try a tool",
      binding: { ...baseBinding, mode: "write" },
      memory: { state: "skipped", hitCount: 0, note: "control" }
    });

    const allowFrame = transport.sent
      .map((line) => JSON.parse(line.trim()) as Record<string, unknown>)
      .find((frame) => frame["type"] === "control_response");

    assert.ok(allowFrame, "expected a control_response to be sent");
    const response = allowFrame["response"] as Record<string, unknown>;
    const inner = response["response"] as Record<string, unknown>;
    assert.equal(response["request_id"], "req-1");
    assert.equal(inner["behavior"], "allow");
    assert.deepEqual(inner["updatedInput"], {});
  });

  it("treats an error result as a failed turn", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [{ type: "result", is_error: true, result: "model overloaded" }]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "fail",
      binding: baseBinding,
      memory: { state: "attached", hitCount: 1, note: "fail" }
    });

    assert.equal(result.finalText, "model overloaded");
    assert.equal(result.events.at(-1)?.kind, "failed");
  });

  it("fails before the turn timeout when the stream emits no first event", async () => {
    const transport = new ScriptedClaudeTransport();
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      firstEventTimeoutMs: 20,
      turnCompletionTimeoutMs: 500
    });

    const startedAt = Date.now();
    const result = await harness.run({
      prompt: "wait forever",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "first-event-timeout" }
    });

    const failed = result.events.find((event) => event.kind === "failed");

    assert.ok(Date.now() - startedAt < 500);
    assert.match(failed?.message ?? "", /first event within 20ms/u);
  });

  it("finalizes an interrupted turn when the abort signal fires", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "working" }] }
        }
      ]
    });
    const abortController = new AbortController();
    let released = false;
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({
        transport,
        release: async () => {
          released = true;
        }
      }),
      turnCompletionTimeoutMs: 1000
    });

    const runPromise = harness.run({
      abortSignal: abortController.signal,
      prompt: "start and wait",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "abort" }
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    abortController.abort("test_stop");

    const result = await runPromise;

    assert.equal(result.finalText, "Claude CLI turn interrupted by local abort signal.");
    assert.equal(result.events.at(-1)?.kind, "final");
    assert.equal(released, true);
  });

  it("fails the turn when the transport closes before completion", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "partial" }] }
        }
      ],
      closeError: new Error("Claude stream transport exited: code=1 signal=null")
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "die early",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "close" }
    });

    assert.equal(result.events.at(-1)?.kind, "failed");
    assert.match(result.finalText, /exited/);
  });

  it("redacts secrets in the final result text", async () => {
    const transport = new ScriptedClaudeTransport({
      messages: [
        { type: "result", is_error: false, result: "here is the key sk-abcdefghijklmnop12345 done" }
      ]
    });
    const harness = createClaudeCliHarness({
      acquireTransport: () => ({ transport, release: async () => undefined }),
      turnCompletionTimeoutMs: 500
    });

    const result = await harness.run({
      prompt: "leak",
      binding: baseBinding,
      memory: { state: "skipped", hitCount: 0, note: "redact" }
    });

    assert.match(result.finalText, /\[REDACTED_SECRET\]/);
    assert.doesNotMatch(result.finalText, /sk-abcdefghijklmnop12345/);
  });

  it("builds read-only stream args with default permission mode", () => {
    const args = buildClaudeStreamArgs({ mode: "read-only", systemPrompt: "be neon" });

    assert.deepEqual(args, [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "default",
      "--append-system-prompt",
      "be neon"
    ]);
  });

  it("builds write stream args with acceptEdits, model, and effort flags", () => {
    const args = buildClaudeStreamArgs({
      mode: "write",
      systemPrompt: "be neon",
      model: "claude-opus-4-8",
      effort: "max"
    });

    assert.ok(args.includes("acceptEdits"));
    assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
    assert.equal(args[args.indexOf("--effort") + 1], "max");
  });

  it("builds full-open write stream args for the Neo Discord tap", () => {
    const args = buildClaudeStreamArgs({
      mode: "write",
      systemPrompt: "be neon",
      permissionMode: "bypassPermissions",
      addDirs: ["/Users/operator"],
      tools: "default"
    });

    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args[args.indexOf("--tools") + 1], "default");
    assert.equal(args[args.indexOf("--add-dir") + 1], "/Users/operator");
  });
});

interface IScriptedClaudeTransportOptions {
  readonly messages?: readonly unknown[];
  readonly closeError?: Error;
}

class ScriptedClaudeTransport implements IClaudeStreamTransport {
  readonly sent: string[] = [];
  released = false;
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();

  constructor(private readonly options: IScriptedClaudeTransportOptions = {}) {}

  async send(line: string): Promise<void> {
    this.sent.push(line);

    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;

    if (parsed["type"] === "user") {
      queueMicrotask(() => {
        this.runScript();
      });
    }
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandlers.add(handler);

    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.closeHandlers.add(handler);

    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.messageHandlers.clear();
    this.closeHandlers.clear();
  }

  private runScript(): void {
    for (const message of this.options.messages ?? []) {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    }

    if (this.options.closeError) {
      for (const handler of this.closeHandlers) {
        handler(this.options.closeError);
      }
    }
  }
}
