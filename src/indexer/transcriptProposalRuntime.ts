import { redactSnapshotText } from "../harness/redaction.js";
import { createNeonFallbackLlmInvoker } from "../llm/llmFallbackInvoker.js";
import type { INeonLlmGate, INeonLlmInvoker, TNeonLlmModel } from "../llm/llmRuntime.js";
import { buildNeonDecisionBody, parseNeonDecisionBody } from "./decisionDocument.js";
import { scoreNeonDecisionImportance } from "./decisionImportance.js";
import { evaluateNeonDecision } from "./decisionQualityGate.js";
import {
  neonDecisionScopes,
  type INeonDecisionCandidate,
  type TNeonDecisionActor,
  type TNeonDecisionScope
} from "./decisionTypes.js";
import { classifyNeonDecisionVoice } from "./operatorVoiceDetector.js";
import { evaluateNeonSummaryQuality } from "./summaryQualityGate.js";
import type { INeonTranscriptMessage } from "./transcriptExtract.js";
import type { INeonTranscriptSessionDigest } from "./transcriptSnapshot.js";

// Neon Transcript Indexer — gated summary + decision passes (S3). Both stack the
// S2 LLM invoker on top of an S1 session digest and emit *proposals only*: no
// memory write happens here (that is S4). With the default dry-run invoker the
// invoker never calls a model, so proposals stay "planned". Only an armed gate +
// an injected runner can yield "proposed" results.
//
// Ported v3 intelligence, wired through the seams:
// - Summary pass: haiku primary with a quality-triggered sonnet fallback
//   (createNeonFallbackLlmInvoker) and the ported summary quality gate.
// - Decision pass: sonnet, strict JSON schema, per-decision quality gate,
//   voice classification via source_role, dynamic importance scoring, and the
//   owned decision document format as the persisted body.
//
// Redaction contract: raw model text is parsed in-memory only (redaction can
// truncate and would break JSON); every field that leaves this module goes
// through redactSnapshotText. Parse failures are classified, visible skip
// reasons — never silent.

const PROPOSAL_PREVIEW_LIMIT = 2_000;
const MIN_PROPOSED_CHARS = 12;
const NO_DECISION_SENTINEL = "NO_DECISION";
const MAX_DECISIONS_PER_SESSION = 3;
const CALL_FAILED_REASON_PREFIX = "llm-call-failed";

export type TNeonTranscriptProposalKind = "summary" | "decision";
export type TNeonTranscriptProposalState = "planned" | "proposed" | "skipped";

export interface INeonTranscriptProposal {
  readonly sessionKey: string;
  readonly kind: TNeonTranscriptProposalKind;
  readonly state: TNeonTranscriptProposalState;
  readonly model: TNeonLlmModel;
  readonly gateEnabled: boolean;
  /** Redacted output for "proposed", a reason placeholder otherwise. Never raw. */
  readonly redactedText: string;
  /** Quality-gate findings — sanitize notes on "proposed", classified reject reasons on "skipped". */
  readonly qualityIssues: readonly string[];
  /** Dynamic importance (0-100), present on proposed decisions. */
  readonly importanceScore?: number;
  readonly safety: { readonly memoryWritten: false };
}

export interface IRunNeonTranscriptProposalOptions {
  readonly session: INeonTranscriptSessionDigest;
  readonly invoker: INeonLlmInvoker;
  readonly gate: INeonLlmGate;
  readonly model?: TNeonLlmModel;
}

const safety = { memoryWritten: false } as const;

interface IProposalShapeInput {
  readonly options: IRunNeonTranscriptProposalOptions;
  readonly kind: TNeonTranscriptProposalKind;
  readonly model: TNeonLlmModel;
  readonly state: TNeonTranscriptProposalState;
  readonly redactedText: string;
  readonly qualityIssues: readonly string[];
  readonly importanceScore?: number;
}

