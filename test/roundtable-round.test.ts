import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createNeonDryRunLlmInvoker,
  readNeonRoundtableRoom,
  renderNeonRoundtableRoundResult,
  resolveNeonRoundtableRoomPath,
  runNeonRoundtableRound,
  writeNeonRoundtableRoom,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type INeonRoundtableHead,
  type INeonRoundtableRoomFile,
  type TNeonLlmResult,
  type TNeonRoundtablePurpose
} from "../src/index.js";

// A fake invoker replaying a fixed script of head replies, one per call. It
// reports `called: true` like a real (armed) invoker, so the whole discourse
// loop is exercised without a spawn. Both heads share one instance, so the
// script advances in the loop's neo -> chaty -> neo -> chaty order.
function scriptedInvoker(script: readonly string[]): INeonLlmInvoker {
  let call = 0;
  return {
    invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      const text = script[call] ?? "CONSENSUS: fallback.";
      call += 1;
      return Promise.resolve({ called: true, model: request.model, text });
    }
  };
}

function monotonicClock(): () => Date {
  const base = Date.parse("2026-07-17T10:00:00.000Z");
  let tick = 0;
  return () => {
    const stamp = new Date(base + tick * 1000);
    tick += 1;
    return stamp;
  };
}

function headsWith(
  invoker: INeonLlmInvoker
): readonly INeonRoundtableHead[] {
  return [
    {
      participant: { id: "neo", runtime: "claude", role: "moderator" },
      invoker,
      model: "sonnet",
      disposition: "depth and architecture"
    },
    {
      participant: { id: "chaty", runtime: "codex", role: "discussant" },
      invoker,
      model: "codex",
      disposition: "speed and pragmatism"
    }
  ];
}

async function withTempRoom(
  fn: (persist: (room: INeonRoundtableRoomFile) => Promise<void>, roomPath: string) => Promise<void>
): Promise<void> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-roundtable-round-test-"));
  const roomPath = resolveNeonRoundtableRoomPath(projectRoot, "test-round");
  try {
    await fn((room) => writeNeonRoundtableRoom(roomPath, room), roomPath);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

test("a scripted two-head exchange reaches consensus and emits a recommendation-first result", async () => {
  const invoker = scriptedInvoker([
    "Depth-first: the store must be closed-shape.",
    "Speed: keep it tiny, one atomic write.",
    "Agree on tiny and closed-shape.",
    "Aligned.\nCONSENSUS: Ship the minimal closed-shape store with redaction on write."
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "test-round",
    topic: "room store scope",
    purpose: "discuss-a-solution",
    heads: headsWith(invoker),
    now: monotonicClock()
  });

  assert.equal(result.outcome, "consensus");
  assert.equal(result.room.status, "resolved");
  // 4 scripted contributions + 1 moderator resolution.
  assert.equal(result.room.turnCount, 5);
  assert.equal(result.room.turns[4]?.kind, "resolution");
  assert.match(result.recommendation, /Ship the minimal closed-shape store/);
  assert.ok(result.reasoning.length >= 2, "reasoning carries the head rationales");
  // Rejected alternatives = the positions before the final consensus turn.
  assert.ok(result.alternatives.length >= 1, "solution round records rejected alternatives");
  assert.equal(result.sources.length, 0, "a solution round cites no sources");

  const render = renderNeonRoundtableRoundResult(result);
  const recIndex = render.indexOf("Recommendation:");
  const reasoningIndex = render.indexOf("Reasoning:");
  assert.ok(recIndex >= 0 && reasoningIndex > recIndex, "recommendation comes before reasoning");
});

test("no consensus within the exchange bound yields a no-consensus outcome that stays open", async () => {
  // Never emits a CONSENSUS marker.
  const invoker = scriptedInvoker([
    "Position A.",
    "Position B.",
    "Still A.",
    "Still B.",
    "A again.",
    "B again."
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "test-round",
    topic: "deadlocked topic",
    purpose: "discuss-a-solution",
    heads: headsWith(invoker),
    now: monotonicClock(),
    maxExchanges: 2
  });

  assert.equal(result.outcome, "no-consensus");
  // maxExchanges 2 * 2 heads = 4 contributions, still open, + 1 resolution note.
  assert.equal(result.room.status, "open");
  assert.equal(result.room.turnCount, 5);
  assert.match(result.recommendation, /No consensus/i);
  assert.match(result.room.turns[4]?.text ?? "", /escalation to the judge/i);
});

test("every turn is persisted redacted and readable, with secrets and paths stripped", async () => {
  await withTempRoom(async (persist, roomPath) => {
    const invoker = scriptedInvoker([
      "Position with a leak probe: API_KEY=supersecret12345 at /Users/operator/secret.txt",
      "Agreed.\nCONSENSUS: Ship it."
    ]);
    const result = await runNeonRoundtableRound({
      roundId: "test-round",
      topic: "leak-safety",
      purpose: "discuss-a-solution",
      heads: headsWith(invoker),
      now: monotonicClock(),
      persist
    });
    assert.equal(result.outcome, "consensus");

    const readBack = await readNeonRoundtableRoom(roomPath);
    assert.ok(readBack, "the round persisted and reads back");
    assert.equal(readBack?.turnCount, 3);

    const serialized = `${JSON.stringify(readBack)}\n${renderNeonRoundtableRoundResult(result)}`;
    assert.doesNotMatch(serialized, /supersecret12345/, "planted secret is stripped");
    assert.doesNotMatch(serialized, /\/Users\//, "filesystem path is stripped");
    assert.match(serialized, /REDACTED/, "the redaction seam left its marker");
  });
});

test("the default dry-run invoker drives a clearly-labelled stand-in round to consensus with no model call", async () => {
  const result = await runNeonRoundtableRound({
    roundId: "test-round",
    topic: "dry-run wiring",
    purpose: "discuss-a-solution",
    heads: headsWith(createNeonDryRunLlmInvoker()),
    now: monotonicClock()
  });

  assert.equal(result.dryRun, true, "no real call happened, so the round is flagged dry-run");
  assert.equal(result.outcome, "consensus", "the stand-in second head closes the round");
  // opener stand-in + closing stand-in + resolution.
  assert.equal(result.room.turnCount, 3);
  assert.match(result.room.turns[0]?.text ?? "", /dry-run stand-in/i);
  assert.match(renderNeonRoundtableRoundResult(result), /dry-run: no model called/i);
});

test("a gather-info round collects cited sources and no rejected alternatives", async () => {
  const purpose: TNeonRoundtablePurpose = "gather-info";
  const invoker = scriptedInvoker([
    "Found prior art.\nSOURCE: whatsappRuntimeStatus closed-shape store",
    "Confirmed.\nSOURCE: llmRuntime dry-run gate\nCONSENSUS: Reuse both patterns."
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "test-round",
    topic: "prior art survey",
    purpose,
    heads: headsWith(invoker),
    now: monotonicClock()
  });

  assert.equal(result.outcome, "consensus");
  assert.equal(result.alternatives.length, 0, "gather-info reports no rejected alternatives");
  assert.deepEqual(
    [...result.sources].sort(),
    ["llmRuntime dry-run gate", "whatsappRuntimeStatus closed-shape store"],
    "both cited sources are collected"
  );
  assert.match(renderNeonRoundtableRoundResult(result), /Sources:/);
});
