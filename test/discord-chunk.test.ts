import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkNeonDiscordText } from "../src/gateway/discordChunk.js";

const MAX = 2000;

describe("chunkNeonDiscordText (pure outbound Discord chunker)", () => {
  it("returns [] for an empty body", () => {
    assert.deepEqual(chunkNeonDiscordText(""), []);
  });

  it("returns the body unchanged when within both limits", () => {
    const body = "a short reply\nwith two lines";
    assert.deepEqual(chunkNeonDiscordText(body), [body]);
  });

  it("splits a single long line into chunks each within the char limit", () => {
    const body = "x".repeat(4500);
    const chunks = chunkNeonDiscordText(body);
    assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= MAX, `chunk too long: ${chunk.length}`);
    }
    // Lossless for a plain run with no fences or whitespace breaks.
    assert.equal(chunks.join(""), body);
  });

  it("splits by the soft line limit even when well under the char limit", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkNeonDiscordText(body);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.split("\n").length <= 17, `too many lines: ${chunk.split("\n").length}`);
    }
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const code = Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const body = `intro line\n\`\`\`ts\n${code}\n\`\`\``;
    const chunks = chunkNeonDiscordText(body);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      const fences = (chunk.match(/```/g) ?? []).length;
      assert.equal(fences % 2, 0, `unbalanced fences in chunk starting: ${chunk.slice(0, 30)}`);
    }
  });

  it("never breaks a surrogate pair in an emoji run", () => {
    const body = "😀".repeat(1500); // 3000 UTF-16 units -> must split
    const chunks = chunkNeonDiscordText(body);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.equal([...chunk].every((cp) => cp === "😀"), true, "lone surrogate at a chunk edge");
    }
    assert.equal(chunks.join(""), body);
  });

  it("respects custom maxChars", () => {
    const chunks = chunkNeonDiscordText("abcdefghij", { maxChars: 4 });
    assert.ok(chunks.length >= 3, `expected >=3 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 4, `chunk too long: ${chunk.length}`);
    }
  });

  it("respects newline mode at paragraph boundaries", () => {
    const body = [
      "Absatz eins bleibt zusammen.",
      "Absatz zwei bleibt ebenfalls zusammen.",
      "Absatz drei kommt in einen weiteren Chunk."
    ].join("\n\n");
    const chunks = chunkNeonDiscordText(body, { chunkMode: "newline", maxChars: 70 });

    assert.deepEqual(chunks, [
      "Absatz eins bleibt zusammen.\n\nAbsatz zwei bleibt ebenfalls zusammen.",
      "Absatz drei kommt in einen weiteren Chunk."
    ]);
  });
});
