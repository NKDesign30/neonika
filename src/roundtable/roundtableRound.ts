/**
 * Neonika Roundtable discourse round (spec issue #15, ticket #18; decision-gate #19).
 *
 * The first complete path: two heads (Neo on the `claude` head, Chaty on the
 * `codex` head) exchange turns through the LLM-invoker seam (#17), each turn is
 * redacted into the room store (#16), a consensus signal ends the round, and
 * the moderator emits a recommendation-first result. It is the tracer bullet
 * that wires #16 and #17 into one runnable flow.
 *
 * Decision gate (#19): a head that hits a point it cannot settle ends its turn
 * with an `ESCALATE: <situation>` line. A pure classifier splits the situation
 * into answerable (fact/specialist — reserved for the on-demand third head #20)
 * vs. will/tradeoff/risk (no objectively correct answer — the human judge). The
 * round then blocks, presents the situation to the injected `judge`
 * (`human-gate` participant), and folds the typed answer back in as a
 * `judge-answer` turn before resuming. The human is the final backstop:
 * ambiguous situations, and — until the third head exists — answerable ones,
 * route to the judge too. With no judge injected an escalation ends the round
 * `awaiting-judge` (outcome `escalated`), never silently.
 *
 * Dry-run by construction. The whole loop drives off the injected
 * `INeonLlmInvoker` (#17): with the default dry-run invoker every `invoke`
 * returns `called: false`, so the round produces deterministic, clearly-labeled
 * stand-in turns and never calls a model. Tests inject a fake invoker with
 * scripted head replies to exercise the real exchange behaviour without a
 * spawn. A real model call only happens once the #17 gate is armed AND a real
 * runner is injected into the head's invoker — this module never arms anything.
 *
 * Leak-safety: every turn is persisted through the #16 redaction seam, and the
 * assembled result (recommendation, reasoning, alternatives, sources) is built
 * from the already-redacted stored turns plus a defensive re-redaction of the
 * consensus recommendation and any parsed sources — no raw invoker text reaches
 * the result or the terminal render.
 *
 * Control lives in the session (Weiche 1): the caller owns the loop and injects
 * `persist`, so persistence, the clock and the heads are all seams. When the
 * Live-Run-Lifecycle later moves the loop into a daemon, the roles and this
 * signature do not change.
 */

import {
  appendNeonRoundtableTurn,
  createNeonRoundtableRoom,
  redactNeonRoundtableTurnText,
  type INeonRoundtableParticipant,
  type INeonRoundtableRoomFile,
  type TNeonRoundtablePurpose
} from "./roundtableRoomStore.js";
import type { INeonLlmInvoker, TNeonLlmModel } from "../llm/llmRuntime.js";

/**
 * A head at the table: its store participant identity, the invoker it speaks
 * through (#17 seam), the model tag passed on each request, and a one-line
 * disposition that shapes its prompt. The friction between distinct
 * dispositions (Neo = depth/architecture, Chaty = speed/pragmatism, spec US15)
 * is what makes a round worth more than one head talking to itself.
 */
export interface INeonRoundtableHead {
  readonly participant: INeonRoundtableParticipant;
  readonly invoker: INeonLlmInvoker;
  readonly model: TNeonLlmModel;
  readonly disposition: string;
}

/**
 * The side a round is convened from (spec #23). `claude` = Neo opens from a
 * Claude window; `codex` = Chaty opens from a Codex window. The convening head
 * is `heads[0]`, so the engine's "moderator = heads[0]" rule makes it the
 * moderator + bridge with no special-casing.
 */
export type TNeonRoundtableConveningSide = "claude" | "codex";

/**
 * Builds the canonical two-head pairing for a convened round, ordered so the
 * convening side opens and therefore moderates. Both entry points — the
 * Claude-side `roundtable-round` and the Codex-side `roundtable-round-codex` —
 * share this one builder, so the two directions are exact mirrors: same heads,
 * same dispositions (Neo = depth/architecture, Chaty = speed/pragmatism), only
 * the opener (and thus the moderator/bridge role) flips. Both heads share the
 * injected invoker (the dry-run default, or a scripted fake in tests);
 * per-head armed transports are a later concern, not this seam's.
 */
