// Neon Transcript Indexer — the decision document module. Single owner of the
// persisted decision markdown format: it serializes AND parses, so no caller
// ever regex-guesses the shape. This is the direct fix for the v3 failure mode
// where one writer (buildBody) had three independent regex readers and a format
// drift silently stopped importance recalculation. Here, parse failures are
// explicit values a caller must handle — never a silent null.
//
// Invariant: field values are line-normalized on build (newlines collapse to
// single spaces), so parse(build(x)) round-trips exactly for normalized input.
// Known sentinel collision: an alternatives value that is literally "None"
// collapses to null on parse (the token doubles as the no-alternatives marker).

import {
  neonDecisionActors,
  neonDecisionScopes,
  type TNeonDecisionActor,
  type TNeonDecisionScope
} from "./decisionTypes.js";

export interface INeonDecisionDocumentFields {
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly scope: TNeonDecisionScope;
  readonly actor: TNeonDecisionActor;
  readonly operatorConfirmed: boolean;
  readonly sessionKey: string;
  /** Dynamic importance (0-100) scored at extraction time. */
  readonly importanceScore: number;
}

export type TNeonDecisionParseResult =
  | { readonly ok: true; readonly fields: INeonDecisionDocumentFields }
  | { readonly ok: false; readonly error: string };

const NO_ALTERNATIVES_TOKEN = "None";

function normalizeLine(value: string): string {
  return value.replace(/\s*\n+\s*/g, " ").trim();
}

export function buildNeonDecisionBody(fields: INeonDecisionDocumentFields): string {
  const alternatives =
    fields.alternatives !== null && normalizeLine(fields.alternatives).length > 0
      ? normalizeLine(fields.alternatives)
      : NO_ALTERNATIVES_TOKEN;

  return [
    `**DECISION: ${normalizeLine(fields.title)}**`,
    "",
    `**Rationale:** ${normalizeLine(fields.rationale)}`,
    "",
    `**Alternatives verworfen:** ${alternatives}`,
    "",
    `**Meta:** scope=${fields.scope}, actor=${fields.actor}, operator_confirmed=${fields.operatorConfirmed}, importance=${Math.round(fields.importanceScore)}, session=${normalizeLine(fields.sessionKey)}`
  ].join("\n");
}

// Field-boundary anchored (not line-anchored): intermediaries like the JSON
// memory-store writer flatten newlines to spaces, and the document must parse
// identically in multi-line and flattened form. Build-side line normalization
// guarantees field values contain no marker sequences of their own.
const titlePattern = /\*\*DECISION: ([\s\S]+?)\*\*(?=\s*\*\*|\s*$)/;
const rationalePattern = /\*\*Rationale:\*\* ([\s\S]+?)\s*\*\*Alternatives verworfen:\*\*/;
const alternativesPattern = /\*\*Alternatives verworfen:\*\* ([\s\S]+?)\s*\*\*Meta:\*\*/;
const metaPattern = /\*\*Meta:\*\* ([\s\S]+)$/;

function isDecisionScope(value: string): value is TNeonDecisionScope {
  return (neonDecisionScopes as readonly string[]).includes(value);
}

function isDecisionActor(value: string): value is TNeonDecisionActor {
  return (neonDecisionActors as readonly string[]).includes(value);
}

export function parseNeonDecisionBody(content: string): TNeonDecisionParseResult {
  const title = titlePattern.exec(content)?.[1]?.trim();
  if (!title) {
    return { ok: false, error: "missing DECISION title line" };
  }

  const rationale = rationalePattern.exec(content)?.[1]?.trim();
  if (!rationale) {
    return { ok: false, error: "missing Rationale line" };
  }

  const alternativesRaw = alternativesPattern.exec(content)?.[1]?.trim();
  if (!alternativesRaw) {
    return { ok: false, error: "missing Alternatives line" };
  }
  const alternatives = alternativesRaw === NO_ALTERNATIVES_TOKEN ? null : alternativesRaw;

  const metaRaw = metaPattern.exec(content)?.[1]?.trim();
  if (!metaRaw) {
    return { ok: false, error: "missing Meta line" };
  }

  // The session key is the only free-text meta value and is always serialized
  // LAST, so it is captured greedily to end-of-line: commas inside it stay
  // literal and injected "key=value" fragments inside it can never override
  // the structured keys parsed from the prefix (first-wins).
  const sessionMarker = ", session=";
  const sessionIdx = metaRaw.indexOf(sessionMarker);
  if (sessionIdx < 0) {
    return { ok: false, error: "missing meta session" };
  }
  const sessionValue = metaRaw.slice(sessionIdx + sessionMarker.length).trim();
  const structuredPrefix = metaRaw.slice(0, sessionIdx);

  const meta = new Map<string, string>();
  for (const pair of structuredPrefix.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = pair.slice(0, separator).trim();
    if (!meta.has(key)) {
      meta.set(key, pair.slice(separator + 1).trim());
    }
  }

  const scope = meta.get("scope");
  if (scope === undefined || !isDecisionScope(scope)) {
    return { ok: false, error: `invalid or missing meta scope "${scope ?? ""}"` };
  }

  const actor = meta.get("actor");
  if (actor === undefined || !isDecisionActor(actor)) {
    return { ok: false, error: `invalid or missing meta actor "${actor ?? ""}"` };
  }

  const operatorConfirmedRaw = meta.get("operator_confirmed");
  if (operatorConfirmedRaw !== "true" && operatorConfirmedRaw !== "false") {
    return { ok: false, error: `invalid or missing meta operator_confirmed "${operatorConfirmedRaw ?? ""}"` };
  }

  const importanceRaw = meta.get("importance");
  const importanceScore = importanceRaw === undefined ? Number.NaN : Number.parseInt(importanceRaw, 10);
  if (!Number.isInteger(importanceScore) || importanceScore < 0 || importanceScore > 100) {
    return { ok: false, error: `invalid or missing meta importance "${importanceRaw ?? ""}"` };
  }

  if (sessionValue.length === 0) {
    return { ok: false, error: "missing meta session" };
  }

  return {
    ok: true,
    fields: {
      title,
      rationale,
      alternatives,
      scope,
      actor,
      operatorConfirmed: operatorConfirmedRaw === "true",
      sessionKey: sessionValue,
      importanceScore
    }
  };
}
