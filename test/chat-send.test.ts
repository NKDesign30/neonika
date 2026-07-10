import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  createNeonDeliveryQueueSnapshot,
  listenNeonGatewayHttpServer,
  NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV,
  NeonChatSendValidationError,
  readNeonGatewayStatus,
  submitNeonChatSend
} from "../src/index.js";

async function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "neon-core-chat-send-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("Neon chat send (dry-run pipeline)", () => {
  it("enqueues a no-send dry-run candidate and persists the run", async () => {
    await withProjectRoot(async (root) => {
      const result = await submitNeonChatSend(
        root,
        { channel: "discord", channelId: "C1", agentId: "chaty", text: "operator reply" },
        { harness: createDryRunHarness() }
      );

      assert.equal(result.state, "queued-dry-run");
      assert.equal(result.outboundSent, false);
      assert.equal(result.deliveryState, "suppressed");
      assert.equal(result.candidateVisibleInQueue, true);

      const status = await readNeonGatewayStatus(root);
      assert.equal(status.runCount, 1);

      // End-to-end: the candidate is readable back from the delivery queue.
      const queue = await createNeonDeliveryQueueSnapshot(root);
      assert.equal(queue.totals.candidates, 1);
      assert.equal(queue.totals.queuedDryRuns, 1);
      assert.equal(queue.candidates[0]?.id, result.candidateId);
      assert.equal(queue.candidates[0]?.safety.outboundSent, false);
    });
  });

  it("keeps webchat dry-run candidates visible in the delivery queue", async () => {
    await withProjectRoot(async (root) => {
      const result = await submitNeonChatSend(
        root,
        { channel: "webchat", channelId: "mission-control", agentId: "chaty", text: "operator reply" },
        { harness: createDryRunHarness() }
      );

      assert.equal(result.channel, "webchat");
      assert.equal(result.outboundSent, false);
      assert.equal(result.deliveryState, "suppressed");
      assert.equal(result.candidateVisibleInQueue, true);

      const queue = await createNeonDeliveryQueueSnapshot(root);

      assert.equal(queue.totals.candidates, 1);
      assert.equal(queue.candidates[0]?.id, result.candidateId);
      assert.equal(queue.candidates[0]?.target.channel, "webchat");
      assert.equal(queue.candidates[0]?.safety.outboundSent, false);
    });
  });

  it("keeps unsupported channels shadow-only instead of queue-visible", async () => {
    await withProjectRoot(async (root) => {
      const result = await submitNeonChatSend(
        root,
        { channel: "telegram", channelId: "telegram-chat", text: "operator reply" },
        { harness: createDryRunHarness() }
      );

      assert.equal(result.channel, "telegram");
      assert.equal(result.outboundSent, false);
      assert.equal(result.candidateVisibleInQueue, false);

      const queue = await createNeonDeliveryQueueSnapshot(root);

      assert.equal(queue.totals.candidates, 0);
    });
  });

  it("rejects an empty text with a field-specific validation error", async () => {
    await withProjectRoot(async (root) => {
      await assert.rejects(
        () =>
          submitNeonChatSend(
            root,
            { channelId: "C1", text: "   " },
            { harness: createDryRunHarness() }
          ),
        (error: unknown) =>
          error instanceof NeonChatSendValidationError && error.field === "text"
      );
    });
  });

  it("rejects a missing channelId", async () => {
    await withProjectRoot(async (root) => {
      await assert.rejects(
        () =>
          submitNeonChatSend(root, { channelId: "", text: "hi" }, { harness: createDryRunHarness() }),
        (error: unknown) =>
          error instanceof NeonChatSendValidationError && error.field === "channelId"
      );
    });
  });

  it("keeps the result leak-safe", async () => {
    await withProjectRoot(async (root) => {
      const result = await submitNeonChatSend(
        root,
        { channel: "discord", channelId: "C1", text: "no secret here" },
        { harness: createDryRunHarness() }
      );
      assert.doesNotMatch(JSON.stringify(result), /secret/i);
    });
  });
});

describe("Neon chat send HTTP route", () => {
  it("accepts a loopback POST and returns the queued dry-run candidate", async () => {
    await withProjectRoot(async (root) => {
      const handle = await listenNeonGatewayHttpServer({ projectRoot: root }, { host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`${handle.url}/api/neon-chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: "C1", text: "hallo dashboard" })
        });
        const body = (await response.json()) as {
          readonly state: string;
          readonly chat: { readonly state: string; readonly outboundSent: boolean; readonly candidateId: string };
        };

        assert.equal(response.status, 201);
        assert.equal(body.state, "accepted");
        assert.equal(body.chat.state, "queued-dry-run");
        assert.equal(body.chat.outboundSent, false);

        const queue = await createNeonDeliveryQueueSnapshot(root);
        assert.equal(queue.candidates[0]?.id, body.chat.candidateId);
      } finally {
        await handle.close();
      }
    });
  });

  it("returns 400 for an empty text", async () => {
    await withProjectRoot(async (root) => {
      const handle = await listenNeonGatewayHttpServer({ projectRoot: root }, { host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`${handle.url}/api/neon-chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: "C1", text: "" })
        });
        const body = (await response.json()) as { readonly error: string; readonly field?: string };

        assert.equal(response.status, 400);
        assert.equal(body.error, "invalid-chat-send");
        assert.equal(body.field, "text");
      } finally {
        await handle.close();
      }
    });
  });

  it("requires the configured HTTP mutation token", async () => {
    await withProjectRoot(async (root) => {
      const previousToken = process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV];
      process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV] = "chat-send-token";
      const handle = await listenNeonGatewayHttpServer({ projectRoot: root }, { host: "127.0.0.1", port: 0 });
      try {
        const unauthenticated = await fetch(`${handle.url}/api/neon-chat/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channelId: "C1", text: "blocked" })
        });
        assert.equal(unauthenticated.status, 401);

        const authenticated = await fetch(`${handle.url}/api/neon-chat/send`, {
          method: "POST",
          headers: {
            authorization: "Bearer chat-send-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({ channelId: "C1", text: "allowed" })
        });
        assert.equal(authenticated.status, 201);
      } finally {
        await handle.close();
        if (previousToken === undefined) {
          delete process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV];
        } else {
          process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV] = previousToken;
        }
      }
    });
  });
});