export function buildNeonRoundtableConvenedHeads(
  convenedBy: TNeonRoundtableConveningSide,
  invoker: INeonLlmInvoker
): readonly [INeonRoundtableHead, INeonRoundtableHead] {
  const neo: INeonRoundtableHead = {
    participant: {
      id: "neo",
      runtime: "claude",
      role: convenedBy === "claude" ? "moderator" : "discussant"
    },
    invoker,
    model: "sonnet",
    disposition: "depth and architecture"
  };
  const chaty: INeonRoundtableHead = {
    participant: {
      id: "chaty",
      runtime: "codex",
      role: convenedBy === "codex" ? "moderator" : "discussant"
    },
    invoker,
    model: "codex",
    disposition: "speed and pragmatism"
  };
  return convenedBy === "claude" ? [neo, chaty] : [chaty, neo];
}

export type TNeonRoundtableRoundOutcome = "consensus" | "no-consensus" | "escalated";

export interface INeonRoundtableRoundResult {
  readonly room: INeonRoundtableRoomFile;
  readonly outcome: TNeonRoundtableRoundOutcome;
  /** True when any head turn fell back to a dry-run stand-in (no real call). */
  readonly dryRun: boolean;
  /** Redacted, recommendation-first — the agreed direction, or a no-consensus note. */
  readonly recommendation: string;
  /** Attributed, redacted rationale lines, in turn order. */
  readonly reasoning: readonly string[];
  /** Rejected alternatives (discuss-a-solution rounds); empty for gather-info. */
  readonly alternatives: readonly string[];
  /** Cited sources (gather-info rounds); empty for discuss-a-solution. */
  readonly sources: readonly string[];
}

/**
 * The human-gate seam (#19): the owner as a `human-gate` participant plus the
 * blocking `ask` that presents an escalated situation and returns the typed
 * decision. Injected, so the escalation path is exercised by a scripted judge
 * with no real terminal I/O. Omitted -> an escalation ends the round
 * `awaiting-judge` instead of resuming.
 */
export interface INeonRoundtableJudge {
  readonly participant: INeonRoundtableParticipant;
  readonly ask: (situation: string) => Promise<string>;
}

/**
 * What the round hands the wake-nudge seam (#21) when an escalation is routed to
 * the human judge. Deliberately minimal — a safe stall-class label plus the
 * round slug, never the escalated situation — so the signal is leak-safe by
 * construction and Discord stays a wake channel, not an answer channel.
 */
export interface INeonRoundtableEscalationEvent {
  readonly stallClass: TNeonRoundtableStallClass;
  readonly roundId: string;
}

export interface IRunNeonRoundtableRoundOptions {
  readonly roundId: string;
  readonly topic: string;
  readonly purpose: TNeonRoundtablePurpose;
  /** The discussants that take turns (v1: the two AI heads). */
  readonly heads: readonly INeonRoundtableHead[];
  /** Monotonic clock; each call stamps one turn (repo rule: no wall-clock in logic). */
  readonly now: () => Date;
  /** Max full head-rotations before the round ends without consensus. */
  readonly maxExchanges?: number;
  /** Persist the room after every turn, so a crash leaves a readable partial round. */
  readonly persist?: (room: INeonRoundtableRoomFile) => Promise<void>;
  /** Human-gate for `ESCALATE:` situations (#19). Omitted -> escalation blocks the round. */
  readonly judge?: INeonRoundtableJudge;
  /**
   * On-demand specialist (#20). An `answerable` (fact/specialist) escalation
   * pulls this head autonomously — a single invoker call with the full running
   * context — instead of waking the human. Its contribution lands in the store
   * and the discussion resumes. Omitted -> an answerable stall falls to the
   * judge backstop (the #19 behaviour). Give its participant the `specialist`
   * role; the room grows to hold it (n participants, not a fixed two).
   */
  readonly thirdHead?: INeonRoundtableHead;
  /**
   * Wake-nudge seam (#21). Called once at the moment an escalation is routed to
   * the human judge (status -> awaiting-judge), i.e. the human is genuinely
   * needed — whether or not a `judge` is injected. The answerable -> third-head
   * path (#20) resolves autonomously and does NOT fire this. Injected + async;
   * must not throw (the wake signal is best-effort — the round awaits it like
   * `persist`/`judge` and does not guard it). Omitted -> no nudge (pure default).
   */
  readonly onEscalationToJudge?: (event: INeonRoundtableEscalationEvent) => Promise<void>;
}

/**
 * A head declares agreement by ending its contribution with a
 * `CONSENSUS: <one-line direction>` line; the moderator takes that line as the
 * recommendation and closes the round. A gather-info head cites a finding with
 * a `SOURCE: <source>` line.
 */
