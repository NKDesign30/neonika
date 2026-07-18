import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createNeonDryRunLlmInvoker,
  resolveNeonLlmGate,
  runNeonTranscriptDecisionProposals,
  runNeonTranscriptSummaryProposal,
  parseNeonDecisionBody,
  type INeonLlmInvoker,
  type INeonTranscriptSessionDigest
} from "../src/index.js";

const SESSION: INeonTranscriptSessionDigest = {
  sessionKey: "demo:sess-1",
  project: "demo",
  sessionId: "sess-1",
  mode: "live",
  isSubagent: false,
  messageCount: 8,
  userCount: 4,
  assistantCount: 4,
  toolFailureCount: 0,
  latestPreview: "Built the transcript indexer floor.",
  sizeBytes: 4096,
  updatedAt: "2026-06-01T12:00:00.000Z"
};

const ARMED_GATE = resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" });

function fakeInvoker(text: string): INeonLlmInvoker {
  return {
    invoke(request) {
      return Promise.resolve({ called: true, model: request.model, text });
    }
  };
}

function decisionJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decisions: [
      {
        title: "Transcript-Indexer redaction-first bauen",
        rationale:
          "Die Quelle enthält rohe Secrets, weil Transcripts ungefiltert sind — Redaction vor Persist statt danach.",
        alternatives: null,
        scope: "architecture",
        source_role: "user",
        ...overrides
      }
    ]
  });
}

