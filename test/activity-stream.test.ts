import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonActivityStream,
  listenNeonGatewayHttpServer,
  writeNeonGatewayRun,
  type INeonActivityStreamFrame,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon Activity stream", () => {
  it("emits one activity frame per run on start and only new run ids on refresh", async () => {
    const projectRoot = await createTempProjectRoot();
    const frames: INeonActivityStreamFrame[] = [];

    try {
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-1", "sk-activity-secret-one"));
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-2", "sk-activity-secret-two"));

      const stream = createNeonActivityStream(projectRoot, { onFrame: (frame) => frames.push(frame) });
      try {
        await stream.start();

        assert.equal(frames.length, 2);
        assert.deepEqual(
          frames.map((frame) => frame.runId).sort(),
          ["run-1", "run-2"]
        );
        assert.ok((frames[0]?.entries.length ?? 0) > 0);
        assert.ok(frames[0]?.entries.every((entry) => entry.runId === frames[0]?.runId));

        await stream.refresh();
        assert.equal(frames.length, 2);

        await writeNeonGatewayRun(projectRoot, createStreamRun("run-3", "sk-activity-secret-three"));
        await stream.refresh();

        assert.equal(frames.length, 3);
        assert.equal(frames[2]?.runId, "run-3");
      } finally {
        stream.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("never leaks raw output, command, or final text into activity frames", async () => {
    const projectRoot = await createTempProjectRoot();
    const frames: INeonActivityStreamFrame[] = [];
    const secret = "sk-activity-secret-leakcheck";

    try {
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-leak", secret));

      const stream = createNeonActivityStream(projectRoot, { onFrame: (frame) => frames.push(frame) });
      try {
        await stream.start();
      } finally {
        stream.close();
      }

      const serialized = JSON.stringify(frames);
      assert.equal(frames.length, 1);
      assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("pushes a new run live via the file watcher", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const received = new Promise<INeonActivityStreamFrame>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("no live activity frame within timeout")), 4000);
        const stream = createNeonActivityStream(projectRoot, {
          debounceMs: 20,
          onFrame: (frame) => {
            clearTimeout(timeout);
            stream.close();
            resolve(frame);
          }
        });
        void stream
          .start()
          .then(() => writeNeonGatewayRun(projectRoot, createStreamRun("run-live", "sk-activity-secret-live")))
          .catch((error: unknown) => {
            clearTimeout(timeout);
            stream.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
      });

      const frame = await received;
      assert.equal(frame.runId, "run-live");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves leak-safe activity frames over the real SSE HTTP endpoint", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createStreamRun("run-http", "sk-activity-secret-http"));

      const handle = await listenNeonGatewayHttpServer({ projectRoot }, { host: "127.0.0.1", port: 0 });
      const controller = new AbortController();

      try {
        const response = await fetch(new URL("/api/neon-activity/stream", handle.url), {
          headers: { accept: "text/event-stream" },
          signal: controller.signal
        });

        assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");

        const frame = await readFirstActivityRunFrame(response, 4000);
        assert.equal(frame.runId, "run-http");
        assert.doesNotMatch(JSON.stringify(frame), /sk-activity-secret-http/u);
      } finally {
        controller.abort();
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function readFirstActivityRunFrame(
  response: Response,
  timeoutMs: number
): Promise<INeonActivityStreamFrame> {
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
        if (isActivityRunFrame(parsed)) {
          return parsed;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("no activity-run frame received over SSE within timeout");
}

function isActivityRunFrame(value: unknown): value is INeonActivityStreamFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "activity-run" &&
    typeof (value as { runId?: unknown }).runId === "string"
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
      workspaceRoot: "/Users/operator/neon-projects/neon-core",
      mode: "read-only",
      contentPreview: "Activity stream bitte",
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
  return await mkdtemp(join(tmpdir(), "neon-core-activity-stream-"));
}
