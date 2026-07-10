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

    const present = evaluateNeonSummaryQuality("## Session-Summary [demo]\n- Punkt", {
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
});
