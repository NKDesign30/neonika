import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  readNeonRoundtableRoom,
  resolveNeonRoundtableRoomPath,
  runNeonRoundtableRound,
  writeNeonRoundtableRoom,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type INeonRoundtableHead,
  type INeonRoundtableJudge,
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

function fixedInvoker(text: string): INeonLlmInvoker {
  return {
    invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      return Promise.resolve({ called: true, model: request.model, text });
    }
  };
}

function monotonicClock(): () => Date {
  const base = Date.parse("2026-07-17T12:00:00.000Z");
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

function specialist(invoker: INeonLlmInvoker): INeonRoundtableHead {
  return {
    participant: { id: "scout", runtime: "claude", role: "specialist" },
    invoker,
    model: "haiku",
    disposition: "fast factual lookup"
  };
}

// A judge that throws if ever asked — proof an answerable stall never wakes it.
function forbiddenJudge(): INeonRoundtableJudge {
  return {
    participant: { id: "owner", runtime: "human-gate", role: "judge" },
    ask: () => Promise.reject(new Error("judge must not be woken"))
  };
}

test("an answerable stall pulls the third head autonomously and never wakes the human", async () => {
  const result = await runNeonRoundtableRound({
    roundId: "third-round",
    topic: "atomic write",
    purpose: "discuss-a-solution",
    heads: headsWith(
      scriptedInvoker([
        "Depth-first position.",
        "I need a fact.\nESCALATE: What is the atomic-write pattern used by the store?",
        "Given that, agreed.\nCONSENSUS: Reuse temp+rename."
      ])
    ),
    thirdHead: specialist(fixedInvoker("It writes a temp file then renames atomically.")),
    judge: forbiddenJudge(),
    now: monotonicClock()
  });

  assert.equal(result.outcome, "consensus");
  assert.equal(result.room.status, "resolved");
  // The pull is observable: a question to the specialist, then its contribution.
  const question = result.room.turns.find((turn) => turn.kind === "question");
  assert.match(question?.text ?? "", /answerable -> scout/);
  const specialistTurn = result.room.turns.find(
    (turn) => turn.speaker === "scout" && turn.kind === "contribution"
  );
  assert.ok(specialistTurn, "the specialist's contribution is stored");
  assert.match(specialistTurn?.text ?? "", /temp file then renames/);
  // No human escalation fired: the third-head path posts a `question`, never an
  // `escalation` turn, and never a `judge-answer`.
  assert.ok(!result.room.turns.some((turn) => turn.kind === "judge-answer"));
  assert.ok(!result.room.turns.some((turn) => turn.kind === "escalation"));
  // The room grew to hold the specialist (n participants).
  assert.ok(result.room.participants.some((participant) => participant.id === "scout"));
});

test("the third head's turn is persisted redacted like any other participant", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-roundtable-third-test-"));
  const roomPath = resolveNeonRoundtableRoomPath(projectRoot, "third-round");
  try {
    const result = await runNeonRoundtableRound({
      roundId: "third-round",
      topic: "leak-safety",
      purpose: "discuss-a-solution",
      heads: headsWith(
        scriptedInvoker([
          "Position.",
          "ESCALATE: What is the store's write path?",
          "Thanks.\nCONSENSUS: Ship it."
        ])
      ),
      thirdHead: specialist(
        fixedInvoker("The path is API_KEY=supersecret12345 under /Users/operator/secret.txt")
      ),
      now: monotonicClock(),
      persist: (room) => writeNeonRoundtableRoom(roomPath, room)
    });
    assert.equal(result.outcome, "consensus");

    const readBack = await readNeonRoundtableRoom(roomPath);
    assert.ok(readBack);
    const serialized = JSON.stringify(readBack);
    assert.doesNotMatch(serialized, /supersecret12345/, "the specialist's secret is stripped");
    assert.doesNotMatch(serialized, /\/Users\//, "the specialist's path is stripped");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("a will/tradeoff stall still goes to the judge even when a third head is configured", async () => {
  let judgeAsked = false;
  const judge: INeonRoundtableJudge = {
    participant: { id: "owner", runtime: "human-gate", role: "judge" },
    ask: () => {
      judgeAsked = true;
      return Promise.resolve("Go with option A.");
    }
  };
  const result = await runNeonRoundtableRound({
    roundId: "third-round",
    topic: "a real decision",
    purpose: "discuss-a-solution",
    heads: headsWith(
      scriptedInvoker([
        "Position.",
        "ESCALATE: Should we ship now or wait for the cap?",
        "Given the call, agreed.\nCONSENSUS: Ship now."
      ])
    ),
    thirdHead: specialist(fixedInvoker("(should not be called)")),
    judge,
    now: monotonicClock()
  });

  assert.ok(judgeAsked, "a will/tradeoff decision reaches the human");
  assert.ok(result.room.turns.some((turn) => turn.kind === "judge-answer"));
  assert.ok(
    !result.room.turns.some((turn) => turn.speaker === "scout"),
    "the specialist is not pulled for a will/tradeoff stall"
  );
  assert.equal(result.outcome, "consensus");
});

test("an answerable stall with no third head configured falls back to the judge (#19 behaviour)", async () => {
  let judgeAsked = false;
  const judge: INeonRoundtableJudge = {
    participant: { id: "owner", runtime: "human-gate", role: "judge" },
    ask: () => {
      judgeAsked = true;
      return Promise.resolve("It uses temp+rename.");
    }
  };
  const result = await runNeonRoundtableRound({
    roundId: "third-round",
    topic: "no specialist",
    purpose: "discuss-a-solution",
    heads: headsWith(
      scriptedInvoker([
        "Position.",
        "ESCALATE: What is the atomic-write pattern?",
        "Thanks.\nCONSENSUS: Reuse it."
      ])
    ),
    judge,
    now: monotonicClock()
  });

  assert.ok(judgeAsked, "with no specialist, the human is the answerable backstop");
  assert.ok(result.room.turns.some((turn) => turn.kind === "judge-answer"));
  assert.equal(result.outcome, "consensus");
});

test("a dry-run third head yields a clearly-labelled stand-in contribution", async () => {
  const dryRunInvoker: INeonLlmInvoker = {
    invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      return Promise.resolve({ called: false, model: request.model, reason: "llm-dry-run-no-call" });
    }
  };
  const result = await runNeonRoundtableRound({
    roundId: "third-round",
    topic: "dry-run specialist",
    purpose: "discuss-a-solution",
    heads: headsWith(
      scriptedInvoker([
        "Position.",
        "ESCALATE: What is the pattern?",
        "Thanks.\nCONSENSUS: Reuse it."
      ])
    ),
    thirdHead: specialist(dryRunInvoker),
    now: monotonicClock()
  });

  assert.equal(result.dryRun, true, "a dry-run specialist call flags the round dry-run");
  const specialistTurn = result.room.turns.find(
    (turn) => turn.speaker === "scout" && turn.kind === "contribution"
  );
  assert.match(specialistTurn?.text ?? "", /dry-run stand-in/i);
  assert.equal(result.outcome, "consensus");
});