function shapeProposal(input: IProposalShapeInput): INeonTranscriptProposal {
  return {
    sessionKey: input.options.session.sessionKey,
    kind: input.kind,
    state: input.state,
    model: input.model,
    gateEnabled: input.options.gate.enabled,
    redactedText: input.redactedText,
    qualityIssues: input.qualityIssues,
    ...(input.importanceScore !== undefined ? { importanceScore: input.importanceScore } : {}),
    safety
  };
}

export async function runNeonTranscriptSummaryProposal(
  options: IRunNeonTranscriptProposalOptions
): Promise<INeonTranscriptProposal> {
  const model = options.model ?? "haiku";
  const fallbackEvents: string[] = [];
  const invoker = createNeonFallbackLlmInvoker({
    invoker: options.invoker,
    shouldFallback: (text) => !evaluateNeonSummaryQuality(text).passed,
    onFallback: (event) =>
      fallbackEvents.push(`fallback ${event.from}->${event.to}: ${event.reason}`)
  });

  const result = await invoker.invoke({ prompt: buildSummaryPrompt(options.session), model });

  if (!result.called) {
    // A genuine call failure (after the fallback already tried the stronger
    // model) is a failed attempt, not a plan — report it as a classified skip.
    // Gate-closed / no-runner / dry-run reasons stay "planned".
    if (result.reason.startsWith(CALL_FAILED_REASON_PREFIX)) {
      return shapeProposal({
        options,
        kind: "summary",
        model,
        state: "skipped",
        redactedText: `[skipped summary: ${result.reason}]`,
        qualityIssues: [...fallbackEvents, `llm-call-failed: ${result.reason}`]
      });
    }
    return shapeProposal({
      options,
      kind: "summary",
      model,
      state: "planned",
      redactedText: `[planned summary: ${result.reason}]`,
      qualityIssues: fallbackEvents
    });
  }

  const redactedText = redactSnapshotText(result.text, { previewLimit: PROPOSAL_PREVIEW_LIMIT });
  const quality = evaluateNeonSummaryQuality(redactedText);
  const qualityIssues = [...fallbackEvents, ...quality.issues];

  if (!quality.passed) {
    return shapeProposal({
      options,
      kind: "summary",
      model: result.model,
      state: "skipped",
      redactedText: `[skipped summary: ${quality.issues.join("; ")}]`,
      qualityIssues
    });
  }

  if (quality.cleaned.length < MIN_PROPOSED_CHARS) {
    return shapeProposal({
      options,
      kind: "summary",
      model: result.model,
      state: "skipped",
      redactedText: "[skipped summary: low-signal output]",
      qualityIssues
    });
  }

  return shapeProposal({
    options,
    kind: "summary",
    model: result.model,
    state: "proposed",
    redactedText: quality.cleaned,
    qualityIssues
  });
}

interface IRawDecisionEntry {
  readonly title: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly scope: TNeonDecisionScope;
  readonly actor: TNeonDecisionActor;
  readonly sourceMessageIndex: number | null;
}

type TDecisionJsonParseResult =
  | { readonly ok: true; readonly decisions: readonly IRawDecisionEntry[] }
  | { readonly ok: false; readonly error: string };

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseDecisionJson(text: string): TDecisionJsonParseResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, error: "no JSON object in model output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Deliberately drop the V8 error message: it embeds raw source fragments
    // (up to ~26 chars of model output) that would leak unredacted into
    // qualityIssues and the CLI report. The classified code is enough.
    return { ok: false, error: "invalid JSON syntax in model output" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "model output is not a JSON object" };
  }

  const decisionsRaw = (parsed as Record<string, unknown>)["decisions"];
  if (!Array.isArray(decisionsRaw)) {
    return { ok: false, error: 'missing "decisions" array' };
  }

  const decisions: IRawDecisionEntry[] = [];
  for (const entry of decisionsRaw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const scopeRaw = asTrimmedString(record["scope"]);
    const scope: TNeonDecisionScope = (neonDecisionScopes as readonly string[]).includes(scopeRaw)
      ? (scopeRaw as TNeonDecisionScope)
      : "unknown";
    const sourceRole = asTrimmedString(record["source_role"]);
    const actor: TNeonDecisionActor =
      sourceRole === "user" ? "operator" : sourceRole === "assistant" ? "neo" : "unknown";
    const alternativesRaw = asTrimmedString(record["alternatives"]);
    const sourceMessageIndexRaw = record["source_message_index"];
    const sourceMessageIndex =
      typeof sourceMessageIndexRaw === "number" && Number.isInteger(sourceMessageIndexRaw)
        ? sourceMessageIndexRaw
        : null;

    decisions.push({
      title: asTrimmedString(record["title"]),
      rationale: asTrimmedString(record["rationale"]),
      alternatives: alternativesRaw.length > 0 && alternativesRaw !== "null" ? alternativesRaw : null,
      scope,
      actor,
      sourceMessageIndex
    });
  }

  return { ok: true, decisions };
}

