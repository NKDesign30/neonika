import assert from "node:assert/strict";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, it } from "node:test";

import {
  CodexJsonRpcClient,
  CodexJsonRpcError,
  codexAppServerMethods,
  type ICodexAppServerNotification,
  type ICodexAppServerRequest,
  type ICodexAppServerResponse,
  type ICodexJsonRpcTransport
} from "../src/index.js";

describe("Codex JSON-RPC client", () => {
  it("sends initialize as a JSON-RPC request", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport);
    const initializing = client.initialize();
    const request = assertRequest(transport.sentMessages[0]);

    assert.equal(request.jsonrpc, "2.0");
    assert.equal(request.method, codexAppServerMethods.initialize);
    assert.deepEqual(request.params, {
      clientInfo: {
        name: "neon-core",
        title: "Neon Core",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: request?.id,
      result: {
        ready: true
      }
    });

    await initializing;
    await client.close();
  });

  it("resolves matching responses", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport);
    const result = client.request(codexAppServerMethods.threadStart, {
      cwd: "/tmp/neon-core"
    });
    const request = assertRequest(transport.sentMessages[0]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: request.id,
      result: "started"
    });

    assert.equal(await result, "started");
    assert.equal(client.getPendingRequestCountForTests(), 0);
    await client.close();
  });

  it("dispatches server notifications to subscribers", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport);
    const notifications: ICodexAppServerNotification[] = [];
    const unsubscribe = client.subscribe((notification) => {
      notifications.push(notification);
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      method: "thread/event",
      params: {
        type: "assistant_delta",
        text: "hi"
      }
    });
    unsubscribe();
    transport.emitMessage({
      jsonrpc: "2.0",
      method: "thread/event",
      params: {
        type: "ignored"
      }
    });

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.method, "thread/event");
    assert.deepEqual(notifications[0]?.params, {
      type: "assistant_delta",
      text: "hi"
    });
    await client.close();
  });

  it("responds to app-server tool requests through the registered handler", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport, {
      serverRequestHandler: (request) => {
        assert.equal(request.method, "item/tool/call");

        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: "host tool ok"
            }
          ]
        };
      }
    });

    transport.emitMessage({
      jsonrpc: "2.0",
      id: "tool-call-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: "peekaboo",
        arguments: {
          command: "permissions"
        }
      }
    });
    await waitImmediate();

    assert.deepEqual(transport.sentMessages[0], {
      jsonrpc: "2.0",
      id: "tool-call-1",
      result: {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: "host tool ok"
          }
        ]
      }
    });
    await client.close();
  });

  it("rejects RPC errors with structured error data", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport);
    const result = client.request(codexAppServerMethods.turnStart);
    const request = assertRequest(transport.sentMessages[0]);

    transport.emitMessage({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32_000,
        message: "turn rejected",
        data: {
          reason: "busy"
        }
      }
    });

    await assert.rejects(result, (error: unknown) => {
      if (!(error instanceof CodexJsonRpcError)) {
        return false;
      }

      assert.equal(error.code, -32_000);
      assert.deepEqual(error.data, {
        reason: "busy"
      });

      return true;
    });
    await client.close();
  });

  it("times out pending requests", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport, {
      defaultRequestTimeoutMs: 5
    });
    const result = client.request(codexAppServerMethods.turnInterrupt);

    await assert.rejects(result, /timed out after 5ms/);
    assert.equal(client.getPendingRequestCountForTests(), 0);
    await client.close();
  });

  it("rejects pending requests when the transport closes", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport, {
      defaultRequestTimeoutMs: 0
    });
    const result = client.request(codexAppServerMethods.threadResume);

    assert.equal(client.getPendingRequestCountForTests(), 1);

    transport.emitClose(new Error("transport died"));

    await assert.rejects(result, /transport died/);
    assert.equal(client.getPendingRequestCountForTests(), 0);
  });

  it("rejects new requests after close", async () => {
    const transport = new MemoryJsonRpcTransport();
    const client = new CodexJsonRpcClient(transport);

    await client.close();

    await assert.rejects(client.request(codexAppServerMethods.turnStart), /client is closed/);
  });
});

class MemoryJsonRpcTransport implements ICodexJsonRpcTransport {
  readonly sentMessages: Array<ICodexAppServerRequest | ICodexAppServerResponse> = [];
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private closed = false;

  async send(message: ICodexAppServerRequest | ICodexAppServerResponse): Promise<void> {
    if (this.closed) {
      throw new Error("transport is closed");
    }

    this.sentMessages.push(message);
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
    this.closed = true;
  }

  emitMessage(message: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitClose(error?: Error): void {
    this.closed = true;

    for (const handler of this.closeHandlers) {
      handler(error);
    }
  }
}

function assertRequest(
  value: ICodexAppServerRequest | ICodexAppServerResponse | undefined
): ICodexAppServerRequest {
  assert.ok(value);
  assert.ok("method" in value);

  return value;
}
