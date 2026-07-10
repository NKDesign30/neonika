import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appendNeonCommitment,
  applyNeonCommitmentStatus,
  buildNeonCommitmentRecord,
  findActiveNeonCommitmentByDedupeKey,
  listNeonDueCommitments,
  readNeonCommitments,
  renderNeonDueCommitmentsReport,
  type INeonCommitmentRecord
} from "../src/index.js";

const OPEN_GATE = {
  enabled: true,
  reason: "store-enabled" as const,
  envKey: "NEON_COMMITMENTS_STORE_ENABLED" as const
};
const CLOSED_GATE = {
  enabled: false,
  reason: "store-disabled" as const,
  envKey: "NEON_COMMITMENTS_STORE_ENABLED" as const
};

function makeCommitment(
  overrides: Partial<INeonCommitmentRecord> & { id: string }
): INeonCommitmentRecord {
  return {
    agentId: "neo",
    sessionKey: "sess-1",
    channel: "discord",
    kind: "open_loop",
    source: "agent_promise",
    status: "pending",
    suggestedText: "check in",
    dedupeKey: "dk-1",
    confidence: 0.9,
    dueWindow: { earliestMs: 1_000, latestMs: 5_000, timezone: "UTC" },
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    attempts: 0,
    ...overrides
  };
}

test("buildNeonCommitmentRecord redacts text, sets pending, clamps confidence", () => {
  const built = buildNeonCommitmentRecord(
    {
      id: "c1",
      agentId: "neo",
      sessionKey: "s1",
      channel: "discord",
      kind: "deadline_check",
      source: "inferred_user_context",
      suggestedText: "ping me about sk-abcdef0123456789ABCDEF tomorrow",
      dedupeKey: "dk",
      confidence: 1.5,
      dueWindow: { earliestMs: 2_000, latestMs: 9_000, timezone: "UTC" }
    },
    1_000
  );

  assert.equal(built.status, "pending");
  assert.equal(built.attempts, 0);
  assert.equal(built.createdAtMs, 1_000);
  assert.equal(built.updatedAtMs, 1_000);
  assert.equal(built.confidence, 1); // clamped from 1.5
  assert.match(built.suggestedText, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(built.suggestedText, /sk-abcdef/);
});

test("applyNeonCommitmentStatus enforces valid transitions", () => {
  const pending = makeCommitment({ id: "c1" });

  const sent = applyNeonCommitmentStatus(pending, "sent", 2_000);
  assert.equal(sent.applied, true);
  if (sent.applied) {
    assert.equal(sent.commitment.status, "sent");
    assert.equal(sent.commitment.sentAtMs, 2_000);
    assert.equal(sent.commitment.updatedAtMs, 2_000);
  }

  // snooze needs snoozedUntilMs
  assert.equal(applyNeonCommitmentStatus(pending, "snoozed", 2_000).applied, false);
  const snoozed = applyNeonCommitmentStatus(pending, "snoozed", 2_000, { snoozedUntilMs: 9_000 });
  assert.equal(snoozed.applied, true);
  if (snoozed.applied) {
    assert.equal(snoozed.commitment.snoozedUntilMs, 9_000);
  }

  // back to pending is rejected
  assert.equal(applyNeonCommitmentStatus(pending, "pending", 2_000).applied, false);

  // inactive (sent) cannot transition
  const alreadySent = makeCommitment({ id: "c2", status: "sent" });
  assert.equal(applyNeonCommitmentStatus(alreadySent, "dismissed", 3_000).applied, false);

  // input is not mutated
  assert.equal(pending.status, "pending");
});

test("appendNeonCommitment is blocked by default (no gate / no store)", async () => {
  const commitment = makeCommitment({ id: "c1" });
  const blocked = await appendNeonCommitment({ commitment, gate: CLOSED_GATE });
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.diagnostics.join(" "), /NEON_COMMITMENTS_STORE_ENABLED/);

  const blockedNoPath = await appendNeonCommitment({ commitment, gate: OPEN_GATE });
  assert.equal(blockedNoPath.state, "blocked");
});