export const NEON_ROUNDTABLE_CONSENSUS_MARKER = "CONSENSUS:";
export const NEON_ROUNDTABLE_SOURCE_MARKER = "SOURCE:";
/** A head raises a point it cannot settle with `ESCALATE: <situation>` (#19). */
export const NEON_ROUNDTABLE_ESCALATE_MARKER = "ESCALATE:";

const DEFAULT_MAX_EXCHANGES = 4;

/**
 * How the decision gate routes a stalled situation (#19):
 * - `answerable` — a fact/specialist question with an objectively correct
 *   answer; reserved for the on-demand third head (#20).
 * - `will-tradeoff` — a will/tradeoff/risk call with no objectively correct
 *   answer; belongs to the human judge.
 * - `ambiguous` — neither is clear; falls back to the human judge (the backstop).
 */
export type TNeonRoundtableStallClass = "answerable" | "will-tradeoff" | "ambiguous";

// Will/tradeoff/risk signals — a decision the human owns. Deciding words plus
// preference and risk language.
const WILL_TRADEOFF_SIGNALS: readonly string[] = [
  "should we",
  "should i",
  "should it",
  "do we want",
  "worth",
  "trade-off",
  "tradeoff",
  "prefer",
  "rather",
  "risk",
  "risky",
  "decide",
  "decision",
  "opinion",
  "priorit",
  "acceptable",
  "ok to",
  "okay to",
  "go with",
  "choose between",
  "which way",
  "vs.",
  " versus "
];

// Answerable/fact signals — a lookup with an objectively correct answer.
const ANSWERABLE_SIGNALS: readonly string[] = [
  "what is",
  "what's",
  "what are",
  "how does",
  "how do",
  "which api",
  "does it support",
  "is there",
  "look up",
  "spec says",
  "the spec",
  "definition",
  "syntax",
  "version",
  "documented",
  "reference",
  "where is",
  "how many"
];

function countSignals(haystack: string, signals: readonly string[]): number {
  return signals.reduce((count, signal) => (haystack.includes(signal) ? count + 1 : count), 0);
}

/**
 * Pure decision-gate classifier (#19). Deterministic keyword heuristic over the
 * situation text — no model call, so it is fully unit-testable. Fails safe: a
 * will/tradeoff signal outranks a fact signal (a decision that merely mentions
 * facts is still a decision), and no clear signal is `ambiguous` (the human
 * backstop), never a silent auto-answer. It is intentionally coarse; the true
 * arbiter of a hard case is always the human, and an answerable miss simply
 * pulls the third head (#20) instead of the judge.
 */
export function classifyNeonRoundtableStall(situation: string): TNeonRoundtableStallClass {
  const text = situation.toLowerCase();
  const will = countSignals(text, WILL_TRADEOFF_SIGNALS);
  const fact = countSignals(text, ANSWERABLE_SIGNALS);
  if (will > 0 && will >= fact) {
    return "will-tradeoff";
  }
  if (fact > will) {
    return "answerable";
  }
  return "ambiguous";
}

interface IParsedContribution {
  /** The contribution with marker lines removed — the plain rationale. */
  readonly body: string;
  /** The recommendation after a `CONSENSUS:` marker, if the head signalled one. */
  readonly consensus?: string;
  /** The situation after an `ESCALATE:` marker, if the head raised one (#19). */
  readonly escalation?: string;
  readonly sources: readonly string[];
}

function parseContributionMarkers(text: string): IParsedContribution {
  const bodyLines: string[] = [];
  const sources: string[] = [];
  let consensus: string | undefined;
  let escalation: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(NEON_ROUNDTABLE_CONSENSUS_MARKER)) {
      const value = trimmed.slice(NEON_ROUNDTABLE_CONSENSUS_MARKER.length).trim();
      // The first consensus marker wins; a later one cannot override the close.
      if (value.length > 0 && consensus === undefined) {
        consensus = value;
      }
      continue;
    }
    if (trimmed.startsWith(NEON_ROUNDTABLE_ESCALATE_MARKER)) {
      const value = trimmed.slice(NEON_ROUNDTABLE_ESCALATE_MARKER.length).trim();
      if (value.length > 0 && escalation === undefined) {
        escalation = value;
      }
      continue;
    }
    if (trimmed.startsWith(NEON_ROUNDTABLE_SOURCE_MARKER)) {
      const value = trimmed.slice(NEON_ROUNDTABLE_SOURCE_MARKER.length).trim();
      if (value.length > 0) {
        sources.push(value);
      }
      continue;
    }
    bodyLines.push(line);
  }
  return {
    body: bodyLines.join("\n").trim(),
    ...(consensus !== undefined ? { consensus } : {}),
    ...(escalation !== undefined ? { escalation } : {}),
    sources
  };
}

