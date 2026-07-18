import type { INeonToolInventorySnapshot } from "../tools/neonTools.js";

// Mission Control — server-rendered Neonika Tools panel.
//
// Self-contained (own HTML escaper, no dependency on the large, concurrently
// edited gatewayHtml internals) so it can be injected with a single line and
// unit-tested via HTML-string assertions without a browser. Leak-safe by
// construction: the tool inventory snapshot carries no secret values (only ref
// COUNTS, family names, gate state, and tool decisions), and every dynamic
// field is HTML-escaped before it reaches an attribute or text node.

function escapeToolsPanelHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderFamilyRows(snapshot: INeonToolInventorySnapshot): string {
  return snapshot.families
    .map(
      (family) =>
        `<div class="route-step" data-tool-family="${escapeToolsPanelHtml(
          family.family
        )}"><div class="route-copy"><strong>${escapeToolsPanelHtml(
          family.family
        )}</strong><span>${family.available}/${family.total} available</span></div></div>`
    )
    .join("");
}

function renderProviderRows(snapshot: INeonToolInventorySnapshot): string {
  return snapshot.providers
    .map((provider) => {
      const refs =
        provider.refsTotal > 0 ? ` / refs ${provider.refsPresent}/${provider.refsTotal}` : "";
      return `<div class="route-step" data-tool-provider="${escapeToolsPanelHtml(
        provider.id
      )}"><div class="route-copy"><strong>${escapeToolsPanelHtml(
        provider.id
      )}</strong><span>${escapeToolsPanelHtml(provider.readiness)}${escapeToolsPanelHtml(
        refs
      )}</span></div></div>`;
    })
    .join("");
}

/**
 * Render the read-only Neonika Tools overview panel. Shows the live-gate posture,
 * per-family availability, and provider readiness — never a secret value. The
 * panel root carries a stable `id="toolsPanel"` that the client hydration never
 * touches, so it is curl-verifiable on the served path.
 */
export function renderNeonMissionControlToolsPanel(snapshot: INeonToolInventorySnapshot): string {
  const gateTag = snapshot.gate.enabled ? "ARMED" : "closed";
  const liveModeTools = snapshot.tools.filter((tool) => tool.mode === "live").length;

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Tools</h2>
            <span class="tag shadow" id="toolsGate">gate ${escapeToolsPanelHtml(gateTag)}</span>
          </div>
          <div class="panel-body stack" id="toolsPanel">
            <div class="line"><strong>available</strong> <span id="toolsAvailable">${snapshot.totals.available}/${snapshot.totals.tools}</span></div>
            <div class="line"><strong>providers ready</strong> <span id="toolsProvidersReady">${snapshot.totals.providersReady}/${snapshot.totals.providers}</span></div>
            <div class="line"><strong>live-mode tools</strong> <span id="toolsLiveMode">${liveModeTools}</span></div>
            ${renderFamilyRows(snapshot)}
            ${renderProviderRows(snapshot)}
          </div>
        </article>`;
}
