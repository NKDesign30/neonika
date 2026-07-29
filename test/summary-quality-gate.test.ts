import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateNeonSummaryQuality } from "../src/index.js";

describe("Neon summary quality gate", () => {
  it("rejects empty output", () => {
    const result = evaluateNeonSummaryQuality("   ");
    assert.equal(result.passed, false);
    assert.deepEqual(result.issues, ["empty output"]);
  });

  it("strips a boilerplate greeting prefix and passes", () => {
    const result = evaluateNeonSummaryQuality(
      "Okay, hier ist eine Zusammenfassung der Session:\n- Indexer-Gate gebaut\n- Tests grün"
    );
    assert.equal(result.passed, true);
    assert.ok(result.cleaned.startsWith("- Indexer-Gate gebaut"));
    assert.ok(result.issues.includes("stripped boilerplate prefix"));
  });

  it("strips an enclosing codefence and passes", () => {
    const result = evaluateNeonSummaryQuality("```md\n- Punkt eins\n- Punkt zwei\n```");
    assert.equal(result.passed, true);
    assert.equal(result.cleaned, "- Punkt eins\n- Punkt zwei");
    assert.ok(result.issues.includes("stripped enclosing codefence"));
  });

  it("rejects output that is only a boilerplate greeting", () => {
    const result = evaluateNeonSummaryQuality("Okay, hier ist eine Zusammenfassung:");
    assert.equal(result.passed, false);
    assert.ok(result.issues.includes("empty after sanitize"));
  });

  it("rejects leaked template placeholders", () => {
    const result = evaluateNeonSummaryQuality("- Ergebnis: <titel> wurde umgesetzt");
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.includes("template placeholder")));
  });

  it("enforces a required header when configured", () => {
    const missing = evaluateNeonSummaryQuality("- nur Stichpunkte", {
      requiredHeader: "## Session-Summary"
    });
    assert.equal(missing.passed, false);
    assert.ok(missing.issues.some((issue) => issue.includes("missing header")));

    // Real content on purpose: a bare "- Punkt" would trip the hollow-summary
    // rule and make this test pass or fail for the wrong reason.
    const present = evaluateNeonSummaryQuality("## Session-Summary [demo]\n- Gate erweitert", {
      requiredHeader: "## Session-Summary"
    });
    assert.equal(present.passed, true);
  });

  it("accepts an explicit no-op line instead of the required header", () => {
    const result = evaluateNeonSummaryQuality("_Keine substantiellen Aktivitäten._", {
      requiredHeader: "## Session-Summary"
    });
    assert.equal(result.passed, true);
  });

  it("rejects a summary built from the format's own example bullets", () => {
    // The live failure this rule was written for: summaries dedupe by session_id,
    // so one skeleton entry blocks the real content until someone notices.
    const result = evaluateNeonSummaryQuality("- Punkt 1\n- Punkt 2\n- Entscheidung 1");
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.includes("hollow summary")));
  });

  it("rejects a single skeleton bullet when it is the whole summary", () => {
    const result = evaluateNeonSummaryQuality("- Detail 2");
    assert.equal(result.passed, false);
    assert.ok(result.issues.some((issue) => issue.includes("hollow summary")));
  });

  it("tolerates one skeleton bullet among real content", () => {
    // A model may legitimately name a point "Punkt 1" next to actual findings;
    // one skeleton line is noise, not a copied format.
    const result = evaluateNeonSummaryQuality(
      "- Punkt 1\n- Indexer-Gate nach TypeScript gezogen\n- Relations-Cap auf 20k angehoben"
    );
    assert.equal(result.passed, true);
  });

  it("leaves prose without bullets to the other checks", () => {
    const result = evaluateNeonSummaryQuality(
      "Die Session drehte sich um den Live-Indexer und endete mit grünen Tests."
    );
    assert.equal(result.passed, true);
  });
});
