import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyOnePasswordSecretRef,
  parseOnePasswordSecretRef,
  summarizeOnePasswordSecretRefReachability
} from "../src/index.js";

describe("Neon op:// SecretRef reachability", () => {
  it("parses a vault/item/field reference into structural parts", () => {
    assert.deepEqual(parseOnePasswordSecretRef("op://Automation/Vercel/credential"), {
      vault: "Automation",
      item: "Vercel",
      field: "credential"
    });
  });

  it("parses a vault/item/section/field reference with a section", () => {
    assert.deepEqual(parseOnePasswordSecretRef("op://Vault/Item/Section/token"), {
      vault: "Vault",
      item: "Item",
      section: "Section",
      field: "token"
    });
  });

  it("returns null for a structurally incomplete reference", () => {
    assert.equal(parseOnePasswordSecretRef("op://Vault/Item"), null);
    assert.equal(parseOnePasswordSecretRef("op://Vault"), null);
  });

  it("classifies reachability across resolvable, incomplete, malformed, and non-refs", () => {
    assert.equal(classifyOnePasswordSecretRef("op://v/i/f"), "resolvable");
    assert.equal(classifyOnePasswordSecretRef("op://v/i/s/f"), "resolvable");
    assert.equal(classifyOnePasswordSecretRef("op://v/i"), "incomplete");
    assert.equal(classifyOnePasswordSecretRef("op://v"), "incomplete");
    assert.equal(classifyOnePasswordSecretRef("op://"), "malformed");
    assert.equal(classifyOnePasswordSecretRef("op://a/b/c/d/e"), "malformed");
    assert.equal(classifyOnePasswordSecretRef("not-a-ref"), null);
  });

  it("summarizes reachability over a config blob without resolving any value", () => {
    const blob = [
      'BOT_TOKEN="op://Vault/Bot/token"',
      'WEBHOOK="op://Vault/Hook/Section/secret"',
      'BROKEN="op://Vault/Item"',
      'TOOLONG="op://Vault/Item/Section/sub/field"',
      'PLAIN="literal-value"'
    ].join("\n");

    const summary = summarizeOnePasswordSecretRefReachability(blob);

    assert.equal(summary.total, 4);
    assert.equal(summary.resolvable, 2);
    assert.equal(summary.incomplete, 1);
    assert.equal(summary.malformed, 1);
  });

  it("reports an all-zero summary when no op:// references are present", () => {
    const summary = summarizeOnePasswordSecretRefReachability("PLAIN=literal\nOTHER=value");

    assert.deepEqual(summary, { total: 0, resolvable: 0, incomplete: 0, malformed: 0 });
  });
});