test("appendNeonCommitment writes + readNeonCommitments projects latest per id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-commitment-"));
  const storePath = join(dir, "commitments.jsonl");
  try {
    const v1 = makeCommitment({ id: "c1", status: "pending", updatedAtMs: 1_000 });
    const v2 = makeCommitment({ id: "c1", status: "sent", updatedAtMs: 2_000, sentAtMs: 2_000 });
    const other = makeCommitment({ id: "c2", suggestedText: "remember sk-0123456789abcdefXYZ" });

    assert.equal((await appendNeonCommitment({ commitment: v1, gate: OPEN_GATE, storePath })).state, "appended");
    await appendNeonCommitment({ commitment: v2, gate: OPEN_GATE, storePath });
    await appendNeonCommitment({
      commitment: buildNeonCommitmentRecord(
        {
          id: other.id,
          agentId: other.agentId,
          sessionKey: other.sessionKey,
          channel: other.channel,
          kind: other.kind,
          source: other.source,
          suggestedText: "remember sk-0123456789abcdefXYZ",
          dedupeKey: other.dedupeKey,
          confidence: other.confidence,
          dueWindow: other.dueWindow
        },
        1_500
      ),
      gate: OPEN_GATE,
      storePath
    });

    const read = await readNeonCommitments({ storePath });
    const c1 = read.find((c) => c.id === "c1");
    assert.equal(read.length, 2); // c1 collapsed to latest, plus c2
    assert.equal(c1?.status, "sent"); // latest updatedAtMs wins

    const raw = await readFile(storePath, "utf8");
    assert.doesNotMatch(raw, /sk-0123456789/); // suggestedText was redacted before store
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findActiveNeonCommitmentByDedupeKey ignores inactive commitments", () => {
  const commitments = [
    makeCommitment({ id: "c1", dedupeKey: "dup", status: "dismissed" }),
    makeCommitment({ id: "c2", dedupeKey: "dup", status: "pending" })
  ];
  assert.equal(findActiveNeonCommitmentByDedupeKey(commitments, "dup")?.id, "c2");
  assert.equal(findActiveNeonCommitmentByDedupeKey(commitments, "none"), undefined);
});

test("listNeonDueCommitments filters by active, due window, snooze, session", () => {
  const commitments = [
    makeCommitment({ id: "due", status: "pending", dueWindow: { earliestMs: 1_000, latestMs: 9_000, timezone: "UTC" } }),
    makeCommitment({ id: "future", status: "pending", dueWindow: { earliestMs: 9_999, latestMs: 99_999, timezone: "UTC" } }),
    makeCommitment({ id: "sent", status: "sent", dueWindow: { earliestMs: 1_000, latestMs: 9_000, timezone: "UTC" } }),
    makeCommitment({ id: "snoozed-future", status: "snoozed", snoozedUntilMs: 9_000, dueWindow: { earliestMs: 1_000, latestMs: 9_000, timezone: "UTC" } }),
    makeCommitment({ id: "snoozed-elapsed", status: "snoozed", snoozedUntilMs: 1_500, dueWindow: { earliestMs: 1_000, latestMs: 9_000, timezone: "UTC" } }),
    makeCommitment({ id: "other-session", sessionKey: "sess-2", status: "pending", dueWindow: { earliestMs: 1_000, latestMs: 9_000, timezone: "UTC" } })
  ];

  const due = listNeonDueCommitments(commitments, 5_000, "sess-1");
  const ids = due.map((c) => c.id).sort();
  assert.deepEqual(ids, ["due", "snoozed-elapsed"]);
});

test("renderNeonDueCommitmentsReport renders empty and populated", () => {
  assert.match(renderNeonDueCommitmentsReport([]), /none \(suppressed/);
  const rendered = renderNeonDueCommitmentsReport([
    makeCommitment({ id: "c1", kind: "care_check_in" })
  ]);
  assert.match(rendered, /1 \(suppressed/);
  assert.match(rendered, /c1 \[care_check_in\/pending\]/);
});
