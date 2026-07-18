import assert from "node:assert/strict";
import { test } from "node:test";

import { safeEqualSecret } from "../src/index.js";

test("safeEqualSecret: equal strings compare true", () => {
  assert.equal(safeEqualSecret("super-secret-token", "super-secret-token"), true);
});

test("safeEqualSecret: same-length difference compares false", () => {
  assert.equal(safeEqualSecret("super-secret-token", "super-secret-toker"), false);
});

test("safeEqualSecret: different lengths compare false (no length-leak short-circuit)", () => {
  assert.equal(safeEqualSecret("short", "short-but-longer"), false);
  assert.equal(safeEqualSecret("short-but-longer", "short"), false);
});

test("safeEqualSecret: non-string inputs compare false", () => {
  assert.equal(safeEqualSecret(undefined, "x"), false);
  assert.equal(safeEqualSecret("x", undefined), false);
  assert.equal(safeEqualSecret(null, null), false);
});

test("safeEqualSecret: empty vs empty is true, empty vs non-empty is false", () => {
  assert.equal(safeEqualSecret("", ""), true);
  assert.equal(safeEqualSecret("", "x"), false);
  assert.equal(safeEqualSecret("x", ""), false);
});

test("safeEqualSecret: utf8 multibyte content compares correctly", () => {
  assert.equal(safeEqualSecret("schlüssel-€", "schlüssel-€"), true);
  assert.equal(safeEqualSecret("schlüssel-€", "schlussel-€"), false);
});

test("safeEqualSecret: hex fingerprint equality (device-session shape)", () => {
  const fingerprint = "a".repeat(64); // sha256 hex shape
  assert.equal(safeEqualSecret(fingerprint, fingerprint), true);
  assert.equal(safeEqualSecret(fingerprint, `${"a".repeat(63)}b`), false);
});
