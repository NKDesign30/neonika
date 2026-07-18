import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonReplayStream,
  listenNeonGatewayHttpServer,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun,
  type INeonReplayStreamFrame
} from "../src/index.js";

describe("Neonika Replay stream", () => {
  it("emits the leak-safe backlog on start and pushes only new run ids on refresh", async () => {
    const projectRoot = await createTempProjectRoot();
    const frames: INeonReplayStreamFrame[] = [];

    try {
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-1", "sk-stream-secret-one"));
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-2", "sk-stream-secret-two"));

      const stream = createNeonReplayStream(projectRoot, { onFrame: (frame) => frames.push(frame) });
      try {
        await stream.start();

        assert.equal(frames.length, 2);
        assert.deepEqual(
          frames.map((frame) => frame.run.runId).sort(),
          ["run-1", "run-2"]
        );
        assert.deepEqual(
          frames.map((frame) => frame.seq).sort((left, right) => left - right),
          [1, 2]
        );

        // Re-scanning without new runs must not re-emit.
        await stream.refresh();
        assert.equal(frames.length, 2);

        await writeNeonGatewayRun(projectRoot, createStreamRun("run-3", "sk-stream-secret-three"));
        await stream.refresh();

        assert.equal(frames.length, 3);
        assert.equal(frames[2]?.run.runId, "run-3");
      } finally {
        stream.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("never leaks raw output, command, or final text into stream frames", async () => {
    const projectRoot = await createTempProjectRoot();
    const frames: INeonReplayStreamFrame[] = [];
    const secret = "sk-stream-secret-leakcheck";

    try {
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-leak", secret));

      const stream = createNeonReplayStream(projectRoot, { onFrame: (frame) => frames.push(frame) });
      try {
        await stream.start();
      } finally {
        stream.close();
      }

      const serialized = JSON.stringify(frames);
      assert.equal(frames.length, 1);
      // The reused replay-detail projection strips secrets to [REDACTED_SECRET]/***.
      assert.doesNotMatch(serialized, new RegExp(secret, "u"));
      assert.match(serialized, /\[REDACTED_SECRET\]/u);
      // The leak-safe replay event shape carries no raw payload fields.
      for (const event of frames[0]?.run.events ?? []) {
        assert.ok(typeof event.kind === "string");
        assert.equal(Object.prototype.hasOwnProperty.call(event, "output"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(event, "command"), false);
        assert.equal(Object.prototype.hasOwnProperty.call(event, "text"), false);
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("pushes a new run live via the file watcher", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const received = new Promise<INeonReplayStreamFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("no live replay frame within timeout")), 4000);
        const stream = createNeonReplayStream(projectRoot, {
          debounceMs: 20,
          onFrame: (frame) => {
            clearTimeout(timeout);
            stream.close();
            resolve(frame);
          }
        });
        void stream
          .start()
          .then(() => writeNeonGatewayRun(projectRoot, createStreamRun("run-live", "sk-stream-secret-live")))
          .catch((error: unknown) => {
            clearTimeout(timeout);
            stream.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });

      const frame = await received;
      assert.equal(frame.run.runId, "run-live");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves leak-safe replay frames over the real SSE HTTP endpoint", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-http", "sk-stream-secret-http"));

      const handle = await listenNeonGatewayHttpServer({ projectRoot }, { host: "127.0.0.1", port: 0 });
      const controller = new AbortController();

      try {
        const response = await fetch(new URL("/api/neon-replay/stream", handle.url), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal
        });

        assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

        const frame = await readFirstReplayRunFrame(response, 4000);
        assert.equal(frame.run.runId, "run-http");
        assert.doesNotMatch(JSON.stringify(frame), /sk-stream-secret-http/u);
      } finally {
        controller.abort();
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function readFirstReplayRunFrame(
  response: Response,
  timeoutMs: number
): Promise<INeonReplayStreamFrame> {
  const body = response.body;
  if (!body) {
    throw new Error("SSE response had no body");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      for (const block of buffer.split("\n\n")) {
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) {
          continue;
        }
        const parsed: unknown = JSON.parse(dataLine.slice("data: ".length));
        if (isReplayRunFrame(parsed)) {
          return parsed;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("no replay-run frame received over SSE within timeout");
}

function isReplayRunFrame(value: unknown): value is INeonReplayStreamFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "replay-run" &&
    typeof (value as { run?: { runId?: unknown } }).run?.runId === "string"
  );
}

function createStreamRun(runId: string, secret: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Replay stream bitte",
      receivedAt: "2026-06-01T08:58:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:channel:main:hash:read-only",
    memoryState: "attached",
    events: [
      { kind: "tool-start", toolName: "codex" },
      { kind: "tool-output", toolName: "codex", output: `result ${secret}` },
      { kind: "command-exit", command: `deploy --token ${secret}`, exitCode: 0 },
      { kind: "final", text: `done ${secret}` }
    ],
    finalText: `done ${secret}`,
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: `done ${secret}`
    },
    startedAt: "2026-06-01T08:58:00.000Z",
    completedAt: "2026-06-01T08:58:02.000Z"
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-replay-stream-"));
}
