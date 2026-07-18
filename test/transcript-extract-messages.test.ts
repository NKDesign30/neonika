import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractNeonTranscript } from "../src/index.js";

function turn(role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: role, message: { content: text } });
}

describe("Neon transcript extract — per-turn messages", () => {
  it("omits messages by default (digest/HTTP path stays lean)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-extract-"));
    try {
      const file = join(dir, "s.jsonl");
      await writeFile(file, [turn("user", "Bitte den Indexer bauen."), ""].join("\n"));
      const extract = await extractNeonTranscript(file);
      assert.equal(extract.messages, undefined);
      assert.equal(extract.messageCount, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collects redacted messages with absolute 1-based indexes when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-extract-"));
    try {
      const file = join(dir, "s.jsonl");
      await writeFile(
        file,
        [
          turn("user", "Deploy mit ghp_aBcD1234567890aBcD1234567890aBcD12 bitte."),
          turn("assistant", "Vorschlag: Gate vor Persist einbauen."),
          turn("user", "ja mach das genau so."),
          ""
        ].join("\n")
      );
      const extract = await extractNeonTranscript(file, { includeMessages: true });
      assert.ok(extract.messages);
      assert.equal(extract.messages.length, 3);
      assert.deepEqual(
        extract.messages.map((message) => [message.messageIndex, message.role]),
        [
          [1, "user"],
          [2, "assistant"],
          [3, "user"]
        ]
      );
      assert.doesNotMatch(extract.messages[0]?.text ?? "", /ghp_aBcD/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps only the last 80 turns but preserves absolute indexes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-extract-"));
    try {
      const file = join(dir, "s.jsonl");
      const lines: string[] = [];
      for (let index = 1; index <= 90; index += 1) {
        lines.push(turn(index % 2 === 1 ? "user" : "assistant", `Nachricht Nummer ${index} mit Inhalt.`));
      }
      await writeFile(file, `${lines.join("\n")}\n`);
      const extract = await extractNeonTranscript(file, { includeMessages: true });
      assert.ok(extract.messages);
      assert.equal(extract.messages.length, 80);
      assert.equal(extract.messages[0]?.messageIndex, 11);
      assert.equal(extract.messages[79]?.messageIndex, 90);
      assert.equal(extract.messageCount, 90);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
