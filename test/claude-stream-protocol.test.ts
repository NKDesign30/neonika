import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildClaudeAllowControlResponse,
  buildClaudeDenyControlResponse,
  buildClaudeUserInputLine,
  projectClaudeStreamMessage
} from "../src/index.js";

describe("Claude stream protocol projection", () => {
  it("projects assistant text blocks to assistant-delta events", () => {
    const projection = projectClaudeStreamMessage({
      type: "assistant",
      session_id: "sess-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hallo " },
          { type: "text", text: "Operator." }
        ]
      }
    });

    assert.deepEqual(
      projection.events.map((event) => event.kind),
      ["assistant-delta", "assistant-delta"]
    );
    assert.equal(projection.sessionId, "sess-1");
    assert.equal(projection.completion, undefined);
  });

  it("projects assistant tool_use blocks to tool-start events", () => {
    const projection = projectClaudeStreamMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: { path: "x" } }]
      }
    });

    const event = projection.events[0];

    assert.equal(event?.kind, "tool-start");
    assert.equal(event?.kind === "tool-start" ? event.toolName : undefined, "Read");
    assert.equal(event?.kind === "tool-start" ? event.toolCallId : undefined, "toolu_01");
  });

  it("projects provider-shaped assistant tool call aliases", () => {
    const projection = projectClaudeStreamMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "toolcall", name: "Bash", toolCallId: "toolu_camel" },
          { type: "tool_call", name: "Read", tool_call_id: "toolu_snake" },
          { type: "tooluse", name: "Search", tool_use_id: "toolu_use" }
        ]
      }
    });

    assert.deepEqual(projection.events, [
      { kind: "tool-start", toolName: "Bash", toolCallId: "toolu_camel" },
      { kind: "tool-start", toolName: "Read", toolCallId: "toolu_snake" },
      { kind: "tool-start", toolName: "Search", toolCallId: "toolu_use" }
    ]);
  });

  it("projects user tool_result blocks to tool-output events", () => {
    const projection = projectClaudeStreamMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "file contents" }]
      }
    });

    const event = projection.events[0];

    assert.equal(event?.kind, "tool-output");
    assert.equal(event?.kind === "tool-output" ? event.output : undefined, "file contents");
    assert.equal(event?.kind === "tool-output" ? event.toolCallId : undefined, "toolu_01");
  });

  it("reads structured tool_result content arrays", () => {
    const projection = projectClaudeStreamMessage({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_02",
            content: [
              { type: "text", text: "line one" },
              { type: "text", text: "line two" },
              { type: "tool_result", content: "nested content fallback" },
              { type: "toolResult", content: "duplicate fallback", text: "nested text preferred" }
            ]
          }
        ]
      }
    });

    const event = projection.events[0];

    assert.equal(
      event?.kind === "tool-output" ? event.output : undefined,
      "line one\nline two\nnested content fallback\nnested text preferred"
    );
  });

  it("omits primitive inline data URI tool_result payloads", () => {
    const dataUri = "data:text/plain;base64,abcdefghijklmnopqrstuvwxyz0123456789";
    const projection = projectClaudeStreamMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: dataUri }]
      }
    });

    const event = projection.events[0];

    assert.equal(
      event?.kind === "tool-output" ? event.output : undefined,
      `[inline data URI: ${dataUri.length} chars]`
    );
  });

  it("keeps primitive data-prefixed tool_result text that is not a data URI", () => {
    const projection = projectClaudeStreamMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "data: {\"status\":\"ok\"}" }]
      }
    });

    const event = projection.events[0];

    assert.equal(event?.kind === "tool-output" ? event.output : undefined, "data: {\"status\":\"ok\"}");
  });

  it("caps long primitive tool_result text without splitting emoji pairs", () => {
    const projection = projectClaudeStreamMessage({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: `${"x".repeat(7_999)}😀tail` }]
      }
    });

    const event = projection.events[0];
    const output = event?.kind === "tool-output" ? event.output : "";

    assert.match(output, /\.\.\.\(truncated\)\.\.\.$/u);
    assert.doesNotMatch(output, /\uD83D$/u);
  });

  it("projects a success result to completed with final text and token usage", () => {
    const projection = projectClaudeStreamMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Fertig, Sir.",
      session_id: "sess-9",
      usage: { input_tokens: 12, output_tokens: 8 }
    });

    assert.equal(projection.completion, "completed");
    assert.equal(projection.finalText, "Fertig, Sir.");
    assert.equal(projection.sessionId, "sess-9");

    const usage = projection.events.find((event) => event.kind === "token-usage");

    assert.equal(usage?.kind === "token-usage" ? usage.inputTokens : undefined, 12);
    assert.equal(usage?.kind === "token-usage" ? usage.outputTokens : undefined, 8);
    assert.equal(usage?.kind === "token-usage" ? usage.totalTokens : undefined, 20);
  });

  it("projects an error result to failed with a failed event", () => {
    const projection = projectClaudeStreamMessage({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "model overloaded"
    });

    assert.equal(projection.completion, "failed");
    assert.equal(projection.finalText, "model overloaded");
    assert.equal(projection.events.at(-1)?.kind, "failed");
  });

  it("captures a can_use_tool control request id and emits no events", () => {
    const projection = projectClaudeStreamMessage({
      type: "control_request",
      request_id: "req-7",
      request: { subtype: "can_use_tool", tool_use_id: "toolu_03" }
    });

    assert.equal(projection.controlRequestId, "req-7");
    assert.equal(projection.events.length, 0);
  });

  it("ignores system messages but keeps their session id", () => {
    const projection = projectClaudeStreamMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-init"
    });

    assert.equal(projection.events.length, 0);
    assert.equal(projection.sessionId, "sess-init");
  });

  it("projects malformed or unknown frames to nothing", () => {
    assert.deepEqual(projectClaudeStreamMessage(null).events, []);
    assert.deepEqual(projectClaudeStreamMessage("nope").events, []);
    assert.deepEqual(projectClaudeStreamMessage({ type: "stream_event" }).events, []);
    assert.deepEqual(projectClaudeStreamMessage({ type: "assistant", message: {} }).events, []);
  });

  it("redacts secrets in assistant text and result text", () => {
    const assistant = projectClaudeStreamMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "key sk-abcdefghijklmnop12345" }] }
    });
    const assistantEvent = assistant.events[0];

    assert.equal(assistantEvent?.kind, "assistant-delta");
    assert.match(
      assistantEvent?.kind === "assistant-delta" ? assistantEvent.text : "",
      /\[REDACTED_SECRET\]/
    );

    const result = projectClaudeStreamMessage({
      type: "result",
      is_error: false,
      result: "token ghp_0123456789abcdefghijklmnopqrstuvwxyz"
    });

    assert.match(result.finalText ?? "", /\[REDACTED_SECRET\]/);
    assert.doesNotMatch(result.finalText ?? "", /ghp_0123456789/);
  });

  it("builds a stream-json user input frame", () => {
    const line = buildClaudeUserInputLine("hello");
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;

    assert.ok(line.endsWith("\n"));
    assert.equal(parsed["type"], "user");
    const message = parsed["message"] as Record<string, unknown>;
    assert.equal(message["role"], "user");
    assert.equal(message["content"], "hello");
  });

  it("builds a deny control response frame", () => {
    const line = buildClaudeDenyControlResponse("req-1", "gated");
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    const response = parsed["response"] as Record<string, unknown>;
    const inner = response["response"] as Record<string, unknown>;

    assert.equal(parsed["type"], "control_response");
    assert.equal(response["request_id"], "req-1");
    assert.equal(inner["behavior"], "deny");
  });

  it("builds an allow control response frame", () => {
    const line = buildClaudeAllowControlResponse("req-1");
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    const response = parsed["response"] as Record<string, unknown>;
    const inner = response["response"] as Record<string, unknown>;

    assert.equal(parsed["type"], "control_response");
    assert.equal(response["request_id"], "req-1");
    assert.equal(inner["behavior"], "allow");
    assert.deepEqual(inner["updatedInput"], {});
  });
});
