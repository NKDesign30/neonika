import {
  listNeonChannelManifests,
  summarizeNeonChannelManifests
} from "../channels/channelManifest.js";
import type { INeonCanaryLivePreconditions } from "../gateway/outboundSender.js";
import type { INeonGatewayRunSummary } from "../gateway/runStore.js";
import { createNeonToolInventorySnapshot } from "../tools/neonTools.js";
import { resolveNeonGatedSideEffectPosture } from "../core/gatedSideEffectsPosture.js";
import type {
  INeonMissionControlGatewayEvent,
  INeonMissionControlGatewaySnapshot
} from "./gatewaySnapshot.js";
import { renderNeonMissionControlGatePosturePanel } from "./gatePosturePanel.js";
import { createNeonBlockedRowReadinessSnapshot } from "./blockedRowReadiness.js";
import { renderNeonMissionControlBlockedReadinessPanel } from "./blockedRowReadinessPanel.js";
import {
  createNeonLiveSessionReadinessSnapshot,
  type INeonLiveSessionReadinessSnapshot
} from "../gateway/liveSessionReadiness.js";
import { renderNeonMissionControlLiveSessionReadinessPanel } from "./liveSessionReadinessPanel.js";
import { renderNeonMissionControlToolsPanel } from "./toolsPanel.js";
import { renderNeonMissionControlWorkboardPanel } from "./workboardPanel.js";
import type { INeonWorkboardSnapshot } from "../tasks/workboardSnapshot.js";
import {
  renderNeonMissionControlCronDaemonStatusPanel,
  type INeonCronDaemonStatusSnapshot
} from "./cronDaemonStatusPanel.js";
import {
  renderNeonMissionControlHeartbeatDaemonStatusPanel,
  type INeonHeartbeatDaemonStatusSnapshot
} from "./heartbeatDaemonStatusPanel.js";

export const neonMissionControlViewNames = [
  "chat",
  "sites",
  "overview",
  "activity",
  "workboard",
  "instances",
  "sessions",
  "usage",
  "cron",
  "agents",
  "skills",
  "nodes",
  "dreams",
  "indexer",
  "transcript",
  "config",
  "channels",
  "logs"
] as const;

export type TNeonMissionControlView = (typeof neonMissionControlViewNames)[number];

export interface INeonMissionControlHtmlOptions {
  readonly initialView?: TNeonMissionControlView;
  /** Live Neon Workboard snapshot for the server-rendered workboard view. Omit to render the empty/loading state. */
  readonly workboard?: INeonWorkboardSnapshot;
  /** Live cron daemon status (gate/cursor/jobs) for the server-rendered cron view. Omit to render the empty/not-loaded state. */
  readonly cronDaemon?: INeonCronDaemonStatusSnapshot;
  /** Live heartbeat daemon status (gate/cursor/agents) for the server-rendered cron view. Omit to render the empty/not-loaded state. */
  readonly heartbeatDaemon?: INeonHeartbeatDaemonStatusSnapshot;
  /**
   * Live-session readiness snapshot built from the real run-control registry so
   * the server-rendered panel can surface active `runningRunIds` plus Stop/Abort
   * controls. Omit to fall back to the architectural (no-runtime) snapshot.
   */
  readonly liveSessionReadiness?: INeonLiveSessionReadinessSnapshot;
}

const neonMissionControlViewSet = new Set<string>(neonMissionControlViewNames);

const legacyMissionControlViewAliases: Readonly<Record<string, TNeonMissionControlView>> = {
  cutover: "usage",
  doctor: "cron",
  gateway: "overview",
  memory: "workboard",
  mirror: "instances",
  onboarding: "skills",
  routes: "activity",
  runs: "sessions"
};

export function normalizeNeonMissionControlView(value: string | undefined): TNeonMissionControlView | undefined {
  const normalized = normalizeRouteSegment(value);

  if (!normalized) {
    return undefined;
  }

  if (neonMissionControlViewSet.has(normalized)) {
    return normalized as TNeonMissionControlView;
  }

  return legacyMissionControlViewAliases[normalized];
}

export function resolveNeonMissionControlViewFromPathname(
  pathname: string
): TNeonMissionControlView | undefined {
  const normalizedPath = pathname.replace(/\/+$/u, "") || "/mission-control";

  if (normalizedPath === "/mission-control" || normalizedPath === "/mission-control/gateway") {
    return "chat";
  }

  if (!normalizedPath.startsWith("/mission-control/")) {
    return undefined;
  }

  return normalizeNeonMissionControlView(normalizedPath.slice("/mission-control/".length));
}

export function isNeonMissionControlPath(pathname: string): boolean {
  return resolveNeonMissionControlViewFromPathname(pathname) !== undefined;
}

function escapeMissionControlHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A distinct event-kind facet derived from the live snapshot projection: the
 * `kind` value plus how many of the rendered Recent Events carry it. Counts come
 * straight from `snapshot.recentEvents`, so the filter reflects real data, never
 * a fabricated option list.
 */
interface INeonRecentEventsKindFacet {
  readonly kind: INeonMissionControlGatewayEvent["kind"];
  readonly count: number;
}

/**
 * Derive the kind facets present in the live event projection, ordered by first
 * appearance so the filter mirrors the rendered row order. Pure over the snapshot
 * data — no env, no clock, no fabricated entries.
 */
function deriveRecentEventsKindFacets(
  events: readonly INeonMissionControlGatewayEvent[]
): readonly INeonRecentEventsKindFacet[] {
  const counts = new Map<INeonMissionControlGatewayEvent["kind"], number>();

  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }

  return Array.from(counts, ([kind, count]) => ({ kind, count }));
}

/**
 * Server-rendered tool/status filter control for the Recent Events panel. The
 * facet chips and the visible-count summary are built from `events` (the live
 * snapshot projection), HTML-escaped, with each `data-event-kind` chip carrying a
 * `data-event-count` from real data. Because the rows below also tag their
 * `data-event-kind`, this is a genuine filterable DOM surface — but every number
 * rendered here is the actual snapshot count, so it stays honest without a
 * browser and is curl/test verifiable on the served path.
 */
function renderRecentEventsFilter(
  events: readonly INeonMissionControlGatewayEvent[]
): string {
  const facets = deriveRecentEventsKindFacets(events);

  if (facets.length === 0) {
    return "";
  }

  const chips = facets
    .map((facet) => {
      const safeKind = escapeMissionControlHtml(facet.kind);

      return `<button class="tag" type="button" data-event-kind="${safeKind}" data-event-count="${facet.count}" aria-pressed="false">${safeKind} ${facet.count}</button>`;
    })
    .join("");

  return `<div class="recent-events-filterbar" id="recentEventsFilter" aria-label="Recent Events Filter">
            <span class="recent-events-filter-label">Filter</span>
            <div class="recent-events-filter-chips">
              <button class="tag ready" type="button" data-event-kind="" aria-pressed="true">alle ${events.length}</button>
              ${chips}
            </div>
            <span class="recent-events-filter-summary" id="recentEventsVisibleCount">${events.length} / ${events.length} sichtbar</span>
          </div>`;
}

/**
 * Server-rendered Recent Events panel. Reads the live `snapshot.recentEvents`
 * projection (leak-safe `{runId, kind, label}` — no raw output/command/secret).
 * Rendered server-side so the served Mission Control path is verifiable by curl
 * without a browser, and on its own `id` so the client hydration never clears it.
 *
 * The tool/status filter control above the rows is also server-rendered from the
 * same projection: it exposes one facet per distinct event kind (with real
 * counts) and a visible-count summary, and tags every row with `data-event-kind`
 * so it is a real filterable surface rather than a decorative widget.
 */
function renderRecentEventsPanel(
  events: readonly INeonMissionControlGatewayEvent[]
): string {
  const rows =
    events.length === 0
      ? '<div class="muted" id="recentEventsEmpty">no recent events</div>'
      : events
          .map(
            (event) =>
              `<div class="route-step" data-event-kind="${escapeMissionControlHtml(
                event.kind
              )}"><div class="route-copy"><strong>${escapeMissionControlHtml(
                event.label
              )}</strong><span>${escapeMissionControlHtml(event.runId)} / ${escapeMissionControlHtml(
                event.kind
              )}</span></div></div>`
          )
          .join("");

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Recent Events</h2>
            <span class="tag shadow" id="recentEventsCount">${events.length} live</span>
          </div>
          <div class="panel-body stack" id="recentEventsPanel">
            ${renderRecentEventsFilter(events)}
            ${rows}
          </div>
        </article>`;
}

/**
 * Same-origin operator deep-link to a filtered read-only API view. Params are
 * URL-encoded; the path is a fixed relative `/api/...` route (no user-controlled
 * redirect target, so no open-redirect surface). The caller HTML-escapes the
 * result before placing it in an `href` attribute.
 */
function buildMissionControlDeepLink(path: string, params: Record<string, string>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");

  return query ? `${path}?${query}` : path;
}

/**
 * Server-rendered Recent Runs panel with operator deep-links. Each run links to
 * its filtered replay/chat views plus a channel-scoped replay filter, so the
 * operator can pivot from a run into the read-only transcript surfaces without a
 * client round-trip. Run identifiers come from the redacted run summary (no raw
 * secrets); links are URL-encoded then HTML-escaped for attribute safety.
 */
function renderRecentRunsPanel(runs: readonly INeonGatewayRunSummary[]): string {
  const rows =
    runs.length === 0
      ? '<div class="muted" id="recentRunsEmpty">no recent runs</div>'
      : runs
          .map((run) => {
            const replayLink = escapeMissionControlHtml(
              buildMissionControlDeepLink("/api/neon-replay", { runId: run.runId })
            );
            const chatLink = escapeMissionControlHtml(
              buildMissionControlDeepLink("/api/neon-chat", { runId: run.runId })
            );
            const channelLink = escapeMissionControlHtml(
              buildMissionControlDeepLink("/api/neon-replay", { channelId: run.channelId })
            );

            return `<div class="route-step"><div class="route-copy"><strong>${escapeMissionControlHtml(
              run.runId
            )}</strong><span>${escapeMissionControlHtml(run.status)} / ${escapeMissionControlHtml(
              run.channel
            )} / ${escapeMissionControlHtml(
              run.agentId
            )}</span><span class="deeplinks"><a href="${replayLink}">replay</a> <a href="${chatLink}">chat</a> <a href="${channelLink}">channel</a></span></div></div>`;
          })
          .join("");

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Recent Runs</h2>
            <span class="tag shadow" id="recentRunsCount">${runs.length} runs</span>
          </div>
          <div class="panel-body stack" id="recentRunsPanel">
            ${rows}
          </div>
        </article>`;
}

/**
 * Server-rendered Canary Outbound control panel. Shows the live outbound
 * readiness as booleans (token presence only, never the token) plus the single
 * canary channel id. `ready=false` means outbound stays suppressed — the default.
 * Read-only: this surfaces posture, it does not flip any gate.
 */
function renderCanaryPosturePanel(posture: INeonCanaryLivePreconditions): string {
  const flag = (on: boolean): string =>
    `<span class="tag ${on ? "ok" : "shadow"}">${on ? "yes" : "no"}</span>`;
  const verdict = posture.ready
    ? '<span class="tag ok" id="canaryReady">LIVE-READY</span>'
    : '<span class="tag shadow" id="canaryReady">SUPPRESSED (default)</span>';

  return `<article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Canary Outbound</h2>
            ${verdict}
          </div>
          <div class="panel-body stack" id="canaryPosturePanel">
            <div class="line"><strong>token present</strong> ${flag(posture.tokenPresent)}</div>
            <div class="line"><strong>stage = canary</strong> ${flag(posture.stageIsCanary)}</div>
            <div class="line"><strong>canary approved</strong> ${flag(posture.canaryApproved)}</div>
            <div class="line"><strong>outbound enabled</strong> ${flag(posture.outboundEnabled)}</div>
            <div class="line"><strong>single channel</strong> ${flag(posture.singleChannel)}</div>
            <div class="line"><strong>channel</strong> <span id="canaryChannel">${escapeMissionControlHtml(
              posture.channelId ?? "none"
            )}</span></div>
          </div>
        </article>`;
}

/**
 * Server-rendered Channels panel. Reads the static channel manifest catalog
 * (`channels/channelManifest.ts`) — Discord live, every other platform a gated
 * inventory entry — and renders one leak-safe row per channel. Pure over the
 * catalog: no env, no snapshot data, no secrets. Delivery is shown as suppressed
 * for every channel by the shadow contract, so this is curl/test verifiable
 * without a browser and never implies a live send path that does not exist.
 */
function renderNeonMissionControlChannelsPanel(): string {
  const manifests = listNeonChannelManifests();
  const totals = summarizeNeonChannelManifests(manifests);
  const rows = manifests
    .map((manifest) => {
      const liveTag =
        manifest.liveStatus === "live"
          ? '<span class="tag ok">live</span>'
          : '<span class="tag shadow">gated</span>';

      return `<div class="route-step" data-channel="${escapeMissionControlHtml(
        manifest.id
      )}"><div class="route-copy"><strong>${escapeMissionControlHtml(
        manifest.id
      )}</strong><span>${escapeMissionControlHtml(manifest.label)} / ${escapeMissionControlHtml(
        manifest.transport
      )} / ${escapeMissionControlHtml(
        manifest.loginPolicy
      )}</span><span class="deeplinks">${liveTag} <span class="tag shadow">suppressed</span></span></div></div>`;
    })
    .join("");

  return `<article class="panel" id="channelsPanel">
          <div class="panel-header">
            <h2 class="panel-title">Channels</h2>
            <span class="tag shadow" id="channelsCount">${totals.live} live / ${totals.gated} gated</span>
          </div>
          <div class="panel-body stack" id="channelsPanelBody">
            ${rows}
          </div>
        </article>`;
}

