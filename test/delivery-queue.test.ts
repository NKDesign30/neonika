import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDeliveryDryRunCandidate,
  createNeonDeliveryQueueSnapshot,
  enqueueNeonDeliveryDryRunCandidate,
  readNeonDeliveryApprovalRecords,
  readNeonDeliveryQueueCandidates,
  recordNeonDeliveryApproval,
  resolveNeonDeliveryQueuePaths,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neonika Delivery Queue", () => {
  it("creates no-send Discord delivery candidates from Gateway runs", () => {
    const candidate = createNeonDeliveryDryRunCandidate(createRun(), {
      now: () => new Date("2026-05-31T20:00:00.000Z")
    });

    assert.match(candidate.id, /^neon-delivery-/);
    assert.equal(candidate.state, "queued-dry-run");
    assert.equal(candidate.reason, "primary-dry-run");
    assert.equal(candidate.target.channel, "discord");
    assert.equal(candidate.target.replyToMessageId, "message-1");
    assert.equal(candidate.safety.outboundSent, false);
    assert.equal(candidate.safety.requiresApproval, true);
    assert.equal(candidate.safety.cutoverStage, "shadow");
    assert.equal(candidate.ackState, "queued");
    assert.equal(candidate.recoveryState, "none");
  });

  it("keeps webchat dry-run candidates queue-visible without sending", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-webchat-"));
    const baseRun = createRun();

    try {
      const candidate = await enqueueNeonDeliveryDryRunCandidate(
        projectRoot,
        createRun({
          runId: "run-webchat",
          request: {
            ...baseRun.request,
            channel: "webchat",
            accountId: "dashboard",
            channelId: "webchat-main",
            messageId: "webchat-message-1"
          },
          delivery: {
            ...baseRun.delivery,
            targetChannel: "webchat",
            targetChannelId: "webchat-main"
          }
        }),
        {
          now: () => new Date("2026-05-31T20:04:00.000Z")
        }
      );

      const snapshot = await createNeonDeliveryQueueSnapshot(projectRoot);

      assert.equal(candidate.target.channel, "webchat");
      assert.equal(snapshot.totals.candidates, 1);
      assert.equal(snapshot.candidates[0]?.id, candidate.id);
      assert.equal(snapshot.candidates[0]?.target.channel, "webchat");
      assert.equal(snapshot.candidates[0]?.safety.outboundSent, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps unsupported channel candidates out of the delivery queue read model", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-unsupported-"));
    const baseRun = createRun();

    try {
      const unsupported = createNeonDeliveryDryRunCandidate(
        createRun({
          runId: "run-telegram",
          request: {
            ...baseRun.request,
            channel: "telegram",
            accountId: "telegram-default",
            channelId: "telegram-chat"
          },
          delivery: {
            ...baseRun.delivery,
            targetChannel: "telegram",
            targetChannelId: "telegram-chat"
          }
        }),
        {
          now: () => new Date("2026-05-31T20:04:30.000Z")
        }
      );

      const { queuePath } = resolveNeonDeliveryQueuePaths(projectRoot);
      await mkdir(dirname(queuePath), { recursive: true });
      await appendFile(queuePath, `${JSON.stringify(unsupported)}\n`, "utf8");

      const candidates = await readNeonDeliveryQueueCandidates(projectRoot);

      assert.equal(candidates.length, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("defaults ackState/recoveryState for legacy persisted rows without the fields", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-legacy-"));

    try {
      const fresh = createNeonDeliveryDryRunCandidate(createRun({ runId: "run-fresh" }), {
        now: () => new Date("2026-05-31T20:05:00.000Z")
      });
      const legacy = createNeonDeliveryDryRunCandidate(createRun({ runId: "run-legacy" }), {
        now: () => new Date("2026-05-31T20:06:00.000Z")
      });
      const { ackState: _ack, recoveryState: _recovery, ...legacyWithoutNewFields } = legacy;

      const { queuePath } = resolveNeonDeliveryQueuePaths(projectRoot);
      await mkdir(dirname(queuePath), { recursive: true });
      await appendFile(queuePath, `${JSON.stringify(legacyWithoutNewFields)}\n`, "utf8");
      await appendFile(queuePath, `${JSON.stringify(fresh)}\n`, "utf8");

      const candidates = await readNeonDeliveryQueueCandidates(projectRoot);

      assert.equal(candidates.length, 2);
      const reread = candidates.find((entry) => entry.runId === "run-legacy");
      assert.ok(reread, "legacy candidate must not be dropped");
      assert.equal(reread.ackState, "queued");
      assert.equal(reread.recoveryState, "none");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("round-trips ackState/recoveryState through persistence and totals", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-status-"));

    try {
      const base = createNeonDeliveryDryRunCandidate(createRun({ runId: "run-status" }), {
        now: () => new Date("2026-05-31T20:07:00.000Z")
      });
      const working = { ...base, runId: "run-working", ackState: "working" as const };
      const done = {
        ...base,
        runId: "run-done",
        ackState: "done" as const,
        recoveryState: "pending-drain" as const
      };

      const { queuePath } = resolveNeonDeliveryQueuePaths(projectRoot);
      await mkdir(dirname(queuePath), { recursive: true });
      await appendFile(queuePath, `${JSON.stringify(base)}\n`, "utf8");
      await appendFile(queuePath, `${JSON.stringify(working)}\n`, "utf8");
      await appendFile(queuePath, `${JSON.stringify(done)}\n`, "utf8");

      const snapshot = await createNeonDeliveryQueueSnapshot(projectRoot);

      assert.equal(snapshot.totals.candidates, 3);
      assert.equal(snapshot.totals.ackStateCounts.queued, 1);
      assert.equal(snapshot.totals.ackStateCounts.working, 1);
      assert.equal(snapshot.totals.ackStateCounts.done, 1);
      assert.equal(snapshot.totals.pendingRecovery, 1);

      const reread = snapshot.candidates.find((entry) => entry.runId === "run-done");
      assert.ok(reread, "done candidate must survive parse roundtrip");
      assert.equal(reread.ackState, "done");
      assert.equal(reread.recoveryState, "pending-drain");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks failed runs and redacts final text previews", () => {
    const candidate = createNeonDeliveryDryRunCandidate(
      createRun({
        status: "failed",
        finalText: "failed sk-test-secret-value"
      })
    );

    assert.equal(candidate.state, "blocked");
    assert.equal(candidate.reason, "run-failed");
    assert.doesNotMatch(candidate.finalTextPreview, /sk-test-secret-value/);
    assert.match(candidate.finalTextPreview, /\[REDACTED_SECRET\]/);
  });

  it("keeps delivery previews UTF-16 safe when truncating emoji boundaries", () => {
    const candidate = createNeonDeliveryDryRunCandidate(
      createRun({
        finalText: `${"a".repeat(498)}🙂tail`
      })
    );

    assert.equal(candidate.finalTextPreview, `${"a".repeat(498)}…`);
    assert.doesNotMatch(candidate.finalTextPreview, /[\ud800-\udbff]$/u);
  });

  it("persists and summarizes delivery dry-runs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-queue-"));

    try {
      const candidate = await enqueueNeonDeliveryDryRunCandidate(projectRoot, createRun({ runId: "run-1" }), {
        now: () => new Date("2026-05-31T20:01:00.000Z")
      });
      await enqueueNeonDeliveryDryRunCandidate(
        projectRoot,
        createRun({ runId: "run-2", finalText: "" }),
        {
          now: () => new Date("2026-05-31T20:02:00.000Z")
        }
      );
      const approval = await recordNeonDeliveryApproval(
        projectRoot,
        {
          candidateId: candidate.id,
          decision: "approve-canary",
          operatorId: "operator",
          reason: "bereit für canary sk-test-secret-value"
        },
        {
          now: () => new Date("2026-05-31T20:03:00.000Z")
        }
      );

      const snapshot = await createNeonDeliveryQueueSnapshot(projectRoot);
      const approvals = await readNeonDeliveryApprovalRecords(projectRoot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.candidates, 2);
      assert.equal(snapshot.totals.queuedDryRuns, 1);
      assert.equal(snapshot.totals.blocked, 1);
      assert.equal(snapshot.totals.approvalRecords, 1);
      assert.equal(snapshot.candidates[0]?.runId, "run-1");
      assert.equal(snapshot.candidates[1]?.reason, "empty-final-text");
      assert.equal(snapshot.approvals[0]?.id, approval.id);
      assert.equal(approvals[0]?.candidateId, candidate.id);
      assert.equal(approvals[0]?.safety.outboundSent, false);
      assert.match(approvals[0]?.reason ?? "", /\[REDACTED_SECRET\]/);
      // Read-time ack producer: the operator-decided candidate is effectively "done".
      assert.equal(snapshot.candidates[0]?.ackState, "done");
      assert.equal(snapshot.candidates[1]?.ackState, "queued");
      assert.equal(snapshot.totals.ackStateCounts.done, 1);
      assert.equal(snapshot.totals.ackStateCounts.queued, 1);
      assert.equal(snapshot.totals.pendingRecovery, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects approval records for blocked or missing candidates", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-approval-"));

    try {
      const blocked = await enqueueNeonDeliveryDryRunCandidate(
        projectRoot,
        createRun({ runId: "run-blocked", finalText: "" })
      );

      await assert.rejects(
        () => recordNeonDeliveryApproval(projectRoot, {
          candidateId: blocked.id,
          decision: "approve-canary"
        }),
        /not queued/
      );
      await assert.rejects(
        () => recordNeonDeliveryApproval(projectRoot, {
          candidateId: "missing-candidate",
          decision: "approve-canary"
        }),
        /not found/
      );
      await assert.rejects(
        () => recordNeonDeliveryApproval(projectRoot, {
          candidateId: "",
          decision: "approve-canary"
        }),
        /must not be empty/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createRun(overrides: Partial<INeonGatewayShadowRun> = {}): INeonGatewayShadowRun {
  return {
    runId: "run-delivery",
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
      receivedAt: "2026-05-31T20:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-delivery",
    memoryState: "attached",
    events: [
      {
        kind: "final",
        text: "Antwort bereit"
      }
    ],
    finalText: "Antwort bereit",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "Antwort bereit"
    },
    startedAt: "2026-05-31T20:00:00.000Z",
    completedAt: "2026-05-31T20:00:01.000Z",
    ...overrides
  };
}
