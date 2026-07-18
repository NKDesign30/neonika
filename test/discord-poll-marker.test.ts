import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NEON_DISCORD_POLL_MARKER_DEFAULT_DURATION_HOURS,
  parseNeonDiscordPollMarker
} from "../src/index.js";

describe("Neon Discord poll marker parser", () => {
  it("parses a full marker and strips it from the reply text", () => {
    const result = parseNeonDiscordPollMarker(
      'Here are the choices.\n<NEON_POLL question="Which logo?" duration_hours="48" multi="true">Emerald|Slate|Ivory</NEON_POLL>'
    );

    assert.equal(result.text, "Here are the choices.");
    assert.deepEqual(result.poll, {
      question: "Which logo?",
      answers: [{ text: "Emerald" }, { text: "Slate" }, { text: "Ivory" }],
      durationHours: 48,
      allowMultiselect: true
    });
  });

  it("applies default duration and single-select when attributes are omitted", () => {
    const result = parseNeonDiscordPollMarker(
      '<NEON_POLL question="Deploy tonight?">Yes|No</NEON_POLL>'
    );

    assert.equal(result.text, "");
    assert.equal(result.poll?.durationHours, NEON_DISCORD_POLL_MARKER_DEFAULT_DURATION_HOURS);
    assert.equal(result.poll?.allowMultiselect, undefined);
    assert.deepEqual(
      result.poll?.answers.map((answer) => answer.text),
      ["Yes", "No"]
    );
  });

  it("returns the text unchanged when no marker is present", () => {
    const result = parseNeonDiscordPollMarker("Just a normal answer.");

    assert.equal(result.text, "Just a normal answer.");
    assert.equal(result.poll, undefined);
  });

  it("strips an invalid marker without producing a poll", () => {
    const singleAnswer = parseNeonDiscordPollMarker(
      'Answer.\n<NEON_POLL question="Broken?">only-one-option</NEON_POLL>'
    );
    assert.equal(singleAnswer.text, "Answer.");
    assert.equal(singleAnswer.poll, undefined);

    const badDuration = parseNeonDiscordPollMarker(
      '<NEON_POLL question="Too long?" duration_hours="999">A|B</NEON_POLL>'
    );
    assert.equal(badDuration.text, "");
    assert.equal(badDuration.poll, undefined);
  });

  it("rejects more than ten answers and over-long answer texts", () => {
    const tooMany = parseNeonDiscordPollMarker(
      '<NEON_POLL question="Pick">a|b|c|d|e|f|g|h|i|j|k</NEON_POLL>'
    );
    assert.equal(tooMany.poll, undefined);

    const tooLong = parseNeonDiscordPollMarker(
      `<NEON_POLL question="Pick">short|${"x".repeat(56)}</NEON_POLL>`
    );
    assert.equal(tooLong.poll, undefined);
  });

  it("uses the first marker and strips every occurrence", () => {
    const result = parseNeonDiscordPollMarker(
      [
        'Intro.',
        '<NEON_POLL question="First?">A|B</NEON_POLL>',
        'Middle.',
        '<NEON_POLL question="Second?">C|D</NEON_POLL>'
      ].join("\n")
    );

    assert.equal(result.poll?.question, "First?");
    assert.equal(result.text, "Intro.\n\nMiddle.");
    assert.doesNotMatch(result.text, /NEON_POLL/u);
  });

  it("redacts secrets inside question and answers at the source", () => {
    const result = parseNeonDiscordPollMarker(
      '<NEON_POLL question="Rotate token sk-test-secret-value now?">rotate sk-test-secret-value|keep</NEON_POLL>'
    );

    const serialized = JSON.stringify(result.poll);
    assert.notEqual(result.poll, undefined);
    assert.doesNotMatch(serialized, /sk-test-secret-value/u);
  });
});