export async function runNeonTranscriptDecisionProposals(
  options: IRunNeonTranscriptProposalOptions
): Promise<readonly INeonTranscriptProposal[]> {
  const model = options.model ?? "sonnet";
  const result = await options.invoker.invoke({
    prompt: buildDecisionPrompt(options.session),
    model
  });

  if (!result.called) {
    if (result.reason.startsWith(CALL_FAILED_REASON_PREFIX)) {
      return [
        shapeProposal({
          options,
          kind: "decision",
          model,
          state: "skipped",
          redactedText: `[skipped decision: ${result.reason}]`,
          qualityIssues: [`llm-call-failed: ${result.reason}`]
        })
      ];
    }
    return [
      shapeProposal({
        options,
        kind: "decision",
        model,
        state: "planned",
        redactedText: `[planned decision: ${result.reason}]`,
        qualityIssues: []
      })
    ];
  }

  const parsed = parseDecisionJson(result.text);

  // The NO_DECISION sentinel only counts when the output is NOT parseable
  // JSON — a valid decision whose text merely mentions the sentinel (e.g. a
  // session about this very indexer) must not be discarded.
  if (!parsed.ok && result.text.toUpperCase().includes(NO_DECISION_SENTINEL)) {
    return [
      shapeProposal({
        options,
        kind: "decision",
        model: result.model,
        state: "skipped",
        redactedText: "[skipped decision: low-signal output]",
        qualityIssues: []
      })
    ];
  }

  if (!parsed.ok) {
    return [
      shapeProposal({
        options,
        kind: "decision",
        model: result.model,
        state: "skipped",
        redactedText: `[skipped decision: decision-json-parse-failed]`,
        qualityIssues: [`decision-json-parse-failed: ${parsed.error}`]
      })
    ];
  }

  if (parsed.decisions.length === 0) {
    return [
      shapeProposal({
        options,
        kind: "decision",
        model: result.model,
        state: "skipped",
        redactedText: "[skipped decision: no decisions extracted]",
        qualityIssues: []
      })
    ];
  }

  const capNote =
    parsed.decisions.length > MAX_DECISIONS_PER_SESSION
      ? [
          `capped to ${MAX_DECISIONS_PER_SESSION} decisions (model returned ${parsed.decisions.length})`
        ]
      : [];

  const messages = options.session.messages;
  const proposals: INeonTranscriptProposal[] = [];
  for (const raw of parsed.decisions.slice(0, MAX_DECISIONS_PER_SESSION)) {
    const baseIssues = proposals.length === 0 ? capNote : [];

    // Voice classification: with real message bodies present the ported v3
    // detector is authoritative (confirm/reject tokens in the NEXT user turn);
    // without messages the model-reported source_role stays the fallback.
    let actor: TNeonDecisionActor = raw.actor;
    let operatorConfirmed = raw.actor === "operator";
    if (messages !== undefined && messages.length > 0) {
      const voice = classifyNeonDecisionVoice(raw.sourceMessageIndex ?? -1, messages);
      if (voice.actor === "unknown") {
        proposals.push(
          shapeProposal({
            options,
            kind: "decision",
            model: result.model,
            state: "skipped",
            redactedText: "[skipped decision: reject:invalid_source]",
            qualityIssues: [
              ...baseIssues,
              "reject:invalid_source",
              "source_message_index not resolvable against session messages"
            ]
          })
        );
        continue;
      }
      if (voice.operatorRejected) {
        proposals.push(
          shapeProposal({
            options,
            kind: "decision",
            model: result.model,
            state: "skipped",
            redactedText: "[skipped decision: reject:operator_rejected]",
            qualityIssues: [...baseIssues, "reject:operator_rejected"]
          })
        );
        continue;
      }
      actor = voice.actor;
      operatorConfirmed = voice.operatorConfirmed;
    }

    const candidate: INeonDecisionCandidate = {
      title: raw.title,
      rationale: raw.rationale,
      alternatives: raw.alternatives,
      actor,
      scope: raw.scope,
      operatorConfirmed
    };

    const verdict = evaluateNeonDecision(candidate);

    if (!verdict.passed) {
      proposals.push(
        shapeProposal({
          options,
          kind: "decision",
          model: result.model,
          state: "skipped",
          redactedText: `[skipped decision: reject:${verdict.rejectClass ?? "unknown"}]`,
          qualityIssues: [...baseIssues, `reject:${verdict.rejectClass ?? "unknown"}`, ...verdict.notes]
        })
      );
      continue;
    }

    const importanceScore = scoreNeonDecisionImportance({
      scope: candidate.scope,
      actor: candidate.actor,
      operatorConfirmed: candidate.operatorConfirmed,
      alternatives: verdict.alternatives,
      title: candidate.title,
      rationale: candidate.rationale
    });

    const body = buildNeonDecisionBody({
      title: candidate.title,
      rationale: candidate.rationale,
      alternatives: verdict.alternatives,
      scope: candidate.scope,
      actor: candidate.actor,
      operatorConfirmed: candidate.operatorConfirmed,
      sessionKey: options.session.sessionKey,
      importanceScore
    });

    const redactedBody = redactSnapshotText(body, { previewLimit: PROPOSAL_PREVIEW_LIMIT });

    // Document self-check: redaction can truncate (previewLimit) or rewrite the
    // body; a document that no longer parses must never persist as "proposed".
    // Fail visible, never silent — this is the classified guard the v3 indexer
    // was missing.
    const selfCheck = parseNeonDecisionBody(redactedBody);
    if (!selfCheck.ok) {
      proposals.push(
        shapeProposal({
          options,
          kind: "decision",
          model: result.model,
          state: "skipped",
          redactedText: "[skipped decision: decision-document-integrity-failed]",
          qualityIssues: [
            ...baseIssues,
            `decision-document-integrity-failed: ${selfCheck.error}`
          ]
        })
      );
      continue;
    }

    proposals.push(
      shapeProposal({
        options,
        kind: "decision",
        model: result.model,
        state: "proposed",
        redactedText: redactedBody,
        qualityIssues: [...baseIssues, ...verdict.notes],
        importanceScore
      })
    );
  }

  return proposals;
}

