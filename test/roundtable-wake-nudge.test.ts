import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildNeonRoundtableWakeNudgeMessage,
  createNeonDryRunOutboundSender,
  dispatchNeonRoundtableWakeNudge,
  runNeonRoundtableRound,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type INeonOutboundSendResult,
  type INeonOutboundSender,
  type INeonRoundtableEscalationEvent,
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

const dryRunTarget = { channel: "discord" as const, accountId: "local", channelId: "roundtable-private" };

test("the wake-nudge body carries only the wake signal, stall class and round id", () => {
  const message = buildNeonRoundtableWakeNudgeMessage({ stallClass: "will-tradeoff", roundId: "round-abc" });
  assert.match(message, /Roundtable needs you/);
  assert.match(message, /will-tradeoff/);
  assert.match(message, /round-abc/);
});

test("the wake-nudge body is defensively redacted even if the round id carries a payload", () => {
  const message = buildNeonRoundtableWakeNudgeMessage({
    stallClass: "ambiguous",
    // A round id is a caller-minted slug in practice; prove the seam scrubs a
    // secret regardless, so no marker payload can ever reach the wire.
    roundId: "round-API_KEY=supersecret12345"
  });
  assert.doesNotMatch(message, /supersecret12345/);
});

test("a present owner skips the nudge — no send is attempted", async () => {
  const forbiddenSender: INeonOutboundSender = {
    sendText(): Promise<INeonOutboundSendResult> {
      return Promise.reject(new Error("owner present: no send must be attempted"));
    }
  };
  const result = await dispatchNeonRoundtableWakeNudge({
    sender: forbiddenSender,
    target: dryRunTarget,
    stallClass: "will-tradeoff",
    roundId: "round-present",
    ownerAway: false
  });

  assert.equal(result.state, "skipped-owner-present");
  assert.equal(result.outboundSent, false);
  assert.equal(result.bodyPreview, "");
});

test("an away owner gets a suppressed dry-run nudge — never a real send", async () => {
  const result = await dispatchNeonRoundtableWakeNudge({
    sender: createNeonDryRunOutboundSender({ now: () => new Date("2026-07-17T12:00:00.000Z") }),
    target: dryRunTarget,
    stallClass: "will-tradeoff",
    roundId: "round-away",
    ownerAway: true
  });

  assert.equal(result.state, "suppressed");
  assert.equal(result.outboundSent, false);
  assert.match(result.bodyPreview, /Roundtable needs you/);
  assert.match(result.bodyPreview, /will-tradeoff/);
});

test("an escalation to the human judge fires the wake-nudge exactly once", async () => {
  const events: INeonRoundtableEscalationEvent[] = [];
  const result = await runNeonRoundtableRound({
    roundId: "wake-round",
    topic: "risky migration timing",
    purpose: "discuss-a-solution",
    heads: headsWith(
      scriptedInvoker([
        "Depth-first position on the migration.",
        "We are stuck.\nESCALATE: Should we ship the risky migration now, or is it worth waiting?"
      ])
    ),
    now: monotonicClock(),
    onEscalationToJudge: (event) => {
      events.push(event);
      return Promise.resolve();
    }
  });

  assert.equal(result.outcome, "escalated");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.stallClass, "will-tradeoff");
  assert.equal(events[0]?.roundId, "wake-round");
});

test("an answerable stall resolved by the third head never fires the wake-nudge", async () => {
  const events: INeonRoundtableEscalationEvent[] = [];
  const result = await runNeonRoundtableRound({
    roundId: "answerable-round",
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
    now: monotonicClock(),
    onEscalationToJudge: (event) => {
      events.push(event);
      return Promise.resolve();
    }
  });

  // The specialist resolves the fact autonomously (#20); the human is never
  // needed, so the wake-nudge must stay silent.
  assert.equal(result.outcome, "consensus");
  assert.equal(events.length, 0);
});

test("the wake-nudge body never carries the escalated situation, secret or path", async () => {
  const PLANTED_SECRET = "supersecret12345";
  let bodyPreview = "";
  const result = await runNeonRoundtableRound({
    roundId: "leak-round",
    topic: "risky migration timing",
    purpose: "discuss-a-solution",
    heads: headsWith(
      scriptedInvoker([
        "Depth-first position.",
        `Stuck.\nESCALATE: Should we ship the risky migration now? (leak probe: API_KEY=${PLANTED_SECRET} at /Users/operator/secret.txt)`
      ])
    ),
    now: monotonicClock(),
    onEscalationToJudge: async (event) => {
      const nudge = await dispatchNeonRoundtableWakeNudge({
        sender: createNeonDryRunOutboundSender({ now: () => new Date("2026-07-17T12:00:00.000Z") }),
        target: dryRunTarget,
        stallClass: event.stallClass,
        roundId: event.roundId,
        ownerAway: true
      });
      bodyPreview = nudge.bodyPreview;
    }
  });

  assert.equal(result.outcome, "escalated");
  assert.match(bodyPreview, /Roundtable needs you/);
  assert.doesNotMatch(bodyPreview, /supersecret12345/);
  assert.doesNotMatch(bodyPreview, /\/Users\//);
  assert.doesNotMatch(bodyPreview, /migration/i);
});
