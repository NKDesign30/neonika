import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt, relativeTime } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface SessionRow {
  readonly key: string;
  readonly title?: string;
  readonly channel?: string;
  readonly agentId?: string;
  readonly mode?: string;
  readonly updatedAt?: string;
  readonly runCount?: number;
  readonly messageCount?: number;
  readonly failedRuns?: number;
  readonly latestRunStatus?: string;
  readonly latestPreview?: string;
}
interface SessionsSnapshot {
  readonly totals: {
    readonly sessions: number;
    readonly runs: number;
    readonly completedRuns: number;
    readonly failedRuns: number;
    readonly runningRuns?: number;
  };
  readonly sessions: readonly SessionRow[];
}

type Filter = "all" | "active" | "idle" | "error";

function sessionStatus(s: SessionRow): "active" | "idle" | "error" {
  if ((s.failedRuns ?? 0) > 0 || s.latestRunStatus === "failed") return "error";
  if (s.latestRunStatus === "completed") return "active";
  return "idle";
}

export class NeonSessions extends NeonView<SessionsSnapshot> {
  @state() private filter: Filter = "all";
  @state() private query = "";

  protected load(signal: AbortSignal): Promise<SessionsSnapshot> {
    return neonClient.sessions<SessionsSnapshot>({ signal });
  }

  private setFilter(f: Filter): void {
    this.filter = f;
  }
  private onSearch(e: Event): void {
    this.query = (e.target as HTMLInputElement).value.toLowerCase();
  }

  protected renderData(data: SessionsSnapshot): TemplateResult {
    const rows = data.sessions.filter((s) => {
      const matchesFilter = this.filter === "all" || sessionStatus(s) === this.filter;
      const hay = `${s.key} ${s.channel ?? ""} ${s.agentId ?? ""}`.toLowerCase();
      return matchesFilter && (this.query === "" || hay.includes(this.query));
    });
    const segs: readonly Filter[] = ["all", "active", "idle", "error"];

    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.sessions")}</h1>
            <p class="page__sub">
              ${fmtInt(data.totals.sessions)} sessions · ${fmtInt(data.totals.runs)} runs ·
              ${fmtInt(data.totals.runningRuns ?? 0)} running · ${fmtInt(data.totals.completedRuns)} completed · ${fmtInt(data.totals.failedRuns)} failed
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <div class="filterbar">
          <div class="seg">
            ${segs.map(
              (f) => html`<button
                class=${"seg__btn" + (f === this.filter ? " seg__btn--active" : "")}
                @click=${() => this.setFilter(f)}
              >
                ${f === "all" ? t("common.all") : f === "active" ? t("common.active") : f === "idle" ? t("common.idle") : t("common.error")}
              </button>`,
            )}
          </div>
          <div class="field">
            ${icon("search", 13)}
            <input type="text" .value=${this.query} @input=${this.onSearch} placeholder="key / channel / agent" style="width:180px" />
          </div>
        </div>

        <div class="card">
          <div class="tablewrap">
            <table class="dtable">
              <thead>
                <tr>
                  <th style="width:34%">Session</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th class="num">Runs</th>
                  <th class="num">Msgs</th>
                  <th class="num">Updated</th>
                </tr>
              </thead>
              <tbody>
                ${rows.length === 0
                  ? html`<tr><td colspan="6"><div class="empty">${t("state.empty")}</div></td></tr>`
                  : rows.map((s) => {
                      const st = sessionStatus(s);
                      return html`
                        <tr>
                          <td>
                            <span class="cellkey">${s.key}</span>
                            <div class="cellmuted">${s.channel ?? "—"}${s.mode ? ` · ${s.mode}` : ""}</div>
                          </td>
                          <td><span class="cellmuted">${s.agentId ?? "—"}</span></td>
                          <td>${renderBadge(statusBadge(st))}</td>
                          <td class="num">${fmtInt(s.runCount ?? 0)}</td>
                          <td class="num">${fmtInt(s.messageCount ?? 0)}</td>
                          <td class="num"><span class="cellmuted">${relativeTime(s.updatedAt)}</span></td>
                        </tr>
                      `;
                    })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-sessions", NeonSessions);
