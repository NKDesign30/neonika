import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildNeonRoundtableConvenedHeads,
  createNeonDryRunLlmInvoker,
  readNeonRoundtableRoom,
  renderNeonRoundtableRoundResult,
  resolveNeonRoundtableRoomPath,
  runNeonRoundtableRound,
  writeNeonRoundtableRoom,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type TNeonLlmResult
} from "../src/index.js";

// Scripted invoker replaying fixed head replies, one per call, reporting
// `called: true` like an armed invoker so the whole loop runs without a spawn.
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

test("the convened-heads builder mirrors the two sides: the convening side opens and moderates", () => {
  const invoker = createNeonDryRunLlmInvoker();
  const codex = buildNeonRoundtableConvenedHeads("codex", invoker);
  const claude = buildNeonRoundtableConvenedHeads("claude", invoker);

  // Codex side: Chaty opens (heads[0]) and therefore moderates + bridges.
  assert.equal(codex[0].participant.id, "chaty");
  assert.equal(codex[0].participant.runtime, "codex");
  assert.equal(codex[0].participant.role, "moderator");
  assert.equal(codex[1].participant.id, "neo");
  assert.equal(codex[1].participant.role, "discussant");

  // Claude side: the exact mirror — Neo opens and moderates.
  assert.equal(claude[0].participant.id, "neo");
  assert.equal(claude[0].participant.role, "moderator");
  assert.equal(claude[1].participant.id, "chaty");
  assert.equal(claude[1].participant.role, "discussant");

  // Same members, reversed order — the mirror axis.
  assert.equal(codex[0].participant.id, claude[1].participant.id);
  assert.equal(codex[1].participant.id, claude[0].participant.id);

  // Each head keeps its disposition regardless of which side convenes.
  assert.equal(codex[0].disposition, "speed and pragmatism");
  assert.equal(codex[1].disposition, "depth and architecture");
  assert.equal(claude[0].disposition, "depth and architecture");
});

test("a round convened from the Codex side reaches consensus with Chaty moderating and bridging", async () => {
  const invoker = scriptedInvoker([
    "Speed-first from the Codex side: ship the mirror entry, same engine, flipped opener.",
    "Depth check: the moderator role follows the opener, no special-casing.",
    "Agree — one shared heads builder, the convening side is heads[0].",
    "Aligned.\nCONSENSUS: Chaty convenes and moderates the round from the Codex side."
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "codex-round",
    topic: "bidirectional convene",
    purpose: "discuss-a-solution",
    heads: buildNeonRoundtableConvenedHeads("codex", invoker),
    now: monotonicClock()
  });

  assert.equal(result.outcome, "consensus");
  assert.equal(result.room.status, "resolved");
  // 4 scripted contributions + 1 moderator resolution.
  assert.equal(result.room.turnCount, 5);

  // The Codex side (chaty) opens the round and closes it as moderator.
  assert.equal(result.room.participants[0]?.id, "chaty");
  assert.equal(result.room.participants[0]?.role, "moderator");
  assert.equal(result.room.turns[0]?.speaker, "chaty");
  const resolution = result.room.turns[result.room.turns.length - 1];
  assert.equal(resolution?.kind, "resolution");
  assert.equal(resolution?.speaker, "chaty");

  assert.match(result.recommendation, /Chaty convenes and moderates/);
  const render = renderNeonRoundtableRoundResult(result);
  const recIndex = render.indexOf("Recommendation:");
  const reasoningIndex = render.indexOf("Reasoning:");
  assert.ok(recIndex >= 0 && reasoningIndex > recIndex, "recommendation comes before reasoning");
});

test("a Codex-side round persists every turn redacted, stripping planted secrets and paths", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-roundtable-codex-test-"));
  const roomPath = resolveNeonRoundtableRoomPath(projectRoot, "codex-round");
  try {
    const invoker = scriptedInvoker([
      "Opening with a leak probe: API_KEY=supersecret12345 at /Users/operator/secret.txt",
      "Aligned.\nCONSENSUS: Ship the Codex-side mirror."
    ]);
    const result = await runNeonRoundtableRound({
      roundId: "codex-round",
      topic: "leak-safety on the codex side",
      purpose: "discuss-a-solution",
      heads: buildNeonRoundtableConvenedHeads("codex", invoker),
      now: monotonicClock(),
      persist: (room) => writeNeonRoundtableRoom(roomPath, room)
    });
    assert.equal(result.outcome, "consensus");

    const readBack = await readNeonRoundtableRoom(roomPath);
    assert.ok(readBack, "the codex-side round persisted and reads back");

    const serialized = `${JSON.stringify(readBack)}\n${renderNeonRoundtableRoundResult(result)}`;
    assert.doesNotMatch(serialized, /supersecret12345/, "planted secret is stripped");
    assert.doesNotMatch(serialized, /\/Users\//, "filesystem path is stripped");
    assert.match(serialized, /REDACTED/, "the redaction seam left its marker");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});
