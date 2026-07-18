import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectNeonSecretAuditFields,
  neonSecretAuditEnvKeys,
  renderNeonSecretsAuditReport,
  resolveNeonSecretsAuditExitCode,
  runNeonSecretsAudit
} from "../src/secrets/neonSecretsAudit.js";

describe("Neon secrets audit", () => {
  it("reports clean when every field is missing or an op:// reference", () => {
    const report = runNeonSecretsAudit({
      fields: {
        NEON_DISCORD_BOT_TOKEN: undefined,
        NEON_SECRET: "op://Automation/Neon/secret",
        NEON_REPLAY_SESSION_KEY: "   "
      }
    });

    assert.equal(report.findings.length, 0);
    assert.equal(report.exitCode, 0);
    // Only the resolvable op:// ref counts as scanned; blank/undefined are skipped.
    assert.equal(report.scannedFields, 1);
    assert.equal(report.cleanFields, 1);
  });

  it("flags a plaintext credential value as PLAINTEXT (exit 1)", () => {
    const report = runNeonSecretsAudit({
      fields: { NEON_DISCORD_BOT_TOKEN: "plain-token-value-1234" }
    });

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.code, "PLAINTEXT");
    assert.equal(report.findings[0]?.field, "NEON_DISCORD_BOT_TOKEN");
    assert.equal(report.exitCode, 1);
  });

  it("flags an incomplete op:// reference as REF_UNRESOLVED (exit 2)", () => {
    const report = runNeonSecretsAudit({
      fields: { NEON_SECRET: "op://only-vault" }
    });

    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.code, "REF_UNRESOLVED");
    assert.match(report.findings[0]?.detail ?? "", /incomplete/);
    assert.equal(report.exitCode, 2);
  });

  it("ranks an unresolved ref above plaintext in the exit code", () => {
    const report = runNeonSecretsAudit({
      fields: {
        NEON_DISCORD_BOT_TOKEN: "plain-token",
        NEON_SECRET: "op://broken"
      }
    });

    assert.equal(report.findings.length, 2);
    assert.equal(report.exitCode, 2);
  });

  it("resolves exit codes deterministically from findings", () => {
    assert.equal(resolveNeonSecretsAuditExitCode([]), 0);
    assert.equal(
      resolveNeonSecretsAuditExitCode([{ code: "PLAINTEXT", field: "x", detail: "d" }]),
      1
    );
    assert.equal(
      resolveNeonSecretsAuditExitCode([{ code: "REF_UNRESOLVED", field: "x", detail: "d" }]),
      2
    );
  });

  it("collects the known Neon secret env keys (excluding the public key)", () => {
    const fields = collectNeonSecretAuditFields({
      NEON_DISCORD_BOT_TOKEN: "op://Vault/Item/field",
      NEON_PAIR_PUBLIC_KEY: "ed25519-public-not-a-secret"
    });

    for (const key of neonSecretAuditEnvKeys) {
      assert.ok(key in fields);
    }
    assert.ok(!("NEON_PAIR_PUBLIC_KEY" in fields));
  });

  it("never echoes the secret value into the report", () => {
    const plaintext = "super-plain-token-DO-NOT-LEAK-9931";
    const report = runNeonSecretsAudit({ fields: { NEON_SECRET: plaintext } });

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, new RegExp(plaintext));
    assert.doesNotMatch(renderNeonSecretsAuditReport(report), new RegExp(plaintext));
  });

  it("renders a readable report with finding lines", () => {
    const report = runNeonSecretsAudit({
      fields: { NEON_SECRET: "plain" }
    });

    const rendered = renderNeonSecretsAuditReport(report);
    assert.match(rendered, /Neon Secrets Audit: findings/);
    assert.match(rendered, /\[PLAINTEXT\] NEON_SECRET/);
  });
});
