import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreNeonDecisionImportance, type INeonDecisionScoreInput } from "../src/index.js";

function input(overrides: Partial<INeonDecisionScoreInput> = {}): INeonDecisionScoreInput {
  return {
    scope: "architecture",
    actor: "operator",
    operatorConfirmed: true,
    alternatives: "Redis mit AOF-Persistenz",
    title: "SQLite statt Redis für Session-State",
    rationale: "Eine Datei ohne Server reicht für einen Node, statt Redis-Betrieb ohne Mehrwert.",
    ...overrides
  };
}

describe("Neon decision importance scorer", () => {
  it("scores a confirmed architecture decision with trade-off high", () => {
    // base 50 + scope 15 + confirmed 10 + alternatives 5 + trade-off marker 5 = 85
    assert.equal(scoreNeonDecisionImportance(input()), 85);
  });

  it("scores an unconfirmed uiux decision without alternatives low", () => {
    const score = scoreNeonDecisionImportance(
      input({
        scope: "uiux",
        operatorConfirmed: false,
        alternatives: null,
        rationale: "Die Vignette dämpft nur die Ränder, der globale Glow bleibt damit erhalten."
      })
    );
    // base 50 + 0 + 0 + 0 + 0 = 50
    assert.equal(score, 50);
  });

  it("penalizes subagent decisions", () => {
    const confirmed = scoreNeonDecisionImportance(input());
    const subagent = scoreNeonDecisionImportance(input({ actor: "subagent" }));
    assert.equal(confirmed - subagent, 20);
  });

  it("penalizes bug-prefixed titles and thin rationales", () => {
    const score = scoreNeonDecisionImportance(
      input({
        title: "Fix Cache-Invalidierung",
        rationale: "war kaputt",
        alternatives: null,
        operatorConfirmed: false,
        scope: "tactical"
      })
    );
    // base 50 + tactical 5 - bug prefix 10 - thin rationale 10 = 35
    assert.equal(score, 35);
  });

  it("adds a capped diversity bonus for repeated distinct-query hits", () => {
    assert.equal(
      scoreNeonDecisionImportance(input({ distinctQueryCount: 4 })) -
        scoreNeonDecisionImportance(input()),
      6
    );
    assert.equal(
      scoreNeonDecisionImportance(input({ distinctQueryCount: 50 })) -
        scoreNeonDecisionImportance(input()),
      10
    );
  });

  it("clamps to the 0-100 range", () => {
    const score = scoreNeonDecisionImportance(
      input({ distinctQueryCount: 50, scope: "architecture" })
    );
    assert.ok(score <= 100);
    assert.ok(score >= 0);
  });
});
