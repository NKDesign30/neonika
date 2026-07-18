import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NEON_DISCORD_ACCENT_COLOR,
  neonDiscordCardMarkerColors,
  neonDiscordSeverityColors,
  parseNeonDiscordCardMarker
} from "../src/index.js";

describe("Neon Discord card marker parser", () => {
  it("parses a full marker with a multi-line body and strips it from the reply text", () => {
    const result = parseNeonDiscordCardMarker(
      'Summary below.\n<NEON_CARD title="Deploy Report" color="red" image="https://example.com/shot.png">Line one.\nLine two.</NEON_CARD>'
    );

    assert.equal(result.text, "Summary below.");
    assert.deepEqual(result.card, {
      title: "Deploy Report",
      description: "Line one.\nLine two.",
      color: neonDiscordSeverityColors.critical,
      imageUrl: "https://example.com/shot.png"
    });
  });

  it("defaults to the Neon emerald accent when no color is given", () => {
    const result = parseNeonDiscordCardMarker(
      '<NEON_CARD title="Status">All systems green.</NEON_CARD>'
    );

    assert.equal(result.text, "");
    assert.equal(result.card?.color, NEON_DISCORD_ACCENT_COLOR);
    assert.equal(result.card?.imageUrl, undefined);
    assert.equal(neonDiscordCardMarkerColors["emerald"], NEON_DISCORD_ACCENT_COLOR);
  });

  it("returns the text unchanged when no marker is present", () => {
    const result = parseNeonDiscordCardMarker("Plain answer.");

    assert.equal(result.text, "Plain answer.");
    assert.equal(result.card, undefined);
  });

  it("strips an invalid marker without producing a card", () => {
    const emptyBody = parseNeonDiscordCardMarker(
      'Answer.\n<NEON_CARD title="Empty">   </NEON_CARD>'
    );

    assert.equal(emptyBody.text, "Answer.");
    assert.equal(emptyBody.card, undefined);
  });

  it("uses the first marker and strips every occurrence", () => {
    const result = parseNeonDiscordCardMarker(
      [
        '<NEON_CARD title="First">one</NEON_CARD>',
        'between',
        '<NEON_CARD title="Second">two</NEON_CARD>'
      ].join("\n")
    );

    assert.equal(result.card?.title, "First");
    assert.equal(result.text, "between");
    assert.doesNotMatch(result.text, /NEON_CARD/u);
  });

  it("redacts secrets in title and body and drops a mangled image URL instead of leaking", () => {
    const result = parseNeonDiscordCardMarker(
      '<NEON_CARD title="Token sk-test-secret-value rotated" image="https://example.com/x?token=sk-test-secret-value">body with sk-test-secret-value inside</NEON_CARD>'
    );

    const serialized = JSON.stringify(result.card);
    assert.notEqual(result.card, undefined);
    assert.doesNotMatch(serialized, /sk-test-secret-value/u);
  });
});