function buildHeadPrompt(options: {
  readonly topic: string;
  readonly purpose: TNeonRoundtablePurpose;
  readonly head: INeonRoundtableHead;
  readonly room: INeonRoundtableRoomFile;
}): string {
  const { topic, purpose, head, room } = options;
  const transcript =
    room.turns.length > 0
      ? room.turns.map((turn) => `${turn.speaker} [${turn.kind}]: ${turn.text}`).join("\n")
      : "(no turns yet — you open)";
  const goal =
    purpose === "discuss-a-solution"
      ? "Converge on a single recommended direction, not a finished plan."
      : "Gather and weigh the facts; cite each finding with a `SOURCE: ...` line.";
  return [
    `You are ${head.participant.id} at a Neonika Roundtable. Disposition: ${head.disposition}.`,
    `Round purpose: ${purpose}. Topic: ${topic}`,
    goal,
    "Argue your position in a few sentences, engaging the other head's points.",
    `When a clear direction is agreed, end with a single \`${NEON_ROUNDTABLE_CONSENSUS_MARKER} <one line>\` line.`,
    `If you hit a point you cannot settle, end with \`${NEON_ROUNDTABLE_ESCALATE_MARKER} <the open question>\` instead.`,
    "--- discussion so far ---",
    transcript
  ].join("\n");
}

/**
 * Prompt for an on-demand third head (#20). The specialist is pulled to answer
 * one answerable question with the full running context; it does not re-open
 * the debate, so it gets a focused ask plus the transcript, not the discussant
 * prompt.
 */
function buildThirdHeadPrompt(options: {
  readonly topic: string;
  readonly situation: string;
  readonly head: INeonRoundtableHead;
  readonly room: INeonRoundtableRoomFile;
}): string {
  const { topic, situation, head, room } = options;
  const transcript = room.turns.map((turn) => `${turn.speaker} [${turn.kind}]: ${turn.text}`).join("\n");
  return [
    `You are ${head.participant.id}, a specialist pulled into a Neonika Roundtable. Disposition: ${head.disposition}.`,
    `Topic: ${topic}`,
    `The heads reached an answerable point they could not settle: ${situation}`,
    "Answer that specific question concisely from the full context below; do not re-open the wider debate.",
    "--- discussion so far ---",
    transcript
  ].join("\n");
}

/**
 * Deterministic stand-in for a head whose invoker did not make a real call
 * (the default dry-run path). The opener states a dry-run position; every later
 * head closes with a consensus marker, so a dry-run round demonstrates the full
 * open -> exchange -> consensus -> result flow end-to-end while being clearly
 * labelled as a stand-in that called no model.
 */
function dryRunStandIn(options: {
  readonly head: INeonRoundtableHead;
  readonly topic: string;
  readonly isOpener: boolean;
}): string {
  const { head, topic, isOpener } = options;
  if (isOpener) {
    return `[dry-run stand-in — no model called] ${head.participant.id} opens on "${topic}" from a ${head.disposition} angle.`;
  }
  return [
    `[dry-run stand-in — no model called] ${head.participant.id} agrees the direction is clear.`,
    `${NEON_ROUNDTABLE_CONSENSUS_MARKER} Proceed on "${topic}" (dry-run stand-in agreement).`
  ].join("\n");
}

