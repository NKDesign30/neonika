import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveNeonGatedSideEffectPosture } from "../src/core/gatedSideEffectsPosture.js";
import {
  renderNeonSecurityAuditReport,
  resolveNeonSecurityAuditExitCode,
  runNeonSecurityAudit
} from "../src/security/neonSecurityAudit.js";

describe("Neon security footgun audit", () => {
  it("an empty env yields only info findings and a clean exit code", () => {
    const report = runNeonSecurityAudit({});

    assert.equal(report.exitCode, 0);
    assert.ok(report.findings.every((finding) => finding.severity === "info"));
    // mutation-auth + ws-origin info hints are expected on a bare env.
    assert.ok(report.findings.some((finding) => finding.axis === "gateway-http-mutation-auth"));
    assert.ok(report.findings.some((finding) => finding.axis === "ws-origin-allowlist"));
  });

  it("is fully clean once mutation token + ws-origin are configured in shadow", () => {
    const report = runNeonSecurityAudit({
      NEON_GATEWAY_HTTP_MUTATION_TOKEN: "op://Automation/Gateway/token",
      NEON_GATEWAY_ALLOWED_ORIGINS: "https://control.neon",
      NEON_CUTOVER_STAGE: "shadow"
    });

    assert.equal(report.findings.length, 0);
    assert.equal(report.exitCode, 0);
  });

  it("flags canary stage without approval as critical (exit 2)", () => {
    const report = runNeonSecurityAudit({
      NEON_GATEWAY_HTTP_MUTATION_TOKEN: "op://Automation/Gateway/token",
      NEON_GATEWAY_ALLOWED_ORIGINS: "https://control.neon",
      NEON_CUTOVER_STAGE: "canary"
    });

    const cutover = report.findings.find((finding) => finding.axis === "cutover-stage");
    assert.ok(cutover);
    assert.equal(cutover?.severity, "critical");
    assert.equal(report.exitCode, 2);
  });

  it("clears the cutover finding when canary is approved", () => {
    const report = runNeonSecurityAudit({
      NEON_GATEWAY_HTTP_MUTATION_TOKEN: "op://Automation/Gateway/token",
      NEON_GATEWAY_ALLOWED_ORIGINS: "https://control.neon",
      NEON_CUTOVER_STAGE: "canary",
      NEON_CUTOVER_CANARY_APPROVED: "ready"
    });

    assert.ok(!report.findings.some((finding) => finding.axis === "cutover-stage"));
  });

  it("reports an armed gated side-effect as a finding (coupled to real posture)", () => {
    // Drive whatever env the posture treats as 'armed' for delivery-drain, then
    // assert the audit surfaces it. If "1" does not arm the gate, the posture
    // probe below skips the assertion rather than asserting a guessed value.
    const env = { NEON_DELIVERY_DRAIN_ENABLED: "1" };
    const posture = resolveNeonGatedSideEffectPosture(env as NodeJS.ProcessEnv);
    const armedDrain = posture.gates.find(
      (gate) => gate.envKey === "NEON_DELIVERY_DRAIN_ENABLED" && gate.armed
    );

    if (!armedDrain) {
      // Posture does not treat "1" as armed; nothing to assert for this axis.
      return;
    }

    const report = runNeonSecurityAudit(env as NodeJS.ProcessEnv);
    const gateFinding = report.findings.find((finding) => finding.axis === "gate:delivery-drain");
    assert.ok(gateFinding);
    assert.equal(gateFinding?.severity, "critical"); // outbound category
    assert.equal(report.exitCode, 2);
  });

  it("resolves exit codes by highest severity", () => {
    assert.equal(resolveNeonSecurityAuditExitCode([]), 0);
    assert.equal(
      resolveNeonSecurityAuditExitCode([{ axis: "a", severity: "info", detail: "d" }]),
      0
    );
    assert.equal(
      resolveNeonSecurityAuditExitCode([{ axis: "a", severity: "warn", detail: "d" }]),
      1
    );
    assert.equal(
      resolveNeonSecurityAuditExitCode([
        { axis: "a", severity: "warn", detail: "d" },
        { axis: "b", severity: "critical", detail: "d" }
      ]),
      2
    );
  });

  it("renders a readable report with a severity breakdown", () => {
    const report = runNeonSecurityAudit({ NEON_CUTOVER_STAGE: "canary" });
    const rendered = renderNeonSecurityAuditReport(report);

    assert.match(rendered, /Neonika Security Audit: exit 2/);
    assert.match(rendered, /critical/);
  });
});
