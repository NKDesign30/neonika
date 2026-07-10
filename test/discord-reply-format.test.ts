import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatNeonDiscordReplyText } from "../src/index.js";

describe("formatNeonDiscordReplyText", () => {
  it("keeps numbered lists exactly readable instead of rewriting section labels", () => {
    const input =
      "1. Upstream macht Discord lesbar.\n2. 123 bleibt 123.\n10. Große Nummern werden nicht angefasst.\n\nKurzfassung: Neon soll das nicht umbauen.";

    assert.equal(formatNeonDiscordReplyText(input), input);
    assert.doesNotMatch(formatNeonDiscordReplyText(input), /\*\*Kurzfassung:\*\*/u);
  });

  it("preserves already readable short replies", () => {
    const input = "Hey Operator, bin da.";

    assert.equal(formatNeonDiscordReplyText(input), input);
  });

  it("preserves already readable bullet sections", () => {
    const input = "Wichtigste Punkte:\n- erster Punkt\n- zweiter Punkt";

    assert.equal(formatNeonDiscordReplyText(input), input);
  });

  it("strips internal runtime scaffolding tags", () => {
    const input =
      "Sichtbar davor\n<system-reminder>internes Routing</system-reminder>\n<previous_response id=\"x\" />\nSichtbar danach";

    assert.equal(formatNeonDiscordReplyText(input), "Sichtbar davor\n\nSichtbar danach");
  });

  it("strips internal channel trace lines outside code fences", () => {
    const input = [
      "Sichtbar davor",
      "analysis: interner Gedanke",
      "```",
      "analysis: bleibt Code",
      "```",
      "reasoning = noch intern",
      "Sichtbar danach"
    ].join("\n");

    assert.equal(
      formatNeonDiscordReplyText(input),
      ["Sichtbar davor", "```", "analysis: bleibt Code", "```", "Sichtbar danach"].join("\n")
    );
  });

  it("normalizes Cyrillic homoglyphs inside Latin words only", () => {
    const input = "Gemerk\u0442: 1.200 €\n\u0422est bleibt lesbar.\n\n\u041a\u043e\u043c\u0430\u043d\u0434\u0430 bleibt kyrillisch.";

    assert.equal(
      formatNeonDiscordReplyText(input),
      "Gemerkt: 1.200 €\nTest bleibt lesbar.\n\n\u041a\u043e\u043c\u0430\u043d\u0434\u0430 bleibt kyrillisch."
    );
  });

  it("turns markdown tables into Discord-readable code blocks", () => {
    const input = "Ergebnis:\n\n| Name | Wert |\n| --- | ---: |\n| A | 1 |\n| B | 23 |";

    assert.equal(
      formatNeonDiscordReplyText(input),
      "Ergebnis:\n\n```\n| Name | Wert |\n| ---- | ---- |\n| A    | 1    |\n| B    | 23   |\n```"
    );
  });

  it("does not convert markdown-looking tables inside fenced code blocks", () => {
    const input = "```md\n| Name | Wert |\n| --- | --- |\n| A | 1 |\n```";

    assert.equal(formatNeonDiscordReplyText(input), input);
  });

  it("keeps list spacing but collapses excessive blank lines", () => {
    const input = "Liste:\r\n  1. eins  \r\n  2. zwei\r\n\r\n\r\nEnde";

    assert.equal(formatNeonDiscordReplyText(input), "Liste:\n  1. eins\n  2. zwei\n\nEnde");
  });
});
