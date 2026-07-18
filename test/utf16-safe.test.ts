import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sliceUtf16Safe, truncateUtf16Safe } from "../src/index.js";

describe("UTF-16 safe text slicing", () => {
  it("does not leave a dangling high surrogate at the truncation boundary", () => {
    const value = `${"a".repeat(3)}🙂tail`;

    assert.equal(truncateUtf16Safe(value, 4), "aaa");
  });

  it("does not start a slice with a dangling low surrogate", () => {
    const value = "head🙂tail";

    assert.equal(sliceUtf16Safe(value, 5), "tail");
  });

  it("normalizes negative and reversed bounds without splitting emojis", () => {
    const value = "ab🙂cd";

    assert.equal(sliceUtf16Safe(value, -3), "cd");
    assert.equal(sliceUtf16Safe(value, 5, 2), "🙂c");
  });
});
