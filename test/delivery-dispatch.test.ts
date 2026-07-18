import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDeliveryDryRunCandidate,
  createNeonDryRunOutboundSender,
  deliverAndRecordNeonApprovedCandidate,
  deliverNeonApprovedCandidate,
  readNeonDeliveryDispatchRecords,
  readNeonDeliveryPlatformSendMarkers,
  recordNeonDeliveryPlatformSendMarker,
  renderNeonDeliveryDispatchReport,
  type INeonDeliveryApprovalRecord,
  type INeonDeliveryQueueCandidate,
  type INeonGatewayShadowRun,
  type INeonOutboundSender
} from "../src/index.js";

describe("Neon Delivery dispatch", () => {
  it("does not send when the candidate has no matching approval", async () => {
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const result = await deliverNeonApprovedCandidate({
      sender: createNeonDryRunOutboundSender(),
      candidate,
      now: () => new Date("2026-06-02T11:00:00.000Z")
    });

    assert.equal(result.outcome, "not-approved");
    assert.equal(result.outboundSent, false);
    assert.equal(result.ackState, "queued");
    assert.equal(result.messageId, undefined);
  });

  it("stays suppressed when approved but the sender is no-send (dry-run)", async () => {
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const result = await deliverNeonApprovedCandidate({
      sender: createNeonDryRunOutboundSender(),
      candidate,
      approval: approve(candidate)
    });

    assert.equal(result.outcome, "suppressed");
    assert.equal(result.outboundSent, false);
    assert.equal(result.ackState, "queued");
    assert.equal(result.reason, "dry-run-no-send");
  });

  it("transitions to done with a message id when an approved send succeeds", async () => {
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const { sender, calls } = mockSendingSender();

    const result = await deliverNeonApprovedCandidate({
      sender,
      candidate,
      approval: approve(candidate)
    });

    assert.equal(result.outcome, "delivered");
    assert.equal(result.outboundSent, true);
    assert.equal(result.ackState, "done");
    assert.equal(result.recoveryState, "none");
    assert.equal(result.messageId, "mock-msg-1");
    assert.equal(calls.length, 1);
    assert.match(renderNeonDeliveryDispatchReport(result), /Neon Delivery dispatch: delivered/);
  });

  it("protects a terminal candidate from re-sending", async () => {
    const candidate: INeonDeliveryQueueCandidate = {
      ...createNeonDeliveryDryRunCandidate(createRun()),
      ackState: "done"
    };
    const { sender, calls } = mockSendingSender();

    const result = await deliverNeonApprovedCandidate({
      sender,
      candidate,
      approval: approve(candidate)
    });

    assert.equal(result.outcome, "already-terminal");
    assert.equal(result.outboundSent, false);
    assert.equal(calls.length, 0);
  });

  it("marks pending-drain on a transport error and never leaks the raw error", async () => {
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("connect ECONNREFUSED token=sk-leak-attempt-9999 channel=999");
      }
    };

    const result = await deliverNeonApprovedCandidate({
      sender,
      candidate,
      approval: approve(candidate)
    });

    assert.equal(result.outcome, "transport-error");
    assert.equal(result.outboundSent, false);
    assert.equal(result.ackState, "working");
    assert.equal(result.recoveryState, "pending-drain");
    assert.equal(result.reason, "transport-error");
    assert.doesNotMatch(JSON.stringify(result), /sk-leak-attempt-9999/);
    assert.doesNotMatch(JSON.stringify(result), /ECONNREFUSED/);
  });

  it("records successful dispatches and blocks crash replays from sending twice", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-dispatch-"));
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const { sender, calls } = mockSendingSender();

    try {
      const first = await deliverAndRecordNeonApprovedCandidate({
        projectRoot,
        sender,
        candidate,
        approval: approve(candidate),
        now: () => new Date("2026-06-02T11:00:01.000Z")
      });
      const replay = await deliverAndRecordNeonApprovedCandidate({
        projectRoot,
        sender,
        candidate,
        approval: approve(candidate),
        now: () => new Date("2026-06-02T11:00:02.000Z")
      });
      const records = await readNeonDeliveryDispatchRecords(projectRoot);

      assert.equal(first.outcome, "delivered");
      assert.equal(replay.outcome, "already-sent");
      assert.equal(replay.outboundSent, false);
      assert.equal(replay.ackState, "done");
      assert.equal(replay.messageId, "mock-msg-1");
      assert.equal(calls.length, 1);
      assert.deepEqual(records.map((record) => record.outcome), ["delivered", "already-sent"]);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks crash replays from platform-send markers even when dispatch ack is missing", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-platform-send-"));
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const { sender, calls } = mockSendingSender();

    try {
      const first = await deliverNeonApprovedCandidate({
        sender,
        candidate,
        approval: approve(candidate),
        now: () => new Date("2026-06-02T11:00:03.000Z")
      });
      await recordNeonDeliveryPlatformSendMarker(projectRoot, first);

      const replay = await deliverAndRecordNeonApprovedCandidate({
        projectRoot,
        sender,
        candidate,
        approval: approve(candidate),
        now: () => new Date("2026-06-02T11:00:04.000Z")
      });
      const records = await readNeonDeliveryDispatchRecords(projectRoot);
      const markers = await readNeonDeliveryPlatformSendMarkers(projectRoot);

      assert.equal(first.outcome, "delivered");
      assert.equal(replay.outcome, "already-sent");
      assert.equal(replay.outboundSent, false);
      assert.equal(replay.ackState, "done");
      assert.equal(replay.messageId, "mock-msg-1");
      assert.equal(calls.length, 1);
      assert.deepEqual(records.map((record) => record.outcome), ["already-sent"]);
      assert.equal(markers.length, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records pending-drain transport errors and blocks blind replay before reconciliation", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-dispatch-drain-"));
    const candidate = createNeonDeliveryDryRunCandidate(createRun());
    const failingSender: INeonOutboundSender = {
      sendText() {
        throw new Error("socket closed after platform send may have started");
      }
    };
    const { sender: succeedingSender, calls } = mockSendingSender();

    try {
      const first = await deliverAndRecordNeonApprovedCandidate({
        projectRoot,
        sender: failingSender,
        candidate,
        approval: approve(candidate),
        now: () => new Date("2026-06-02T11:01:01.000Z")
      });
      const replay = await deliverAndRecordNeonApprovedCandidate({
        projectRoot,
        sender: succeedingSender,
        candidate,
        approval: approve(candidate),
        now: () => new Date("2026-06-02T11:01:02.000Z")
      });

      assert.equal(first.outcome, "transport-error");
      assert.equal(first.recoveryState, "pending-drain");
      assert.equal(replay.outcome, "pending-drain");
      assert.equal(replay.outboundSent, false);
      assert.equal(replay.ackState, "working");
      assert.equal(calls.length, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function approve(candidate: INeonDeliveryQueueCandidate): INeonDeliveryApprovalRecord {
  return {
    id: `approval-${candidate.id}`,
    candidateId: candidate.id,
    runId: candidate.runId,
    decision: "approve-canary",
    operatorId: "operator",
    safety: { outboundSent: false, requiresCanaryGate: true, cutoverStage: "shadow" },
    createdAt: "2026-06-02T11:00:00.000Z"
  };
}

function mockSendingSender(): {
  readonly sender: INeonOutboundSender;
  readonly calls: string[];
} {
  const calls: string[] = [];

  return {
    calls,
    sender: {
      sendText(target, message) {
        calls.push(message);
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message.slice(0, 32),
          cutoverStage: "canary",
          messageId: "mock-msg-1",
          sentAt: "2026-06-02T11:00:01.000Z"
        });
      }
    }
  };
}

function createRun(overrides: Partial<INeonGatewayShadowRun> = {}): INeonGatewayShadowRun {
  return {
    runId: "run-dispatch",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      messageId: "message-1",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Bitte liefern",
      receivedAt: "2026-06-02T10:59:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-dispatch",
    memoryState: "attached",
    events: [{ kind: "final", text: "Antwort bereit" }],
    finalText: "Antwort bereit",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "Antwort bereit"
    },
    startedAt: "2026-06-02T10:59:00.000Z",
    completedAt: "2026-06-02T10:59:01.000Z",
    ...overrides
  };
}
