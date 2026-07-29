import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt, relativeTime, titleCase } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon, isIconName, type IconName } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

// Shapes mirror src/missionControl/gatewaySnapshot.ts + gateway/runStore.ts.
// Optional fields keep rendering safe if the snapshot evolves.
interface GatewayTotals {
  readonly runs: number;
  readonly shadowRuns: number;
  readonly completed: number;
  readonly failed: number;
  readonly running?: number;
  readonly deliverySuppressed: number;
}
interface GatewayRun {
  readonly runId: string;
  readonly mode?: string;
  readonly status?: string;
  readonly channel?: string;
  readonly agentId?: string;
  readonly startedAt?: string;
}
interface GatewayEvent {
  readonly runId: string;
  readonly kind: string;
  readonly label: string;
}
interface GatewaySnapshot {
  readonly generatedAt?: string;
  readonly state?: string;
  readonly totals: GatewayTotals;
  readonly recentRuns?: readonly GatewayRun[];
  readonly recentEvents?: readonly GatewayEvent[];
}

const EVENT_ICON: Record<string, { icon: IconName; tone: string }> = {
  "tool-start": { icon: "zap", tone: "brand" },
  "tool-output": { icon: "zap", tone: "brand" },
  "file-write": { icon: "fileText", tone: "brand" },
  "command-exit": { icon: "terminal", tone: "ok" },
  "token-usage": { icon: "coins", tone: "brand" },
  "assistant-delta": { icon: "messageSquare", tone: "brand" },
  final: { icon: "check", tone: "ok" },
  failed: { icon: "alertTriangle", tone: "err" },
};
function eventVisual(kind: string): { icon: IconName; tone: string } {
  return EVENT_ICON[kind] ?? { icon: "activity", tone: "brand" };
}

export class NeonOverview extends NeonView<GatewaySnapshot> {
  protected load(signal: AbortSignal): Promise<GatewaySnapshot> {
    return neonClient.gateway<GatewaySnapshot>({ signal });
  }

  // The overview's "live" pill is honest: refresh the snapshot every 10s.
  protected override pollIntervalMs(): number {
    return 10_000;
  }

  private go(tab: string): void {
    this.dispatchEvent(new CustomEvent("tab-select", { detail: tab, bubbles: true, composed: true }));
  }

  // Mixpanel-style time-of-day greeting — the overview addresses the operator,
  // not the feature ("Überblick" is what the sidebar already says).
  private greeting(): string {
    const hour = new Date().getHours();
    if (hour < 11) {
      return t("overview.greetingMorning");
    }
    if (hour < 18) {
      return t("overview.greetingDay");
    }
    return t("overview.greetingEvening");
  }

  protected renderData(data: GatewaySnapshot): TemplateResult {
    const totals = data.totals;
    const running = totals.running ?? 0;
    const runs = data.recentRuns ?? [];
    const events = data.recentEvents ?? [];
    const cards = [
      { kind: "runs", tab: "sessions", label: "Runs", icon: "fileText" as IconName, value: fmtInt(totals.runs), brand: true, hint: html`${fmtInt(totals.shadowRuns)} shadow` },
      { kind: "running", tab: "sessions", label: "Running", icon: "activity" as IconName, value: fmtInt(running), brand: false, hint: running > 0 ? html`<span class="ok">${fmtInt(running)} active</span>` : html`none` },
      { kind: "completed", tab: "activity", label: "Completed", icon: "check" as IconName, value: fmtInt(totals.completed), brand: false, hint: html`<span class="ok">${fmtInt(totals.completed)} done</span>` },
      { kind: "failed", tab: "activity", label: "Failed", icon: "alertTriangle" as IconName, value: fmtInt(totals.failed), brand: false, hint: totals.failed > 0 ? html`<span class="err">${fmtInt(totals.failed)} failed</span>` : html`none` },
      { kind: "suppressed", tab: "config", label: "Suppressed", icon: "pause" as IconName, value: fmtInt(totals.deliverySuppressed), brand: false, hint: html`outbound` },
      { kind: "gateway", tab: "config", label: t("overview.modelAuth"), icon: "cpu" as IconName, value: titleCase(data.state ?? "shadow"), brand: false, hint: html`${relativeTime(data.generatedAt)} ago` },
    ];

    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${this.greeting()}, Operator</h1>
            <p class="page__sub">${t("overview.sub", { count: fmtInt(totals.runs) })}</p>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
          </div>
        </div>

        <section class="statgrid">
          ${cards.map(
            (c) => html`
              <button class="stat" data-kind=${c.kind} @click=${() => this.go(c.tab)}>
                ${icon("arrowUpRight", 14, "regular", "stat__go")}
                <div class="stat__label">${icon(c.icon, 12)} ${c.label}</div>
                <div class=${"stat__value" + (c.brand ? " stat__value--brand" : "")}>${c.value}</div>
                <div class="stat__hint">${c.hint}</div>
              </button>
            `,
          )}
        </section>

        <div class="cols">
          <div class="card">
            <div class="card__head">
              <span class="card__title">${t("overview.recentSessions")}</span>
              <button class="btn btn--sm" @click=${() => this.go("sessions")}>${t("common.viewAll")}</button>
            </div>
            <div class="card__body">
              ${runs.length === 0
                ? html`<div class="empty">${t("state.empty")}</div>`
                : html`<div class="rowlist">
                    ${runs.slice(0, 6).map(
                      (r) => html`
                        <div class="row" style="grid-template-columns:minmax(0,1fr) auto auto">
                          <div style="min-width:0">
                            <div class="row__key">${r.runId}</div>
                            <div class="row__sub">${r.channel ?? "—"} · ${r.agentId ?? "—"}</div>
                          </div>
                          ${renderBadge(statusBadge(r.status))}
                          <span class="row__time">${relativeTime(r.startedAt)}</span>
                        </div>
                      `,
                    )}
                  </div>`}
            </div>
          </div>

          <div class="card">
            <div class="card__head">
              <span class="card__title">${t("overview.liveActivity")}</span>
              <span class="statuspill" style="height:24px;font-size:10px">
                <span class="dot dot--pulse"></span> ${t("common.live")}
              </span>
            </div>
            <div class="card__body">
              ${events.length === 0
                ? html`<div class="empty">${t("state.empty")}</div>`
                : html`<div class="feed">
                    ${events.map((e) => {
                      const v = eventVisual(e.kind);
                      const ico = isIconName(v.icon) ? v.icon : "activity";
                      return html`
                        <div class="feed__item">
                          <div class=${"feed__ico feed__ico--" + v.tone}>${icon(ico, 13)}</div>
                          <div class="feed__body">
                            <div class="feed__text">${e.label} <em>${e.runId}</em></div>
                          </div>
                          <span class="feed__time">${e.kind}</span>
                        </div>
                      `;
                    })}
                  </div>`}
            </div>
          </div>
        </div>
        ${nothing}
      </div>
    `;
  }
}

customElements.define("neon-overview", NeonOverview);
