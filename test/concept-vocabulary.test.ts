import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveNeonConceptTags,
  neonTopConceptTag,
  NEON_MAX_CONCEPT_TAGS
} from "../src/index.js";

test("deriveNeonConceptTags ranks by frequency then first appearance", () => {
  const tags = deriveNeonConceptTags("Gateway backpressure protects the websocket gateway buffer");
  // "gateway" appears twice -> first; the rest keep their first-seen order.
  assert.deepEqual(tags, ["gateway", "backpressure", "protects", "websocket", "buffer"]);
  assert.equal(neonTopConceptTag("Gateway backpressure protects the websocket gateway buffer"), "gateway");
});

test("deriveNeonConceptTags drops stop words, short, pure-numeric and date tokens", () => {
  // the/and = stop words, 2026-06-03 = date, 42 = digits, ab = too short.
  assert.deepEqual(deriveNeonConceptTags("the and 2026-06-03 42 ab gateway"), ["gateway"]);
});

test("deriveNeonConceptTags dedupes and respects the default and explicit limits", () => {
  assert.deepEqual(deriveNeonConceptTags("router router router cache"), ["router", "cache"]);

  const many = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  assert.equal(deriveNeonConceptTags(many).length, NEON_MAX_CONCEPT_TAGS);
  assert.deepEqual(deriveNeonConceptTags(many, 3), ["alpha", "bravo", "charlie"]);
});

test("deriveNeonConceptTags keeps compound tokens and returns empty for all-stop-word text", () => {
  assert.deepEqual(deriveNeonConceptTags("neonika gateway/server config"), [
    "neonika",
    "gateway/server",
    "config"
  ]);
  assert.deepEqual(deriveNeonConceptTags(""), []);
  assert.deepEqual(deriveNeonConceptTags("the and for with"), []);
  assert.equal(neonTopConceptTag("the and for with"), undefined);
});
