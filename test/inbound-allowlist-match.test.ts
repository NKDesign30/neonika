import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compileNeonAllowlist,
  formatNeonAllowlistMatchMeta,
  resolveNeonAllowlistMatchByCandidates,
  resolveNeonAllowlistMatchSimple
} from "../src/index.js";

describe("Neon inbound allowlist match (upstream allowlist-match parity)", () => {
  it("denies everyone when the allowlist is empty", () => {
    const match = resolveNeonAllowlistMatchSimple({ allowFrom: [], senderId: "user-1" });
    assert.equal(match.allowed, false);
    assert.equal(match.matchSource, undefined);
  });

  it("allows everyone on a wildcard entry", () => {
    const match = resolveNeonAllowlistMatchSimple({ allowFrom: ["*"], senderId: "user-1" });
    assert.equal(match.allowed, true);
    assert.equal(match.matchSource, "wildcard");
    assert.equal(match.matchKey, "*");
  });

  it("matches a sender id case-insensitively", () => {
    const match = resolveNeonAllowlistMatchSimple({ allowFrom: ["User-7"], senderId: "user-7" });
    assert.equal(match.allowed, true);
    assert.equal(match.matchSource, "id");
    assert.equal(match.matchKey, "user-7");
  });

  it("only matches by name when name matching is explicitly enabled", () => {
    const off = resolveNeonAllowlistMatchSimple({
      allowFrom: ["operator"],
      senderId: "user-7",
      senderName: "Operator"
    });
    assert.equal(off.allowed, false);

    const on = resolveNeonAllowlistMatchSimple({
      allowFrom: ["operator"],
      senderId: "user-7",
      senderName: "Operator",
      allowNameMatching: true
    });
    assert.equal(on.allowed, true);
    assert.equal(on.matchSource, "name");
  });

  it("prefers an id match over a name match (candidate order)", () => {
    const match = resolveNeonAllowlistMatchSimple({
      allowFrom: ["user-7", "shared"],
      senderId: "user-7",
      senderName: "shared",
      allowNameMatching: true
    });
    assert.equal(match.allowed, true);
    assert.equal(match.matchSource, "id");
  });

  it("compiles entries with dedupe and empty filtering and matches typed candidate sources", () => {
    const compiled = compileNeonAllowlist(["a", "a", "", "b"]);
    assert.equal(compiled.set.size, 2);
    assert.equal(compiled.wildcard, false);

    const match = resolveNeonAllowlistMatchByCandidates({
      allowList: ["team:ops"],
      candidates: [
        { source: "id" },
        { value: "team:ops", source: "tag" }
      ]
    });
    assert.equal(match.allowed, true);
    assert.equal(match.matchSource, "tag");
  });

  it("renders leak-safe meta that never exposes the raw matched key", () => {
    const match = resolveNeonAllowlistMatchSimple({ allowFrom: ["secret-id-123"], senderId: "secret-id-123" });
    const meta = formatNeonAllowlistMatchMeta(match);
    assert.match(meta, /matchKey=matched/);
    assert.match(meta, /matchSource=id/);
    assert.doesNotMatch(meta, /secret-id-123/);

    assert.equal(formatNeonAllowlistMatchMeta(undefined), "matchKey=none matchSource=none");
  });
});