describe("Neonika Transcript proposal runtime (S3)", () => {
  it("plans (no call, no write) with the default dry-run invoker", async () => {
    const proposal = await runNeonTranscriptSummaryProposal({
      session: SESSION,
      invoker: createNeonDryRunLlmInvoker(),
      gate: resolveNeonLlmGate({})
    });
    assert.equal(proposal.state, "planned");
    assert.equal(proposal.safety.memoryWritten, false);
    assert.equal(proposal.gateEnabled, false);
  });

  it("produces a redacted summary proposal when the invoker returns text", async () => {
    const proposal = await runNeonTranscriptSummaryProposal({
      session: SESSION,
      invoker: fakeInvoker(
        "Deployed with ghp_aBcD1234567890aBcD1234567890aBcD12 to /Users/me/app, all green."
      ),
      gate: ARMED_GATE
    });
    assert.equal(proposal.state, "proposed");
    assert.equal(proposal.safety.memoryWritten, false);
    assert.doesNotMatch(proposal.redactedText, /ghp_aBcD/);
    assert.doesNotMatch(proposal.redactedText, /Users\/me\/app/);
  });

  it("strips boilerplate greetings from a summary via the quality gate", async () => {
    const proposal = await runNeonTranscriptSummaryProposal({
      session: SESSION,
      invoker: fakeInvoker(
        "Okay, hier ist eine Zusammenfassung der Session:\n- Transcript-Gate portiert\n- Tests erweitert"
      ),
      gate: ARMED_GATE
    });
    assert.equal(proposal.state, "proposed");
    assert.ok(proposal.redactedText.startsWith("- Transcript-Gate portiert"));
    assert.ok(proposal.qualityIssues.includes("stripped boilerplate prefix"));
  });

  it("skips a placeholder summary and records the sonnet fallback attempt", async () => {
    const proposal = await runNeonTranscriptSummaryProposal({
      session: SESSION,
      invoker: fakeInvoker("- Ergebnis: <titel> wurde umgesetzt und <begründung> ergänzt"),
      gate: ARMED_GATE
    });
    assert.equal(proposal.state, "skipped");
    assert.ok(proposal.qualityIssues.some((issue) => issue.includes("template placeholder")));
    assert.ok(
      proposal.qualityIssues.some((issue) => issue.includes("fallback haiku->sonnet: quality-reject"))
    );
  });

  it("plans a decision pass with the default dry-run invoker", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: createNeonDryRunLlmInvoker(),
      gate: resolveNeonLlmGate({})
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "planned");
    assert.equal(proposals[0]?.model, "sonnet");
  });

  it("skips the decision pass when the model answers NO_DECISION", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker("NO_DECISION"),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "skipped");
  });

  it("produces a scored decision document for a valid JSON decision", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker(decisionJson()),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    const proposal = proposals[0];
    assert.ok(proposal);
    assert.equal(proposal.state, "proposed");
    // base 50 + architecture 15 + operator-confirmed 10 + trade-off marker 5 = 80
    assert.equal(proposal.importanceScore, 80);
    assert.match(proposal.redactedText, /\*\*DECISION: Transcript-Indexer redaction-first bauen\*\*/);

    const parsed = parseNeonDecisionBody(proposal.redactedText);
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.actor, "operator");
    assert.equal(parsed.fields.importanceScore, 80);
    assert.equal(parsed.fields.sessionKey, "demo:sess-1");
  });

  it("rejects a bug-fix step with a classified reject reason", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker(decisionJson({ title: "Bug 7 Flag entfernt" })),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "skipped");
    assert.ok(proposals[0]?.qualityIssues.includes("reject:bug_fix_step"));
  });

  it("classifies broken JSON as a visible parse failure — never silent", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker('{"decisions": [ { "title": "kaputt" '),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "skipped");
    assert.ok(
      proposals[0]?.qualityIssues.some((issue) => issue.startsWith("decision-json-parse-failed"))
    );
  });

  it("never leaks raw model-output fragments through JSON parse errors", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker('{"decisions": [ ghp_aBcD1234567890aBcD1234567890aBcD12 }'),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    const issues = proposals[0]?.qualityIssues.join(" ") ?? "";
    assert.doesNotMatch(issues, /ghp_aBcD/);
    assert.doesNotMatch(proposals[0]?.redactedText ?? "", /ghp_aBcD/);
  });

  it("keeps a valid decision whose text mentions NO_DECISION", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker(
        decisionJson({
          rationale:
            "Der NO_DECISION-Sentinel greift nur noch bei Parse-Fail, weil valide JSON-Antworten sonst verworfen würden."
        })
      ),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "proposed");
  });

  it("skips a decision whose document breaks under redaction truncation — classified, never silent", async () => {
    const longTail = " Der Trade-off bleibt derselbe, weil die Datenlage identisch ist.".repeat(40);
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker(
        decisionJson({
          rationale: `Wir nehmen die kleine Variante statt der großen, weil sie reicht.${longTail}`
        })
      ),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "skipped");
    assert.ok(
      proposals[0]?.qualityIssues.some((issue) =>
        issue.startsWith("decision-document-integrity-failed")
      )
    );
  });

  it("reports a genuine call failure as a classified skip, not as planned", async () => {
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: {
        invoke(request) {
          return Promise.resolve({
            called: false,
            model: request.model,
            reason: "llm-call-failed-exit-1"
          });
        }
      },
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.state, "skipped");
    assert.ok(proposals[0]?.qualityIssues.some((issue) => issue.startsWith("llm-call-failed")));
  });

  it("confirms a neo decision through the voice detector when messages are present", async () => {
    const session: INeonTranscriptSessionDigest = {
      ...SESSION,
      messages: [
        { messageIndex: 1, role: "assistant", text: "Vorschlag: Gate vor Persist einbauen." },
        { messageIndex: 2, role: "user", text: "ja mach das genau so." }
      ]
    };
    const proposals = await runNeonTranscriptDecisionProposals({
      session,
      invoker: fakeInvoker(decisionJson({ source_role: "assistant", source_message_index: 1 })),
      gate: ARMED_GATE
    });
    assert.equal(proposals[0]?.state, "proposed");
    const parsed = parseNeonDecisionBody(proposals[0]?.redactedText ?? "");
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.actor, "neo");
    assert.equal(parsed.fields.operatorConfirmed, true);
  });

  it("drops a decision Operator explicitly rejected in the next message", async () => {
    const session: INeonTranscriptSessionDigest = {
      ...SESSION,
      messages: [
        { messageIndex: 1, role: "assistant", text: "Vorschlag: Store global cachen." },
        { messageIndex: 2, role: "user", text: "nee, lieber nicht." }
      ]
    };
    const proposals = await runNeonTranscriptDecisionProposals({
      session,
      invoker: fakeInvoker(decisionJson({ source_role: "assistant", source_message_index: 1 })),
      gate: ARMED_GATE
    });
    assert.equal(proposals[0]?.state, "skipped");
    assert.ok(proposals[0]?.qualityIssues.includes("reject:operator_rejected"));
  });

  it("rejects an unresolvable source_message_index when messages are present", async () => {
    const session: INeonTranscriptSessionDigest = {
      ...SESSION,
      messages: [{ messageIndex: 1, role: "user", text: "Wir nehmen SQLite statt Redis." }]
    };
    const proposals = await runNeonTranscriptDecisionProposals({
      session,
      invoker: fakeInvoker(decisionJson({ source_message_index: 99 })),
      gate: ARMED_GATE
    });
    assert.equal(proposals[0]?.state, "skipped");
    assert.ok(proposals[0]?.qualityIssues.includes("reject:invalid_source"));
  });

  it("caps at three decisions per session with a visible note", async () => {
    const entry = {
      title: "SQLite statt Redis für Session-State",
      rationale:
        "Eine Datei ohne Server reicht für einen Node, statt Redis-Betrieb ohne Mehrwert.",
      alternatives: "Redis mit AOF-Persistenz",
      scope: "architecture",
      source_role: "user"
    };
    const proposals = await runNeonTranscriptDecisionProposals({
      session: SESSION,
      invoker: fakeInvoker(JSON.stringify({ decisions: [entry, entry, entry, entry, entry] })),
      gate: ARMED_GATE
    });
    assert.equal(proposals.length, 3);
    assert.ok(proposals[0]?.qualityIssues.some((issue) => issue.includes("capped to 3 decisions")));
  });
});
