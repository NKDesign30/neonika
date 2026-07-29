// Adapted from NK Design's Neon runtime tests for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runNeonSummaryQualityCheck } from "../src/index.js";

describe("Neon summary quality check entry point", () => {
  it("renders a passing verdict as JSON and exits zero", () => {
    const outcome = runNeonSummaryQualityCheck("- Gate gebaut\n- Tests grün");
    assert.equal(outcome.exitCode, 0);

    const parsed = JSON.parse(outcome.output) as {
      passed: boolean;
      cleaned: string;
      issues: string[];
    };
    assert.equal(parsed.passed, true);
    assert.equal(parsed.cleaned, "- Gate gebaut\n- Tests grün");
    assert.deepEqual(parsed.issues, []);
  });

  it("exits one when the summary is rejected", () => {
    const outcome = runNeonSummaryQualityCheck("- Punkt 1\n- Punkt 2");
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.result.passed, false);
  });

  it("hands back the sanitized text, not just a verdict", () => {
    // This is what the Python caller gains: it used to keep the raw output
    // because its own copy of the rule could only say yes or no.
    const outcome = runNeonSummaryQualityCheck(
      "Okay, hier ist eine Zusammenfassung:\n- Echter Punkt\n- Zweiter Punkt"
    );
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.result.cleaned, "- Echter Punkt\n- Zweiter Punkt");
  });

  it("accepts the required header in both flag spellings", () => {
    const spaced = runNeonSummaryQualityCheck("- Punkt ohne Header", [
      "--header",
      "## Session-Summary"
    ]);
    assert.equal(spaced.exitCode, 1);

    const equals = runNeonSummaryQualityCheck("- Punkt ohne Header", [
      "--header=## Session-Summary"
    ]);
    assert.equal(equals.exitCode, 1);

    const present = runNeonSummaryQualityCheck("## Session-Summary\n- Inhalt", [
      "--header",
      "## Session-Summary"
    ]);
    assert.equal(present.exitCode, 0);
  });

  it("refuses an unknown flag instead of ignoring it", () => {
    // A silently dropped flag would look like a check that ran and passed.
    assert.throws(
      () => runNeonSummaryQualityCheck("- Inhalt", ["--headerr", "x"]),
      /unknown flag/
    );
    assert.throws(() => runNeonSummaryQualityCheck("- Inhalt", ["--header"]), /needs a value/);
  });
});
