import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createTextTurnInput,
  interruptCodexTurn,
  projectCodexNotification,
  startCodexTurn,
  startOrResumeCodexThread,
  unsubscribeCodexThread,
  neonPeekabooDynamicToolSpec,
  type ICodexAppServerClient,
  type ICodexAppServerNotification,
  type ICodexAppServerRequestOptions,
  type TCodexAppServerMethod,
  type TCodexAppServerNotificationHandler,
  type TJsonValue
} from "../src/index.js";

describe("Codex thread run lifecycle", () => {
  it("starts a new thread with safe Neon-owned params", async () => {
    const client = new RecordingCodexClient([
      {
        thread: {
          id: "thread-1"
        }
      }
    ]);

    const result = await startOrResumeCodexThread({
      client,
      cwd: "/tmp/neon-core",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "Neon Core"
    });

    assert.equal(result.threadId, "thread-1");
    assert.equal(result.source, "started");
    assert.equal(client.requests[0]?.method, "thread/start");
    assert.deepEqual(client.requests[0]?.params, {
      cwd: "/tmp/neon-core",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "Neon Core",
      ephemeral: true
    });
  });

  it("passes dynamic tools during thread start", async () => {
    const client = new RecordingCodexClient([
      {
        thread: {
          id: "thread-1"
        }
      }
    ]);

    await startOrResumeCodexThread({
      client,
      cwd: "/tmp/neon-core",
      dynamicTools: [neonPeekabooDynamicToolSpec]
    });

    assert.equal(client.requests[0]?.method, "thread/start");
    assert.deepEqual(client.requests[0]?.params, {
      cwd: "/tmp/neon-core",
      dynamicTools: [neonPeekabooDynamicToolSpec]
    });
  });

  it("resumes an existing thread when a binding exists", async () => {
    const client = new RecordingCodexClient([
      {
        thread: {
          id: "thread-existing"
        }
      }
    ]);

    const result = await startOrResumeCodexThread({
      client,
      cwd: "/tmp/neon-core",
      existingThreadId: "thread-existing",
      approvalPolicy: "on-request"
    });

    assert.equal(result.threadId, "thread-existing");
    assert.equal(result.source, "resumed");
    assert.equal(client.requests[0]?.method, "thread/resume");
    assert.deepEqual(client.requests[0]?.params, {
      threadId: "thread-existing",
      cwd: "/tmp/neon-core",
      approvalPolicy: "on-request"
    });
  });

  it("rejects malformed thread responses", async () => {
    const client = new RecordingCodexClient([
      {
        thread: {}
      }
    ]);

    await assert.rejects(
      startOrResumeCodexThread({
        client,
        cwd: "/tmp/neon-core"
      }),
      /thread started response did not include thread.id/
    );
  });

  it("starts a turn with Codex text input shape", async () => {
    const client = new RecordingCodexClient([
      {
        turn: {
          id: "turn-1",
          status: "inProgress"
        }
      }
    ]);

    const result = await startCodexTurn({
      client,
      threadId: "thread-1",
      prompt: "hello",
      approvalPolicy: "never"
    });

    assert.equal(result.turnId, "turn-1");
    assert.equal(result.status, "inProgress");
    assert.equal(client.requests[0]?.method, "turn/start");
    assert.deepEqual(client.requests[0]?.params, {
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: "hello",
          text_elements: []
        }
      ],
      approvalPolicy: "never"
    });
  });

  it("passes AbortSignal to the Codex turn request", async () => {
    const client = new RecordingCodexClient([
      {
        turn: {
          id: "turn-1",
          status: "inProgress"
        }
      }
    ]);
    const abortController = new AbortController();

    await startCodexTurn({
      client,
      threadId: "thread-1",
      prompt: "hello",
      signal: abortController.signal
    });

    assert.equal(client.requests[0]?.method, "turn/start");
    assert.equal(client.requests[0]?.signalAborted, false);
  });

  it("builds text turn input explicitly", () => {
    assert.deepEqual(createTextTurnInput("hi"), [
      {
        type: "text",
        text: "hi",
        text_elements: []
      }
    ]);
  });

  it("unsubscribes from a thread", async () => {
    const client = new RecordingCodexClient([
      {
        status: "ok"
      }
    ]);

    assert.deepEqual(await unsubscribeCodexThread(client, "thread-1"), {
      status: "ok"
    });
    assert.deepEqual(client.requests[0], {
      method: "thread/unsubscribe",
      params: {
        threadId: "thread-1"
      }
    });
  });

  it("interrupts an active turn through the app-server facade", async () => {
    const client = new RecordingCodexClient([
      {
        status: "ok"
      }
    ]);

    assert.deepEqual(await interruptCodexTurn(client, { threadId: "thread-1", turnId: "turn-1" }), {
      status: "ok"
    });
    assert.deepEqual(client.requests[0], {
      method: "turn/interrupt",
      params: {
        threadId: "thread-1",
        turnId: "turn-1"
      }
    });
  });

  it("projects core Codex notifications into Neon run events", () => {
    assert.deepEqual(
      projectCodexNotification({
        method: "thread/started",
        params: {
          thread: {
            id: "thread-1"
          }
        }
      }),
      {
        type: "thread.started",
        threadId: "thread-1"
      }
    );
    assert.deepEqual(
      projectCodexNotification({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "token sk-test-secret-value"
        }
      }),
      {
        type: "assistant.delta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "token [REDACTED_SECRET]"
      }
    );
    assert.deepEqual(
      projectCodexNotification({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "completed"
          }
        }
      }),
      {
        type: "turn.completed",
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed"
      }
    );
  });

  it("keeps unknown notifications visible instead of dropping them", () => {
    assert.deepEqual(
      projectCodexNotification({
        method: "future/event",
        params: {
          value: true
        }
      }),
      {
        type: "unknown",
        method: "future/event"
      }
    );
  });
});

interface IRecordedRequest {
  readonly method: TCodexAppServerMethod;
  readonly params: TJsonValue | undefined;
  readonly signalAborted?: boolean;
}

class RecordingCodexClient implements ICodexAppServerClient {
  readonly requests: IRecordedRequest[] = [];
  private readonly handlers = new Set<TCodexAppServerNotificationHandler>();

  constructor(private readonly responses: Array<TJsonValue | undefined>) {}

  async initialize(): Promise<void> {
    return undefined;
  }

  async request(
    method: TCodexAppServerMethod,
    params?: TJsonValue,
    options?: ICodexAppServerRequestOptions
  ): Promise<TJsonValue | undefined> {
    this.requests.push({
      method,
      params,
      ...(options?.signal ? { signalAborted: options.signal.aborted } : {})
    });

    return this.responses.shift();
  }

  subscribe(handler: TCodexAppServerNotificationHandler): () => void {
    this.handlers.add(handler);

    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(notification: ICodexAppServerNotification): void {
    for (const handler of this.handlers) {
      void handler(notification);
    }
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }
}
