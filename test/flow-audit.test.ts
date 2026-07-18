import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listNeonFlowAuditFindings,
  renderNeonFlowAuditReport,
  summarizeNeonFlowAuditFindings,
  type INeonFlowDefinition,
  type INeonFlowStep,
  type TNeonFlowStepEffect
} from "../src/index.js";

const iso = (year: number, monthIndex: number, day: number): string =>
  new Date(Date.UTC(year, monthIndex, day)).toISOString();

function step(effect: TNeonFlowStepEffect, stepId = "s1"): INeonFlowStep {
  return {
    stepId,
    title: "Step",
    effect,
    action: "noop",
    gated: effect !== "read"
  };
}

function flow(overrides: Partial<INeonFlowDefinition> & { flowId: string }): INeonFlowDefinition {
  return {
    name: "Flow",
    ownerAgentId: "neo",
    trigger: { kind: "manual" },
    steps: [step("read")],
    status: "draft",
    createdAt: iso(2026, 5, 1),
    updatedAt: iso(2026, 5, 3),
    ...overrides
  };
}

test("listNeonFlowAuditFindings is clean for read-only/armed and side-effecting/non-armed flows", () => {
  const findings = listNeonFlowAuditFindings([
    flow({ flowId: "f-armed-read", status: "armed", steps: [step("read")] }),
    flow({ flowId: "f-draft-write", status: "draft", steps: [step("write")] }),
    flow({ flowId: "f-disabled-send", status: "disabled", steps: [step("send")] })
  ]);
  assert.equal(findings.length, 0);

  const summary = summarizeNeonFlowAuditFindings(findings);
  assert.equal(summary.total, 0);
  assert.match(renderNeonFlowAuditReport(findings, summary), /Neonika Flow Audit: clean/);
});

test("armed-empty fires for an armed flow without steps", () => {
  const findings = listNeonFlowAuditFindings([
    flow({ flowId: "f-empty", status: "armed", steps: [] })
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["armed-empty"]
  );
  assert.equal(findings[0]?.severity, "warn");
});

test("armed-side-effect fires for an armed flow with non-read steps", () => {
  const findings = listNeonFlowAuditFindings([
    flow({
      flowId: "f-act",
      status: "armed",
      steps: [step("read", "s1"), step("write", "s2"), step("exec", "s3")]
    })
  ]);
  const sideEffect = findings.filter((finding) => finding.code === "armed-side-effect");
  assert.equal(sideEffect.length, 1);
  assert.equal(sideEffect[0]?.flowId, "f-act");
  assert.match(sideEffect[0]?.detail ?? "", /2 gated side-effecting/);
});

test("inconsistent-timestamps is an error when updatedAt precedes createdAt", () => {
  const findings = listNeonFlowAuditFindings([
    flow({ flowId: "f-corrupt", status: "draft", steps: [], createdAt: iso(2026, 5, 3), updatedAt: iso(2026, 5, 1) })
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["inconsistent-timestamps"]
  );
  assert.equal(findings[0]?.severity, "error");
});

test("summary counts severities and errors sort before warnings", () => {
  const findings = listNeonFlowAuditFindings([
    flow({ flowId: "f-corrupt", status: "draft", steps: [], createdAt: iso(2026, 5, 3), updatedAt: iso(2026, 5, 1) }),
    flow({ flowId: "f-empty", status: "armed", steps: [] })
  ]);
  const summary = summarizeNeonFlowAuditFindings(findings);
  assert.equal(summary.total, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.warnings, 1);
  assert.equal(summary.byCode["armed-empty"], 1);
  assert.equal(findings[0]?.severity, "error");

  assert.match(renderNeonFlowAuditReport(findings, summary), /2 finding\(s\)/);
});
