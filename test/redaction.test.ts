import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactText } from "../src/index.js";

// S0a security floor: redactText is the SOLE first boundary for the raw transcript
// source (~/.claude/projects is never-redacted-at-rest, unlike runs.jsonl which is
// redacted at write time). A critique built dist and proved these shapes leaked
// (output === input). Each row asserts the literal secret no longer appears AND a
// redaction marker is present. Any leak is a hard FAIL, never a warn.
const LEAKED_BEFORE: ReadonlyArray<{ readonly name: string; readonly input: string; readonly secret: string }> = [
  {
    name: "GitHub classic PAT (ghp_)",
    input: "deploy with token ghp_aBcD1234567890aBcD1234567890aBcD12 now",
    secret: "ghp_aBcD1234567890aBcD1234567890aBcD12"
  },
  {
    name: "GitHub fine-grained PAT (github_pat_)",
    input: "GH=github_pat_11ABC23DEFghIJklMNopQR_stUVwxyz0123456789ABCDEFghijklmn done",
    secret: "github_pat_11ABC23DEFghIJklMNopQR_stUVwxyz0123456789ABCDEFghijklmn"
  },
  {
    name: "Slack bot token (xoxb-)",
    input: "slack xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx posted",
    secret: "xoxb-1234567890-0987654321-AbCdEfGhIjKlMnOpQrStUvWx"
  },
  {
    // AIza + exactly 35 url-safe chars (10 digits + a..y = 35) = a real-shaped key.
    name: "Google API key (AIza)",
    input: "key AIza0123456789abcdefghijklmnopqrstuvwxy in config",
    secret: "AIza0123456789abcdefghijklmnopqrstuvwxy"
  },
  {
    name: "bare 3-segment JWT (eyJ)",
    input:
      "auth eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N2 ok",
    secret:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N2"
  },
  {
    name: "postgres URL credentials",
    input: "DATABASE_URL connects to postgres://admin:s3cr3tP%40ss@db.internal:5432/app here",
    secret: "s3cr3tP%40ss"
  },
  {
    name: "plaintext password colon-form",
    input: "the password: hunter2SuperSecret should never appear",
    secret: "hunter2SuperSecret"
  }
];

describe("redactText — transcript secret shapes (S0a)", () => {
  for (const { name, input, secret } of LEAKED_BEFORE) {
    it(`redacts ${name}`, () => {
      const redacted = redactText(input);
      assert.ok(
        !redacted.includes(secret),
        `secret leaked through redaction: ${name}`
      );
      assert.match(redacted, /\[REDACTED/);
    });
  }

  it("still redacts the originally-covered shapes", () => {
    const redacted = redactText(
      "OPENAI_API_KEY=sk-test1234567890abcdef AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF op://Vault/Item/field"
    );
    assert.ok(!redacted.includes("sk-test1234567890abcdef"));
    assert.ok(!redacted.includes("AKIA1234567890ABCDEF"));
    assert.doesNotMatch(redacted, /op:\/\/Vault/);
  });

  it("preserves ordinary prose with no secret shapes", () => {
    const clean = "Operator asked Neo to port the v3 live session indexer into Neonika.";
    assert.equal(redactText(clean), clean);
  });

  it("preserves a plain host URL without credentials", () => {
    const clean = "see https://github.com/neon/neonika for details";
    assert.equal(redactText(clean), clean);
  });
});