function assembleResult(options: {
  readonly room: INeonRoundtableRoomFile;
  readonly purpose: TNeonRoundtablePurpose;
  readonly outcome: TNeonRoundtableRoundOutcome;
  readonly recommendation: string;
  readonly dryRun: boolean;
}): INeonRoundtableRoundResult {
  const { room, purpose, outcome, recommendation, dryRun } = options;
  const contributions = room.turns.filter((turn) => turn.kind === "contribution");

  const reasoning: string[] = [];
  const alternatives: string[] = [];
  const sources: string[] = [];
  contributions.forEach((turn, index) => {
    const parsed = parseContributionMarkers(turn.text);
    if (parsed.body.length > 0) {
      reasoning.push(`${turn.speaker}: ${parsed.body}`);
    }
    for (const source of parsed.sources) {
      // Defensive re-redaction: parsed from stored (already-redacted) text, but
      // re-run the seam so a marker payload can never reach the result raw.
      sources.push(redactNeonRoundtableTurnText(source));
    }
    // Rejected alternatives = every position except the final consensus-bearing
    // one, for a solution round only.
    if (purpose === "discuss-a-solution" && index < contributions.length - 1 && parsed.body.length > 0) {
      alternatives.push(`${turn.speaker}: ${parsed.body}`);
    }
  });

  return {
    room,
    outcome,
    dryRun,
    recommendation: redactNeonRoundtableTurnText(recommendation),
    reasoning,
    alternatives: purpose === "discuss-a-solution" ? alternatives : [],
    sources: purpose === "gather-info" ? sources : []
  };
}

/**
 * Runs one Roundtable round to consensus (or to the exchange bound) and returns
 * the persisted room plus the recommendation-first result. Pure over its
 * injected seams: the heads' invokers, the clock and `persist` are all supplied
 * by the caller, so the whole discourse behaviour is exercised by a fake
 * invoker with no real spawn.
 */
