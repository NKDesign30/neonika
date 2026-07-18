import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordThreadWorkspaceRuntime,
  readNeonDiscordThreadWorkspaces,
  resolveNeonDiscordThreadWorkspaceStatePath,
  shouldCreateNeonDiscordThreadWorkspace,
  type INeonDiscordMessageEnvelope
} from "../src/index.js";

const PDF_ENVELOPE: INeonDiscordMessageEnvelope = {
  accountId: "default",
  guildId: "900000000000000001",
  channelId: "900000000000000002",
  messageId: "900000000000000003",
  author: { id: "900000000000000004", username: "operator", displayName: "the operator" },
  content: "Erstelle bitte einen gestalteten PDF-Prospekt für Example Robotics.",
  createdAt: "2026-07-10T10:00:00.000Z",
  mentionedUserIds: []
};

describe("Neon Discord thread workspaces", () => {
  it("recognizes only explicit, PDF, or real long-task intents", () => {
    const { guildId: _guildId, ...dmEnvelope } = PDF_ENVELOPE;
    assert.equal(shouldCreateNeonDiscordThreadWorkspace(PDF_ENVELOPE), "pdf");
    assert.equal(shouldCreateNeonDiscordThreadWorkspace({ ...PDF_ENVELOPE, content: "/thread neuer Auftrag" }), "manual");
    assert.equal(shouldCreateNeonDiscordThreadWorkspace({ ...PDF_ENVELOPE, content: "Kurze Frage" }), undefined);
    assert.equal(
      shouldCreateNeonDiscordThreadWorkspace({ ...PDF_ENVELOPE, threadId: "900000000000000005" }),
      undefined
    );
    assert.equal(shouldCreateNeonDiscordThreadWorkspace(dmEnvelope), undefined);
  });

  it("creates once under concurrency, persists mode 0600, and reuses the binding after restart", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-thread-workspace-"));
    let createCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      const runtime = createNeonDiscordThreadWorkspaceRuntime<string>({
        projectRoot,
        transport: {
          createThread: async (_message, input) => {
            createCalls += 1;
            assert.match(input.name, /^PDF-Arbeitsraum/u);
            await gate;
            return { threadId: "900000000000000005" };
          }
        },
        now: () => new Date("2026-07-10T10:00:00.000Z")
      });
      const first = runtime.route("message", PDF_ENVELOPE);
      const second = runtime.route("message", PDF_ENVELOPE);
      release?.();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.equal(firstResult.threadId, "900000000000000005");
      assert.equal(secondResult.threadId, "900000000000000005");
      assert.equal(createCalls, 1);
      const statePath = resolveNeonDiscordThreadWorkspaceStatePath(projectRoot);
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
      const raw = await readFile(statePath, "utf8");
      assert.doesNotMatch(raw, /gestalteten PDF-Prospekt|Example Robotics/u);

      const restarted = createNeonDiscordThreadWorkspaceRuntime<string>({
        projectRoot,
        transport: {
          createThread: async () => {
            throw new Error("restart must reuse the persisted thread");
          }
        }
      });
      const reused = await restarted.route("message", PDF_ENVELOPE);
      assert.equal(reused.threadId, "900000000000000005");
      assert.equal((await readNeonDiscordThreadWorkspaces(projectRoot)).length, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("fails soft in the parent channel when Discord cannot create a thread", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-thread-workspace-fail-"));
    try {
      const runtime = createNeonDiscordThreadWorkspaceRuntime<string>({
        projectRoot,
        transport: {
          createThread: async () => {
            throw new Error("missing CreatePublicThreads permission");
          }
        }
      });
      const result = await runtime.route("message", PDF_ENVELOPE);

      assert.equal(result.threadId, undefined);
      assert.deepEqual(runtime.list(), []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps disabled channels in the parent channel", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-thread-workspace-disabled-"));
    let createCalls = 0;
    try {
      const runtime = createNeonDiscordThreadWorkspaceRuntime<string>({
        projectRoot,
        disabledChannelIds: [PDF_ENVELOPE.channelId],
        transport: {
          createThread: async () => {
            createCalls += 1;
            return { threadId: "900000000000000005" };
          }
        }
      });
      const result = await runtime.route("message", PDF_ENVELOPE);

      assert.equal(result.threadId, undefined);
      assert.equal(createCalls, 0);
      assert.deepEqual(runtime.list(), []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("derives a readable thread topic from the trigger message", async () => {
    const { deriveThreadTopic } = await import("../src/index.js");
    assert.equal(
      deriveThreadTopic("bitte erstelle eine pokemon website mit 3d model und deploy"),
      "erstelle pokemon website model deploy"
    );
    assert.equal(deriveThreadTopic("ok"), undefined);
    assert.equal(deriveThreadTopic(undefined), undefined);
    assert.doesNotMatch(
      deriveThreadTopic("baue https://example.com/secret-page bitte um") ?? "",
      /example\.com/u
    );
  });
});