// Prompts are built from the S1 digest. When the digest carries redacted
// per-turn messages (snapshot created with includeMessages), both passes get
// the indexed chat log — the decision pass then also demands the 1-based
// source_message_index the voice detector resolves against.
function formatMessagesForPrompt(messages: readonly INeonTranscriptMessage[]): string {
  return messages
    .map(
      (message) =>
        `[${message.messageIndex}] [${message.role === "user" ? "Operator" : "Neo"}]: ${message.text}`
    )
    .join("\n");
}

function buildSummaryPrompt(session: INeonTranscriptSessionDigest): string {
  return [
    "Du bist Memory-Extraktor für Neo (dem KI-Partner des Operators).",
    "Fasse diese Claude-Code-Session in 3-5 Stichpunkten zusammen.",
    "",
    "Hard Rules:",
    "1. Deutsch mit Umlauten (ä ö ü ß), niemals ae/oe/ue/ss.",
    "2. Keine Boilerplate-Anrede (kein \"Okay, hier ist...\").",
    "3. Keine Markdown-Codefences um die gesamte Antwort.",
    "4. Keine Pseudo-Tags wie <titel> — leere Felder weglassen.",
    "5. Secrets niemals aufnehmen (keine Passwörter, Keys, Tokens).",
    "6. Konkrete Datei-/Pfad-/Wert-Angaben aufnehmen, wenn vorhanden.",
    "Wenn die Session keine substantielle Aktivität hatte, schreibe genau:",
    "_Keine substantiellen Aktivitäten._",
    "",
    `Projekt: ${session.project}`,
    `Modus: ${session.mode}`,
    `Nachrichten: ${session.messageCount} (${session.userCount} User / ${session.assistantCount} Assistant)`,
    ...(session.messages !== undefined && session.messages.length > 0
      ? ["", "CHAT-VERLAUF:", formatMessagesForPrompt(session.messages)]
      : [`Letzter Austausch: ${session.latestPreview}`])
  ].join("\n");
}

