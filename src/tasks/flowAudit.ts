import { type INeonFlowDefinition } from "./flowModel.js";

/**
 * Read-only flow audit findings (P-Tasks diagnostics): pure detectors over the
 * projected flow definitions (`readNeonFlows` output). Sibling of taskAudit.ts
 * and the Neon-native half of upstream `src/tasks/task-flow-registry.audit.ts`
 * (listTaskFlowAuditFindings).
 *
 * Upstream audits *runtime* flows (lost/stale/retained executions). Neon flows
 * are *declarative* playbooks (trigger + ordered steps, status draft/armed/
 * disabled) — there is no live flow execution in the shadow runtime — so the
 * findings are adapted to what a pre-canary operator actually needs to see:
 * corrupt bookkeeping, armed-but-empty playbooks, and armed playbooks that
 * carry gated side-effecting steps. Pure: no I/O, no gate, cannot recurse into
 * the doctor/cutover snapshot chain.
 */

export type TNeonFlowAuditSeverity = "warn" | "error";

export type TNeonFlowAuditCode =
  | "inconsistent-timestamps"
  | "armed-empty"
  | "armed-side-effect";

export interface INeonFlowAuditFinding {
  readonly code: TNeonFlowAuditCode;
  readonly severity: TNeonFlowAuditSeverity;
  readonly flowId: string;
  readonly detail: string;
}

export type TNeonFlowAuditCodeCounts = Readonly<Record<TNeonFlowAuditCode, number>>;

export interface INeonFlowAuditSummary {
  readonly total: number;
  readonly errors: number;
  readonly warnings: number;
  readonly byCode: TNeonFlowAuditCodeCounts;
}

const severityRank: Readonly<Record<TNeonFlowAuditSeverity, number>> = {
  error: 0,
  warn: 1
};

const neonFlowAuditCodes: readonly TNeonFlowAuditCode[] = [
  "inconsistent-timestamps",
  "armed-empty",
  "armed-side-effect"
];

export function listNeonFlowAuditFindings(
  flows: readonly INeonFlowDefinition[]
): readonly INeonFlowAuditFinding[] {
  const findings: INeonFlowAuditFinding[] = [];

  for (const flow of flows) {
    const updatedMs = parseTimestampMs(flow.updatedAt);
    const createdMs = parseTimestampMs(flow.createdAt);

    // Corrupt bookkeeping: a flow cannot be updated before it was created.
    if (updatedMs !== undefined && createdMs !== undefined && updatedMs < createdMs) {
      findings.push({
        code: "inconsistent-timestamps",
        severity: "error",
        flowId: flow.flowId,
        detail: "updatedAt is earlier than createdAt"
      });
    }

    if (flow.status === "armed") {
      if (flow.steps.length === 0) {
        findings.push({
          code: "armed-empty",
          severity: "warn",
          flowId: flow.flowId,
          detail: "armed flow has no steps"
        });
      } else {
        const sideEffectSteps = flow.steps.filter((step) => step.effect !== "read").length;

        if (sideEffectSteps > 0) {
          findings.push({
            code: "armed-side-effect",
            severity: "warn",
            flowId: flow.flowId,
            detail: `armed flow carries ${sideEffectSteps} gated side-effecting step(s) (write/send/exec)`
          });
        }
      }
    }
  }

  findings.sort(compareNeonFlowAuditFindings);

  return findings;
}

export function summarizeNeonFlowAuditFindings(
  findings: readonly INeonFlowAuditFinding[]
): INeonFlowAuditSummary {
  const byCode = createCodeCounts();
  let errors = 0;
  let warnings = 0;

  for (const finding of findings) {
    byCode[finding.code] += 1;

    if (finding.severity === "error") {
      errors += 1;
    } else {
      warnings += 1;
    }
  }

  return {
    total: findings.length,
    errors,
    warnings,
    byCode
  };
}

export function renderNeonFlowAuditReport(
  findings: readonly INeonFlowAuditFinding[],
  summary: INeonFlowAuditSummary
): string {
  const header = [
    `Neonika Flow Audit: ${summary.total === 0 ? "clean" : `${summary.total} finding(s)`}`,
    `Errors: ${summary.errors} · Warnings: ${summary.warnings}`
  ];

  const lines =
    findings.length === 0
      ? ["- none"]
      : findings.map(
          (finding) => `- [${finding.severity}] ${finding.code} ${finding.flowId}: ${finding.detail}`
        );

  return [...header, "Findings:", ...lines].join("\n");
}

function compareNeonFlowAuditFindings(
  left: INeonFlowAuditFinding,
  right: INeonFlowAuditFinding
): number {
  const severityDelta = severityRank[left.severity] - severityRank[right.severity];

  if (severityDelta !== 0) {
    return severityDelta;
  }

  const codeDelta = left.code.localeCompare(right.code);

  if (codeDelta !== 0) {
    return codeDelta;
  }

  return left.flowId.localeCompare(right.flowId);
}

function createCodeCounts(): Record<TNeonFlowAuditCode, number> {
  const counts = {} as Record<TNeonFlowAuditCode, number>;

  for (const code of neonFlowAuditCodes) {
    counts[code] = 0;
  }

  return counts;
}

function parseTimestampMs(value: string): number | undefined {
  const ms = Date.parse(value);

  return Number.isNaN(ms) ? undefined : ms;
}