export async function runNeonRoundtableRound(
  options: IRunNeonRoundtableRoundOptions
): Promise<INeonRoundtableRoundResult> {
  const maxExchanges = options.maxExchanges ?? DEFAULT_MAX_EXCHANGES;
  const moderator = options.heads[0];
  const moderatorId = moderator?.participant.id ?? "moderator";
  let room = createNeonRoundtableRoom({
    roundId: options.roundId,
    purpose: options.purpose,
    createdAt: options.now().toISOString(),
    participants: [
      ...options.heads.map((head) => head.participant),
      // The judge is a first-class participant so its answers are attributable.
      ...(options.judge ? [options.judge.participant] : []),
      // The on-demand specialist is a participant too (n participants, #20); it
      // only speaks when an answerable stall pulls it, but the room holds it.
      ...(options.thirdHead ? [options.thirdHead.participant] : [])
    ]
  });
  await options.persist?.(room);

  let dryRun = false;
  let recommendation: string | undefined;
  // Set when an escalation could not be resolved (no judge injected): the round
  // ends blocked on the human rather than silently continuing.
  let blockedOnJudge = false;
  let turnsTaken = 0;

  exchanges: for (let exchange = 0; exchange < maxExchanges; exchange += 1) {
    for (const head of options.heads) {
      const prompt = buildHeadPrompt({ topic: options.topic, purpose: options.purpose, head, room });
      const result = await head.invoker.invoke({ prompt, model: head.model });
      let text: string;
      if (result.called) {
        text = result.text;
      } else {
        dryRun = true;
        text = dryRunStandIn({ head, topic: options.topic, isOpener: turnsTaken === 0 });
      }
      turnsTaken += 1;
      room = appendNeonRoundtableTurn(room, {
        speaker: head.participant.id,
        kind: "contribution",
        text,
        at: options.now().toISOString()
      });
      await options.persist?.(room);

      const parsed = parseContributionMarkers(room.turns[room.turns.length - 1]?.text ?? text);

      // Decision gate (#19): an escalation outranks a consensus in the same turn
      // — a head asking for a decision has not agreed to one.
      if (parsed.escalation !== undefined) {
        const stallClass = classifyNeonRoundtableStall(parsed.escalation);

        // On-demand third head (#20): an answerable (fact/specialist) stall is
        // filled autonomously by the specialist — one invoker call with the
        // full running context — and the discussion resumes WITHOUT waking the
        // human. Only when no specialist is configured does an answerable stall
        // fall through to the judge backstop (the #19 behaviour).
        if (stallClass === "answerable" && options.thirdHead) {
          const third = options.thirdHead;
          // Observable pull: the moderator poses the question to the specialist.
          room = appendNeonRoundtableTurn(room, {
            speaker: moderatorId,
            kind: "question",
            text: `[answerable -> ${third.participant.id}] ${parsed.escalation}`,
            at: options.now().toISOString()
          });
          await options.persist?.(room);

          const thirdPrompt = buildThirdHeadPrompt({
            topic: options.topic,
            situation: parsed.escalation,
            head: third,
            room
          });
          const thirdResult = await third.invoker.invoke({ prompt: thirdPrompt, model: third.model });
          let thirdText: string;
          if (thirdResult.called) {
            thirdText = thirdResult.text;
          } else {
            dryRun = true;
            thirdText = `[dry-run stand-in — no model called] ${third.participant.id} answers the specialist question.`;
          }
          // The specialist's answer lands like any other turn — redacted, in the
          // log — and the round stays open (no human wake).
          room = appendNeonRoundtableTurn(room, {
            speaker: third.participant.id,
            kind: "contribution",
            text: thirdText,
            at: options.now().toISOString()
          });
          await options.persist?.(room);
          continue;
        }

        // Present the situation to the judge (status -> awaiting-judge). A
        // will/tradeoff or ambiguous stall — or an answerable one with no
        // specialist configured — is the human's call.
        room = appendNeonRoundtableTurn(room, {
          speaker: moderatorId,
          kind: "escalation",
          text: `[${stallClass}] ${parsed.escalation}`,
          at: options.now().toISOString(),
          status: "awaiting-judge"
        });
        await options.persist?.(room);

        // Wake-nudge (#21): the human is needed now — fire the gated Discord
        // signal before we block on (or end awaiting) the judge. Leak-safe by
        // construction: only the stall class and the round id cross the seam.
        await options.onEscalationToJudge?.({ stallClass, roundId: options.roundId });

        if (!options.judge) {
          // Nobody to answer: the round stays blocked on the human, never silent.
          blockedOnJudge = true;
          break exchanges;
        }

        const answer = await options.judge.ask(parsed.escalation);
        // Fold the decision back in and resume (status -> open).
        room = appendNeonRoundtableTurn(room, {
          speaker: options.judge.participant.id,
          kind: "judge-answer",
          text: answer,
          at: options.now().toISOString(),
          status: "open"
        });
        await options.persist?.(room);
        continue;
      }

      if (parsed.consensus !== undefined) {
        recommendation = parsed.consensus;
        break exchanges;
      }
    }
  }

  const outcome: TNeonRoundtableRoundOutcome =
    recommendation !== undefined ? "consensus" : blockedOnJudge ? "escalated" : "no-consensus";
  const resolutionText =
    recommendation !== undefined
      ? `${NEON_ROUNDTABLE_CONSENSUS_MARKER} ${recommendation}`
      : blockedOnJudge
        ? "Blocked on a will/tradeoff decision; the judge must answer before the round can resume (#19)."
        : `No consensus after ${turnsTaken} turns; escalation to the judge is the next step (#19).`;
  room = appendNeonRoundtableTurn(room, {
    speaker: moderatorId,
    kind: "resolution",
    text: resolutionText,
    at: options.now().toISOString(),
    ...(recommendation !== undefined
      ? { status: "resolved" as const }
      : blockedOnJudge
        ? { status: "awaiting-judge" as const }
        : {})
  });
  await options.persist?.(room);

  const recommendationText =
    recommendation ??
    (blockedOnJudge
      ? "Escalated to the judge; a will/tradeoff decision is pending."
      : `No consensus reached within ${maxExchanges} exchanges.`);
  return assembleResult({
    room,
    purpose: options.purpose,
    outcome,
    recommendation: recommendationText,
    dryRun
  });
}

/** Recommendation-first terminal render (spec Weiche 4): recommendation -> reasoning -> alternatives / sources. */
export function renderNeonRoundtableRoundResult(result: INeonRoundtableRoundResult): string {
  const lines = [
    `Neonika Roundtable — ${result.outcome}${result.dryRun ? " (dry-run: no model called)" : ""}`,
    `Round: ${result.room.roundId} · ${result.room.purpose} · ${result.room.status}`,
    `Recommendation: ${result.recommendation}`
  ];
  lines.push("Reasoning:");
  if (result.reasoning.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const entry of result.reasoning) {
      lines.push(`  - ${entry}`);
    }
  }
  if (result.room.purpose === "discuss-a-solution") {
    lines.push("Rejected alternatives:");
    if (result.alternatives.length === 0) {
      lines.push("  (none)");
    } else {
      for (const entry of result.alternatives) {
        lines.push(`  - ${entry}`);
      }
    }
  } else {
    lines.push("Sources:");
    if (result.sources.length === 0) {
      lines.push("  (none cited)");
    } else {
      for (const entry of result.sources) {
        lines.push(`  - ${entry}`);
      }
    }
  }
  return lines.join("\n");
}
