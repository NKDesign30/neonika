import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDeliveryIntentId,
  createNeonDeliveryPayloadHash,
  createNeonDiscordDeliveryNonce,
  executeNeonExactlyOnceDelivery,
  readNeonDeliveryReceipt,
  type INeonDeliveryQueueTarget,
  type INeonOutboundSendResult
} from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-1",
  replyToMessageId: "message-1"
};

describe("Neon exactly-once delivery receipts", () => {
  it("serializes concurrent attempts and sends only once", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-delivery-receipt-"));
    let releaseSend: (() => void) | undefined;
    const sendStarted = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let sendCalls = 0;

    try {
      const options = createOptions(projectRoot, async (target) => {
        sendCalls += 1;
        await sendStarted;
        return createSentResult(target, "discord-message-1");
      });
      const first = executeNeonExactlyOnceDelivery(options);
      await waitForReceipt(projectRoot, options.intentId);
      const second = await executeNeonExactlyOnceDelivery(options);
      releaseSend?.();
      const firstResult = await first;

      assert.equal(firstResult.state, "delivered");
      assert.equal(second.state, "in-flight");
      assert.equal(sendCalls, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks restart replays after a delivered receipt", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-delivery-receipt-"));
    let sendCalls = 0;

    try {
      const options = createOptions(projectRoot, async (target) => {
        sendCalls += 1;
        return createSentResult(target, "discord-message-2");
      });
      const first = await executeNeonExactlyOnceDelivery(options);
      const replay = await executeNeonExactlyOnceDelivery(options);
      const receipt = await readNeonDeliveryReceipt(projectRoot, options.intentId);

      assert.equal(first.state, "delivered");
      assert.equal(replay.state, "already-delivered");
      assert.equal(replay.messageId, "discord-message-2");
      assert.equal(receipt?.state, "delivered");
      assert.equal(receipt?.attempts, 1);
      assert.equal(receipt?.nonce, createNeonDiscordDeliveryNonce(options.intentId, 0));
      assert.equal(sendCalls, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("retries an uncertain attempt with the same delivery intent", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-delivery-receipt-"));
    const intents: Array<string | undefined> = [];
    let sendCalls = 0;

    try {
      const options = createOptions(projectRoot, async (target) => {
        sendCalls += 1;
        intents.push(target.deliveryIntentId);
        if (sendCalls === 1) {
          throw new Error("response lost after platform send");
        }
        return createSentResult(target, "discord-message-3");
      });
      const uncertain = await executeNeonExactlyOnceDelivery(options);
      const retry = await executeNeonExactlyOnceDelivery(options);
      const receipt = await readNeonDeliveryReceipt(projectRoot, options.intentId);

      assert.equal(uncertain.state, "transport-error");
      assert.equal(retry.state, "delivered");
      assert.deepEqual(intents, [options.intentId, options.intentId]);
      assert.equal(receipt?.attempts, 2);
      assert.equal(receipt?.messageId, "discord-message-3");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("fails closed when an intent payload changes", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-delivery-receipt-"));
    let sendCalls = 0;

    try {
      const options = createOptions(projectRoot, async (target) => {
        sendCalls += 1;
        return createSentResult(target, "discord-message-4");
      });
      await executeNeonExactlyOnceDelivery(options);
      const mismatch = await executeNeonExactlyOnceDelivery({
        ...options,
        payloadHash: createNeonDeliveryPayloadHash(["changed body"])
      });

      assert.equal(mismatch.state, "payload-mismatch");
      assert.equal(sendCalls, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("fails closed on corrupted state and stores only mode-0600 metadata", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-delivery-receipt-"));
    const secretBody = "private-pdf-body-SHOULD-NOT-BE-STORED";

    try {
      const options = createOptions(projectRoot, async (target) =>
        createSentResult(target, "discord-message-5")
      );
      await executeNeonExactlyOnceDelivery({
        ...options,
        payloadHash: createNeonDeliveryPayloadHash([secretBody])
      });
      const directory = join(projectRoot, "state", "gateway", "delivery-receipts");
      const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
      assert.equal(files.length, 1);
      const receiptPath = join(directory, files[0] ?? "missing");
      const raw = await readFile(receiptPath, "utf8");
      assert.doesNotMatch(raw, /SHOULD-NOT-BE-STORED/u);
      assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);

      await writeFile(receiptPath, "{not-json", { encoding: "utf8", mode: 0o600 });
      await assert.rejects(
        executeNeonExactlyOnceDelivery(options),
        /Unexpected token|Expected property name/u
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createOptions(
  projectRoot: string,
  send: (target: INeonDeliveryQueueTarget) => Promise<INeonOutboundSendResult>
) {
  const intentId = createNeonDeliveryIntentId("run-1", TARGET, "text");
  return {
    projectRoot,
    intentId,
    runId: "run-1",
    kind: "text" as const,
    target: TARGET,
    payloadHash: createNeonDeliveryPayloadHash(["stable body"]),
    send
  };
}

function createSentResult(
  target: INeonDeliveryQueueTarget,
  messageId: string
): INeonOutboundSendResult {
  return {
    outboundSent: true,
    target,
    bodyPreview: "stable body",
    cutoverStage: "canary",
    messageId,
    sentAt: "2026-07-10T10:00:00.000Z"
  };
}

async function waitForReceipt(projectRoot: string, intentId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await readNeonDeliveryReceipt(projectRoot, intentId)) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("delivery receipt was not created in time");
}
