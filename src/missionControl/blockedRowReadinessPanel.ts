import type {
  INeonBlockedRowReadinessSnapshot,
  INeonBlockedRowReadinessStatus
} from "./blockedRowReadiness.js";

/**
 * Server-rendered Mission-Control panel for the blocked-row readiness snapshot
 * (`missionControl/blockedRowReadiness.ts`). Pure over the snapshot: it renders
 * one decision card per blocked capability row (why blocked, live effect,
 * rollback, verify command, missing env, operator-approval flag) so an operator can
 * read every "what would it take to go live" decision in the dashboard. No env
 * read here, no secrets — curl/test verifiable without a browser. The live env
 * state is already resolved into the snapshot upstream.
 */

function escapeBlockedReadinessHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function approvalTag(row: INeonBlockedRowReadinessStatus): string {
  if (row.operatorApprovalNeeded) {
    return '<span class="tag warn">OPERATOR-FREIGABE</span>';
  }
  if (row.category === "non-goal") {
    return '<span class="tag shadow">NON-GOAL</span>';
  }
  if (row.category === "upstream-protocol") {
    return '<span class="tag shadow">UPSTREAM</span>';
  }
  return '<span class="tag shadow">LIVE-RUNTIME</span>';
}

function envLine(row: INeonBlockedRowReadinessStatus): string {
  if (row.requiredEnv.length === 0) {
    return '<div class="line muted">env: kein Env-Gate (Architektur/Protokoll/Non-Goal)</div>';
  }
  if (row.requiredEnvSatisfied) {
    return '<div class="line"><span class="tag ok">env gesetzt</span> alle Required-Env vorhanden</div>';
  }
  return `<div class="line"><span class="tag shadow">env fehlt</span> ${escapeBlockedReadinessHtml(
    row.missingEnv.join(", ")
  )}</div>`;
}

function renderRow(row: INeonBlockedRowReadinessStatus): string {
  return `<div class="line"><strong>${escapeBlockedReadinessHtml(
    row.title
  )}</strong> <span class="muted">[${escapeBlockedReadinessHtml(
    row.area
  )} · ${escapeBlockedReadinessHtml(row.category)}]</span> ${approvalTag(row)}</div>
            <div class="line muted">warum: ${escapeBlockedReadinessHtml(row.whyBlocked)}</div>
            <div class="line muted">live-effekt: ${escapeBlockedReadinessHtml(row.liveEffect)}</div>
            <div class="line muted">rollback: ${escapeBlockedReadinessHtml(row.rollback)}</div>
            ${envLine(row)}
            <div class="line"><code>${escapeBlockedReadinessHtml(row.verifyCommand)}</code></div>`;
}

export function renderNeonMissionControlBlockedReadinessPanel(
  snapshot: INeonBlockedRowReadinessSnapshot
): string {
  const totals = snapshot.totals;
  const verdict = `<span class="tag warn" id="blockedReadinessState">${totals.operatorApprovalNeeded} OPERATOR-FREIGABE</span>`;
  const rows = snapshot.rows.map(renderRow).join("\n            ");

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Blocked-Row Readiness</h2>
            ${verdict}
          </div>
          <div class="panel-body stack" id="blockedReadinessPanel">
            <div class="line"><strong>rows</strong> <span id="blockedReadinessTotals">${totals.total} · operator ${totals.operatorApprovalNeeded} · live-session ${totals.liveSessionRuntime} · upstream ${totals.upstreamProtocol} · non-goal ${totals.nonGoal}</span></div>
            <div class="line"><a href="/api/neon-blocked-readiness">/api/neon-blocked-readiness</a> <span class="muted">read-only JSON</span></div>
            ${rows}
          </div>
        </article>`;
}
