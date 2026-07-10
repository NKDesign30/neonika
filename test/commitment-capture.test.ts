import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildNeonCommitmentCaptureCandidates,
  captureNeonCommitmentsFromRun,
  listNeonDueCommitments,
  readNeonCommitments,
  resolveNeonCommitmentCaptureGate,
  resolveNeonCommitmentStorePath,
  type INeonGatewayInboundMessage,
  type INeonGatewayShadowRun
} from "../src/index.js";

const now = new Date("2026-06-03T12:00:00.000Z");
const nowMs = now.getTime();

test("buildNeonCommitmentCaptureCandidates extracts explicit promise + due hint", () => {
  const candidates = buildNeonCommitmentCaptureCandidates({
    run: createRun("Ich erinnere dich in 15m daran und checke den Deploy."),
    message: createMessage(),
    nowMs
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.commitment.agentId, "chaty");
  assert.equal(candidates[0]?.commitment.status, "pending");
  assert.equal(candidates[0]?.commitment.source, "agent_promise");
  assert.equal(candidates[0]?.commitment.dueWindow.earliestMs, nowMs + 15 * 60_000);
  assert.match(candidates[0]?.commitment.suggestedText ?? "", /Follow-up:/u);
});

test("buildNeonCommitmentCaptureCandidates ignores non-promises and non-completed runs", () => {
  assert.equal(
    buildNeonCommitmentCaptureCandidates({
      run: createRun("Fertig."),
      message: createMessage(),
      nowMs
    }).length,
    0
  );
  assert.equal(
    buildNeonCommitmentCaptureCandidates({
      run: { ...createRun("Ich erinnere dich morgen."), status: "failed" },
      message: createMessage(),
      nowMs
    }).length,
    0
  );
});

test("captureNeonCommitmentsFromRun is default-off, then writes deduped commitments when armed", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-commitment-capture-"));
  const storePath = resolveNeonCommitmentStorePath(projectRoot);
  const run = createRun("Ich erinnere dich in 15m daran und checke den Deploy.");
  const message = createMessage();

  try {
    const off = await captureNeonCommitmentsFromRun({
      projectRoot,
      run,
      message,
      gate: resolveNeonCommitmentCaptureGate({}),
      storePath,
      now: () => now
    });
    assert.equal(off.state, "blocked");
    assert.equal((await readNeonCommitments({ storePath })).length, 0);

    const armed = await captureNeonCommitmentsFromRun({
      projectRoot,
      run,
      message,
      gate: resolveNeonCommitmentCaptureGate({ NEON_COMMITMENT_CAPTURE_ENABLED: "ready" }),
      storePath,
      now: () => now
    });
    const duplicate = await captureNeonCommitmentsFromRun({
      projectRoot,
      run,
      message,
      gate: resolveNeonCommitmentCaptureGate({ NEON_COMMITMENT_CAPTURE_ENABLED: "ready" }),
      storePath,
      now: () => now
    });

    const stored = await readNeonCommitments({ storePath });
    assert.equal(armed.state, "captured");
    assert.equal(armed.captured.length, 1);
    assert.equal(duplicate.state, "skipped");
    assert.equal(stored.length, 1);
    assert.equal(listNeonDueCommitments(stored, nowMs + 16 * 60_000, run.harnessSessionKey).length, 1);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

function createMessage(): INeonGatewayInboundMessage {
  return {
    channel: "discord",
    accountId: "default",
    guildId: "900000000000000001",
    channelId: "900000000000000005",
    threadId: "900000000000000011",
    messageId: "commitment-capture-test-message",
    userId: "operator",
    userDisplayName: "Operator",
    agentId: "chaty",
    workspaceRoot: "/tmp/neon-core-commitment-capture-test",
    mode: "read-only",
    content: "<@900000000000000010> check bitte später ob der Deploy grün ist",
    createdAt: "2026-06-03T11:59:00.000Z"
  };
}

function createRun(finalText: string): INeonGatewayShadowRun {
  const message = createMessage();
  return {
    runId: "neon-shadow-commitment-capture-test",
    mode: "shadow",
    status: "completed",
    request: {
      channel: message.channel,
      accountId: message.accountId,
      channelId: message.channelId,
      userId: message.userId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.userDisplayName ? { userDisplayName: message.userDisplayName } : {}),
      agentId: message.agentId,
      workspaceRoot: message.workspaceRoot,
      mode: message.mode,
      contentPreview: message.content,
      receivedAt: message.createdAt ?? now.toISOString()
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:channel:commitment-capture",
    memoryState: "skipped",
    events: [{ kind: "final", text: finalText }],
    finalText,
    delivery: {
      state: "suppressed",
      targetChannel: message.channel,
      targetChannelId: message.channelId,
      reason: "shadow-mode",
      finalText
    },
    startedAt: "2026-06-03T11:59:30.000Z",
    completedAt: now.toISOString()
  };
}
