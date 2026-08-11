import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSnapshotText, redactText } from "../src/index.js";

// S0b characterization: redactSnapshotText is the single source of truth extracted
// from the previously-duplicated redactIndexerText (limit 160) and redactActivityText
// (limit 1200). This pins byte-identical output against the ORIGINAL inline logic so
// the extraction provably changed no behavior at either call site.
function legacyInline(value: string, previewLimit: number): string {
  const redacted = redactText(value)
    .replace(/(^|[\s"'`=])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)[^\s"'`,;]+/g, "$1[REDACTED_PATH]")
    .trim();
  if (redacted.length <= previewLimit) {
    return redacted;
  }
  return `${redacted.slice(0, previewLimit - 3)}...`;
}

const SAMPLES: readonly string[] = [
  "plain short text",
  "  surrounded by whitespace that trim removes  ",
  "wrote to /Users/operator/neon-projects/neonika/src/x.ts then continued",
  "windows path C:\\Users\\operator\\secret.txt and /home/operator/.env both stripped",
  "OPENAI_API_KEY=sk-test1234567890abcdef leaked into a run preview",
  "ghp_aBcD1234567890aBcD1234567890aBcD12 token in the transcript body",
  "x".repeat(500),
  "/var/folders/aa/bb/T/tmpfile and more " + "y".repeat(1500),
  ""
];

describe("redactSnapshotText — byte-identical extraction (S0b)", () => {
  for (const limit of [160, 1200]) {
    it(`matches the legacy inline logic at previewLimit ${limit}`, () => {
      for (const sample of SAMPLES) {
        assert.equal(
          redactSnapshotText(sample, { previewLimit: limit }),
          legacyInline(sample, limit),
          `divergence at limit ${limit} for sample: ${JSON.stringify(sample.slice(0, 40))}`
        );
      }
    });
  }

  it("truncates with a trailing ellipsis exactly at the limit", () => {
    const long = "z".repeat(400);
    const out = redactSnapshotText(long, { previewLimit: 160 });
    assert.equal(out.length, 160);
    assert.ok(out.endsWith("..."));
  });

  it("truncates without splitting UTF-16 surrogate pairs", () => {
    const out = redactSnapshotText(`${"a".repeat(156)}🙂tail`, { previewLimit: 160 });
    assert.equal(out, `${"a".repeat(156)}...`);
    assert.equal(out.includes("\uD83D"), false);
  });

  it("strips filesystem paths even when no secret is present", () => {
    const out = redactSnapshotText("opened /Users/operator/x.ts", { previewLimit: 1200 });
    assert.ok(!out.includes("/Users/operator"));
    assert.match(out, /\[REDACTED_PATH\]/);
  });

  it("strips Linux temporary paths from snapshot text", () => {
    const out = redactSnapshotText("unavailable: /tmp/neonika/codex-sessions", {
      previewLimit: 1200
    });

    assert.equal(out, "unavailable: [REDACTED_PATH]");
  });
});
