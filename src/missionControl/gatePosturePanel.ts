import type { INeonGatedSideEffectPosture } from "../core/gatedSideEffectsPosture.js";

/**
 * Server-rendered Mission-Control panel for the gated side-effect posture
 * (`core/gatedSideEffectsPosture.ts`). Pure over the posture object: it renders
 * one leak-safe row per gate (category, key, armed/shadow tag, static
 * side-effect label) so an operator sees the cutover-safety single-pane in the
 * dashboard, not just via CLI/HTTP. No env read, no snapshot, no secrets —
 * curl/test verifiable without a browser.
 */

function escapeGatePostureHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderNeonMissionControlGatePosturePanel(
  posture: INeonGatedSideEffectPosture
): string {
  const verdict =
    posture.state === "fully-shadowed"
      ? '<span class="tag ok" id="gatePostureState">FULLY SHADOWED</span>'
      : `<span class="tag warn" id="gatePostureState">${posture.totals.armed} ARMED</span>`;

  const rows = posture.gates
    .map((gate) => {
      const tag = gate.armed
        ? '<span class="tag warn">ARMED</span>'
        : '<span class="tag shadow">shadow</span>';
      return `<div class="line">${tag} <strong>${escapeGatePostureHtml(
        gate.key
      )}</strong> <span class="muted">[${escapeGatePostureHtml(
        gate.category
      )}]</span> ${escapeGatePostureHtml(gate.sideEffect)}</div>`;
    })
    .join("\n            ");

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Gated Side-Effects</h2>
            ${verdict}
          </div>
          <div class="panel-body stack" id="gatePosturePanel">
            <div class="line"><strong>gates</strong> <span id="gatePostureTotals">${posture.totals.gates} · armed ${posture.totals.armed} · shadowed ${posture.totals.shadowed}</span></div>
            <div class="line"><a href="/api/neon-gates">/api/neon-gates</a> <span class="muted">read-only JSON</span></div>
            ${rows}
          </div>
        </article>`;
}
