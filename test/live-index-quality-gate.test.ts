import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyNeonLiveIndexQualityGate,
  evaluateNeonLiveIndexRecord,
  renderNeonLiveIndexQualitySummary,
  type INeonLiveIndexRecord
} from "../src/index.js";

describe("Neon live-index quality gate", () => {
  it("accepts a substantial Claude digest with content-derived importance below 61", () => {
    const record = claudeDigest({
      messages: "Messages: 24 (9 user / 15 assistant)",
      toolFailures: "Tool failures: 2",
      preview:
        "Latest preview: Wir haben den Memory-Cutover auf neonika geplant, das Slop-Gate " +
        "zwischen Collect und Write eingehängt und die Importance-Ableitung aus dem Inhalt gebaut."
    });

    const verdict = evaluateNeonLiveIndexRecord(record);

    assert.equal(verdict.passed, true);
    assert.equal(verdict.rejectClass, undefined);
    assert.ok(verdict.importanceScore >= 20 && verdict.importanceScore <= 60);
    assert.notEqual(verdict.importanceScore, 72);
    assert.ok(verdict.notes.length > 0);
  });

  it("scores richer sessions higher than thin ones", () => {
    const rich = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 40 (12 user / 28 assistant)",
        toolFailures: "Tool failures: 3",
        preview:
          "Latest preview: Lange substanzielle Session über Architektur und Cutover: Wir haben das " +
          "Quality-Gate entworfen, die Importance-Ableitung diskutiert, den Daemon-Pfad verdrahtet, " +
          "die Plist umgestellt, Tests ergänzt, den Doctor ausgeführt und offene Risiken für die " +
          "nächsten Slices dokumentiert, inklusive Rollback-Plan und Live-Smoke gegen den echten Daemon."
      })
    );
    const thin = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 2 (1 user / 1 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: Kurze Frage zum Setup beantwortet."
      })
    );

    assert.ok(rich.passed && thin.passed);
    assert.ok(rich.importanceScore > thin.importanceScore);
  });

  it("rejects empty previews", () => {
    const verdict = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 5 (2 user / 3 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: "
      })
    );

    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "empty-preview");
  });

  it("rejects placeholder templates but not HTML/JSX in coding previews", () => {
    const placeholder = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 5 (2 user / 3 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: DECISION: <beschreibung der entscheidung>"
      })
    );
    const htmlPreview = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 5 (2 user / 3 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: Wir rendern die Karte jetzt als <section> mit einem <button> pro Eintrag."
      })
    );
    // React-Native / detail-element sessions: <Text>, <summary>, <TodoItem>
    // must NOT count as placeholders (Sentinel finding, K3 review).
    const jsxPreview = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 8 (3 user / 5 assistant)",
        toolFailures: "Tool failures: 0",
        preview:
          "Latest preview: Die Liste nutzt jetzt <Text> und <TodoItem> pro Zeile, Details stecken in <summary>."
      })
    );
    const germanPlaceholder = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 5 (2 user / 3 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: Neue Entscheidung angelegt mit <titel einfügen> als Überschrift."
      })
    );

    assert.equal(placeholder.passed, false);
    assert.equal(placeholder.rejectClass, "placeholder");
    assert.equal(htmlPreview.passed, true);
    assert.equal(jsxPreview.passed, true);
    assert.equal(germanPlaceholder.passed, false);
    assert.equal(germanPlaceholder.rejectClass, "placeholder");
  });

  it("rejects the repetition loop pattern from the v2 April bug", () => {
    const verdict = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 5 (2 user / 3 assistant)",
        toolFailures: "Tool failures: 0",
        preview: `Latest preview: ${"Sessions indexiert. ".repeat(15)}`
      })
    );

    assert.equal(verdict.passed, false);
    assert.equal(verdict.rejectClass, "repetition");
  });

  it("rejects noise-only previews and single-message sessions", () => {
    const noise = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 5 (2 user / 3 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: Caveat: the messages below were generated during a sandboxed run"
      })
    );
    const trivial = evaluateNeonLiveIndexRecord(
      claudeDigest({
        messages: "Messages: 1 (1 user / 0 assistant)",
        toolFailures: "Tool failures: 0",
        preview: "Latest preview: Hallo, bist du da? Ich wollte nur kurz etwas testen."
      })
    );

    assert.equal(noise.passed, false);
    assert.equal(noise.rejectClass, "noise-preview");
    assert.equal(trivial.passed, false);
    assert.equal(trivial.rejectClass, "trivial-session");
  });

  it("applies the gate as a batch and rewrites importance on accepted records", () => {
    const good = claudeDigest({
      messages: "Messages: 12 (4 user / 8 assistant)",
      toolFailures: "Tool failures: 1",
      preview: "Latest preview: Cutover-Slice K3 gebaut, Gate verdrahtet, Tests ergänzt und Doctor ausgeführt."
    });
    const bad = claudeDigest({
      messages: "Messages: 6 (2 user / 4 assistant)",
      toolFailures: "Tool failures: 0",
      preview: "Latest preview: "
    });

    const outcome = applyNeonLiveIndexQualityGate([good, bad]);

    assert.equal(outcome.summary.evaluated, 2);
    assert.equal(outcome.summary.accepted, 1);
    assert.equal(outcome.summary.rejected, 1);
    assert.equal(outcome.summary.rejectClasses["empty-preview"], 1);
    assert.equal(outcome.accepted.length, 1);
    const accepted = outcome.accepted[0];
    assert.ok(accepted);
    assert.notEqual(accepted.importanceScore, 72);
    assert.ok(accepted.importanceScore <= 60);
    assert.match(
      renderNeonLiveIndexQualitySummary(outcome.summary),
      /accepted=1 rejected=1 \(empty-preview=1\)/
    );
  });

  it("scores Discord digests via run count without a Messages line", () => {
    const record: INeonLiveIndexRecord = {
      source: "discord",
      sourceKey: "discord:test-session",
      sourceFile: "live-index/discord/test-session.md",
      agent: "neo",
      category: "live-index",
      content: [
        "Discord live-index digest",
        "Session: test-session",
        "Agent: neo",
        "Channel: 123",
        "Runs: 4",
        "Latest status: completed",
        "Latest preview: Deploy-Runde für die Website abgeschlossen, alle Checks grün gemeldet."
      ].join("\n"),
      entryDate: "2026-07-07",
      importanceScore: 72
    };

    const verdict = evaluateNeonLiveIndexRecord(record);

    assert.equal(verdict.passed, true);
    assert.ok(verdict.importanceScore > 25);
    assert.ok(verdict.importanceScore <= 60);
  });
});

function claudeDigest(input: {
  readonly messages: string;
  readonly toolFailures: string;
  readonly preview: string;
}): INeonLiveIndexRecord {
  return {
    source: "claude",
    sourceKey: "claude:test-project:test-session",
    sourceFile: "live-index/claude/test-session.md",
    agent: "neo",
    category: "live-index",
    content: [
      "Claude transcript live-index digest",
      "Project: test-project",
      "Session: test-session",
      "Mode: interactive",
      input.messages,
      input.toolFailures,
      input.preview
    ].join("\n"),
    entryDate: "2026-07-07",
    importanceScore: 72
  };
}
