import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compileNeonAllowFrom,
  isNeonSenderIdAllowed,
  mergeNeonDmAllowFromSources,
  normalizeNeonStringEntries,
  parseNeonAccessGroupAllowFromEntry,
  resolveNeonGroupAllowFromSources
} from "../src/index.js";

describe("Neon allow-from policy (upstream allow-from parity)", () => {
  it("parses the accessGroup: prefix and rejects non-matching or empty names", () => {
    assert.equal(parseNeonAccessGroupAllowFromEntry("accessGroup:ops"), "ops");
    assert.equal(parseNeonAccessGroupAllowFromEntry("  accessGroup: ops "), "ops");
    assert.equal(parseNeonAccessGroupAllowFromEntry("user-7"), null);
    assert.equal(parseNeonAccessGroupAllowFromEntry("accessGroup:"), null);
    assert.equal(parseNeonAccessGroupAllowFromEntry("accessGroup:   "), null);
  });

  it("normalizes entries by trimming and dropping empties without lowercasing", () => {
    assert.deepEqual(normalizeNeonStringEntries([" User-7 ", "", "  ", "Ops"]), ["User-7", "Ops"]);
    assert.deepEqual(normalizeNeonStringEntries(undefined), []);
  });

  it("drops store allow-from for allowlist/open DM policies and keeps it otherwise", () => {
    const kept = mergeNeonDmAllowFromSources({
      allowFrom: ["a"],
      storeAllowFrom: ["b"],
      dmPolicy: "closed"
    });
    assert.deepEqual(kept, ["a", "b"]);

    for (const dmPolicy of ["allowlist", "open"]) {
      const dropped = mergeNeonDmAllowFromSources({ allowFrom: ["a"], storeAllowFrom: ["b"], dmPolicy });
      assert.deepEqual(dropped, ["a"]);
    }
  });

  it("prefers explicit group allow-from and honors the fallback flag", () => {
    assert.deepEqual(
      resolveNeonGroupAllowFromSources({ allowFrom: ["a"], groupAllowFrom: ["g"] }),
      ["g"]
    );
    assert.deepEqual(
      resolveNeonGroupAllowFromSources({ allowFrom: ["a"], groupAllowFrom: [] }),
      ["a"]
    );
    assert.deepEqual(
      resolveNeonGroupAllowFromSources({ allowFrom: ["a"], fallbackToAllowFrom: false }),
      []
    );
  });

  it("compiles allow-from into entries/wildcard/hasEntries", () => {
    assert.deepEqual(compileNeonAllowFrom([" a ", "", "b"]), {
      entries: ["a", "b"],
      hasWildcard: false,
      hasEntries: true
    });
    assert.deepEqual(compileNeonAllowFrom(["*"]), {
      entries: ["*"],
      hasWildcard: true,
      hasEntries: true
    });
    assert.deepEqual(compileNeonAllowFrom([]), { entries: [], hasWildcard: false, hasEntries: false });
  });

  it("applies the empty/wildcard/membership decision for a sender id", () => {
    const empty = compileNeonAllowFrom([]);
    assert.equal(isNeonSenderIdAllowed(empty, "user-7", true), true);
    assert.equal(isNeonSenderIdAllowed(empty, "user-7", false), false);

    const wildcard = compileNeonAllowFrom(["*"]);
    assert.equal(isNeonSenderIdAllowed(wildcard, "anyone", false), true);

    const scoped = compileNeonAllowFrom(["user-7"]);
    assert.equal(isNeonSenderIdAllowed(scoped, "user-7", false), true);
    assert.equal(isNeonSenderIdAllowed(scoped, "user-8", false), false);
    assert.equal(isNeonSenderIdAllowed(scoped, undefined, false), false);
    // Case-sensitive membership (the case-insensitive path is the matcher).
    assert.equal(isNeonSenderIdAllowed(scoped, "User-7", false), false);
  });
});
