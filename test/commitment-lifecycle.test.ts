import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendNeonCommitment,
  buildNeonCommitmentRecord,
  listNeonDueCommitments,
  markNeonCommitmentsHeartbeatObserved,
  readNeonCommitments,
  resolveNeonCommitmentLifecycleGate,
  resolveNeonCommitmentStoreGate
} from "../src/index.js";

async function tempStorePath(): Promise<{ readonly dir: string; readonly storePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "neon-commitment-lifecycle-"));
  return { dir, storePath: join(dir, "commitments.jsonl") };
}

test("markNeonCommitmentsHeartbeatObserved blocks by default", async () => {
  const result = await markNeonCommitmentsHeartbeatObserved({
    commitmentIds: ["commitment-1"],
    nowMs: 1_000,
    gate: resolveNeonCommitmentLifecycleGate({})
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.updatedIds.length, 0);
  assert.deepEqual(result.skippedIds, ["commitment-1"]);
  assert.match(result.diagnostics.join(" "), /NEON_COMMITMENT_LIFECYCLE_ENABLED/u);
});

test("markNeonCommitmentsHeartbeatObserved snoozes active commitments and increments attempts", async () => {
  const { dir, storePath } = await tempStorePath();
  const baseMs = Date.parse("2026-06-02T12:00:00.000Z");
  try {
    const commitment = buildNeonCommitmentRecord(
      {
        id: "commitment-1",
        agentId: "chaty",
        sessionKey: "discord/private",
        channel: "discord",
        kind: "open_loop",
        source: "agent_promise",
        suggestedText: "check the deployment",
        dedupeKey: "discord/private:deploy",
        confidence: 0.95,
        dueWindow: {
          earliestMs: baseMs - 60_000,
          latestMs: baseMs + 3_600_000,
          timezone: "Europe/Berlin"
        }
      },
      baseMs - 120_000
    );
    const storeGate = resolveNeonCommitmentStoreGate({ NEON_COMMITMENTS_STORE_ENABLED: "ready" });
    await appendNeonCommitment({ commitment, gate: storeGate, storePath });

    const result = await markNeonCommitmentsHeartbeatObserved({
      commitmentIds: ["commitment-1", "commitment-1", "missing"],
      storePath,
      nowMs: baseMs,
      gate: resolveNeonCommitmentLifecycleGate({ NEON_COMMITMENT_LIFECYCLE_ENABLED: "ready" }),
      storeGate,
      snoozeMs: 900_000
    });

    assert.equal(result.state, "updated");
    assert.deepEqual(result.updatedIds, ["commitment-1"]);
    assert.deepEqual(result.skippedIds, ["missing"]);

    const commitments = await readNeonCommitments({ storePath });
    const updated = commitments.find((candidate) => candidate.id === "commitment-1");
    assert.equal(updated?.status, "snoozed");
    assert.equal(updated?.attempts, 1);
    assert.equal(updated?.snoozedUntilMs, baseMs + 900_000);
    assert.equal(listNeonDueCommitments(commitments, baseMs).length, 0);
    assert.equal(listNeonDueCommitments(commitments, baseMs + 900_001).length, 1);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
