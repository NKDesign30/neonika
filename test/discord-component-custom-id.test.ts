import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNeonDiscordComponentCustomId,
  buildNeonDiscordModalCustomId,
  isNeonDiscordCustomIdWithinLimit,
  NEON_DISCORD_CUSTOM_ID_MAX_LENGTH,
  parseNeonDiscordComponentCustomId,
  parseNeonDiscordModalCustomId
} from "../src/index.js";

describe("Discord component custom-id codec", () => {
  it("round-trips a plain component id", () => {
    const id = buildNeonDiscordComponentCustomId({ componentId: "approve" });
    assert.equal(id, "occomp:cid=approve");
    assert.deepEqual(parseNeonDiscordComponentCustomId(id), { componentId: "approve" });
  });

  it("round-trips a component id with a modal id", () => {
    const id = buildNeonDiscordComponentCustomId({ componentId: "edit", modalId: "form-7" });
    assert.equal(id, "occomp:cid=edit;mid=form-7");
    assert.deepEqual(parseNeonDiscordComponentCustomId(id), { componentId: "edit", modalId: "form-7" });
  });

  it("percent-escapes values containing the separator or a literal percent", () => {
    const id = buildNeonDiscordComponentCustomId({ componentId: "a;b", modalId: "50%" });
    assert.match(id, /^occomp:e=1;/);
    assert.deepEqual(parseNeonDiscordComponentCustomId(id), { componentId: "a;b", modalId: "50%" });
  });

  it("round-trips a modal custom-id and escapes a separator", () => {
    const plain = buildNeonDiscordModalCustomId("feedback");
    assert.equal(plain, "ocmodal:mid=feedback");
    assert.equal(parseNeonDiscordModalCustomId(plain), "feedback");

    const escaped = buildNeonDiscordModalCustomId("a;b");
    assert.match(escaped, /^ocmodal:e=1;/);
    assert.equal(parseNeonDiscordModalCustomId(escaped), "a;b");
  });

  it("returns null for the wrong key or a missing id", () => {
    assert.equal(parseNeonDiscordComponentCustomId("ocmodal:mid=x"), null);
    assert.equal(parseNeonDiscordComponentCustomId("occomp:mid=x"), null);
    assert.equal(parseNeonDiscordComponentCustomId("garbage"), null);
    assert.equal(parseNeonDiscordModalCustomId("occomp:cid=x"), null);
    assert.equal(parseNeonDiscordModalCustomId("ocmodal:"), null);
  });

  it("does not confuse the component and modal parsers", () => {
    const component = buildNeonDiscordComponentCustomId({ componentId: "c" });
    const modal = buildNeonDiscordModalCustomId("m");
    assert.equal(parseNeonDiscordModalCustomId(component), null);
    assert.equal(parseNeonDiscordComponentCustomId(modal), null);
  });

  it("flags an over-length custom id", () => {
    assert.equal(isNeonDiscordCustomIdWithinLimit("occomp:cid=short"), true);
    const long = buildNeonDiscordComponentCustomId({
      componentId: "x".repeat(NEON_DISCORD_CUSTOM_ID_MAX_LENGTH)
    });
    assert.equal(isNeonDiscordCustomIdWithinLimit(long), false);
  });
});
