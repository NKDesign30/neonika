import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon, type IconName } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface SessionsTotals {
  readonly sessions: number;
  readonly runs: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly suppressedDeliveries: number;
}
interface ActivityTotals {
  readonly entries: number;
  readonly done: number;
  readonly errors: number;
}
interface UsageData {
  readonly sessions: { readonly totals: SessionsTotals };
  readonly activity: { readonly totals: ActivityTotals };
}

export class NeonUsage extends NeonView<UsageData> {
  protected async load(signal: AbortSignal): Promise<UsageData> {
    const [sessions, activity] = await Promise.all([
      neonClient.sessions<{ totals: SessionsTotals }>({ signal }),
      neonClient.activity<{ totals: ActivityTotals }>({ signal }),
    ]);
    return { sessions, activity };
  }

  protected renderData(data: UsageData): TemplateResult {
    const s = data.sessions.totals;
    const a = data.activity.totals;
    const tiles: ReadonlyArray<{ label: string; icon: IconName; value: number }> = [
      { label: "Runs", icon: "fileText", value: s.runs },
      { label: "Completed", icon: "check", value: s.completedRuns },
      { label: "Failed", icon: "alertTriangle", value: s.failedRuns },
      { label: "Tool events", icon: "zap", value: a.entries },
    ];
    const breakdown: ReadonlyArray<{ label: string; value: number; color: string }> = [
      { label: "Completed", value: s.completedRuns, color: "var(--brand-primary)" },
      { label: "Failed", value: s.failedRuns, color: "var(--status-error)" },
      { label: "Suppressed", value: s.suppressedDeliveries, color: "rgba(46,171,115,0.45)" },
    ];
    const max = Math.max(1, ...breakdown.map((b) => b.value));

    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.usage")}</h1>
            <p class="page__sub">${fmtInt(s.sessions)} sessions · ${fmtInt(s.runs)} runs · ${fmtInt(a.entries)} tool events</p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <section class="insights">
          ${tiles.map(
            (tile) => html`
              <div class="tile">
                <div class="tile__label">${icon(tile.icon, 12)} ${tile.label}</div>
                <div class="tile__value">${fmtInt(tile.value)}</div>
              </div>
            `,
          )}
        </section>

        <div class="card">
          <div class="card__head"><span class="card__title">Run breakdown</span></div>
          <div class="card__body" style="padding:16px">
            <div class="bd">
              ${breakdown.map(
                (b) => html`
                  <div class="bd__row">
                    <span class="bd__label">${b.label}</span>
                    <div class="bd__track"><div class="bd__fill" style=${`width:${(b.value / max) * 100}%;background:${b.color}`}></div></div>
                    <span class="bd__val">${fmtInt(b.value)}</span>
                  </div>
                `,
              )}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-usage", NeonUsage);
