import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  classifyNeonRoundtableStall,
  readNeonRoundtableRoom,
  resolveNeonRoundtableRoomPath,
  runNeonRoundtableRound,
  writeNeonRoundtableRoom,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type INeonRoundtableHead,
  type INeonRoundtableJudge,
  type INeonRoundtableRoomFile,
  type TNeonLlmResult
} from "../src/index.js";

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
  const base = Date.parse("2026-07-17T11:00:00.000Z");
  let tick = 0;
  return () => {
    const stamp = new Date(base + tick * 1000);
    tick += 1;
    return stamp;
  };
}

function headsWith(invoker: INeonLlmInvoker): readonly INeonRoundtableHead[] {
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

function scriptedJudge(answer: string): INeonRoundtableJudge {
  return {
    participant: { id: "owner", runtime: "human-gate", role: "judge" },
    ask: () => Promise.resolve(answer)
  };
}

test("the pure classifier routes answerable, will-tradeoff and ambiguous branches", () => {
  assert.equal(classifyNeonRoundtableStall("What is the closed-shape store pattern?"), "answerable");
  assert.equal(classifyNeonRoundtableStall("How does the redaction seam work?"), "answerable");
  assert.equal(
    classifyNeonRoundtableStall("Should we cap turn text at 20k or make it configurable?"),
    "will-tradeoff"
  );
  assert.equal(classifyNeonRoundtableStall("Is it worth the added risk?"), "will-tradeoff");
  // Nothing to key on -> the human backstop, never a silent auto-answer.
  assert.equal(classifyNeonRoundtableStall("The frobnicator situation."), "ambiguous");
  // Mixed fact + decision -> the decision wins (fail-safe toward the human).
  assert.equal(
    classifyNeonRoundtableStall("Which API does it use, and should we prefer it?"),
    "will-tradeoff"
  );
});

test("a will/tradeoff escalation blocks, presents to the judge, folds the answer in, and resumes to consensus", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-roundtable-gate-test-"));
  const roomPath = resolveNeonRoundtableRoomPath(projectRoot, "gate-round");
  try {
    const invoker = scriptedInvoker([
      "Depth-first: closed-shape store.",
      "Speed matters, but one point is a real decision.\nESCALATE: Should we cap turn text at 20k or make it configurable?",
      "Given the cap decision, agreed.",
      "Aligned.\nCONSENSUS: Ship the closed-shape store with a fixed 20k cap."
    ]);
    const persisted: INeonRoundtableRoomFile[] = [];
    const result = await runNeonRoundtableRound({
      roundId: "gate-round",
      topic: "turn-text cap",
      purpose: "discuss-a-solution",
      heads: headsWith(invoker),
      judge: scriptedJudge("Cap it at 20k for now."),
      now: monotonicClock(),
      persist: async (room) => {
        persisted.push(room);
        await writeNeonRoundtableRoom(roomPath, room);
      }
    });

    assert.equal(result.outcome, "consensus");
    assert.equal(result.room.status, "resolved");

    const escalation = result.room.turns.find((turn) => turn.kind === "escalation");
    assert.ok(escalation, "the escalation is recorded");
    assert.match(escalation?.text ?? "", /^\[will-tradeoff\]/, "it carries the classification");

    const judgeTurn = result.room.turns.find((turn) => turn.kind === "judge-answer");
    assert.ok(judgeTurn, "the judge's decision is folded back in");
    assert.equal(judgeTurn?.speaker, "owner");
    assert.match(judgeTurn?.text ?? "", /Cap it at 20k/);

    // The round genuinely passed through awaiting-judge before resuming.
    assert.ok(
      persisted.some((room) => room.status === "awaiting-judge"),
      "a persisted snapshot shows the blocking state"
    );

    const readBack = await readNeonRoundtableRoom(roomPath);
    assert.equal(readBack?.status, "resolved", "the resumed, resolved round persists and reads back");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("an escalation with no judge injected ends the round awaiting-judge, never silently", async () => {
  const invoker = scriptedInvoker([
    "Depth-first position.",
    "ESCALATE: Should we ship now or wait?"
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "gate-round",
    topic: "ship timing",
    purpose: "discuss-a-solution",
    heads: headsWith(invoker),
    now: monotonicClock()
  });

  assert.equal(result.outcome, "escalated");
  assert.equal(result.room.status, "awaiting-judge");
  assert.ok(
    result.room.turns.some((turn) => turn.kind === "escalation"),
    "the escalation is recorded"
  );
  assert.ok(
    !result.room.turns.some((turn) => turn.kind === "judge-answer"),
    "no judge answer was fabricated"
  );
});

test("an answerable escalation routes to the human backstop until the third head exists (#20)", async () => {
  const invoker = scriptedInvoker([
    "Depth-first position.",
    "ESCALATE: What is the whatsappRuntimeStatus store pattern?",
    "Thanks — that settles it.\nCONSENSUS: Reuse that pattern."
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "gate-round",
    topic: "prior art",
    purpose: "discuss-a-solution",
    heads: headsWith(invoker),
    judge: scriptedJudge("It's the closed-shape store with atomic temp+rename writes."),
    now: monotonicClock()
  });

  const escalation = result.room.turns.find((turn) => turn.kind === "escalation");
  assert.match(escalation?.text ?? "", /^\[answerable\]/, "classified answerable");
  assert.ok(
    result.room.turns.some((turn) => turn.kind === "judge-answer"),
    "with no third head, the human answers as backstop"
  );
  assert.equal(result.outcome, "consensus");
});

test("a round with no escalation and no judge is unchanged from the #18 path", async () => {
  const invoker = scriptedInvoker([
    "Depth-first position.",
    "Aligned.\nCONSENSUS: Ship it."
  ]);
  const result = await runNeonRoundtableRound({
    roundId: "gate-round",
    topic: "no escalation",
    purpose: "discuss-a-solution",
    heads: headsWith(invoker),
    now: monotonicClock()
  });

  assert.equal(result.outcome, "consensus");
  assert.equal(result.room.status, "resolved");
  assert.ok(!result.room.turns.some((turn) => turn.kind === "escalation"));
});
