import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateNeonDecision, type INeonDecisionCandidate } from "../src/index.js";

function candidate(overrides: Partial<INeonDecisionCandidate> = {}): INeonDecisionCandidate {
  return {
    title: "SQLite statt Redis für Session-State",
    rationale: "Eine Datei ohne Server reicht für einen Node — Redis wäre Betriebsaufwand ohne Nutzen.",
    alternatives: "Redis mit AOF-Persistenz",
    actor: "operator",
    scope: "architecture",
    operatorConfirmed: true,
    ...overrides
  };
}

describe("Neon decision quality gate", () => {
  it("passes a real architecture decision", () => {
    const verdict = evaluateNeonDecision(candidate());
    assert.equal(verdict.passed, true);
    assert.equal(verdict.rejectClass, null);
    assert.equal(verdict.alternatives, "Redis mit AOF-Persistenz");
  });

  it("rejects bug-fix steps by title prefix", () => {
    const verdict = evaluateNeonDecision(candidate({ title: "Bug 7 Flag entfernt" }));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "bug_fix_step");
  });

  it("rejects trivial rationales", () => {
    const verdict = evaluateNeonDecision(candidate({ rationale: "weil besser" }));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "tautological_rationale");
  });

  it("rejects leaked template placeholders", () => {
    const verdict = evaluateNeonDecision(candidate({ title: "Entscheidung zu <titel>" }));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "placeholder");
  });

  it("rejects status updates", () => {
    const verdict = evaluateNeonDecision(candidate({ title: "Indexer-Port abgeschlossen" }));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "status_update");
  });

  it("rejects diary/reflection content", () => {
    const verdict = evaluateNeonDecision(
      candidate({ rationale: "Heute gelernt dass Gates früh besser sind als Review-Nacharbeit später." })
    );
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "diary_reflection");
  });

  it("rejects unknown scope as not promotable", () => {
    const verdict = evaluateNeonDecision(candidate({ scope: "unknown" }));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "invalid_source");
  });

  it("rejects unconfirmed subagent decisions", () => {
    const verdict = evaluateNeonDecision(candidate({ actor: "subagent", operatorConfirmed: false }));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "subagent_report");
  });

  it("drops pseudo-alternatives that merely negate the decision", () => {
    const verdict = evaluateNeonDecision(
      candidate({
        title: "Cache-Layer eingebaut für Snapshot-Reads",
        rationale: "Snapshot-Reads treffen dieselben Daten mehrfach pro Minute, weil das Dashboard pollt.",
        alternatives: "Cache-Layer nicht implementiert"
      })
    );
    assert.equal(verdict.passed, true);
    assert.equal(verdict.alternatives, null);
    assert.ok(verdict.notes.some((note) => note.includes("mere negation")));
  });

  it("does not mutate the input candidate", () => {
    const input = candidate({
      title: "Cache-Layer eingebaut für Snapshot-Reads",
      rationale: "Snapshot-Reads treffen dieselben Daten mehrfach pro Minute, weil das Dashboard pollt.",
      alternatives: "Cache-Layer nicht implementiert"
    });
    evaluateNeonDecision(input);
    assert.equal(input.alternatives, "Cache-Layer nicht implementiert");
  });
});
