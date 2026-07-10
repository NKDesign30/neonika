import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { INeonDeliveryQueueTarget } from "../src/gateway/deliveryQueue.js";
import {
  createNeonCanaryMessageEditSender,
  createNeonDryRunMessageEditSender,
  type INeonMessageEditTransport
} from "../src/gateway/messageEditSender.js";

const target: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "chan-1"
};

const fixedNow = (): Date => new Date("2026-06-03T01:00:00.000Z");

const openGate = {
  cutoverStage: "canary" as const,
  canaryApproved: true,
  outboundEnabled: true
};

const closedGate = {
  cutoverStage: "shadow" as const,
  canaryApproved: false,
  outboundEnabled: false
};

interface IRecordedEdit {
  readonly op: "edit" | "delete";
  readonly messageId: string;
  readonly body?: string;
}

function createRecordingTransport(): {
  readonly transport: INeonMessageEditTransport;
  readonly calls: IRecordedEdit[];
} {
  const calls: IRecordedEdit[] = [];

  return {
    transport: {
      editMessage(_target, messageId, body): Promise<void> {
        calls.push({ op: "edit", messageId, body });
        return Promise.resolve();
      },
      deleteMessage(_target, messageId): Promise<void> {
        calls.push({ op: "delete", messageId });
        return Promise.resolve();
      }
    },
    calls
  };
}

describe("Neon message edit/delete sender", () => {
  it("dry-run edit never mutates and reports editSent:false", async () => {
    const sender = createNeonDryRunMessageEditSender({ now: fixedNow });

    const result = await sender.editMessage(target, "msg-1", "updated body");

    assert.equal(result.editSent, false);
    if (!result.editSent) {
      assert.equal(result.reason, "dry-run-no-send");
      assert.equal(result.cutoverStage, "shadow");
      assert.equal(result.bodyPreview, "updated body");
    }
  });

  it("dry-run delete never mutates and reports deleteSent:false", async () => {
    const sender = createNeonDryRunMessageEditSender({ now: fixedNow });

    const result = await sender.deleteMessage(target, "msg-1");

    assert.equal(result.deleteSent, false);
    if (!result.deleteSent) {
      assert.equal(result.reason, "dry-run-no-send");
    }
  });

  it("canary edit stays suppressed without an open gate", async () => {
    const sender = createNeonCanaryMessageEditSender({ now: fixedNow, gateFacts: closedGate });

    const result = await sender.editMessage(target, "msg-1", "x");

    assert.equal(result.editSent, false);
    if (!result.editSent) {
      assert.equal(result.reason, "canary-gate-closed");
    }
  });

  it("canary edit stays suppressed when the gate is open but no transport is injected", async () => {
    const sender = createNeonCanaryMessageEditSender({ now: fixedNow, gateFacts: openGate });

    const result = await sender.editMessage(target, "msg-1", "x");

    assert.equal(result.editSent, false);
    if (!result.editSent) {
      assert.equal(result.reason, "canary-gate-closed");
    }
  });

  it("canary edit mutates only with an open gate AND a transport", async () => {
    const { transport, calls } = createRecordingTransport();
    const sender = createNeonCanaryMessageEditSender({ now: fixedNow, gateFacts: openGate, transport });

    const result = await sender.editMessage(target, "msg-1", "updated");

    assert.equal(result.editSent, true);
    if (result.editSent) {
      assert.equal(result.cutoverStage, "canary");
      assert.equal(result.editedAt, "2026-06-03T01:00:00.000Z");
    }
    assert.deepEqual(calls, [{ op: "edit", messageId: "msg-1", body: "updated" }]);
  });

  it("canary delete mutates only with an open gate AND a transport", async () => {
    const { transport, calls } = createRecordingTransport();
    const sender = createNeonCanaryMessageEditSender({ now: fixedNow, gateFacts: openGate, transport });

    const result = await sender.deleteMessage(target, "msg-9");

    assert.equal(result.deleteSent, true);
    if (result.deleteSent) {
      assert.equal(result.cutoverStage, "canary");
      assert.equal(result.deletedAt, "2026-06-03T01:00:00.000Z");
    }
    assert.deepEqual(calls, [{ op: "delete", messageId: "msg-9" }]);
  });

  it("canary edit/delete reject a channel outside the allowlist and never call the transport", async () => {
    const { transport, calls } = createRecordingTransport();
    const sender = createNeonCanaryMessageEditSender({
      now: fixedNow,
      gateFacts: openGate,
      transport,
      channelAllowlist: { channels: new Set(["other-chan"]), configured: true }
    });

    const edit = await sender.editMessage(target, "msg-1", "x");
    const del = await sender.deleteMessage(target, "msg-1");

    assert.equal(edit.editSent, false);
    if (!edit.editSent) {
      assert.equal(edit.reason, "canary-channel-not-allowlisted");
    }
    assert.equal(del.deleteSent, false);
    if (!del.deleteSent) {
      assert.equal(del.reason, "canary-channel-not-allowlisted");
    }
    assert.deepEqual(calls, []);
  });

  it("redacts the edit body preview and keeps the result leak-safe", async () => {
    const sender = createNeonDryRunMessageEditSender({ now: fixedNow });

    const result = await sender.editMessage(target, "msg-1", "token secret=sk-abc123 inside");

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /sk-abc123/);
  });

  it("truncates the edit body preview without splitting UTF-16 surrogate pairs", async () => {
    const sender = createNeonDryRunMessageEditSender({ now: fixedNow, bodyPreviewMaxLength: 10 });

    const result = await sender.editMessage(target, "msg-1", `${"a".repeat(8)}🙂tail`);

    assert.equal(result.editSent, false);
    if (!result.editSent) {
      assert.equal(result.bodyPreview, `${"a".repeat(8)}…`);
      assert.equal(result.bodyPreview.includes("\uD83D"), false);
    }
  });
});
