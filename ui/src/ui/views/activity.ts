import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { fmtInt, relativeTime } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon, type IconName } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface ActivityEntry {
  readonly id: string;
  readonly runId: string;
  readonly channel?: string;
  readonly agentId?: string;
  readonly kind: string;
  readonly status?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly startedAt?: string;
  readonly durationMs?: number;
}
interface ActivitySnapshot {
  readonly totals: { readonly entries: number; readonly runs: number; readonly running: number; readonly done: number; readonly errors: number };
  readonly entries: readonly ActivityEntry[];
}

function kindIcon(kind: string): IconName {
  if (kind.includes("tool")) return "zap";
  if (kind.includes("file")) return "fileText";
  if (kind.includes("command")) return "terminal";
  if (kind.includes("token")) return "coins";
  if (kind.includes("message") || kind.includes("assistant")) return "messageSquare";
  if (kind.includes("final") || kind.includes("done")) return "check";
  if (kind.includes("fail") || kind.includes("error")) return "alertTriangle";
  return "activity";
}
function tone(status: string | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "error" || s === "failed") return "err";
  if (s === "done" || s === "completed") return "ok";
  return "brand";
}

export class NeonActivity extends NeonView<ActivitySnapshot> {
  protected load(signal: AbortSignal): Promise<ActivitySnapshot> {
    return neonClient.activity<ActivitySnapshot>({ signal });
  }

  // The "live" pill is honest: refresh the feed every 10s in the background.
  protected override pollIntervalMs(): number {
    return 10_000;
  }

  protected renderData(data: ActivitySnapshot): TemplateResult {
    const entries = data.entries.slice(0, 80);
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.activity")}</h1>
            <p class="page__sub">
              ${fmtInt(data.totals.entries)} events · ${fmtInt(data.totals.done)} done · ${fmtInt(data.totals.errors)} errors
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">${t("overview.liveActivity")}</span>
            <span class="statuspill" style="height:24px;font-size:10px">
              <span class="dot dot--pulse"></span> ${t("common.live")}
            </span>
          </div>
          <div class="card__body">
            ${entries.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="feed">
                  ${entries.map(
                    (e) => html`
                      <div class="feed__item">
                        <div class=${"feed__ico feed__ico--" + tone(e.status)}>${icon(kindIcon(e.kind), 13)}</div>
                        <div class="feed__body">
                          <div class="feed__text"><em>${e.title ?? e.kind}</em>${e.summary ? html` · ${e.summary}` : ""}</div>
                          <div class="row__sub">${e.channel ?? "—"} · ${e.agentId ?? "—"} · ${e.runId}</div>
                        </div>
                        <span class="feed__time">${relativeTime(e.startedAt)}</span>
                      </div>
                    `,
                  )}
                </div>`}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-activity", NeonActivity);
