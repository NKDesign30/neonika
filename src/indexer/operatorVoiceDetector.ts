// Neonika Transcript Indexer — Operator-voice detector. Pure heuristic (no LLM) that
// classifies who made a decision and whether the operator confirmed or rejected it:
//   - decision sourced from a user message      -> actor "operator", confirmed
//   - decision sourced from an assistant message -> actor "neo"; the NEXT user
//     message decides: confirm token -> confirmed, reject token -> rejected,
//     anything else -> no signal.
// Ported from v3; deterministic and fail-safe (unknown on missing source).

import type { TNeonDecisionActor } from "./decisionTypes.js";

/** Minimal message shape the detector needs — decoupled from extract internals. */
export interface INeonVoiceMessage {
  /** 1-based message index as referenced by the model's source_message_index. */
  readonly messageIndex: number;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface INeonVoiceClassification {
  readonly actor: TNeonDecisionActor;
  readonly operatorConfirmed: boolean;
  /** When true the decision was explicitly rejected by the operator — never persist it. */
  readonly operatorRejected: boolean;
}

const confirmTokens: readonly string[] = [
  "ja",
  "jo",
  "geil",
  "mega",
  "perfekt",
  "genau",
  "passt",
  "mach",
  "mach das",
  "los",
  "machen",
  "gut",
  "top",
  "super",
  "boah"
];

const rejectTokens: readonly string[] = [
  "nee",
  "nein",
  "nicht so",
  "anders",
  "meh",
  "mach nicht",
  "nicht machen",
  "lieber nicht",
  "nicht das",
  "stop",
  "abbruch",
  "abbrechen",
  "falsch",
  "verworfen",
  "abgelehnt",
  "doch nicht"
];

const tokenPrefixPattern = /^[\s,.!?;:-]+/;

function normalize(text: string): string {
  return text.toLowerCase().replace(tokenPrefixPattern, "").trim();
}

function startsWithToken(text: string, tokens: readonly string[]): boolean {
  const normalized = normalize(text);
  if (normalized.length === 0) {
    return false;
  }
  for (const token of tokens) {
    if (normalized === token) {
      return true;
    }
    if (
      normalized.startsWith(`${token} `) ||
      normalized.startsWith(`${token},`) ||
      normalized.startsWith(`${token}.`) ||
      normalized.startsWith(`${token}!`)
    ) {
      return true;
    }
  }
  return false;
}

export function classifyNeonDecisionVoice(
  sourceMessageIndex: number,
  messages: readonly INeonVoiceMessage[]
): INeonVoiceClassification {
  const sourceIdx = messages.findIndex((message) => message.messageIndex === sourceMessageIndex);
  const source = sourceIdx >= 0 ? messages[sourceIdx] : undefined;
  if (!source) {
    return { actor: "unknown", operatorConfirmed: false, operatorRejected: false };
  }

  const actor: TNeonDecisionActor = source.role === "user" ? "operator" : "neo";

  if (actor === "operator") {
    return { actor, operatorConfirmed: true, operatorRejected: false };
  }

  for (let index = sourceIdx + 1; index < messages.length; index += 1) {
    const next = messages[index];
    if (!next || next.role !== "user") {
      continue;
    }

    if (startsWithToken(next.text, rejectTokens)) {
      return { actor, operatorConfirmed: false, operatorRejected: true };
    }
    if (startsWithToken(next.text, confirmTokens)) {
      return { actor, operatorConfirmed: true, operatorRejected: false };
    }
    // First user message after the decision with neither signal: stop looking.
    break;
  }

  return { actor, operatorConfirmed: false, operatorRejected: false };
}