export function renderNeonMissionControlGatewayHtml(
  snapshot: INeonMissionControlGatewaySnapshot,
  options: INeonMissionControlHtmlOptions = {}
): string {
  const safeSnapshot = serializeSnapshotForScript(snapshot);
  const initialView = options.initialView ?? "chat";
  const safeInitialView = JSON.stringify(initialView);
  const viewHidden = (view: TNeonMissionControlView): string => (view === initialView ? "" : " hidden");

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Neon Mission Control</title>
  <style>
    :root {
      color-scheme: dark;
      --surface-background: #1A1A18;
      --surface-rail: rgba(18, 20, 18, 0.94);
      --surface-panel: rgba(28, 30, 27, 0.96);
      --surface-elevated: rgba(36, 39, 34, 0.96);
      --surface-muted: rgba(255, 255, 255, 0.048);
      --surface-input: rgba(10, 11, 10, 0.44);
      --stroke-hairline: rgba(255, 255, 255, 0.11);
      --stroke-strong: rgba(46, 171, 115, 0.52);
      --text-primary: rgba(255, 255, 255, 0.94);
      --text-secondary: rgba(255, 255, 255, 0.66);
      --text-tertiary: rgba(255, 255, 255, 0.43);
      --brand-primary: #2EAB73;
      --brand-bright: #42C987;
      --accent-amber: #FFB340;
      --accent-red: #D95C53;
      --accent-blue: #7C8AFF;
      --sidebar-width: 260px;
      --radius-sm: 4px;
      --radius-md: 6px;
      --radius-lg: 10px;
      --radius-card: 14px;
      --button-height: 32px;
      --button-padding-x: 14px;
      --shadow-soft: 0 18px 48px rgba(0, 0, 0, 0.34);
      --font-display: "DM Serif Display", Georgia, serif;
      --font-body: "Space Grotesk", Inter, ui-sans-serif, system-ui, sans-serif;
      --font-mono: "Geist Mono", "SFMono-Regular", ui-monospace, monospace;
      font-family: var(--font-body);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(255, 255, 255, 0.025) 1px, transparent 1px),
        linear-gradient(0deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px),
        var(--surface-background);
      background-size: 56px 56px, 56px 56px, auto;
      color: var(--text-primary);
      letter-spacing: 0;
    }

    a { color: inherit; text-decoration: none; }
    button, input, code { font: inherit; }
    h1, h2, h3, p { margin: 0; }

    .app-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
      overflow: hidden;
    }

    .sidebar {
      height: 100vh;
      min-height: 100vh;
      border-right: 1px solid var(--stroke-hairline);
      background: var(--surface-rail);
      padding: 14px 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      position: sticky;
      top: 0;
      overflow: hidden;
    }

    .brand {
      min-height: 48px;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 8px 10px;
    }

    .mark {
      width: 34px;
      height: 34px;
      border-radius: var(--radius-md);
      border: 1px solid var(--stroke-strong);
      display: grid;
      place-items: center;
      background: rgba(46, 171, 115, 0.09);
      box-shadow: var(--shadow-soft);
      flex: 0 0 auto;
    }

    .mark svg { width: 23px; height: 23px; }

    .eyebrow {
      margin-bottom: 5px;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      line-height: 1.1;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .brand h1 {
      font-size: 16px;
      line-height: 1.05;
      font-weight: 800;
      letter-spacing: 0;
    }

    .nav {
      min-height: 0;
      flex: 1;
      overflow-y: auto;
      display: grid;
      gap: 16px;
      scrollbar-width: none;
    }

    .nav::-webkit-scrollbar {
      display: none;
    }

    .sidebar-sessions {
      display: grid;
      gap: 10px;
      padding: 0 8px;
    }

    .sidebar-new-session {
      min-height: 38px;
      border: 1px solid rgba(46, 171, 115, 0.34);
      border-radius: var(--radius-md);
      background: rgba(46, 171, 115, 0.12);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }

    .recent-list {
      display: grid;
      gap: 4px;
    }

    .recent-label,
    .nav-section-label {
      padding: 0 10px;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .recent-session {
      min-height: 40px;
      display: grid;
      grid-template-columns: 8px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      padding: 7px 9px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 13px;
      overflow: hidden;
    }

    .recent-session.active {
      color: var(--text-primary);
      background: rgba(46, 171, 115, 0.1);
      border-color: rgba(46, 171, 115, 0.3);
    }

    .recent-dot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--text-tertiary);
    }

    .recent-session.active .recent-dot {
      background: var(--brand-primary);
      box-shadow: 0 0 0 4px rgba(46, 171, 115, 0.12);
    }

    .recent-copy {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .recent-name,
    .recent-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .recent-name {
      font-weight: 700;
    }

    .recent-meta {
      color: var(--text-tertiary);
      font-size: 11px;
    }

    .nav-section {
      display: grid;
      gap: 5px;
    }

    .nav a {
      min-height: 40px;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 10px;
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 700;
      border: 1px solid transparent;
      cursor: pointer;
    }

    .nav-icon {
      width: 16px;
      display: inline-grid;
      place-items: center;
      color: var(--text-tertiary);
    }

    .nav-count {
      margin-left: auto;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
    }

    .nav a[aria-current="page"] {
      color: var(--text-primary);
      background: rgba(46, 171, 115, 0.11);
      border-color: rgba(46, 171, 115, 0.3);
    }

    .panel,
    .side-panel {
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-card);
      background: var(--surface-panel);
      box-shadow: var(--shadow-soft);
    }

    .side-panel {
      padding: 12px;
      display: grid;
      gap: 10px;
    }

    .sidebar-footer {
      flex-shrink: 0;
      padding-top: 12px;
      border-top: 1px solid var(--stroke-hairline);
      display: grid;
      gap: 8px;
    }

    .sidebar-link,
    .sidebar-version {
      min-height: 40px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-muted);
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 11px;
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 700;
    }

    .sidebar-version {
      justify-content: space-between;
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
    }

    .connection-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
    }

    .label {
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
      font-size: 12px;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: var(--brand-bright);
      font-family: var(--font-mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--brand-primary);
      box-shadow: 0 0 18px rgba(46, 171, 115, 0.72);
    }

    .workspace {
      height: 100vh;
      width: 100%;
      max-width: none;
      padding: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      align-content: stretch;
      overflow: hidden;
    }

    .view {
      min-height: 0;
      overflow: auto;
      padding: 18px 28px 22px;
      display: grid;
      gap: 14px;
      align-content: start;
    }

    .view[hidden] {
      display: none !important;
    }

    .view.narrow {
      grid-template-columns: minmax(0, 960px);
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: center;
      border-bottom: 1px solid var(--stroke-hairline);
      padding: 18px 28px 14px;
      background: rgba(18, 20, 18, 0.78);
      backdrop-filter: blur(16px);
    }

    .crumbbar {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-tertiary);
      font-size: 13px;
    }

    .crumbbar strong {
      color: var(--brand-bright);
      font-weight: 700;
    }

    .top-tools {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .search {
      width: min(220px, 26vw);
      min-height: var(--button-height);
      border: 1px solid var(--stroke-hairline);
      border-radius: 999px;
      background: var(--surface-input);
      color: var(--text-primary);
      padding: 0 14px;
    }

    .control-row {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(280px, 0.95fr) minmax(180px, 0.5fr) minmax(180px, 0.5fr) auto;
      gap: 8px;
      align-items: center;
    }

    .select-like,
    .usage-pill,
    .round-button {
      min-height: var(--button-height);
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-elevated);
      color: var(--text-secondary);
      padding: 0 var(--button-padding-x);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .usage-pill,
    .round-button {
      justify-content: center;
    }

    .round-button {
      width: var(--button-height);
      padding: 0;
      color: var(--brand-bright);
      border-color: rgba(46, 171, 115, 0.35);
      border-radius: 999px;
    }

    .api-strip {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .title-stack {
      display: grid;
      gap: 7px;
    }

    .title-line {
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
    }

    .title-line h2 {
      min-width: 0;
      color: var(--text-primary);
      font-size: 32px;
      line-height: 1;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .title-line strong {
      color: var(--brand-primary);
      font-family: var(--font-display);
      font-size: 36px;
      line-height: 0.9;
      font-weight: 400;
    }

    .subtitle {
      color: var(--text-secondary);
      font-size: 13px;
    }

    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .button {
      min-height: var(--button-height);
      border-radius: var(--radius-md);
      border: 1px solid var(--stroke-hairline);
      color: var(--text-primary);
      background: var(--surface-muted);
      padding: 0 var(--button-padding-x);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
    }

    .button.primary {
      border-color: var(--stroke-strong);
      background: rgba(46, 171, 115, 0.15);
      color: var(--brand-bright);
    }

    .button.replay-inline {
      min-height: 26px;
      padding: 0 9px;
      border-color: rgba(46, 171, 115, 0.35);
      background: rgba(46, 171, 115, 0.08);
      color: var(--brand-bright);
      font-size: 11px;
    }

    .button.run-control-stop,
    .button.run-control-abort {
      min-height: 24px;
      padding: 0 9px;
      margin-left: 6px;
      font-size: 11px;
    }

    .button.run-control-stop {
      border-color: rgba(255, 179, 64, 0.42);
      background: rgba(255, 179, 64, 0.1);
      color: var(--accent-amber);
    }

    .button.run-control-abort {
      border-color: rgba(217, 92, 83, 0.46);
      background: rgba(217, 92, 83, 0.12);
      color: var(--accent-red);
    }

    .button[disabled] {
      opacity: 0.55;
      cursor: progress;
    }

    .overview-grid {
      display: grid;
      grid-template-columns: minmax(360px, 1.1fr) minmax(360px, 0.9fr);
      gap: 14px;
      align-items: stretch;
    }

    .panel-header {
      min-height: 50px;
      padding: 13px 14px;
      border-bottom: 1px solid var(--stroke-hairline);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .panel-title {
      font-size: 13px;
      font-weight: 700;
    }

    .panel-body {
      padding: 14px;
    }

    .field-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .field {
      display: grid;
      gap: 7px;
      min-width: 0;
    }

    .field.full {
      grid-column: 1 / -1;
    }

    .field span {
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .input-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .input-row input,
    .input-like {
      width: 100%;
      min-width: 0;
      min-height: 38px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-input);
      color: var(--text-primary);
      padding: 0 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .input-row input[readonly] {
      color: var(--text-secondary);
    }

    .icon-button {
      width: 38px;
      min-width: 38px;
      min-height: 38px;
      border-radius: var(--radius-md);
      border: 1px solid var(--stroke-hairline);
      background: var(--surface-muted);
      color: var(--text-secondary);
      display: grid;
      place-items: center;
      cursor: pointer;
    }

    .icon-button svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
    }

    .access-actions {
      margin-top: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .muted {
      color: var(--text-tertiary);
      font-size: 12px;
    }

    .snapshot-grid,
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }

    .stat,
    .metric {
      min-height: 92px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-muted);
      padding: 12px;
      display: grid;
      align-content: space-between;
      gap: 10px;
    }

    .stat strong,
    .metric strong {
      color: var(--brand-primary);
      font-family: var(--font-display);
      font-size: 38px;
      line-height: 0.9;
      font-weight: 400;
    }

    .stat .stat-value {
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .callout {
      margin-top: 12px;
      border: 1px solid rgba(46, 171, 115, 0.22);
      border-radius: var(--radius-md);
      background: rgba(46, 171, 115, 0.075);
      padding: 11px;
      color: var(--text-secondary);
      font-size: 12px;
      line-height: 1.45;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(520px, 1.55fr);
      gap: 14px;
      align-items: start;
    }

    .stack {
      display: grid;
      gap: 12px;
    }

    .route-step {
      min-height: 58px;
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr);
      gap: 12px;
      align-items: center;
    }

    .node {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: rgba(46, 171, 115, 0.09);
      border: 1px solid rgba(46, 171, 115, 0.28);
      color: var(--brand-bright);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .route-copy strong {
      display: block;
      margin-bottom: 3px;
      font-size: 14px;
    }

    .route-copy span {
      display: block;
      color: var(--text-secondary);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .connector {
      width: 1px;
      height: 16px;
      margin-left: 15px;
      background: var(--stroke-hairline);
    }

    .terminal {
      min-height: 152px;
      border-radius: var(--radius-md);
      border: 1px solid rgba(46, 171, 115, 0.2);
      background: rgba(0, 0, 0, 0.22);
      padding: 12px;
      display: grid;
      align-content: start;
      gap: 8px;
    }

    .line {
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .line strong {
      color: var(--brand-bright);
      font-weight: 500;
    }

    .runs {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .runs th,
    .runs td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.075);
      text-align: left;
      vertical-align: middle;
      font-size: 13px;
    }

    .runs th {
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .mono {
      font-family: var(--font-mono);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tag {
      display: inline-flex;
      min-height: 23px;
      align-items: center;
      padding: 0 8px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--stroke-hairline);
      background: var(--surface-muted);
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      white-space: nowrap;
    }

    .tag.completed,
    .tag.attached,
    .tag.pass,
    .tag.ready {
      color: var(--brand-bright);
      border-color: rgba(46, 171, 115, 0.42);
    }

    .tag.failed,
    .tag.action,
    .tag.fail {
      color: var(--accent-red);
      border-color: rgba(217, 92, 83, 0.5);
    }

    .tag.shadow,
    .tag.warn,
    .tag.skipped {
      color: var(--accent-blue);
      border-color: rgba(124, 138, 255, 0.42);
    }

    .cutover-list,
    .doctor-list,
    .onboarding-list,
    .route-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .cutover-row,
    .doctor-row,
    .onboarding-row,
    .route-row {
      min-height: 74px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-muted);
      padding: 10px;
      display: grid;
      gap: 7px;
      align-content: space-between;
    }

    .cutover-row strong,
    .doctor-row strong,
    .onboarding-row strong,
    .route-row strong {
      font-size: 13px;
    }

    .cutover-row span,
    .doctor-row span,
    .onboarding-row span,
    .route-row span {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.35;
    }

    .activity-filterbar,
    .session-filterbar {
      margin-bottom: 10px;
      display: grid;
      grid-template-columns: minmax(220px, 1.2fr) minmax(140px, 0.6fr) minmax(150px, 0.7fr) auto auto;
      gap: 8px;
      align-items: end;
    }

    .activity-filter,
    .session-filter {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    .activity-filter span,
    .activity-filter-summary,
    .session-filter span,
    .session-filter-summary {
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .activity-filter input,
    .activity-filter select,
    .session-filter input,
    .session-filter select {
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-input);
      color: var(--text-primary);
      padding: 0 10px;
    }

    .activity-filter-summary {
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .recent-events-filterbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .recent-events-filter-label {
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .recent-events-filter-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .recent-events-filter-chips .tag {
      cursor: pointer;
    }

    .recent-events-filter-chips .tag[aria-pressed="true"] {
      color: var(--brand-bright);
      border-color: rgba(46, 171, 115, 0.42);
    }

    .recent-events-filter-summary {
      margin-left: auto;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      white-space: nowrap;
    }

    .agent-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }

    .chat-shell {
      min-height: 0;
      height: calc(100vh - 134px);
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
      gap: 12px;
    }

    .chat-session-panel {
      min-height: 0;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-panel);
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
    }

    .chat-session-meta {
      padding: 12px;
      border-bottom: 1px solid var(--stroke-hairline);
      display: grid;
      gap: 7px;
    }

    .chat-session-list {
      min-height: 0;
      overflow: auto;
      padding: 10px;
      display: grid;
      gap: 8px;
      align-content: start;
    }

    .chat-conversation {
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-muted);
      padding: 10px;
      display: grid;
      gap: 7px;
    }

    .chat-conversation.active {
      border-color: rgba(46, 171, 115, 0.38);
      background: rgba(46, 171, 115, 0.09);
    }

    .chat-conversation strong {
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .chat-conversation span {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .chat-stage {
      min-height: 0;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: rgba(16, 18, 16, 0.52);
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      overflow: hidden;
    }

    .chat-thread {
      min-height: 0;
      overflow: auto;
      padding: 18px 22px 10px;
      display: grid;
      gap: 14px;
      align-content: end;
    }

    .chat-message {
      display: flex;
      align-items: flex-end;
      gap: 10px;
      max-width: min(900px, 78%);
    }

    .chat-message.user {
      justify-self: end;
      flex-direction: row-reverse;
    }

    .chat-avatar {
      width: 34px;
      height: 34px;
      border-radius: var(--radius-md);
      border: 1px solid var(--stroke-hairline);
      background: var(--surface-elevated);
      color: var(--brand-bright);
      display: grid;
      place-items: center;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 800;
      flex: 0 0 auto;
    }

    .chat-message.user .chat-avatar {
      color: var(--accent-amber);
    }

    .chat-bubble {
      min-width: 0;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-panel);
      padding: 11px 13px;
      display: grid;
      gap: 7px;
    }

    .chat-message.agent .chat-bubble {
      border-color: rgba(46, 171, 115, 0.26);
      background: rgba(46, 171, 115, 0.055);
    }

    .chat-message.user .chat-bubble {
      border-color: rgba(255, 179, 64, 0.25);
      background: rgba(255, 179, 64, 0.07);
    }

    .chat-bubble strong {
      font-size: 13px;
    }

    .chat-bubble p,
    .chat-bubble span {
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    .chat-bubble .replay-inline {
      justify-self: start;
    }

    .chat-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      font-size: 10px;
      flex-wrap: wrap;
    }

    .composer {
      margin: 0 16px 14px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-lg);
      background: var(--surface-elevated);
      padding: 12px;
      display: grid;
      gap: 10px;
    }

    .composer textarea {
      width: 100%;
      min-height: 40px;
      max-height: 130px;
      resize: vertical;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--text-primary);
      font-size: 15px;
    }

    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }

    .composer-tools {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .agent-row {
      min-height: 74px;
      border: 1px solid var(--stroke-hairline);
      border-radius: var(--radius-md);
      background: var(--surface-muted);
      padding: 10px;
      display: grid;
      align-content: space-between;
      gap: 6px;
    }

    .agent-row strong {
      font-size: 13px;
    }

    .agent-row span {
      color: var(--text-secondary);
      font-size: 11px;
      line-height: 1.3;
    }

    .empty {
      padding: 18px 14px;
      color: var(--text-secondary);
      font-size: 13px;
    }

    @media (max-width: 1180px) {
      .overview-grid,
      .grid,
      .chat-shell,
      .topbar {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: flex-start;
      }
    }

    @media (max-width: 1040px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        min-height: auto;
        max-height: none;
        border-right: 0;
        border-bottom: 1px solid var(--stroke-hairline);
        overflow: visible;
      }
      .workspace {
        width: 100%;
        height: auto;
        min-height: 100vh;
        overflow: visible;
      }
      .view {
        overflow: visible;
        padding: 18px;
      }
      .chat-shell {
        height: auto;
      }
      .metrics,
      .snapshot-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
        .agent-list,
        .chat-shell,
        .cutover-list,
      .doctor-list,
      .onboarding-list,
      .route-list {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .activity-filterbar,
      .session-filterbar {
        grid-template-columns: minmax(0, 1fr) minmax(130px, 0.5fr) minmax(140px, 0.5fr);
      }
    }

    @media (max-width: 680px) {
      body,
      .app-shell {
        overflow-x: hidden;
      }

      .app-shell,
      .sidebar,
      .workspace,
      .panel,
      .side-panel {
        min-width: 0;
        max-width: 100vw;
      }

      .sidebar,
      .workspace {
        overflow: visible;
      }

      .recent-label,
      .recent-list {
        display: none;
      }

      .nav {
        max-height: 220px;
        overflow-y: auto;
      }

      .sidebar-footer {
        display: none;
      }

      .side-panel {
        max-width: 100%;
      }

      .connection-row {
        grid-template-columns: 82px minmax(0, 1fr);
      }

      .nav a span:last-child {
        display: none;
      }

      .connection-row .value {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .title-line {
        display: grid;
        grid-template-columns: 46px minmax(0, 1fr);
        align-items: start;
      }

      .title-line h2 {
        font-size: 28px;
        line-height: 1.05;
      }

      .metrics,
      .snapshot-grid,
      .field-grid,
      .agent-list,
      .cutover-list,
      .doctor-list,
      .onboarding-list,
      .route-list {
        grid-template-columns: 1fr;
      }

      .activity-filterbar,
      .session-filterbar {
        grid-template-columns: 1fr;
      }

      .runs th:nth-child(3),
      .runs td:nth-child(3) {
        display: none;
      }
    }
  </style>
</head>
<body>
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" role="img">
            <path d="M13 43V21l19-8 19 8v22l-19 8-19-8Z" fill="none" stroke="#2EAB73" stroke-width="4" />
            <path d="M22 26h20M22 35h20M32 14v36" stroke="#FFB340" stroke-width="4" stroke-linecap="round" />
          </svg>
        </div>
        <div>
          <p class="eyebrow">NEON CORE</p>
          <h1>Mission Control</h1>
        </div>
      </div>

      <section class="sidebar-sessions" aria-label="Sessions">
        <a class="sidebar-new-session" href="/mission-control/chat" data-view="chat"><span aria-hidden="true">+</span><span>New session</span></a>
        <div class="recent-label">Kürzlich</div>
        <div class="recent-list" id="recentSessions"></div>
      </section>

      <nav class="nav" aria-label="Mission Control Navigation">
        <section class="nav-section" aria-label="Chat">
          <div class="nav-section-label">Chat</div>
          <a href="/mission-control/chat" data-view="chat"${initialView === "chat" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">□</span><span>Chat</span><span class="nav-count" id="navChat">empty</span></a>
        </section>
        <section class="nav-section" aria-label="Steuerung">
          <div class="nav-section-label">Steuerung</div>
          <a href="/mission-control/overview" data-view="overview"${initialView === "overview" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">▥</span><span>Übersicht</span><span class="nav-count" id="navState">ready</span></a>
          <a href="/mission-control/activity" data-view="activity"${initialView === "activity" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">⌁</span><span>Aktivität</span><span class="nav-count" id="navRoutes">setup</span></a>
          <a href="/mission-control/workboard" data-view="workboard"${initialView === "workboard" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">⌑</span><span>Arbeitsbereich</span><span class="nav-count" id="navMemory">none</span></a>
          <a href="/mission-control/instances" data-view="instances"${initialView === "instances" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">↔</span><span>Instanzen</span><span class="nav-count" id="navMirror">evidence</span></a>
          <a href="/mission-control/sessions" data-view="sessions"${initialView === "sessions" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">▤</span><span>Sitzungen</span><span class="nav-count" id="navRuns">0</span></a>
          <a href="/mission-control/usage" data-view="usage"${initialView === "usage" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">↯</span><span>Nutzung</span><span class="nav-count" id="navCutover">shadow</span></a>
          <a href="/mission-control/cron" data-view="cron"${initialView === "cron" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">✣</span><span>Cron-Aufgaben</span><span class="nav-count" id="navCron">shadow</span></a>
        </section>
        <section class="nav-section" aria-label="Agent">
          <div class="nav-section-label">Agent</div>
          <a href="/mission-control/agents" data-view="agents"${initialView === "agents" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">◇</span><span>Agenten</span><span class="nav-count" id="navAgents">0</span></a>
          <a href="/mission-control/skills" data-view="skills"${initialView === "skills" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">✦</span><span>Skills</span><span class="nav-count" id="navOnboarding">setup</span></a>
          <a href="/mission-control/nodes" data-view="nodes"${initialView === "nodes" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">▱</span><span>Geräte</span><span class="nav-count" id="navNodes">local</span></a>
          <a href="/mission-control/dreams" data-view="dreams"${initialView === "dreams" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">☾</span><span>Träume</span><span class="nav-count" id="navDreams">memory</span></a>
        </section>
        <section class="nav-section" aria-label="Einstellungen">
          <div class="nav-section-label">Einstellungen</div>
          <a href="/mission-control/config" data-view="config"${initialView === "config" ? ' aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">⚙</span><span>Einstellungen</span><span class="nav-count" id="navConfig">audit</span></a>
        </section>
      </nav>

      <div class="sidebar-footer">
        <a class="sidebar-link" href="/api/neon-mission-control/gateway"><span aria-hidden="true">□</span><span>Dokumentation</span></a>
        <div class="sidebar-version"><span>Version</span><span id="stateLabel">ready</span><span class="dot" aria-hidden="true"></span></div>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div class="crumbbar"><span>Neonika</span><span>›</span><span>Chaty Lab</span><span>›</span><strong id="viewTitle">${missionControlViewTitle(initialView)}</strong></div>
        <div class="top-tools">
          <input class="search" value="Suchen" aria-label="Suchen" readonly>
          <button class="round-button" id="refreshButton" type="button" title="Aktualisieren" aria-label="Aktualisieren">↻</button>
          <button class="round-button" type="button" title="Theme" aria-label="Theme">☾</button>
        </div>
        <div class="control-row">
          <div class="select-like" id="activeSessionLabel">discord:900000000000000001the allowlisted private</div>
          <div class="select-like">GPT-5.5</div>
          <div class="select-like">Inherited: Medium</div>
          <div class="usage-pill">Nutzung <span id="metricRunsHero">0</span></div>
        </div>
        <div class="api-strip">
          <a class="button" href="/api/neon-mission-control/gateway">Gateway API</a>
          <a class="button" href="/api/neon-gateway/lifecycle">Lifecycle API</a>
          <a class="button" href="/api/neon-gateway/events">Events Stream</a>
          <a class="button" href="/api/neon-chat/conversations">Chat API</a>
          <a class="button" href="/api/neon-delivery/queue">Delivery API</a>
          <a class="button" href="/api/neon-sessions">Sessions API</a>
          <a class="button" href="/api/neon-activity">Activity API</a>
          <a class="button" href="/api/neon-replay">Replay API</a>
          <a class="button" href="/api/neon-gateway/routes">Routes API</a>
          <a class="button" href="/api/neon-mirror/evidence">Mirror API</a>
          <a class="button" href="/api/neon-cutover">Cutover API</a>
          <a class="button" href="/api/neon-agents">Agents API</a>
          <a class="button" href="/api/neon-skills">Skills API</a>
          <a class="button" href="/api/neon-extensions">Extensions API</a>
          <a class="button" href="/api/neon-doctor">Doctor API</a>
        </div>
      </header>

      <section class="view" id="view-overview" data-view="overview"${viewHidden("overview")}>
      <section class="overview-grid" id="gateway">
        <article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Gateway Zugang</h2>
            <span class="tag ready" id="accessState">ready</span>
          </div>
          <div class="panel-body">
            <div class="field-grid">
              <label class="field full">
                <span>WebSocket URL</span>
                <div class="input-row">
                  <input id="wsUrl" value="" readonly aria-label="WebSocket URL">
                  <button class="icon-button" id="copyWsButton" type="button" title="WebSocket URL kopieren" aria-label="WebSocket URL kopieren">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
              </label>
              <label class="field full">
                <span>Event Stream</span>
                <div class="input-row">
                  <input id="eventStreamUrl" value="" readonly aria-label="Event Stream URL">
                  <button class="icon-button" id="copyEventStreamButton" type="button" title="Event Stream URL kopieren" aria-label="Event Stream URL kopieren">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
              </label>
              <label class="field">
                <span>Gateway Token</span>
                <input value="lokal geschützt" type="password" readonly aria-label="Gateway Token">
              </label>
              <label class="field">
                <span>Passwort</span>
                <input value="nicht gesetzt" type="password" readonly aria-label="Passwort">
              </label>
              <label class="field">
                <span>Session</span>
                <div class="input-like" id="sessionKey">neon:mission-control</div>
              </label>
              <label class="field">
                <span>Policy</span>
                <div class="input-like">shadow / no delivery</div>
              </label>
            </div>
            <div class="access-actions">
              <button class="button primary" id="connectButton" type="button">Verbinden</button>
              <button class="button" id="copyDashboardButton" type="button">Dashboard URL</button>
              <span class="muted" id="connectHint">Gateway erreichbar, Auth lokal gekapselt.</span>
            </div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Gateway Snapshot</h2>
            <span class="tag" id="snapshotState">ready</span>
          </div>
          <div class="panel-body">
            <section class="snapshot-grid" aria-label="Gateway Snapshot">
              <div class="stat"><span class="label">Status</span><span class="stat-value" id="snapshotStatus">ready</span></div>
              <div class="stat"><span class="label">Runs</span><strong id="snapshotRuns">0</strong></div>
              <div class="stat"><span class="label">Latest</span><span class="stat-value" id="snapshotLatest">none</span></div>
              <div class="stat"><span class="label">Memory</span><span class="stat-value" id="snapshotMemory">none</span></div>
              <div class="stat"><span class="label">Live</span><span class="stat-value" id="lifecycleState">starting</span></div>
              <div class="stat"><span class="label">Seq</span><span class="stat-value" id="lifecycleSeq">0</span></div>
            </section>
            <div class="callout" id="snapshotCallout">Shadow-Modus aktiv. Discord-Ausgabe bleibt bis zum Cutover unterdrückt.</div>
          </div>
        </article>
      </section>

      <section class="metrics" aria-label="Gateway Metriken">
        <div class="metric"><span class="label">Shadow</span><strong id="metricShadow">0</strong></div>
        <div class="metric"><span class="label">Running</span><strong id="metricRunning">0</strong></div>
        <div class="metric"><span class="label">Completed</span><strong id="metricCompleted">0</strong></div>
        <div class="metric"><span class="label">Failed</span><strong id="metricFailed">0</strong></div>
        <div class="metric"><span class="label">Suppressed</span><strong id="metricSuppressed">0</strong></div>
        <div class="metric"><span class="label">Dry-run Queue</span><strong id="metricDeliveryQueue">0</strong></div>
      </section>

      <section class="grid">
        <article class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Gateway Pfad</h2>
            <span class="tag shadow">shadow</span>
          </div>
          <div class="panel-body stack">
            <div class="route-step"><div class="node">01</div><div class="route-copy"><strong>Channel Ingress</strong><span id="latestChannel">none</span></div></div>
            <div class="connector"></div>
            <div class="route-step"><div class="node">02</div><div class="route-copy"><strong>Neon Gateway</strong><span id="sourcePath"></span></div></div>
            <div class="connector"></div>
            <div class="route-step"><div class="node">03</div><div class="route-copy"><strong>Neon Agent</strong><span id="latestAgent">none</span></div></div>
            <div class="connector"></div>
            <div class="route-step"><div class="node">04</div><div class="route-copy"><strong>Neon Memory</strong><span id="latestMemory">none</span></div></div>
          </div>
        </article>

        ${renderRecentEventsPanel(snapshot.recentEvents)}
        ${renderRecentRunsPanel(snapshot.recentRuns)}
        ${renderCanaryPosturePanel(snapshot.canaryPosture)}
        ${renderNeonMissionControlGatePosturePanel(resolveNeonGatedSideEffectPosture(process.env))}
        ${renderNeonMissionControlBlockedReadinessPanel(createNeonBlockedRowReadinessSnapshot({ env: process.env }))}
        ${renderNeonMissionControlLiveSessionReadinessPanel(options.liveSessionReadiness ?? createNeonLiveSessionReadinessSnapshot({ env: process.env }))}
        ${renderNeonMissionControlChannelsPanel()}
        ${renderNeonMissionControlToolsPanel(createNeonToolInventorySnapshot({ env: process.env }))}
      </section>
      </section>

      <section class="view" id="view-chat" data-view="chat"${viewHidden("chat")}>
        <div class="chat-shell" id="chat">
          <aside class="chat-session-panel" aria-label="Chat Sessions">
            <div class="chat-session-meta">
              <div class="line"><strong>source</strong> <span id="chatSource">gateway runs</span></div>
              <div class="line"><strong>threads</strong> <span id="chatThreadCount">0</span></div>
              <div class="line"><strong>messages</strong> <span id="chatMessageCount">0</span></div>
              <div class="line"><strong>state</strong> <span id="chatSummary">waiting</span></div>
            </div>
            <section class="chat-session-list" id="chatRows" aria-label="Conversations"></section>
          </aside>
          <section class="chat-stage" aria-label="Neon Chat">
            <section class="chat-thread" id="chatMessageRows" aria-label="Chat Messages"></section>
            <form class="composer" id="chatComposer">
              <textarea aria-label="Message Chaty Lab" rows="1"></textarea>
              <div class="composer-toolbar">
                <div class="composer-tools">
                  <button class="button" type="button">Attach file</button>
                  <button class="button" type="button">Start Talk</button>
                  <button class="icon-button" type="button" aria-label="Chat Settings">⚙</button>
                </div>
                <div class="composer-tools">
                  <button class="button" type="button">Exportieren</button>
                  <button class="button primary" type="button">Send</button>
                </div>
              </div>
            </form>
          </section>
        </div>
      </section>

      <section class="view narrow" id="view-workboard" data-view="workboard"${viewHidden("workboard")}>
        ${renderNeonMissionControlWorkboardPanel(options.workboard)}
      </section>

      <section class="view" id="view-activity" data-view="activity"${viewHidden("activity")}>
      <article class="panel" id="activity">
        <div class="panel-header">
            <h2 class="panel-title">Neon Aktivität</h2>
          <span class="label" id="activitySummary">waiting</span>
        </div>
        <div class="panel-body">
          <div class="activity-filterbar" aria-label="Activity Filter">
            <label class="activity-filter">
              <span>Suche</span>
              <input id="activitySearchInput" type="search" autocomplete="off" placeholder="run, agent, event">
            </label>
            <label class="activity-filter">
              <span>Status</span>
              <select id="activityStatusFilter">
                <option value="">Alle Status</option>
              </select>
            </label>
            <label class="activity-filter">
              <span>Agent</span>
              <select id="activityAgentFilter">
                <option value="">Alle Agenten</option>
              </select>
            </label>
            <button class="button" id="activityClearFilters" type="button">Reset</button>
            <span class="activity-filter-summary" id="activityVisibleCount">0 / 0 sichtbar</span>
          </div>
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>state</strong> <span id="activityState">loading</span></div>
            <div class="line"><strong>entries</strong> <span id="activityEntries">0</span></div>
            <div class="line"><strong>runs</strong> <span id="activityRuns">0</span></div>
            <div class="line"><strong>errors</strong> <span id="activityErrors">0</span></div>
            <div class="line"><strong>replay</strong> <span id="replaySummary">empty</span></div>
            <div class="line"><strong>replay events</strong> <span id="replayEvents">0</span></div>
            <div class="line"><strong>delivery queue</strong> <span id="deliveryQueueSummary">0 queued</span></div>
            <div class="line"><strong>delivery approvals</strong> <span id="deliveryApprovalSummary">0 recorded</span></div>
          </div>
          <div class="route-list" id="activityRows"></div>
          <div class="route-list" id="replayDetail" style="margin-top: 10px;"></div>
          <div class="route-list" id="replayRows" style="margin-top: 10px;"></div>
          <div class="route-list" id="deliveryQueueRows" style="margin-top: 10px;"></div>
          <div class="route-list" id="deliveryApprovalRows" style="margin-top: 10px;"></div>
        </div>
      </article>
      </section>

      <section class="view" id="view-instances" data-view="instances"${viewHidden("instances")}>
      <article class="panel" id="mirror">
        <div class="panel-header">
            <h2 class="panel-title">Neon Instanzen</h2>
          <span class="label" id="mirrorSummary">waiting</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>state</strong> <span id="mirrorState">loading</span></div>
            <div class="line"><strong>accepted</strong> <span id="mirrorAccepted">0</span></div>
            <div class="line"><strong>drift</strong> <span id="mirrorDrift">0</span></div>
            <div class="line"><strong>latest</strong> <span id="mirrorLatest">none</span></div>
          </div>
          <div class="cutover-list" id="mirrorRows"></div>
        </div>
      </article>
      </section>

      <section class="view" id="view-usage" data-view="usage"${viewHidden("usage")}>
      <article class="panel" id="cutover">
        <div class="panel-header">
            <h2 class="panel-title">Neon Nutzung</h2>
          <span class="label" id="cutoverSummary">waiting</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>state</strong> <span id="cutoverState">loading</span></div>
            <div class="line"><strong>current</strong> <span id="cutoverCurrent">shadow</span></div>
            <div class="line"><strong>next</strong> <span id="cutoverNext">mirror</span></div>
            <div class="line"><strong>rollback</strong> <span id="cutoverRollback">missing</span></div>
          </div>
          <div class="cutover-list" id="cutoverRows"></div>
        </div>
      </article>
      </section>

      <section class="view" id="view-sessions" data-view="sessions"${viewHidden("sessions")}>
      <article class="panel" id="runs">
        <div class="panel-header">
            <h2 class="panel-title">Neon Sitzungen</h2>
          <span class="label" id="sessionSummary">live aus runs.jsonl</span>
        </div>
        <div class="session-filterbar" aria-label="Session Filter">
          <label class="session-filter">
            <span>Suche</span>
            <input id="sessionSearchInput" type="search" autocomplete="off" placeholder="session, agent, workspace">
          </label>
          <label class="session-filter">
            <span>Status</span>
            <select id="sessionStatusFilter">
              <option value="">Alle Status</option>
            </select>
          </label>
          <label class="session-filter">
            <span>Agent</span>
            <select id="sessionAgentFilter">
              <option value="">Alle Agenten</option>
            </select>
          </label>
          <button class="button" id="sessionClearFilters" type="button">Reset</button>
          <span class="session-filter-summary" id="sessionVisibleCount">0 / 0 sichtbar</span>
        </div>
        <table class="runs">
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Runs</th>
              <th>Agent</th>
              <th>Memory / Delivery</th>
            </tr>
          </thead>
          <tbody id="sessionRows"></tbody>
        </table>
        <div class="empty" id="sessionEmptyState" hidden>Keine Sitzungen.</div>
      </article>
      </section>

      <section class="view" id="view-cron" data-view="cron"${viewHidden("cron")}>
      <article class="panel" id="cron">
        <div class="panel-header">
            <h2 class="panel-title">Cron-Aufgaben</h2>
          <span class="label" id="cronSummary">waiting</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>policy</strong> <span id="automationPolicy">shadow-read-only</span></div>
            <div class="line"><strong>jobs</strong> <span id="automationJobs">0</span></div>
            <div class="line"><strong>hooks</strong> <span id="automationHooks">0</span></div>
            <div class="line"><strong>enabled</strong> <span id="automationEnabled">0</span></div>
          </div>
          <div class="doctor-list" id="cronRows"></div>
          <div class="doctor-list" id="hookRows" style="margin-top: 10px;"></div>
        </div>
      </article>
        ${renderNeonMissionControlCronDaemonStatusPanel(options.cronDaemon)}
        ${renderNeonMissionControlHeartbeatDaemonStatusPanel(options.heartbeatDaemon)}
      </section>

      <section class="view" id="view-skills" data-view="skills"${viewHidden("skills")}>
      <article class="panel" id="skills">
        <div class="panel-header">
            <h2 class="panel-title">Neon Skills & Extensions</h2>
          <span class="label" id="skillsSummary">waiting</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>roots</strong> <span id="skillsRoots">0</span></div>
            <div class="line"><strong>skills</strong> <span id="skillsCount">0</span></div>
            <div class="line"><strong>extensions</strong> <span id="extensionsCount">0</span></div>
            <div class="line"><strong>trust</strong> <span id="skillsTrust">reference-only for upstream</span></div>
          </div>
          <div class="route-list" id="skillRootRows"></div>
          <div class="route-list" id="skillRows" style="margin-top: 8px;"></div>
          <div class="route-list" id="extensionRows" style="margin-top: 8px;"></div>
        </div>
      </article>
      <article class="panel" id="plugins">
        <div class="panel-header">
            <h2 class="panel-title">Neon Plugins</h2>
          <span class="label" id="pluginsSummary">waiting</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>plugins</strong> <span id="pluginsCount">0</span></div>
            <div class="line"><strong>install gate</strong> <span id="pluginsGate">unknown</span></div>
            <div class="line"><strong>auto-load</strong> <span id="pluginsAutoLoad">0 declared / 0 honored</span></div>
            <div class="line"><strong>trust</strong> <span id="pluginsTrust">reference-only</span></div>
          </div>
          <div class="route-list" id="pluginRows" style="margin-top: 8px;"></div>
          <a class="button" href="/api/neon-plugins" style="margin-top: 8px;">Plugins API</a>
        </div>
      </article>
      </section>

      <section class="view" id="view-agents" data-view="agents"${viewHidden("agents")}>
      <article class="panel" id="agents">
        <div class="panel-header">
          <h2 class="panel-title">Neon Agents</h2>
          <span class="label" id="agentsSummary">registry</span>
        </div>
        <div class="panel-body">
          <div class="agent-list" id="agentRows"></div>
        </div>
      </article>
      </section>

      <section class="view" id="view-nodes" data-view="nodes"${viewHidden("nodes")}>
      <article class="panel" id="nodes">
        <div class="panel-header">
          <h2 class="panel-title">Neon Geräte</h2>
          <span class="label" id="nodesSummary">local gateway</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>gateway</strong> <span id="nodesGateway">local</span></div>
            <div class="line"><strong>node</strong> <span id="nodesLocal">waiting</span></div>
            <div class="line"><strong>heartbeat</strong> <span id="nodesHeartbeat">waiting</span></div>
            <div class="line"><strong>pairing</strong> <span id="nodesPairing">locked</span></div>
            <div class="line"><strong>pending pair</strong> <span id="nodesPairingPending">0</span></div>
            <div class="line"><strong>approvals</strong> <span id="nodesPairingApprovals">0</span></div>
            <div class="line"><strong>token gate</strong> <span id="nodesTokenGate">locked</span></div>
            <div class="line"><strong>gate blockers</strong> <span id="nodesTokenGateBlockers">0</span></div>
            <div class="line"><strong>canary tokens</strong> <span id="nodesCanaryTokens">0</span></div>
            <div class="line"><strong>secret delivery</strong> <span id="nodesSecretDelivery">disabled</span></div>
            <div class="line"><strong>device sessions</strong> <span id="nodesDeviceSessions">0</span></div>
            <div class="line"><strong>session scopes</strong> <span id="nodesDeviceSessionScopes">locked</span></div>
            <div class="line"><strong>action requests</strong> <span id="nodesActionRequests">0</span></div>
            <div class="line"><strong>action approvals</strong> <span id="nodesActionApprovals">0</span></div>
            <div class="line"><strong>result previews</strong> <span id="nodesActionResultPreviews">0</span></div>
            <div class="line"><strong>transport</strong> <span id="nodesTransport">0</span></div>
            <div class="line"><strong>transport results</strong> <span id="nodesTransportResults">0</span></div>
            <div class="line"><strong>transport polls</strong> <span id="nodesTransportPolls">0</span></div>
            <div class="line"><strong>runner</strong> <span id="nodesRunner">stopped</span></div>
            <div class="line"><strong>runner loop</strong> <span id="nodesRunnerLoop">0 cycles</span></div>
            <div class="line"><strong>runner service</strong> <span id="nodesRunnerService">blocked</span></div>
            <div class="line"><strong>service install</strong> <span id="nodesRunnerServiceInstall">not-installed</span></div>
            <div class="line"><strong>service creds</strong> <span id="nodesRunnerServiceCredentials">missing</span></div>
            <div class="line"><strong>service canary</strong> <span id="nodesRunnerServiceCanary">blocked</span></div>
            <div class="line"><strong>executor mode</strong> <span id="nodesRunnerServiceExecutor">disabled</span></div>
            <div class="line"><strong>rollback</strong> <span id="nodesRunnerServiceRollback">missing</span></div>
            <div class="line"><strong>service cutover</strong> <span id="nodesRunnerServiceCutover">shadow</span></div>
            <div class="line"><strong>service actions</strong> <span id="nodesRunnerServiceActions">0</span></div>
            <div class="line"><strong>service approvals</strong> <span id="nodesRunnerServiceApprovals">0</span></div>
            <div class="line"><strong>service executions</strong> <span id="nodesRunnerServiceExecutions">0</span></div>
            <div class="line"><strong>action policy</strong> <span id="nodesActionPolicy">disabled</span></div>
            <div class="line"><strong>files</strong> <span id="nodesFiles">read-only</span></div>
          </div>
          <div class="route-list" id="nodeRows"></div>
          <div class="route-list" id="pairingRows" style="margin-top: 10px;"></div>
        </div>
      </article>
      </section>

      <section class="view narrow" id="view-dreams" data-view="dreams"${viewHidden("dreams")}>
      <article class="panel" id="dreams">
        <div class="panel-header">
          <h2 class="panel-title">Neon Träume</h2>
          <span class="label" id="dreamsSummary">memory stream</span>
        </div>
        <div class="panel-body">
          <div class="terminal">
            <div class="line"><strong>latest run</strong> <span id="dreamLatestRun">none</span></div>
            <div class="line"><strong>memory</strong> <span id="dreamMemory">none</span></div>
            <div class="line"><strong>delivery</strong> <span id="dreamDelivery">suppressed</span></div>
            <div class="line"><strong>source</strong> <span id="dreamSource">gateway runs</span></div>
            <div class="line"><strong>policy</strong> <span id="dreamPolicy">operator approval</span></div>
          </div>
          <div class="route-list" id="dreamRows" style="margin-top: 10px;"></div>
        </div>
      </article>
      </section>

      <section class="view" id="view-config" data-view="config"${viewHidden("config")}>
      <article class="panel" id="config">
        <div class="panel-header">
          <h2 class="panel-title">Neon Einstellungen</h2>
          <span class="label" id="configSummary">audit</span>
        </div>
        <div class="panel-body">
          <div class="terminal" style="margin-bottom: 10px;">
            <div class="line"><strong>agent</strong> <span id="configAgent">chaty</span></div>
            <div class="line"><strong>routes</strong> <span id="configRoutes">waiting</span></div>
            <div class="line"><strong>doctor</strong> <span id="configDoctor">waiting</span></div>
            <div class="line"><strong>cutover</strong> <span id="configCutover">shadow</span></div>
          </div>
          <div class="onboarding-list" id="configRows"></div>
        </div>
      </article>
      </section>
    </section>
  </main>

  <script>
    const initialSnapshot = ${safeSnapshot};
    const text = (id, value) => {
      const node = document.getElementById(id);
      if (node) node.textContent = value;
    };
    const setValue = (id, value) => {
      const node = document.getElementById(id);
      if (node && "value" in node) node.value = value;
    };
    const tagClass = (value) => String(value || "").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    const formatEndpoint = (path) => new URL(path, window.location.origin).href;
    const formatGatewayWsUrl = () => {
      const url = new URL(window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      return url.href.replace(/\\/$/, "");
    };
    const formatGatewayEventStreamUrl = () => {
      const url = new URL("/api/neon-gateway/events", window.location.origin);
      return url.href;
    };
    const copyText = (value) => {
      if (!navigator.clipboard) return;
      void navigator.clipboard.writeText(value);
    };
    const initialView = ${safeInitialView};
    const viewNames = ["chat", "overview", "activity", "workboard", "instances", "sessions", "usage", "cron", "agents", "skills", "nodes", "dreams", "config"];
    const viewAliases = {
      cutover: "usage",
      doctor: "cron",
      gateway: "overview",
      memory: "workboard",
      mirror: "instances",
      onboarding: "skills",
      routes: "activity",
      runs: "sessions"
    };
    const viewTitles = {
      chat: "Chat",
      overview: "Übersicht",
      activity: "Aktivität",
      workboard: "Arbeitsbereich",
      instances: "Instanzen",
      sessions: "Sitzungen",
      usage: "Nutzung",
      cron: "Cron-Aufgaben",
      agents: "Agenten",
      skills: "Skills",
      nodes: "Geräte",
      dreams: "Träume",
      config: "Einstellungen"
    };
    const normalizeView = (value) => {
      const requested = String(value || "").replace(/^#?\\/?/, "").replace(/^mission-control\\/?/, "").replace(/^\\/?/, "");
      const firstSegment = requested.split("/")[0] || "";
      const aliased = viewAliases[firstSegment] || firstSegment;
      return viewNames.includes(aliased) ? aliased : "chat";
    };
    const activePathView = () => {
      const path = window.location.pathname.replace(/\\/+$/u, "") || "/mission-control";
      if (path === "/mission-control" || path === "/mission-control/gateway") return initialView;
      return normalizeView(path);
    };
    const activeHashView = () => window.location.hash ? normalizeView(window.location.hash) : activePathView();
    const setActiveView = (requestedView) => {
      const activeView = normalizeView(requestedView);
      for (const view of document.querySelectorAll(".view[data-view]")) {
        view.hidden = view.getAttribute("data-view") !== activeView;
      }
      for (const link of document.querySelectorAll(".nav a[data-view]")) {
        if (link.getAttribute("data-view") === activeView) {
          link.setAttribute("aria-current", "page");
        } else {
          link.removeAttribute("aria-current");
        }
      }
      text("viewTitle", viewTitles[activeView] || "Chat");
    };
    const navigateToView = (view) => {
      const activeView = normalizeView(view);
      window.history.pushState({ view: activeView }, "", "/mission-control/" + activeView);
      setActiveView(activeView);
    };
    const renderShellEndpoints = () => {
      const wsUrl = formatGatewayWsUrl();
      text("httpHost", window.location.host);
      text("wsHost", new URL(wsUrl).host);
      setValue("wsUrl", wsUrl);
      setValue("eventStreamUrl", formatGatewayEventStreamUrl());
    };
    const renderLifecycle = (snapshot) => {
      if (!snapshot) return;
      text("lifecycleState", snapshot.state || "unknown");
      text("lifecycleSeq", String(snapshot.eventSeq || 0));
      text("accessState", snapshot.state || "unknown");
      text("stateLabel", snapshot.state || "unknown");
    };
    const renderGateway = (snapshot) => {
      text("generatedAt", "Snapshot " + snapshot.generatedAt);
      text("stateLabel", snapshot.state);
      text("navState", snapshot.state);
      text("accessState", snapshot.state);
      text("snapshotState", snapshot.state);
      text("snapshotStatus", snapshot.state);
      text("navRuns", String(snapshot.totals.runs));
      text("metricRunsHero", String(snapshot.totals.runs));
      text("metricShadow", String(snapshot.totals.shadowRuns));
      text("metricRunning", String(snapshot.totals.running || 0));
      text("metricCompleted", String(snapshot.totals.completed));
      text("metricFailed", String(snapshot.totals.failed));
      text("metricSuppressed", String(snapshot.totals.deliverySuppressed));
      text("snapshotRuns", String(snapshot.totals.runs));
      text("latestChannel", snapshot.latestRun ? snapshot.latestRun.channel + "/" + snapshot.latestRun.channelId : "none");
      text("latestRun", snapshot.latestRun ? snapshot.latestRun.runId : "none");
      text("snapshotLatest", snapshot.latestRun ? snapshot.latestRun.runId : "none");
      text("latestAgent", snapshot.latestRun ? snapshot.latestRun.agentId : "none");
      text("latestMemory", snapshot.latestRun ? snapshot.latestRun.memoryState : "none");
      text("snapshotMemory", snapshot.latestRun ? snapshot.latestRun.memoryState : "none");
      text("navMemory", snapshot.latestRun ? snapshot.latestRun.memoryState : "none");
      text("navDreams", snapshot.latestRun ? snapshot.latestRun.memoryState : "memory");
      text("latestStatus", snapshot.latestRun ? snapshot.latestRun.status : "none");
      text("sourcePath", formatEndpoint(snapshot.source.gatewayStatusPath));
      text("runsPath", snapshot.source.runsPath);
      text("memoryLine", snapshot.latestRun ? snapshot.latestRun.memoryState : "none");
      text("deliveryLine", snapshot.latestRun ? snapshot.latestRun.deliveryState : "suppressed");
      text("dreamLatestRun", snapshot.latestRun ? snapshot.latestRun.runId : "none");
      text("dreamMemory", snapshot.latestRun ? snapshot.latestRun.memoryState : "none");
      text("dreamDelivery", snapshot.latestRun ? snapshot.latestRun.deliveryState : "suppressed");
      text("dreamSource", snapshot.source.runsPath);
      text("nodesGateway", formatGatewayWsUrl());
    };
    const renderAgents = (snapshot) => {
      text("navAgents", String(snapshot.agents.length));
      text("agentsSummary", snapshot.defaultAgentId + " default / " + snapshot.agents.length + " agents");
      text("agentsLine", snapshot.agents.length + " agents / default " + snapshot.defaultAgentId);
      const rows = document.getElementById("agentRows");
      if (!rows) return;
      rows.textContent = "";
      for (const agent of snapshot.agents) {
        const row = document.createElement("div");
        row.className = "agent-row";
        row.innerHTML = '<strong></strong><span></span><span class="tag"></span>';
        row.children[0].textContent = agent.displayName;
        row.children[1].textContent = agent.role;
        row.children[2].textContent = agent.runtime;
        rows.appendChild(row);
      }
    };
    const renderDoctor = (snapshot) => {
      text("configDoctor", snapshot.state + " / pass=" + snapshot.totals.pass + " warn=" + snapshot.totals.warn + " fail=" + snapshot.totals.fail);
    };
    const renderAutomation = (snapshot) => {
      const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
      const hooks = Array.isArray(snapshot.hooks) ? snapshot.hooks : [];
      const dreams = Array.isArray(snapshot.dreams) ? snapshot.dreams : [];
      text("navCron", String((snapshot.totals && snapshot.totals.enabled) || 0) + "/" + String((snapshot.totals && snapshot.totals.jobs) || 0));
      text("navDreams", String((snapshot.totals && snapshot.totals.dreams) || 0));
      text("cronSummary", snapshot.state + " / " + snapshot.policy);
      text("automationPolicy", snapshot.policy);
      text("automationJobs", String((snapshot.totals && snapshot.totals.jobs) || jobs.length));
      text("automationHooks", String((snapshot.totals && snapshot.totals.hooks) || hooks.length));
      text("automationEnabled", String((snapshot.totals && snapshot.totals.enabled) || 0));
      const cronRows = document.getElementById("cronRows");
      if (cronRows) {
        cronRows.textContent = "";
        for (const job of jobs) {
          const row = document.createElement("div");
          row.className = "doctor-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span>';
          row.children[0].firstElementChild.textContent = job.label;
          row.children[0].lastElementChild.textContent = job.state;
          row.children[0].lastElementChild.classList.add(tagClass(job.state));
          row.children[1].textContent = job.schedule + " / " + job.policy + " / " + job.summary;
          cronRows.appendChild(row);
        }
      }
      const hookRows = document.getElementById("hookRows");
      if (hookRows) {
        hookRows.textContent = "";
        for (const hook of hooks) {
          const row = document.createElement("div");
          row.className = "doctor-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span>';
          row.children[0].firstElementChild.textContent = hook.id;
          row.children[0].lastElementChild.textContent = hook.state;
          row.children[0].lastElementChild.classList.add(tagClass(hook.state));
          row.children[1].textContent = hook.event + " / " + hook.policy + " / " + hook.summary;
          hookRows.appendChild(row);
        }
      }
      const dreamRows = document.getElementById("dreamRows");
      if (dreamRows) {
        dreamRows.textContent = "";
        text("dreamPolicy", dreams[0] ? dreams[0].policy : "operator approval");
        for (const dream of dreams) {
          const row = document.createElement("div");
          row.className = "route-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
          row.children[0].firstElementChild.textContent = dream.id;
          row.children[0].lastElementChild.textContent = dream.state;
          row.children[0].lastElementChild.classList.add(tagClass(dream.state));
          row.children[1].textContent = dream.policy;
          row.children[2].textContent = dream.summary;
          dreamRows.appendChild(row);
        }
      }
    };
    const renderOnboarding = (snapshot) => {
      text("navOnboarding", snapshot.readyForDiscordSmoke ? "ready" : "action");
      text("onboardingSummary", snapshot.state + " / " + snapshot.steps.length + " steps");
      text("onboardingReady", snapshot.readyForDiscordSmoke ? "yes" : "no");
      text("onboardingCommand", snapshot.configPreview.command);
      text("onboardingSecrets", snapshot.configPreview.secretsPrinted ? "visible" : "hidden");
      text("configSummary", snapshot.state);
      const rows = document.getElementById("onboardingRows");
      const configRows = document.getElementById("configRows");
      if (rows) {
        rows.textContent = "";
      }
      if (configRows) {
        configRows.textContent = "";
      }
      for (const step of snapshot.steps) {
        const row = document.createElement("div");
        row.className = "onboarding-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span>';
        row.children[0].firstElementChild.textContent = step.label;
        row.children[0].lastElementChild.textContent = step.state;
        row.children[0].lastElementChild.classList.add(tagClass(step.state));
        row.children[1].textContent = step.summary;
        if (rows) {
          rows.appendChild(row);
        }
        if (configRows) {
          configRows.appendChild(row.cloneNode(true));
        }
      }
    };
    const renderRoutes = (snapshot) => {
      text("configAgent", snapshot.discord.agentId);
      text("configRoutes", snapshot.state + " / " + snapshot.routes.length + " routes");
      const rows = document.getElementById("routeRows");
      if (rows) {
        rows.textContent = "";
      }
      for (const route of snapshot.routes) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span> <span class="tag"></span></div><span></span><span></span><span></span>';
        row.children[0].firstElementChild.textContent = route.id;
        row.children[0].children[1].textContent = route.delivery;
        row.children[0].children[1].classList.add(tagClass(route.delivery));
        row.children[0].children[2].textContent = "probe " + route.probeState;
        row.children[0].children[2].classList.add(tagClass(route.probeState));
        row.children[1].textContent = route.channel + " / " + route.accountId + " / " + route.agentId;
        row.children[2].textContent = "auth " + route.authState + " / guilds " + route.guildScope + " / channels " + route.channelScope + " / " + route.mentionPolicy;
        row.children[3].textContent = "probe " + route.probeState + " / last " + (route.lastProbeAt || "none") + " / latest " + (route.latestRunId || "none");
        if (rows) {
          rows.appendChild(row);
        }
      }
    };
    const renderNodes = (snapshot) => {
      const capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
      const safeRoots = Array.isArray(snapshot.safeRoots) ? snapshot.safeRoots : [];
      const pairingRequests = Array.isArray(snapshot.pairingRequests) ? snapshot.pairingRequests : [];
      const pairingApprovals = Array.isArray(snapshot.pairingApprovals) ? snapshot.pairingApprovals : [];
      const pairingTokenGate = snapshot.pairingTokenGate || { state: "locked", cutoverStage: "shadow", currentGateState: "missing", totals: { eligibleApprovals: 0, blockers: 0 }, blockers: [], eligibleApprovals: [], invariants: [] };
      const pairingCanaryTokens = snapshot.pairingCanaryTokens || { state: "locked", totals: { issued: 0, active: 0, expired: 0 }, deliveryPolicy: { rawTokenPersistence: "disabled", rawTokenHttpExposure: "disabled", rawTokenCliEcho: "disabled" }, issues: [] };
      const deviceSessions = snapshot.deviceSessions || { state: "locked", totals: { sessions: 0, active: 0, expired: 0, blockedScopes: 0 }, policy: { actionPolicy: { fileTransfer: "approval-required", browser: "approval-required", commandExecution: "disabled" } }, sessions: [] };
      const actionRequests = snapshot.actionRequests || { state: "empty", totals: { requests: 0, recorded: 0, approvalRequired: 0, blocked: 0, approvalRecords: 0, pendingApproval: 0, resultPreviews: 0, readyResultPreviews: 0, blockedResultPreviews: 0, pendingResultPreviews: 0 }, policy: { execution: "disabled", fileRead: "approval-required", browserRead: "approval-required" }, requests: [], approvals: [], resultPreviews: [] };
      const transport = snapshot.transport || { state: "empty", totals: { dispatches: 0, blockers: 0, results: 0, receivedResults: 0, blockedResults: 0, polls: 0, activePollingSessions: 0, pendingDispatches: 0, approvedActions: 0, previewedApprovals: 0, ingestedApprovals: 0, unsupportedActions: 0, unsafeTargets: 0 }, policy: { mode: "poll-only", approval: "operator-approved-actions-only", mutationAllowed: false, rawTokenExposure: "disabled", sessionSecretExposure: "disabled", resultIngest: "bounded-audit" }, dispatches: [], blockers: [], results: [], polls: [] };
      const runner = snapshot.runner || { state: "stopped", control: { desiredState: "stopped", updatedAt: "never", operatorId: "system", reason: "not started" }, totals: { cycles: 0, pollRequests: 0, dispatches: 0, submitted: 0, blocked: 0, failed: 0 }, results: [], safety: { mutationExecuted: false, sideEffectExecuted: false, rawOutputPersisted: false, rawTokenPersisted: false, sessionSecretPersisted: false } };
      const runnerService = snapshot.runnerService || { state: "blocked", manager: "launchd", installState: "not-installed", credentials: { source: "missing" }, blockers: [], commands: [], safety: { installExecuted: false, restartExecuted: false, stopExecuted: false, launchAgentWritten: false, rawTokenPersisted: false, sessionSecretPersisted: false } };
      const runnerServiceActions = snapshot.runnerServiceActions || { state: "empty", totals: { requests: 0, approvalRequired: 0, blocked: 0, approvals: 0, approved: 0, rejected: 0, pendingApproval: 0, executions: 0, executed: 0, blockedExecutions: 0 }, requests: [], approvals: [], executions: [] };
      const runnerServiceCanary = snapshot.runnerServiceCanary || { state: "blocked", credentialsSource: "missing", runnerControl: "stopped", executorMode: "disabled", rollbackConfigured: false, cutoverStage: "shadow", cutoverState: "blocked", currentGateState: "missing", actionState: "empty", totals: { serviceBlockers: 0, pendingApprovals: 0, blockedActions: 0, blockedExecutions: 0 }, blockers: [], safety: { rawTokenPersisted: false, sessionSecretPersisted: false, launchAgentWritten: false, serviceMutationExecuted: false, canaryMutationAllowed: false } };
      const tokenGateBlockers = Array.isArray(pairingTokenGate.blockers) ? pairingTokenGate.blockers : [];
      const tokenGateApprovals = Array.isArray(pairingTokenGate.eligibleApprovals) ? pairingTokenGate.eligibleApprovals : [];
      const canaryTokenIssues = Array.isArray(pairingCanaryTokens.issues) ? pairingCanaryTokens.issues : [];
      const deviceSessionRows = Array.isArray(deviceSessions.sessions) ? deviceSessions.sessions : [];
      const actionRequestRows = Array.isArray(actionRequests.requests) ? actionRequests.requests : [];
      const actionApprovalRows = Array.isArray(actionRequests.approvals) ? actionRequests.approvals : [];
      const actionResultPreviewRows = Array.isArray(actionRequests.resultPreviews) ? actionRequests.resultPreviews : [];
      const transportDispatchRows = Array.isArray(transport.dispatches) ? transport.dispatches : [];
      const transportBlockerRows = Array.isArray(transport.blockers) ? transport.blockers : [];
      const transportResultRows = Array.isArray(transport.results) ? transport.results : [];
      const transportPollRows = Array.isArray(transport.polls) ? transport.polls : [];
      const runnerResultRows = Array.isArray(runner.results) ? runner.results : [];
      const runnerServiceBlockerRows = Array.isArray(runnerService.blockers) ? runnerService.blockers : [];
      const runnerServiceCommandRows = Array.isArray(runnerService.commands) ? runnerService.commands : [];
      const runnerServiceActionRows = Array.isArray(runnerServiceActions.requests) ? runnerServiceActions.requests : [];
      const runnerServiceApprovalRows = Array.isArray(runnerServiceActions.approvals) ? runnerServiceActions.approvals : [];
      const runnerServiceExecutionRows = Array.isArray(runnerServiceActions.executions) ? runnerServiceActions.executions : [];
      const runnerServiceCanaryBlockerRows = Array.isArray(runnerServiceCanary.blockers) ? runnerServiceCanary.blockers : [];
      const fileCapability = capabilities.find((capability) => capability.id === "file-transfer");
      text("navNodes", String((snapshot.totals && snapshot.totals.onlineNodes) || 0) + "/" + String((snapshot.totals && snapshot.totals.nodes) || 0));
      text("nodesSummary", snapshot.state + " / " + snapshot.localNode.displayName);
      text("nodesGateway", snapshot.gatewayUrl || formatGatewayWsUrl());
      text("nodesLocal", snapshot.localNode.nodeId + " / " + snapshot.localNode.platform + "-" + snapshot.localNode.arch);
      text("nodesHeartbeat", snapshot.localNode.heartbeatAt + " / " + snapshot.localNode.health);
      text("nodesPairing", snapshot.pairing.state + " / " + snapshot.pairing.approval);
      text("nodesPairingPending", String((snapshot.totals && snapshot.totals.pendingPairingRequests) || 0));
      text("nodesPairingApprovals", String((snapshot.totals && snapshot.totals.pairingApprovals) || 0));
      text("nodesTokenGate", pairingTokenGate.state + " / " + pairingTokenGate.cutoverStage + " / " + pairingTokenGate.currentGateState);
      text("nodesTokenGateBlockers", String((pairingTokenGate.totals && pairingTokenGate.totals.blockers) || 0));
      text("nodesCanaryTokens", pairingCanaryTokens.state + " / " + String((pairingCanaryTokens.totals && pairingCanaryTokens.totals.issued) || 0));
      text("nodesSecretDelivery", pairingCanaryTokens.deliveryPolicy.rawTokenPersistence + " / " + pairingCanaryTokens.deliveryPolicy.rawTokenHttpExposure);
      text("nodesDeviceSessions", deviceSessions.state + " / " + String((deviceSessions.totals && deviceSessions.totals.active) || 0));
      text("nodesDeviceSessionScopes", "blocked " + String((deviceSessions.totals && deviceSessions.totals.blockedScopes) || 0));
      text("nodesActionRequests", actionRequests.state + " / " + String((actionRequests.totals && actionRequests.totals.requests) || 0));
      text("nodesActionApprovals", String((actionRequests.totals && actionRequests.totals.approvalRecords) || actionApprovalRows.length || 0) + " / pending " + String((actionRequests.totals && actionRequests.totals.pendingApproval) || 0));
      text("nodesActionResultPreviews", String((actionRequests.totals && actionRequests.totals.readyResultPreviews) || 0) + " ready / pending " + String((actionRequests.totals && actionRequests.totals.pendingResultPreviews) || 0));
      text("nodesTransport", transport.state + " / " + String((transport.totals && transport.totals.dispatches) || 0) + " dispatch / blockers " + String((transport.totals && transport.totals.blockers) || 0));
      text("nodesTransportResults", String((transport.totals && transport.totals.results) || 0) + " received " + String((transport.totals && transport.totals.receivedResults) || 0));
      text("nodesTransportPolls", String((transport.totals && transport.totals.polls) || 0) + " polls / sessions " + String((transport.totals && transport.totals.activePollingSessions) || 0));
      text("nodesRunner", runner.state + " / control " + (runner.control ? runner.control.desiredState : "stopped"));
      text("nodesRunnerLoop", String((runner.totals && runner.totals.cycles) || 0) + " cycles / submitted " + String((runner.totals && runner.totals.submitted) || 0) + " / failed " + String((runner.totals && runner.totals.failed) || 0));
      text("nodesRunnerService", runnerService.state + " / blockers " + String(runnerServiceBlockerRows.length));
      text("nodesRunnerServiceInstall", String(runnerService.installState || "not-installed") + " / " + String(runnerService.manager || "manual"));
      text("nodesRunnerServiceCredentials", (runnerService.credentials && runnerService.credentials.source) || "missing");
      text("nodesRunnerServiceCanary", runnerServiceCanary.state + " / blockers " + String(runnerServiceCanaryBlockerRows.length));
      text("nodesRunnerServiceExecutor", String(runnerServiceCanary.executorMode || "disabled"));
      text("nodesRunnerServiceRollback", runnerServiceCanary.rollbackConfigured ? "configured" : "missing");
      text("nodesRunnerServiceCutover", String(runnerServiceCanary.cutoverStage || "shadow") + " / gate " + String(runnerServiceCanary.currentGateState || "missing"));
      text("nodesRunnerServiceActions", runnerServiceActions.state + " / pending " + String((runnerServiceActions.totals && runnerServiceActions.totals.pendingApproval) || 0));
      text("nodesRunnerServiceApprovals", String((runnerServiceActions.totals && runnerServiceActions.totals.approvals) || 0) + " / blocked " + String((runnerServiceActions.totals && runnerServiceActions.totals.blocked) || 0));
      text("nodesRunnerServiceExecutions", String((runnerServiceActions.totals && runnerServiceActions.totals.executed) || 0) + " executed / blocked " + String((runnerServiceActions.totals && runnerServiceActions.totals.blockedExecutions) || 0));
      text("nodesActionPolicy", actionRequests.policy.execution + " / file " + actionRequests.policy.fileRead + " / browser " + actionRequests.policy.browserRead);
      text("nodesFiles", fileCapability ? fileCapability.policy + " / " + fileCapability.state : "missing");
      const rows = document.getElementById("nodeRows");
      if (!rows) return;
      rows.textContent = "";
      const localRow = document.createElement("div");
      localRow.className = "route-row";
      localRow.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
      localRow.children[0].firstElementChild.textContent = snapshot.localNode.displayName;
      localRow.children[0].lastElementChild.textContent = snapshot.localNode.health;
      localRow.children[0].lastElementChild.classList.add(tagClass(snapshot.localNode.health));
      localRow.children[1].textContent = snapshot.localNode.nodeId + " / pid " + snapshot.localNode.processId;
      localRow.children[2].textContent = "heartbeat " + snapshot.localNode.heartbeatAt;
      rows.appendChild(localRow);
      for (const capability of capabilities) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = capability.label;
        row.children[0].lastElementChild.textContent = capability.policy;
        row.children[0].lastElementChild.classList.add(tagClass(capability.policy));
        row.children[1].textContent = capability.state + " / " + capability.id;
        row.children[2].textContent = capability.summary;
        rows.appendChild(row);
      }
      for (const root of safeRoots) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = root.id;
        row.children[0].lastElementChild.textContent = root.readable ? "readable" : "blocked";
        row.children[0].lastElementChild.classList.add(tagClass(root.readable ? "ready" : "blocked"));
        row.children[1].textContent = root.kind + " / write " + root.writeAccess;
        row.children[2].textContent = root.path;
        rows.appendChild(row);
      }
      const pairingRows = document.getElementById("pairingRows");
      if (!pairingRows) return;
      pairingRows.textContent = "";
      if (pairingRequests.length === 0) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong>no pairing requests</strong> <span class="tag">locked</span></div><span>token gate waiting</span><span>operator approval required</span>';
        row.children[0].lastElementChild.classList.add("tag-warn");
        pairingRows.appendChild(row);
      }
      for (const blocker of tokenGateBlockers.slice(0, 4)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">gate</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = blocker.id;
        row.children[0].lastElementChild.classList.add("tag-warn");
        row.children[1].textContent = blocker.summary;
        row.children[2].textContent = blocker.recovery;
        pairingRows.appendChild(row);
      }
      for (const approval of tokenGateApprovals.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">eligible</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = approval.displayName || approval.deviceId;
        row.children[0].lastElementChild.classList.add("tag-ready");
        row.children[1].textContent = approval.approvalId + " / " + approval.requestedRole;
        row.children[2].textContent = "token " + approval.tokenIssued + " / " + approval.requestId;
        pairingRows.appendChild(row);
      }
      for (const issue of canaryTokenIssues.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">canary</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = issue.tokenIssueId;
        row.children[0].lastElementChild.classList.add("tag-ready");
        row.children[1].textContent = issue.deviceId + " / " + issue.deliveryState;
        row.children[2].textContent = "secret " + issue.secretPersisted + " / material " + issue.tokenMaterialPersisted;
        pairingRows.appendChild(row);
      }
      for (const session of deviceSessionRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">session</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = session.sessionId;
        row.children[0].lastElementChild.classList.add(tagClass(session.state));
        row.children[1].textContent = session.deviceId + " / " + session.state;
        row.children[2].textContent = "scopes " + session.grantedScopes.join(",") + " / blocked " + session.blockedScopes.length;
        pairingRows.appendChild(row);
      }
      for (const request of actionRequestRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">request</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = request.requestId;
        row.children[0].lastElementChild.classList.add(tagClass(request.state));
        row.children[1].textContent = request.kind + " / " + request.state;
        row.children[2].textContent = "execution " + request.executionState + " / sideEffect " + request.sideEffectExecuted;
        pairingRows.appendChild(row);
      }
      for (const approval of actionApprovalRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">approval</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = approval.approvalId;
        row.children[0].lastElementChild.classList.add(tagClass(approval.decision));
        row.children[1].textContent = approval.kind + " / " + approval.decision;
        row.children[2].textContent = "execution " + approval.safety.executionEnabled + " / sideEffect " + approval.safety.sideEffectExecuted;
        pairingRows.appendChild(row);
      }
      for (const preview of actionResultPreviewRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">preview</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = preview.resultPreviewId;
        row.children[0].lastElementChild.classList.add(tagClass(preview.state));
        row.children[1].textContent = (preview.resultKind || preview.kind) + " / " + preview.state;
        row.children[2].textContent = preview.summary;
        pairingRows.appendChild(row);
      }
      for (const dispatch of transportDispatchRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">dispatch</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = dispatch.dispatchId;
        row.children[0].lastElementChild.classList.add(tagClass(dispatch.state));
        row.children[1].textContent = dispatch.kind + " / " + dispatch.deviceId;
        row.children[2].textContent = "poll / mutation " + dispatch.safety.mutationAllowed;
        pairingRows.appendChild(row);
      }
      for (const blocker of transportBlockerRows.slice(0, 4)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">transport</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = blocker.id;
        row.children[0].lastElementChild.classList.add("tag-warn");
        row.children[1].textContent = blocker.kind + " / " + blocker.deviceId;
        row.children[2].textContent = blocker.recovery;
        pairingRows.appendChild(row);
      }
      for (const result of transportResultRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">result</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = result.transportResultId;
        row.children[0].lastElementChild.classList.add(tagClass(result.state));
        row.children[1].textContent = result.resultKind + " / " + result.state;
        row.children[2].textContent = result.summary;
        pairingRows.appendChild(row);
      }
      for (const poll of transportPollRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">poll</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = poll.pollId;
        row.children[0].lastElementChild.classList.add(tagClass(poll.replay));
        row.children[1].textContent = poll.deviceId + " / " + poll.replay;
        row.children[2].textContent = "dispatches " + poll.dispatches + " / heartbeat " + poll.heartbeatAt;
        pairingRows.appendChild(row);
      }
      for (const result of runnerResultRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">runner</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = result.dispatchId;
        row.children[0].lastElementChild.classList.add(tagClass(result.state));
        row.children[1].textContent = result.kind + " / " + result.state;
        row.children[2].textContent = result.summary;
        pairingRows.appendChild(row);
      }
      for (const blocker of runnerServiceBlockerRows.slice(0, 4)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">service</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = blocker.id;
        row.children[0].lastElementChild.classList.add("tag-warn");
        row.children[1].textContent = blocker.summary;
        row.children[2].textContent = blocker.recovery;
        pairingRows.appendChild(row);
      }
      for (const command of runnerServiceCommandRows.slice(0, 3)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">service cmd</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = command.id;
        row.children[0].lastElementChild.classList.add(command.requiresApproval ? "tag-warn" : "tag-ready");
        row.children[1].textContent = command.label;
        row.children[2].textContent = command.command;
        pairingRows.appendChild(row);
      }
      for (const request of runnerServiceActionRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">service action</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = request.actionRequestId;
        row.children[0].lastElementChild.classList.add(tagClass(request.state));
        row.children[1].textContent = request.action + " / " + request.state;
        row.children[2].textContent = "mutation " + request.safety.serviceMutationExecuted + " / blockers " + request.blockers.length;
        pairingRows.appendChild(row);
      }
      for (const approval of runnerServiceApprovalRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">service approval</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = approval.approvalId;
        row.children[0].lastElementChild.classList.add(tagClass(approval.decision));
        row.children[1].textContent = approval.action + " / " + approval.decision;
        row.children[2].textContent = "execution " + approval.safety.executionEnabled + " / mutation " + approval.safety.serviceMutationExecuted;
        pairingRows.appendChild(row);
      }
      for (const execution of runnerServiceExecutionRows.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">service execution</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = execution.executionId;
        row.children[0].lastElementChild.classList.add(tagClass(execution.state));
        row.children[1].textContent = execution.action + " / " + execution.state;
        row.children[2].textContent = "runnerControl " + execution.safety.runnerControlWritten + " / serviceMutation " + execution.safety.serviceMutationExecuted;
        pairingRows.appendChild(row);
      }
      for (const blocker of runnerServiceCanaryBlockerRows.slice(0, 4)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag">service canary</span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = blocker.id;
        row.children[0].lastElementChild.classList.add("tag-warn");
        row.children[1].textContent = blocker.summary;
        row.children[2].textContent = blocker.recovery;
        pairingRows.appendChild(row);
      }
      for (const request of pairingRequests.slice(-6).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = request.displayName || request.deviceId;
        row.children[0].lastElementChild.textContent = request.state;
        row.children[0].lastElementChild.classList.add(tagClass(request.state));
        row.children[1].textContent = request.requestId + " / " + request.requestedRole;
        row.children[2].textContent = "token " + request.tokenIssued + " / expires " + request.expiresAt;
        pairingRows.appendChild(row);
      }
      for (const approval of pairingApprovals.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = approval.approvalId;
        row.children[0].lastElementChild.textContent = approval.stateAfterDecision;
        row.children[0].lastElementChild.classList.add(tagClass(approval.stateAfterDecision));
        row.children[1].textContent = approval.decision + " / " + approval.decidedBy;
        row.children[2].textContent = "token " + approval.tokenIssued + " / " + approval.requestId;
        pairingRows.appendChild(row);
      }
    };
    const emptyReplaySnapshot = (state) => ({
      state,
      totals: { sourceRuns: 0, filteredRuns: 0, events: 0 },
      filters: {},
      runs: []
    });
    const cleanReplayFilters = (filters) => ({
      runId: (filters && filters.runId) || "",
      sessionKey: (filters && filters.sessionKey) || "",
      conversationId: (filters && filters.conversationId) || "",
      channelId: (filters && filters.channelId) || ""
    });
    const readReplayFiltersFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      return cleanReplayFilters({
        runId: params.get("runId") || params.get("replayRunId") || "",
        sessionKey: params.get("sessionKey") || params.get("replaySessionKey") || "",
        conversationId: params.get("conversationId") || params.get("replayConversationId") || "",
        channelId: params.get("channelId") || params.get("replayChannelId") || ""
      });
    };
    const hasReplayFilters = (filters) => Boolean(filters.runId || filters.sessionKey || filters.conversationId || filters.channelId);
    let activeReplayFilters = readReplayFiltersFromLocation();
    const writeReplayFiltersToLocation = (filters) => {
      const nextUrl = new URL(window.location.href);
      nextUrl.pathname = "/mission-control/activity";
      for (const key of ["runId", "sessionKey", "conversationId", "channelId"]) {
        if (filters[key]) {
          nextUrl.searchParams.set(key, filters[key]);
        } else {
          nextUrl.searchParams.delete(key);
        }
      }
      window.history.pushState({ view: "activity" }, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
      setActiveView("activity");
    };
    const replayUrl = (filters, options) => {
      const selectedFilters = cleanReplayFilters(filters);
      const query = new URLSearchParams();
      query.set("limit", (options && options.limit) || "8");
      query.set("events", (options && options.events) || "20");
      if (selectedFilters.runId) query.set("runId", selectedFilters.runId);
      if (selectedFilters.sessionKey) query.set("sessionKey", selectedFilters.sessionKey);
      if (selectedFilters.conversationId) query.set("conversationId", selectedFilters.conversationId);
      if (selectedFilters.channelId) query.set("channelId", selectedFilters.channelId);
      return "/api/neon-replay?" + query.toString();
    };
    const appendReplayButton = (target, filters, label) => {
      const button = document.createElement("button");
      button.className = "button replay-inline";
      button.type = "button";
      button.textContent = label;
      if (filters.runId) button.setAttribute("data-replay-run-id", filters.runId);
      if (filters.sessionKey) button.setAttribute("data-replay-session-key", filters.sessionKey);
      if (filters.conversationId) button.setAttribute("data-replay-conversation-id", filters.conversationId);
      if (filters.channelId) button.setAttribute("data-replay-channel-id", filters.channelId);
      target.appendChild(button);
    };
    const normalizeActivityNeedle = (value) => String(value || "").trim().toLowerCase();
    const cleanActivityFilters = (filters) => ({
      query: (filters && filters.query) || "",
      status: (filters && filters.status) || "",
      agentId: (filters && filters.agentId) || ""
    });
    const readActivityFiltersFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      return cleanActivityFilters({
        query: params.get("activityQuery") || "",
        status: params.get("activityStatus") || "",
        agentId: params.get("activityAgent") || params.get("activityAgentId") || ""
      });
    };
    let lastActivitySnapshot = null;
    let activityFilters = readActivityFiltersFromLocation();
    const writeActivityFiltersToLocation = () => {
      const nextUrl = new URL(window.location.href);
      for (const [param, value] of [
        ["activityQuery", activityFilters.query],
        ["activityStatus", activityFilters.status],
        ["activityAgent", activityFilters.agentId]
      ]) {
        if (value) {
          nextUrl.searchParams.set(param, value);
        } else {
          nextUrl.searchParams.delete(param);
        }
      }
      window.history.replaceState({ view: normalizeView("activity") }, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
    };
    const updateActivityFilters = (nextFilters) => {
      activityFilters = cleanActivityFilters({ ...activityFilters, ...nextFilters });
      writeActivityFiltersToLocation();
      rerenderActivity();
    };
    const activityEntryMatches = (entry) => {
      if (activityFilters.status && entry.status !== activityFilters.status) return false;
      if (activityFilters.agentId && entry.agentId !== activityFilters.agentId) return false;
      const needle = normalizeActivityNeedle(activityFilters.query);
      if (!needle) return true;
      return [
        entry.title,
        entry.status,
        entry.kind,
        entry.agentId,
        entry.channel,
        entry.channelId,
        entry.runId,
        entry.sessionKey,
        entry.summary,
        entry.preview,
        entry.deliveryState,
        entry.runStatus
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    };
    const uniqueActivityValues = (entries, key) => {
      return [...new Set(entries.map((entry) => entry[key]).filter(Boolean))].sort();
    };
    const renderActivitySelect = (id, allLabel, values, selectedValue) => {
      const select = document.getElementById(id);
      if (!select) return;
      const optionValues = selectedValue && !values.includes(selectedValue) ? [selectedValue, ...values] : values;
      select.textContent = "";
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = allLabel;
      select.appendChild(allOption);
      for (const value of optionValues) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = selectedValue;
    };
    const syncActivityControls = (entries) => {
      const searchInput = document.getElementById("activitySearchInput");
      if (searchInput && searchInput.value !== activityFilters.query) {
        searchInput.value = activityFilters.query;
      }
      renderActivitySelect("activityStatusFilter", "Alle Status", uniqueActivityValues(entries, "status"), activityFilters.status);
      renderActivitySelect("activityAgentFilter", "Alle Agenten", uniqueActivityValues(entries, "agentId"), activityFilters.agentId);
    };
    const rerenderActivity = () => {
      if (lastActivitySnapshot) {
        renderActivity(lastActivitySnapshot);
      }
    };
    const loadReplay = (filters, options) => {
      activeReplayFilters = cleanReplayFilters(filters);
      text("replaySummary", "loading replay");
      if (!options || options.persist !== false) {
        writeReplayFiltersToLocation(activeReplayFilters);
      } else if (hasReplayFilters(activeReplayFilters)) {
        setActiveView("activity");
      }
      return fetch(replayUrl(activeReplayFilters, { limit: "8", events: "20" }))
        .then((response) => response.ok ? response.json() : emptyReplaySnapshot("not-found"))
        .then((snapshot) => {
          renderReplay(snapshot);
        })
        .catch(() => {
          renderReplay(emptyReplaySnapshot("error"));
        });
    };
    const normalizeSessionNeedle = (value) => String(value || "").trim().toLowerCase();
    const cleanSessionFilters = (filters) => ({
      query: (filters && filters.query) || "",
      status: (filters && filters.status) || "",
      agentId: (filters && filters.agentId) || ""
    });
    const readSessionFiltersFromLocation = () => {
      const params = new URLSearchParams(window.location.search);
      return cleanSessionFilters({
        query: params.get("sessionQuery") || "",
        status: params.get("sessionStatus") || "",
        agentId: params.get("sessionAgent") || params.get("sessionAgentId") || ""
      });
    };
    let lastSessionsSnapshot = null;
    let sessionFilters = readSessionFiltersFromLocation();
    const writeSessionFiltersToLocation = () => {
      const nextUrl = new URL(window.location.href);
      for (const [param, value] of [
        ["sessionQuery", sessionFilters.query],
        ["sessionStatus", sessionFilters.status],
        ["sessionAgent", sessionFilters.agentId]
      ]) {
        if (value) {
          nextUrl.searchParams.set(param, value);
        } else {
          nextUrl.searchParams.delete(param);
        }
      }
      window.history.replaceState({ view: normalizeView("sessions") }, "", nextUrl.pathname + nextUrl.search + nextUrl.hash);
    };
    const updateSessionFilters = (nextFilters) => {
      sessionFilters = cleanSessionFilters({ ...sessionFilters, ...nextFilters });
      writeSessionFiltersToLocation();
      rerenderSessions();
    };
    const sessionMatches = (session) => {
      if (sessionFilters.status && session.latestRunStatus !== sessionFilters.status) return false;
      if (sessionFilters.agentId && session.agentId !== sessionFilters.agentId) return false;
      const needle = normalizeSessionNeedle(sessionFilters.query);
      if (!needle) return true;
      return [
        session.key,
        session.title,
        session.channel,
        session.accountId,
        session.guildId,
        session.channelId,
        session.threadId,
        session.agentId,
        session.mode,
        session.workspaceName,
        session.userId,
        session.userDisplayName,
        session.latestRunId,
        session.latestRunStatus,
        session.latestMemoryState,
        session.latestDeliveryState,
        session.latestPreview
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    };
    const uniqueSessionValues = (sessions, key) => {
      return [...new Set(sessions.map((session) => session[key]).filter(Boolean))].sort();
    };
    const renderSessionSelect = (id, allLabel, values, selectedValue) => {
      const select = document.getElementById(id);
      if (!select) return;
      const optionValues = selectedValue && !values.includes(selectedValue) ? [selectedValue, ...values] : values;
      select.textContent = "";
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = allLabel;
      select.appendChild(allOption);
      for (const value of optionValues) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
      }
      select.value = selectedValue;
    };
    const syncSessionControls = (sessions) => {
      const searchInput = document.getElementById("sessionSearchInput");
      if (searchInput && searchInput.value !== sessionFilters.query) {
        searchInput.value = sessionFilters.query;
      }
      renderSessionSelect("sessionStatusFilter", "Alle Status", uniqueSessionValues(sessions, "latestRunStatus"), sessionFilters.status);
      renderSessionSelect("sessionAgentFilter", "Alle Agenten", uniqueSessionValues(sessions, "agentId"), sessionFilters.agentId);
    };
    const rerenderSessions = () => {
      if (lastSessionsSnapshot) {
        renderSessions(lastSessionsSnapshot);
      }
    };
    const renderSessions = (snapshot) => {
      lastSessionsSnapshot = snapshot;
      const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
      const filteredSessions = sessions.filter(sessionMatches);
      text("navRuns", String(snapshot.totals.sessions || snapshot.totals.runs));
      text("sessionSummary", snapshot.state + " / " + snapshot.totals.sessions + " sessions / " + filteredSessions.length + " sichtbar");
      text("sessionVisibleCount", String(filteredSessions.length) + " / " + String(sessions.length) + " sichtbar");
      syncSessionControls(sessions);
      const rows = document.getElementById("sessionRows");
      const empty = document.getElementById("sessionEmptyState");
      if (!rows || !empty) return;
      rows.textContent = "";
      empty.hidden = filteredSessions.length > 0;
      empty.textContent = sessions.length === 0 ? "Keine Sitzungen." : "Keine Sitzungen passen zur aktuellen Auswahl.";
      for (const session of filteredSessions.slice(0, 20)) {
        const tr = document.createElement("tr");
        tr.innerHTML =
          '<td><div class="mono"></div><span></span></td>' +
          '<td><span class="tag"></span></td>' +
          '<td><span class="tag shadow"></span></td>' +
          '<td></td>' +
          '<td><span class="tag"></span> <span class="tag"></span></td>';
        tr.children[0].firstElementChild.textContent = session.key;
        tr.children[0].lastElementChild.textContent = session.title;
        tr.children[1].firstElementChild.textContent = session.latestRunStatus;
        tr.children[1].firstElementChild.classList.add(tagClass(session.latestRunStatus));
        tr.children[2].firstElementChild.textContent = String(session.runCount);
        tr.children[3].textContent = session.agentId;
        tr.children[4].children[0].textContent = session.latestMemoryState;
        tr.children[4].children[0].classList.add(tagClass(session.latestMemoryState));
        tr.children[4].children[1].textContent = session.latestDeliveryState;
        tr.children[4].children[1].classList.add(tagClass(session.latestDeliveryState));
        appendReplayButton(tr.children[0], { sessionKey: session.key }, "Replay");
        rows.appendChild(tr);
      }
    };
    const renderActivity = (snapshot) => {
      lastActivitySnapshot = snapshot;
      const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
      const filteredEntries = entries.filter(activityEntryMatches);
      text("navRoutes", snapshot.state);
      text("activitySummary", snapshot.state + " / " + snapshot.totals.entries + " entries / " + filteredEntries.length + " sichtbar");
      text("activityState", snapshot.state);
      text("activityEntries", String(snapshot.totals.entries));
      text("activityRuns", String(snapshot.totals.runs));
      text("activityErrors", String(snapshot.totals.errors));
      text("activityVisibleCount", String(filteredEntries.length) + " / " + String(entries.length) + " sichtbar");
      syncActivityControls(entries);
      const rows = document.getElementById("activityRows");
      if (!rows) return;
      rows.textContent = "";
      if (filteredEntries.length === 0) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong>Keine Activity</strong> <span class="tag">empty</span></div><span>Filter</span><span>Keine Gateway-Events passen zur aktuellen Auswahl.</span>';
        row.children[0].lastElementChild.classList.add("warn");
        rows.appendChild(row);
        return;
      }
      for (const entry of filteredEntries.slice(0, 20)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = entry.title;
        row.children[0].lastElementChild.textContent = entry.status;
        row.children[0].lastElementChild.classList.add(tagClass(entry.status));
        row.children[1].textContent = entry.kind + " / " + entry.agentId + " / " + entry.runId + " ";
        appendReplayButton(row.children[1], { runId: entry.runId }, "Replay");
        row.children[2].textContent = entry.summary;
        rows.appendChild(row);
      }
    };
    const renderReplay = (snapshot) => {
      const runs = Array.isArray(snapshot.runs) ? snapshot.runs : [];
      const latest = runs[0];
      const filters = snapshot.filters || {};
      const filterLabel = [filters.runId, filters.sessionKey, filters.conversationId, filters.channelId].filter(Boolean).join(" / ");
      text("replaySummary", snapshot.state + " / " + String((snapshot.totals && snapshot.totals.filteredRuns) || runs.length) + " runs" + (filterLabel ? " / " + filterLabel : ""));
      text("replayEvents", String((snapshot.totals && snapshot.totals.events) || 0));
      const detail = document.getElementById("replayDetail");
      if (detail) {
        detail.textContent = "";
        if (latest) {
          const detailLine = (label, value, tagValue) => {
            const row = document.createElement("div");
            row.className = "route-row";
            const head = document.createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = label;
            head.appendChild(strong);
            if (tagValue) {
              head.appendChild(document.createTextNode(" "));
              const tag = document.createElement("span");
              tag.className = "tag";
              tag.textContent = tagValue;
              tag.classList.add(tagClass(tagValue));
              head.appendChild(tag);
            }
            const valueCell = document.createElement("span");
            valueCell.textContent = value;
            const spacerCell = document.createElement("span");
            spacerCell.textContent = "";
            row.appendChild(head);
            row.appendChild(valueCell);
            row.appendChild(spacerCell);
            detail.appendChild(row);
          };
          const durationMs = typeof latest.durationMs === "number" ? latest.durationMs : 0;
          detailLine("run", latest.runId, latest.status);
          detailLine("mode", String(latest.mode || "unknown") + " / " + String(latest.channel || "unknown"));
          detailLine("memory", String(latest.memoryState || "unknown"), latest.memoryState);
          detailLine("delivery", String(latest.deliveryState || "unknown"), latest.deliveryState);
          detailLine("agent", String(latest.agentId || "unknown") + " / " + String(latest.sessionKey || ""));
          detailLine("events", String(latest.eventCount || 0) + " events");
          detailLine("started", String(latest.startedAt || "") + " -> " + String(latest.completedAt || "") + " (" + String(durationMs) + " ms)");
          detailLine("content", String(latest.inboundPreview || "(empty)"));
          detailLine("final", String(latest.finalPreview || "(empty)"));
          const suspiciousFindings = Array.isArray(latest.suspiciousFindings) ? latest.suspiciousFindings : [];
          const suspiciousValue = suspiciousFindings.length > 0
            ? suspiciousFindings.map((finding) => String(finding.id) + " x" + String(finding.count)).join(", ")
            : "none";
          const suspiciousTag = suspiciousFindings.length > 0 ? "warn" : "";
          detailLine("suspicious", suspiciousValue, suspiciousTag);
        }
      }
      const rows = document.getElementById("replayRows");
      if (!rows) return;
      rows.textContent = "";
      if (!latest) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong>no replay</strong> <span class="tag">empty</span></div><span>Gateway history</span><span>waiting for stored runs</span>';
        row.children[0].lastElementChild.classList.add("tag-warn");
        rows.appendChild(row);
        return;
      }
      const header = document.createElement("div");
      header.className = "route-row";
      header.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
      header.children[0].firstElementChild.textContent = latest.runId;
      header.children[0].lastElementChild.textContent = latest.status;
      header.children[0].lastElementChild.classList.add(tagClass(latest.status));
      header.children[1].textContent = latest.channel + " / " + latest.agentId + " / " + latest.eventCount + " events";
      header.children[2].textContent = latest.sessionKey;
      rows.appendChild(header);
      for (const event of latest.events.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = event.title;
        row.children[0].lastElementChild.textContent = event.status;
        row.children[0].lastElementChild.classList.add(tagClass(event.status));
        row.children[1].textContent = "#" + String(event.sequence) + " / " + event.kind;
        row.children[2].textContent = event.preview || event.summary;
        rows.appendChild(row);
      }
    };
    const renderDeliveryQueue = (snapshot) => {
      const totals = snapshot.totals || {};
      const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
      const approvals = Array.isArray(snapshot.approvals) ? snapshot.approvals : [];
      const queuedDryRuns = totals.queuedDryRuns || 0;
      const blocked = totals.blocked || 0;
      const approvalRecords = totals.approvalRecords || approvals.length;
      text("metricDeliveryQueue", String(queuedDryRuns));
      text("deliveryQueueSummary", queuedDryRuns + " queued / " + blocked + " blocked / " + approvalRecords + " approvals");
      text("deliveryApprovalSummary", approvalRecords + " recorded / outbound suppressed");
      const rows = document.getElementById("deliveryQueueRows");
      if (rows) {
        rows.textContent = "";
      }
      for (const candidate of candidates.slice(-6).reverse()) {
        if (!rows) break;
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = candidate.id;
        row.children[0].lastElementChild.textContent = candidate.state;
        row.children[0].lastElementChild.classList.add(tagClass(candidate.state));
        row.children[1].textContent = candidate.target.channel + "/" + candidate.target.channelId + " / outbound " + candidate.safety.outboundSent;
        row.children[2].textContent = candidate.finalTextPreview || candidate.reason;
        rows.appendChild(row);
      }
      const approvalRows = document.getElementById("deliveryApprovalRows");
      if (!approvalRows) return;
      approvalRows.textContent = "";
      if (approvals.length === 0) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong>no approvals recorded</strong> <span class="tag">shadow</span></div><span>approval audit empty</span><span>outbound suppressed</span>';
        row.children[0].lastElementChild.classList.add("tag-warn");
        approvalRows.appendChild(row);
        return;
      }
      for (const approval of approvals.slice(-6).reverse()) {
        const row = document.createElement("div");
        row.className = "route-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = approval.approvalId;
        row.children[0].lastElementChild.textContent = approval.decision;
        row.children[0].lastElementChild.classList.add(tagClass(approval.decision));
        row.children[1].textContent = approval.candidateId + " / " + approval.runId;
        row.children[2].textContent = "outbound " + approval.outboundSent + " / " + approval.decidedBy;
        approvalRows.appendChild(row);
      }
    };
    const renderSkills = (snapshot) => {
      text("navOnboarding", String(snapshot.totals.availableSkills || snapshot.totals.skills));
      text("skillsSummary", snapshot.state + " / " + snapshot.totals.skills + " skills / " + snapshot.totals.extensionManifests + " extensions");
      text("skillsRoots", snapshot.totals.readableRoots + "/" + snapshot.totals.roots);
      text("skillsCount", String(snapshot.totals.skills));
      text("extensionsCount", String(snapshot.totals.extensionManifests));
      text("skillsTrust", "upstream " + snapshot.totals.referenceExtensions + " reference-only");
      const rootRows = document.getElementById("skillRootRows");
      const skillRows = document.getElementById("skillRows");
      const extensionRows = document.getElementById("extensionRows");
      if (rootRows) {
        rootRows.textContent = "";
        for (const root of snapshot.roots.filter((entry) => entry.readable).slice(0, 8)) {
          const row = document.createElement("div");
          row.className = "route-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
          row.children[0].firstElementChild.textContent = root.label;
          row.children[0].lastElementChild.textContent = root.trust;
          row.children[0].lastElementChild.classList.add(tagClass(root.trust));
          row.children[1].textContent = root.kind + " / " + root.discoveredSkillFiles + " skills";
          row.children[2].textContent = root.path;
          rootRows.appendChild(row);
        }
      }
      if (skillRows) {
        skillRows.textContent = "";
        for (const skill of snapshot.skills.slice(0, 12)) {
          const row = document.createElement("div");
          row.className = "route-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
          row.children[0].firstElementChild.textContent = skill.name;
          row.children[0].lastElementChild.textContent = skill.loadState;
          row.children[0].lastElementChild.classList.add(tagClass(skill.loadState));
          row.children[1].textContent = skill.sourceKind + " / " + skill.rootLabel;
          row.children[2].textContent = skill.description || skill.filePath;
          skillRows.appendChild(row);
        }
      }
      if (extensionRows) {
        extensionRows.textContent = "";
        for (const extension of snapshot.extensions.slice(0, 12)) {
          const row = document.createElement("div");
          row.className = "route-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
          row.children[0].firstElementChild.textContent = extension.name || extension.id;
          row.children[0].lastElementChild.textContent = extension.loadState;
          row.children[0].lastElementChild.classList.add(tagClass(extension.loadState));
          row.children[1].textContent = "channels " + extension.capabilities.channels + " / providers " + extension.capabilities.providers + " / skills " + extension.capabilities.skills;
          row.children[2].textContent = extension.description || extension.manifestPath;
          extensionRows.appendChild(row);
        }
      }
    };
    const renderPlugins = (snapshot) => {
      text("pluginsSummary", snapshot.state + " / " + snapshot.totals.plugins + " plugins");
      text("pluginsCount", String(snapshot.totals.plugins));
      text("pluginsGate", (snapshot.installGate.enabled ? "enabled" : "disabled") + " (" + snapshot.installGate.flag + ")");
      text("pluginsAutoLoad", snapshot.totals.autoLoadDeclared + " declared / " + snapshot.totals.autoLoadHonored + " honored");
      text("pluginsTrust", snapshot.totals.referenceOnly + " reference-only / " + snapshot.totals.allowlisted + " allowlisted / " + snapshot.totals.blocked + " blocked");
      const pluginRows = document.getElementById("pluginRows");
      if (pluginRows) {
        pluginRows.textContent = "";
        for (const plugin of snapshot.plugins.slice(0, 12)) {
          const row = document.createElement("div");
          row.className = "route-row";
          row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
          row.children[0].firstElementChild.textContent = plugin.name || plugin.id;
          row.children[0].lastElementChild.textContent = plugin.trustLevel;
          row.children[0].lastElementChild.classList.add(tagClass(plugin.trustLevel));
          row.children[1].textContent = "install " + plugin.installDecision + (plugin.autoLoadOnStartup ? " / auto-load ignored" : "");
          row.children[2].textContent = "cmds " + plugin.counts.commands + " / channels " + plugin.counts.channels + " / tools " + plugin.counts.tools;
          pluginRows.appendChild(row);
        }
      }
    };
    const renderChat = (snapshot) => {
      text("navChat", snapshot.state);
      text("chatSummary", snapshot.state + " / " + snapshot.totals.conversations + " threads");
      text("chatThreadCount", String(snapshot.totals.conversations));
      text("chatMessageCount", String(snapshot.totals.messages));
      text("chatSource", snapshot.source.runsPath);
      const rows = document.getElementById("chatRows");
      const messages = document.getElementById("chatMessageRows");
      const recent = document.getElementById("recentSessions");
      if (!rows || !messages) return;
      rows.textContent = "";
      messages.textContent = "";
      if (recent) {
        recent.textContent = "";
      }
      const activeConversation = snapshot.conversations[0];
      if (activeConversation) {
        text("activeSessionLabel", activeConversation.title);
      }
      for (const conversation of snapshot.conversations.slice(0, 8)) {
        const row = document.createElement("div");
        row.className = "chat-conversation" + (conversation === activeConversation ? " active" : "");
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = conversation.title;
        row.children[0].lastElementChild.textContent = conversation.channel;
        row.children[1].textContent = conversation.runCount + " runs / " + conversation.messageCount + " messages ";
        appendReplayButton(row.children[1], { conversationId: conversation.conversationId, channelId: conversation.channelId }, "Replay");
        row.children[2].textContent = conversation.latestAt;
        rows.appendChild(row);
        if (recent) {
          const recentRow = document.createElement("a");
          recentRow.className = "recent-session" + (conversation === activeConversation ? " active" : "");
          recentRow.href = "/mission-control/chat";
          recentRow.setAttribute("data-view", "chat");
          recentRow.innerHTML =
            '<span class="recent-dot" aria-hidden="true"></span>' +
            '<span class="recent-copy"><span class="recent-name"></span><span class="recent-meta"></span></span>';
          recentRow.querySelector(".recent-name").textContent = conversation.title;
          recentRow.querySelector(".recent-meta").textContent = conversation.latestAt || "just now";
          recent.appendChild(recentRow);
        }
      }
      if (!activeConversation) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Keine Gateway-Chats.";
        messages.appendChild(empty);
        return;
      }
      for (const message of activeConversation.messages.slice(-10)) {
        const row = document.createElement("div");
        const isAgent = message.direction === "agent";
        row.className = "chat-message " + (isAgent ? "agent" : "user");
        const avatar = document.createElement("div");
        avatar.className = "chat-avatar";
        avatar.textContent = isAgent ? "CL" : "NK";
        const bubble = document.createElement("div");
        bubble.className = "chat-bubble";
        const title = document.createElement("strong");
        title.textContent = isAgent ? message.agentId : message.userDisplayName || message.userId;
        const body = document.createElement("p");
        body.textContent = message.textPreview;
        const meta = document.createElement("div");
        meta.className = "chat-meta";
        meta.textContent = message.createdAt + " / " + message.status + " / memory " + message.memoryState;
        appendReplayButton(meta, { runId: message.runId }, "Replay");
        bubble.append(title, body, meta);
        row.append(avatar, bubble);
        messages.appendChild(row);
      }
    };
    const renderCutover = (snapshot) => {
      text("navCutover", snapshot.state);
      text("cutoverSummary", snapshot.state + " / " + snapshot.currentStage + " -> " + (snapshot.nextStage || "none"));
      text("cutoverState", snapshot.state);
      text("cutoverCurrent", snapshot.currentStage);
      text("cutoverNext", snapshot.nextStage || "none");
      text("cutoverRollback", snapshot.source.rollbackConfigured ? "configured" : "missing");
      text("configCutover", snapshot.currentStage + " -> " + (snapshot.nextStage || "none"));
      const rows = document.getElementById("cutoverRows");
      if (!rows) return;
      rows.textContent = "";
      for (const gate of snapshot.gates) {
        const row = document.createElement("div");
        row.className = "cutover-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = gate.label;
        row.children[0].lastElementChild.textContent = gate.state;
        row.children[0].lastElementChild.classList.add(tagClass(gate.state));
        row.children[1].textContent = gate.summary;
        row.children[2].textContent = gate.rollback;
        rows.appendChild(row);
      }
    };
    const renderMirror = (snapshot) => {
      text("navMirror", snapshot.state);
      text("mirrorSummary", snapshot.state + " / " + snapshot.totals.records + " records");
      text("mirrorState", snapshot.state);
      text("mirrorAccepted", String(snapshot.totals.accepted));
      text("mirrorDrift", String(snapshot.totals.drift));
      text("mirrorLatest", snapshot.latestRecord ? snapshot.latestRecord.evidenceId : "none");
      const rows = document.getElementById("mirrorRows");
      if (!rows) return;
      rows.textContent = "";
      for (const record of snapshot.records.slice(-4).reverse()) {
        const row = document.createElement("div");
        row.className = "cutover-row";
        row.innerHTML = '<div><strong></strong> <span class="tag"></span></div><span></span><span></span>';
        row.children[0].firstElementChild.textContent = record.evidenceId;
        row.children[0].lastElementChild.textContent = record.verdict;
        row.children[0].lastElementChild.classList.add(tagClass(record.verdict));
        row.children[1].textContent = record.promptPreview;
        row.children[2].textContent = "latency delta " + (record.latencyDeltaMs ?? "n/a") + "ms";
        rows.appendChild(row);
      }
    };
    const refresh = () => {
      return Promise.all([
        fetch("/api/neon-mission-control/gateway?limit=8").then((response) => response.ok ? response.json() : initialSnapshot),
        fetch("/api/neon-agents").then((response) => response.ok ? response.json() : { state: "ready", defaultAgentId: "chaty", agents: [] }),
        fetch("/api/neon-doctor").then((response) => response.ok ? response.json() : { state: "warn", currentStage: "shadow", totals: { pass: 0, warn: 1, fail: 0 }, checks: [] }),
        fetch("/api/neon-onboarding").then((response) => response.ok ? response.json() : { state: "needs-action", readyForDiscordSmoke: false, configPreview: { command: "discord-shadow-tap", secretsPrinted: false }, steps: [] }),
        fetch("/api/neon-automation").then((response) => response.ok ? response.json() : { state: "ready", policy: "shadow-read-only", totals: { jobs: 0, hooks: 0, dreams: 0, enabled: 0, disabled: 0 }, jobs: [], hooks: [], dreams: [] }),
        fetch("/api/neon-gateway/lifecycle").then((response) => response.ok ? response.json() : { state: "unknown", eventSeq: 0 }),
        fetch("/api/neon-chat/conversations?limit=40").then((response) => response.ok ? response.json() : { state: "empty", totals: { conversations: 0, messages: 0, runs: 0 }, source: { runsPath: "unavailable" }, conversations: [] }),
        fetch("/api/neon-delivery/queue?limit=50").then((response) => response.ok ? response.json() : { state: "ready", totals: { candidates: 0, queuedDryRuns: 0, blocked: 0, approvalRecords: 0 }, candidates: [], approvals: [] }),
        fetch("/api/neon-sessions?limit=100").then((response) => response.ok ? response.json() : { state: "empty", totals: { sessions: 0, runs: 0, completedRuns: 0, failedRuns: 0, suppressedDeliveries: 0 }, sessions: [] }),
        fetch("/api/neon-activity?limit=100").then((response) => response.ok ? response.json() : { state: "empty", totals: { entries: 0, runs: 0, running: 0, done: 0, errors: 0 }, entries: [] }),
        fetch(replayUrl(activeReplayFilters, { limit: "8", events: "12" })).then((response) => response.ok ? response.json() : { state: "empty", totals: { sourceRuns: 0, filteredRuns: 0, events: 0 }, filters: {}, runs: [] }),
        fetch("/api/neon-skills").then((response) => response.ok ? response.json() : { state: "empty", totals: { roots: 0, readableRoots: 0, skills: 0, availableSkills: 0, shadowedSkills: 0, invalidSkills: 0, referenceSkills: 0, extensionManifests: 0, invalidExtensionManifests: 0, referenceExtensions: 0 }, roots: [], skills: [], extensions: [] }),
        fetch("/api/neon-gateway/routes").then((response) => response.ok ? response.json() : { state: "needs-config", discord: { accountId: "default", agentId: "chaty", botUserIdPresent: false, mentionPolicy: "guild", harnessMode: "dry" }, allowlist: { guilds: { count: 0, configured: false, entries: [], omittedCount: 0 }, channels: { count: 0, configured: false, entries: [], omittedCount: 0 } }, authStatus: [], routes: [], recovery: [] }),
        fetch("/api/neon-nodes").then((response) => response.ok ? response.json() : { state: "partial", localNode: { nodeId: "local-unavailable", displayName: "Local Neonika", platform: "unknown", arch: "unknown", processId: 0, health: "degraded", heartbeatAt: "unavailable" }, pairing: { state: "locked", approval: "operator-required" }, pairingTokenGate: { state: "locked", cutoverStage: "shadow", currentGateState: "missing", totals: { eligibleApprovals: 0, blockers: 0 }, blockers: [], eligibleApprovals: [], invariants: [] }, pairingCanaryTokens: { state: "locked", totals: { issued: 0, active: 0, expired: 0 }, deliveryPolicy: { rawTokenPersistence: "disabled", rawTokenHttpExposure: "disabled", rawTokenCliEcho: "disabled" }, issues: [] }, deviceSessions: { state: "locked", totals: { sessions: 0, active: 0, expired: 0, blockedScopes: 0 }, policy: { actionPolicy: { fileTransfer: "approval-required", browser: "approval-required", commandExecution: "disabled" } }, sessions: [] }, actionRequests: { state: "empty", totals: { requests: 0, recorded: 0, approvalRequired: 0, blocked: 0, approvalRecords: 0, pendingApproval: 0, resultPreviews: 0, readyResultPreviews: 0, blockedResultPreviews: 0, pendingResultPreviews: 0 }, policy: { execution: "disabled", fileRead: "approval-required", browserRead: "approval-required" }, requests: [], approvals: [], resultPreviews: [] }, transport: { state: "empty", totals: { approvedActions: 0, dispatches: 0, blockers: 0, results: 0, receivedResults: 0, blockedResults: 0, polls: 0, activePollingSessions: 0, pendingDispatches: 0, previewedApprovals: 0, ingestedApprovals: 0, unsupportedActions: 0, unsafeTargets: 0 }, policy: { mode: "poll-only", approval: "operator-approved-actions-only", mutationAllowed: false, rawTokenExposure: "disabled", sessionSecretExposure: "disabled", resultIngest: "bounded-audit" }, dispatches: [], blockers: [], results: [], polls: [] }, runner: { state: "stopped", control: { desiredState: "stopped", updatedAt: "never", operatorId: "system", reason: "not started" }, totals: { cycles: 0, pollRequests: 0, dispatches: 0, submitted: 0, blocked: 0, failed: 0 }, results: [], safety: { mutationExecuted: false, sideEffectExecuted: false, rawOutputPersisted: false, rawTokenPersisted: false, sessionSecretPersisted: false } }, gatewayUrl: "", totals: { nodes: 0, onlineNodes: 0, pairingRequests: 0, pendingPairingRequests: 0, pairingApprovals: 0, pairingCanaryTokens: 0, deviceSessions: 0, actionRequests: 0, transportDispatches: 0, transportResults: 0, transportPolls: 0, runnerCycles: 0, runnerSubmitted: 0, runnerFailed: 0 }, capabilities: [], safeRoots: [], pairingRequests: [], pairingApprovals: [] }),
        fetch("/api/neon-cutover").then((response) => response.ok ? response.json() : { state: "needs-evidence", currentStage: "shadow", nextStage: "mirror", source: { rollbackConfigured: false }, gates: [] }),
        fetch("/api/neon-mirror/evidence?limit=8").then((response) => response.ok ? response.json() : { state: "needs-evidence", totals: { records: 0, accepted: 0, drift: 0, failed: 0 }, records: [] }),
        fetch("/api/neon-plugins").then((response) => response.ok ? response.json() : { state: "empty", installGate: { enabled: false, flag: "NEON_PLUGIN_INSTALL_ENABLED" }, totals: { plugins: 0, referenceOnly: 0, allowlisted: 0, blocked: 0, autoLoadDeclared: 0, autoLoadHonored: 0, withCommands: 0, withChannels: 0, invalidManifests: 0 }, plugins: [] })
      ]).then(([gateway, agents, doctor, onboarding, automation, lifecycle, chat, deliveryQueue, sessions, activity, replay, skills, routes, nodes, cutover, mirror, plugins]) => {
        renderGateway(gateway);
        renderAgents(agents);
        renderDoctor(doctor);
        renderOnboarding(onboarding);
        renderAutomation(automation);
        renderLifecycle(lifecycle);
        renderChat(chat);
        renderDeliveryQueue(deliveryQueue);
        renderSessions(sessions);
        renderActivity(activity);
        renderReplay(replay);
        renderSkills(skills);
        renderRoutes(routes);
        renderNodes(nodes);
        renderCutover(cutover);
        renderMirror(mirror);
        renderPlugins(plugins);
      }).catch(() => {
        renderGateway(initialSnapshot);
      });
    };
    const startLifecycleEvents = () => {
      if (!("EventSource" in window)) {
        text("lifecycleState", "polling");
        return;
      }
      const stream = new EventSource("/api/neon-gateway/events");
      const handleEvent = (event) => {
        try {
          const frame = JSON.parse(event.data);
          renderLifecycle(frame.payload);
        } catch {
          text("lifecycleState", "event-error");
        }
      };
      for (const eventName of [
        "neon.gateway.ready",
        "neon.gateway.snapshot",
        "neon.gateway.heartbeat",
        "neon.gateway.closing",
        "neon.gateway.closed"
      ]) {
        stream.addEventListener(eventName, handleEvent);
      }
      stream.onerror = () => {
        text("lifecycleState", "reconnecting");
      };
    };
    renderShellEndpoints();
    setActiveView(activeHashView());
    renderGateway(initialSnapshot);
    refresh();
    startLifecycleEvents();
    document.getElementById("refreshButton")?.addEventListener("click", () => {
      void refresh();
    });
    document.getElementById("connectButton")?.addEventListener("click", () => {
      void refresh();
    });
    document.getElementById("copyWsButton")?.addEventListener("click", () => {
      copyText(formatGatewayWsUrl());
    });
    document.getElementById("copyEventStreamButton")?.addEventListener("click", () => {
      copyText(formatGatewayEventStreamUrl());
    });
    document.getElementById("copyDashboardButton")?.addEventListener("click", () => {
      copyText(window.location.href);
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-replay-run-id], [data-replay-session-key], [data-replay-conversation-id]") : null;
      if (!target) return;
      event.preventDefault();
      void loadReplay({
        runId: target.getAttribute("data-replay-run-id") || "",
        sessionKey: target.getAttribute("data-replay-session-key") || "",
        conversationId: target.getAttribute("data-replay-conversation-id") || "",
        channelId: target.getAttribute("data-replay-channel-id") || ""
      });
    });
    const setRunControlStatus = (message, tone) => {
      const statusEl = document.getElementById("runControlStatus");
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.setAttribute("data-tone", tone || "info");
    };
    const dispatchRunControl = async (trigger, action, runId) => {
      const row = trigger.closest("[data-run-control-row]");
      const buttons = row ? row.querySelectorAll("button") : [trigger];
      for (const button of buttons) button.setAttribute("disabled", "disabled");
      setRunControlStatus(action + " -> " + runId + " ...", "info");
      try {
        const response = await fetch("/api/neon-runs/control", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: action, runId: runId })
        });
        let payload = null;
        try { payload = await response.json(); } catch { payload = null; }
        if (response.ok && payload && payload.state === "accepted") {
          const control = payload.control || {};
          setRunControlStatus(
            "accepted: " + action + " " + runId + " (interrupt=" + (control.interruptSent ? "yes" : "no") + " abort=" + (control.localAbortSent ? "yes" : "no") + ")",
            "ok"
          );
          window.setTimeout(() => { window.location.reload(); }, 900);
          return;
        }
        const reason = (payload && (payload.error || (payload.control && payload.control.reason))) || ("http " + response.status);
        setRunControlStatus("abgelehnt: " + action + " " + runId + " (" + reason + ")", "error");
      } catch (error) {
        setRunControlStatus("Fehler: " + action + " " + runId + " (network)", "error");
      }
      for (const button of buttons) button.removeAttribute("disabled");
    };
    document.addEventListener("click", (event) => {
      const trigger = event.target instanceof Element ? event.target.closest("[data-run-control-action]") : null;
      if (!trigger) return;
      event.preventDefault();
      const action = trigger.getAttribute("data-run-control-action") || "";
      const runId = trigger.getAttribute("data-run-control-run-id") || "";
      if ((action !== "stop" && action !== "abort") || !runId) return;
      void dispatchRunControl(trigger, action, runId);
    });
    for (const link of document.querySelectorAll("a[data-view]")) {
      link.addEventListener("click", (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        navigateToView(link.getAttribute("data-view") || "chat");
      });
    }
    window.addEventListener("hashchange", () => {
      setActiveView(activeHashView());
    });
    window.addEventListener("popstate", () => {
      activeReplayFilters = readReplayFiltersFromLocation();
      sessionFilters = readSessionFiltersFromLocation();
      activityFilters = readActivityFiltersFromLocation();
      setActiveView(activePathView());
      void refresh();
    });
    document.getElementById("sessionSearchInput")?.addEventListener("input", (event) => {
      const target = event.target;
      updateSessionFilters({ query: target ? target.value : "" });
    });
    document.getElementById("sessionStatusFilter")?.addEventListener("change", (event) => {
      const target = event.target;
      updateSessionFilters({ status: target ? target.value : "" });
    });
    document.getElementById("sessionAgentFilter")?.addEventListener("change", (event) => {
      const target = event.target;
      updateSessionFilters({ agentId: target ? target.value : "" });
    });
    document.getElementById("sessionClearFilters")?.addEventListener("click", () => {
      updateSessionFilters({ query: "", status: "", agentId: "" });
    });
    document.getElementById("activitySearchInput")?.addEventListener("input", (event) => {
      const target = event.target;
      updateActivityFilters({ query: target ? target.value : "" });
    });
    document.getElementById("activityStatusFilter")?.addEventListener("change", (event) => {
      const target = event.target;
      updateActivityFilters({ status: target ? target.value : "" });
    });
    document.getElementById("activityAgentFilter")?.addEventListener("change", (event) => {
      const target = event.target;
      updateActivityFilters({ agentId: target ? target.value : "" });
    });
    document.getElementById("activityClearFilters")?.addEventListener("click", () => {
      updateActivityFilters({ query: "", status: "", agentId: "" });
    });
    window.setInterval(() => {
      void refresh();
    }, 5000);
  </script>
</body>
</html>`;
}

function serializeSnapshotForScript(snapshot: INeonMissionControlGatewaySnapshot): string {
  return JSON.stringify(snapshot)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function normalizeRouteSegment(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^#?\/?/u, "")
    .replace(/^mission-control\/?/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

function missionControlViewTitle(view: TNeonMissionControlView): string {
  switch (view) {
    case "activity":
      return "Aktivität";
    case "agents":
      return "Agenten";
    case "chat":
      return "Chat";
    case "sites":
      return "Seiten";
    case "config":
      return "Einstellungen";
    case "cron":
      return "Cron-Aufgaben";
    case "dreams":
      return "Träume";
    case "indexer":
      return "Indexer";
    case "transcript":
      return "Transcripts";
    case "instances":
      return "Instanzen";
    case "nodes":
      return "Geräte";
    case "overview":
      return "Übersicht";
    case "sessions":
      return "Sitzungen";
    case "skills":
      return "Skills";
    case "usage":
      return "Nutzung";
    case "workboard":
      return "Arbeitsbereich";
    case "channels":
      return "Kanäle";
    case "logs":
      return "Protokolle";
  }
}
