import {
  isNeonOutboundStage,
  readCutoverStageFromEnv,
  readReadyCutoverEnv,
  resolveCutoverStageFromEnv
} from "../core/cutover.js";
import { resolveNeonGatedSideEffectPosture } from "../core/gatedSideEffectsPosture.js";
import { resolveNeonGatewayAllowedOrigins } from "../gateway/webSocketServer.js";

/**
 * Read-only Security-Footgun-Audit für Neonika.
 *
 * Aggregiert NEON-relevante Konfigurations-Footguns über vier Achsen — komplett
 * read-only, kein Side-Effect, kein Secret-Wert im Report:
 *   1. gated-side-effect-posture: jeder im Shadow-Stand GEARMTE Gate ist ein
 *      Footgun (Default soll fully-shadowed sein).
 *   2. gateway-http-mutation-auth: ohne gesetztes Mutation-Token sind HTTP-
 *      Mutationen loopback-only (info).
 *   3. ws-origin-allowlist: ohne Allowlist ist der Browser-CSRF-Origin-Check aus
 *      (info; ok für same-origin/loopback).
 *   4. cutover-stage-vs-approval: stage canary/primary OHNE Approval ist kritisch
 *      (produktive Side-Effects könnten ungenehmigt feuern).
 *
 * Vorlage: upstream `src/security/audit.ts` (`runSecurityAudit`,
 * `collectGatewayConfigFindings`, `collectLoggingFindings`). Bewusst auf die
 * neon-relevanten Achsen reduziert; upstream projects Plugin-Trust-/Docker-Sandbox-/
 * Multi-User-Kollektoren sind Neon-Nicht-Ziele (Plugins sind reference-only,
 * kein Docker-Sandbox-Ziel) — siehe Hinweis in der Gap-MD.
 */
export type TNeonSecurityFindingSeverity = "info" | "warn" | "critical";
export type TNeonSecurityAuditExitCode = 0 | 1 | 2;

export interface INeonSecurityFinding {
  readonly axis: string;
  readonly severity: TNeonSecurityFindingSeverity;
  readonly detail: string;
}

export interface INeonSecurityAuditReport {
  readonly findings: readonly INeonSecurityFinding[];
  readonly exitCode: TNeonSecurityAuditExitCode;
}

// Gate-Kategorien, deren Arming einen echten Live-Side-Effect freischaltet.
const criticalArmedGateCategories: ReadonlySet<string> = new Set([
  "outbound",
  "mutation",
  "secret",
  "execution"
]);

export function runNeonSecurityAudit(
  env: NodeJS.ProcessEnv = process.env
): INeonSecurityAuditReport {
  const findings: INeonSecurityFinding[] = [];

  // Axis 1: gated side-effect posture — anything armed in shadow is a footgun.
  const posture = resolveNeonGatedSideEffectPosture(env);
  for (const gate of posture.gates) {
    if (!gate.armed) {
      continue;
    }
    findings.push({
      axis: `gate:${gate.key}`,
      severity: criticalArmedGateCategories.has(gate.category) ? "critical" : "warn",
      detail: `gated ${gate.category} side-effect armed (${gate.envKey}): ${gate.sideEffect}`
    });
  }

  // Axis 2: gateway HTTP mutation auth.
  if ((env["NEON_GATEWAY_HTTP_MUTATION_TOKEN"] ?? "").trim() === "") {
    findings.push({
      axis: "gateway-http-mutation-auth",
      severity: "info",
      detail:
        "no NEON_GATEWAY_HTTP_MUTATION_TOKEN set; HTTP mutations are loopback-only (non-loopback returns 401)"
    });
  }

  // Axis 3: WS origin allowlist (browser-CSRF boundary).
  if (resolveNeonGatewayAllowedOrigins(env).length === 0) {
    findings.push({
      axis: "ws-origin-allowlist",
      severity: "info",
      detail:
        "no NEON_GATEWAY_ALLOWED_ORIGINS set; browser-CSRF origin enforcement is off (fine for same-origin/loopback)"
    });
  }

  // Axis 4: deliberate outbound posture vs approval.
  //
  // The finding reports an inconsistent intent: an operator reaching for outbound
  // without granting approval. Since `primary` became the default stage, sitting on
  // an outbound stage is no longer evidence of that intent by itself — it would flag
  // every fresh, silent install as critical.
  //
  // Intent is therefore read from two signals, either of which is a deliberate act:
  // naming a stage explicitly (nothing defaults to `canary`), or arming outbound.
  const stage = resolveCutoverStageFromEnv(env);
  const stageWasStated = readCutoverStageFromEnv(env) !== undefined;
  const outboundArmed = readReadyCutoverEnv(env, "NEON_CUTOVER_OUTBOUND_ENABLED");
  if (isNeonOutboundStage(stage) && (stageWasStated || outboundArmed)) {
    if (!readReadyCutoverEnv(env, "NEON_CUTOVER_CANARY_APPROVED")) {
      const posture = outboundArmed
        ? `outbound is armed at stage ${stage}`
        : `cutover stage is set to ${stage}`;
      findings.push({
        axis: "cutover-stage",
        severity: "critical",
        detail: `${posture} without NEON_CUTOVER_CANARY_APPROVED — productive side-effects could fire unapproved`
      });
    }
  }

  return { findings, exitCode: resolveNeonSecurityAuditExitCode(findings) };
}

/**
 * Exit-Code: 2 wenn ein kritisches Finding existiert, 1 bei Warnungen, sonst 0.
 * Info-Findings allein lassen den Exit-Code clean — sie sind Hinweise, keine
 * Footguns.
 */
export function resolveNeonSecurityAuditExitCode(
  findings: readonly INeonSecurityFinding[]
): TNeonSecurityAuditExitCode {
  if (findings.some((finding) => finding.severity === "critical")) {
    return 2;
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return 1;
  }
  return 0;
}

export function renderNeonSecurityAuditReport(report: INeonSecurityAuditReport): string {
  const lines: string[] = [];
  const critical = report.findings.filter((finding) => finding.severity === "critical").length;
  const warn = report.findings.filter((finding) => finding.severity === "warn").length;
  const info = report.findings.filter((finding) => finding.severity === "info").length;

  lines.push(`Neonika Security Audit: exit ${report.exitCode}`);
  lines.push(`Findings: ${critical} critical, ${warn} warn, ${info} info`);

  if (report.findings.length > 0) {
    for (const finding of report.findings) {
      lines.push(`  [${finding.severity}] ${finding.axis}: ${finding.detail}`);
    }
  }

  return lines.join("\n");
}
