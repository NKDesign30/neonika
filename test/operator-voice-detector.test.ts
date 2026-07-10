import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNeonDecisionVoice, type INeonVoiceMessage } from "../src/index.js";

function messages(entries: ReadonlyArray<readonly ["user" | "assistant", string]>): INeonVoiceMessage[] {
  return entries.map(([role, text], index) => ({ messageIndex: index + 1, role, text }));
}

describe("Neon Operator-voice detector", () => {
  it("classifies a user-sourced decision as operator + confirmed", () => {
    const result = classifyNeonDecisionVoice(
      1,
      messages([["user", "Wir nehmen SQLite statt Redis."]])
    );
    assert.deepEqual(result, { actor: "operator", operatorConfirmed: true, operatorRejected: false });
  });

  it("confirms a neo proposal when the next user message agrees", () => {
    const result = classifyNeonDecisionVoice(
      1,
      messages([
        ["assistant", "Ich schlage vor: Gate vor Persist, nicht danach."],
        ["user", "geil, mach das"]
      ])
    );
    assert.deepEqual(result, { actor: "neo", operatorConfirmed: true, operatorRejected: false });
  });

  it("rejects a neo proposal when the next user message declines", () => {
    const result = classifyNeonDecisionVoice(
      1,
      messages([
        ["assistant", "Wir könnten den Store global cachen."],
        ["user", "nee, lieber nicht"]
      ])
    );
    assert.deepEqual(result, { actor: "neo", operatorConfirmed: false, operatorRejected: true });
  });

  it("treats a neutral follow-up as no signal", () => {
    const result = classifyNeonDecisionVoice(
      1,
      messages([
        ["assistant", "Vorschlag: Debounce auf zwei Sekunden."],
        ["user", "was kostet das an Latenz?"]
      ])
    );
    assert.deepEqual(result, { actor: "neo", operatorConfirmed: false, operatorRejected: false });
  });

  it("returns unknown for a source index that does not exist", () => {
    const result = classifyNeonDecisionVoice(9, messages([["user", "hi"]]));
    assert.deepEqual(result, { actor: "unknown", operatorConfirmed: false, operatorRejected: false });
  });

  it("does not treat 'ja' inside a longer word as confirmation", () => {
    const result = classifyNeonDecisionVoice(
      1,
      messages([
        ["assistant", "Vorschlag: Snapshot cachen."],
        ["user", "jagen wir erstmal den Bug weiter"]
      ])
    );
    assert.deepEqual(result, { actor: "neo", operatorConfirmed: false, operatorRejected: false });
  });
});
