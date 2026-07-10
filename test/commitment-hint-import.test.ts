import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildNeonCommitmentFromHint,
  importNeonCommitmentHints,
  parseNeonCommitmentHintsContent,
  readNeonCommitments,
  type INeonCommitmentStoreGate
} from "../src/index.js";

const ARMED_GATE: INeonCommitmentStoreGate = {
  enabled: true,
  reason: "store-enabled",
  envKey: "NEON_COMMITMENTS_STORE_ENABLED"
};
const OFF_GATE: INeonCommitmentStoreGate = {
  enabled: false,
  reason: "store-disabled",
  envKey: "NEON_COMMITMENTS_STORE_ENABLED"
};
const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");

function sampleHintsJson(): string {
  return JSON.stringify({
    hints: [
      {
        id: "hint-a",
        title: "Migrate action-inbox to neon-core",
        source: "codex:/Users/operator",
        excerpt: "do the migration",
        priorityHint: "high",
        confidence: 0.92,
        capturedAt: "2026-06-10T14:32:28+02:00"
      }
    ]
  });
}

test("buildNeonCommitmentFromHint maps deterministically", () => {
  const commitment = buildNeonCommitmentFromHint(
    {
      id: "hint-a",
      title: "Do the thing",
      source: "codex:/Users/operator",
      confidence: 0.9,
      capturedAt: "2026-06-10T14:32:28+02:00"
    },
    NOW_MS
  );
  assert.equal(commitment.id, "hint-hint-a");
  assert.equal(commitment.dedupeKey, "v3-hint:hint-a");
  assert.equal(commitment.kind, "open_loop");
  assert.equal(commitment.source, "inferred_user_context");
  assert.equal(commitment.channel, "codex");
  assert.equal(commitment.status, "pending");
  assert.equal(commitment.suggestedText, "Do the thing");
  assert.equal(commitment.confidence, 0.9);
  assert.equal(commitment.dueWindow.earliestMs, Date.parse("2026-06-10T14:32:28+02:00"));
  assert.equal(commitment.dueWindow.timezone, "UTC");
});

test("buildNeonCommitmentFromHint falls back to nowMs + excerpt + default channel", () => {
  const commitment = buildNeonCommitmentFromHint({ id: "x", title: "  " }, NOW_MS);
  assert.equal(commitment.suggestedText, "Follow-up x");
  assert.equal(commitment.channel, "import");
  assert.equal(commitment.dueWindow.earliestMs, NOW_MS);
  assert.equal(commitment.confidence, 0.5);
});

test("buildNeonCommitmentFromHint redacts secrets in suggestedText", () => {
  const commitment = buildNeonCommitmentFromHint(
    { id: "sec", title: "token sk-abcdef0123456789ghij now" },
    NOW_MS
  );
  assert.doesNotMatch(commitment.suggestedText, /sk-abcdef0123456789ghij/);
});

test("parseNeonCommitmentHintsContent handles valid + malformed input", () => {
  const ok = parseNeonCommitmentHintsContent(sampleHintsJson());
  assert.equal(ok.hints.length, 1);
  assert.equal(ok.hints[0]?.id, "hint-a");

  assert.equal(parseNeonCommitmentHintsContent("{not json").hints.length, 0);
  assert.equal(parseNeonCommitmentHintsContent("[]").hints.length, 0);
  assert.equal(parseNeonCommitmentHintsContent('{"hints":"nope"}').hints.length, 0);

  const partial = parseNeonCommitmentHintsContent(
    JSON.stringify({ hints: [{ id: "good", title: "t" }, { title: "no id" }, 42] })
  );
  assert.equal(partial.hints.length, 1);
  assert.ok(partial.diagnostics.length >= 1);
});

test("importNeonCommitmentHints is blocked default-off (no write)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-hint-import-off-"));
  const hintsPath = join(dir, "hints.json");
  const storePath = join(dir, "commitments.jsonl");
  try {
    await writeFile(hintsPath, sampleHintsJson(), "utf8");
    const result = await importNeonCommitmentHints({
      hintsPath,
      storePath,
      gate: OFF_GATE,
      now: () => NOW_MS
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.imported.length, 0);
    assert.deepEqual(await readNeonCommitments({ storePath }), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("importNeonCommitmentHints imports once and is idempotent on re-run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-hint-import-armed-"));
  const hintsPath = join(dir, "hints.json");
  const storePath = join(dir, "commitments.jsonl");
  try {
    await writeFile(hintsPath, sampleHintsJson(), "utf8");

    const first = await importNeonCommitmentHints({
      hintsPath,
      storePath,
      gate: ARMED_GATE,
      now: () => NOW_MS
    });
    assert.equal(first.state, "imported");
    assert.equal(first.imported.length, 1);

    const second = await importNeonCommitmentHints({
      hintsPath,
      storePath,
      gate: ARMED_GATE,
      now: () => NOW_MS
    });
    assert.equal(second.state, "skipped");
    assert.equal(second.imported.length, 0);
    assert.equal(second.skipped.length, 1);

    const stored = await readNeonCommitments({ storePath });
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.dedupeKey, "v3-hint:hint-a");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("importNeonCommitmentHints skips cleanly when hints file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-hint-import-missing-"));
  const storePath = join(dir, "commitments.jsonl");
  try {
    const result = await importNeonCommitmentHints({
      hintsPath: join(dir, "does-not-exist.json"),
      storePath,
      gate: ARMED_GATE,
      now: () => NOW_MS
    });
    assert.equal(result.state, "skipped");
    assert.equal(result.imported.length, 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