function buildDecisionPrompt(session: INeonTranscriptSessionDigest): string {
  return [
    "Du bist Architectural Decision Extractor für Neo (dem KI-Partner des Operators).",
    "Extrahiere aus dieser Claude-Code-Session NUR echte, dauerhafte Entscheidungen.",
    "",
    "Gib NUR JSON aus, keinen Erklärtext davor oder danach:",
    '{"decisions":[{"title":"...","rationale":"...","alternatives":"... oder null","scope":"architecture|tooling|tactical|uiux","source_role":"user|assistant","source_message_index":3}]}',
    "",
    "Regeln:",
    "- title ohne Bug-/Fix-/Refactor-Präfix, maximal 80 Zeichen.",
    "- rationale nennt den konkreten Trade-off (\"statt\", \"weil\", \"vs\") oder messbaren Effekt.",
    "- alternatives: echte verworfene Option oder null — KEINE Verneinung der Decision.",
    "- Bug-Fix-Schritte, Status-Updates, Implementierungsdetails weglassen.",
    `- Maximal ${MAX_DECISIONS_PER_SESSION} decisions. Session ohne echte Entscheidung: {"decisions":[]}.`,
    "- Deutsch mit Umlauten (ä ö ü ß).",
    ...(session.messages !== undefined && session.messages.length > 0
      ? [
          "- source_message_index = die [N]-Nummer der Nachricht, aus der die Entscheidung stammt.",
          "",
          `Projekt: ${session.project}`,
          `Modus: ${session.mode}`,
          "",
          "CHAT-VERLAUF (Format `[N] [Operator|Neo]: text`):",
          formatMessagesForPrompt(session.messages)
        ]
      : [
          "",
          `Projekt: ${session.project}`,
          `Modus: ${session.mode}`,
          `Nachrichten: ${session.messageCount} (${session.userCount} User / ${session.assistantCount} Assistant)`,
          `Letzter Austausch: ${session.latestPreview}`
        ])
  ].join("\n");
}

export function renderNeonTranscriptProposalReport(
  proposals: readonly INeonTranscriptProposal[]
): string {
  const lines = proposals.map((proposal, index) => {
    const importance =
      proposal.importanceScore !== undefined ? `, importance: ${proposal.importanceScore}` : "";
    const quality =
      proposal.qualityIssues.length > 0 ? proposal.qualityIssues.join("; ") : "clean";
    return [
      `${index + 1}. ${proposal.kind} · ${proposal.state} · ${proposal.sessionKey}`,
      `   model: ${proposal.model}, gate-enabled: ${proposal.gateEnabled}, memory-written: ${proposal.safety.memoryWritten}${importance}`,
      `   quality: ${quality}`,
      `   text: ${proposal.redactedText}`
    ].join("\n");
  });

  return [`Neon Transcript Proposals: ${proposals.length}`, ...lines].join("\n");
}
