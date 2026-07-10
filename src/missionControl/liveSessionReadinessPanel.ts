import type { INeonLiveSessionReadinessSnapshot } from "../gateway/liveSessionReadiness.js";

/**
 * Server-rendered Mission-Control panel for live-session runtime readiness
 * (`gateway/liveSessionReadiness.ts`). Pure over the snapshot: one line per
 * capability (state + missing runtime piece) plus the deduped missing-pieces
 * list, so an operator sees exactly what is needed before resume/branch/delete/
 * checkpoints become real.
 *
 * When the snapshot carries a real in-flight runtime (active `runningRunIds`
 * fed from the run-control registry), the panel also renders per-run Stop/Abort
 * controls that POST against the existing `/api/neon-runs/control` endpoint. The
 * controls are fail-closed: the buttons only appear for runs the registry
 * actually reports, the client shows accepted/error and never assumes success.
 * No env read, no secrets, no token, no outbound — the panel surfaces the real
 * `liveRuntimeReady` truth and an interrupt affordance, it does not arm anything.
 */

function escapeLiveSessionHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stateTag(state: string): string {
  if (state === "interrupt-ready") {
    return '<span class="tag warn">interrupt-ready*</span>';
  }
  if (state === "plan-only") {
    return '<span class="tag shadow">plan-only</span>';
  }
  return '<span class="tag shadow">not-modeled</span>';
}

function renderRunControlRow(runId: string): string {
  const safeRunId = escapeLiveSessionHtml(runId);
  return `<div class="line" data-run-control-row="${safeRunId}"><code>${safeRunId}</code> <button type="button" class="button run-control-stop" data-run-control-action="stop" data-run-control-run-id="${safeRunId}">Stop</button> <button type="button" class="button run-control-abort" data-run-control-action="abort" data-run-control-run-id="${safeRunId}">Abort</button></div>`;
}

function renderRunControls(snapshot: INeonLiveSessionReadinessSnapshot): string {
  const runIds = snapshot.runtime.runningRunIds;

  if (runIds.length === 0) {
    return `<div class="line muted" id="runControlEmpty">keine aktiven Runs — Stop/Abort erscheinen, sobald ein Live-Run läuft</div>`;
  }

  return runIds.map(renderRunControlRow).join("\n            ");
}

export function renderNeonMissionControlLiveSessionReadinessPanel(
  snapshot: INeonLiveSessionReadinessSnapshot
): string {
  const verdict = snapshot.liveRuntimeReady
    ? '<span class="tag warn" id="liveSessionReadyState">LIVE-RUNTIME READY</span>'
    : '<span class="tag shadow" id="liveSessionReadyState">LIVE-RUNTIME NOT READY</span>';

  const capabilityRows = snapshot.capabilities
    .map(
      (cap) =>
        `<div class="line">${stateTag(cap.state)} <strong>${escapeLiveSessionHtml(
          cap.capability
        )}</strong> <span class="muted">${escapeLiveSessionHtml(cap.missingRuntimePiece)}</span></div>`
    )
    .join("\n            ");

  const missingRows = snapshot.missingRuntimePieces
    .map((piece) => `<div class="line muted">fehlt: ${escapeLiveSessionHtml(piece)}</div>`)
    .join("\n            ");

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Live-Session Readiness</h2>
            ${verdict}
          </div>
          <div class="panel-body stack" id="liveSessionReadinessPanel">
            <div class="line"><strong>runtime</strong> <span id="liveSessionRuntimeState">active-runs ${snapshot.runtime.activeRuns} · busy ${snapshot.runtime.busy ? "yes" : "no"} · live-runtime-ready ${snapshot.liveRuntimeReady ? "true" : "false"}</span></div>
            <div class="line"><strong>controls</strong> <span class="muted">POST /api/neon-runs/control · fail-closed</span></div>
            ${renderRunControls(snapshot)}
            <div class="line muted" id="runControlStatus" aria-live="polite" data-run-control-status>bereit</div>
            <div class="line"><strong>states</strong> <span id="liveSessionReadinessTotals">env-gate ${snapshot.envGateEnabled ? "enabled" : "disabled"} · interrupt-ready ${snapshot.totals.interruptReady} · plan-only ${snapshot.totals.planOnly} · not-modeled ${snapshot.totals.notModeled}</span></div>
            <div class="line"><a href="/api/neon-live-session-readiness">/api/neon-live-session-readiness</a> <span class="muted">read-only JSON</span></div>
            <div class="line muted">* interrupt-ready is hypothetical: it needs a real live in-flight run; none exists yet.</div>
            ${capabilityRows}
            ${missingRows}
          </div>
        </article>`;
}
