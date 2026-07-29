import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { collapseConsecutive, fmtInt, shortTime } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
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
}
interface ActivitySnapshot {
  readonly totals: { readonly entries: number; readonly errors: number };
  readonly entries: readonly ActivityEntry[];
}

function level(status: string | undefined): "info" | "debug" | "warn" | "error" {
  const s = (status ?? "").toLowerCase();
  if (s === "error" || s === "failed") return "error";
  if (s === "running") return "debug";
  return "info";
}

export class NeonLogs extends NeonView<ActivitySnapshot> {
  protected load(signal: AbortSignal): Promise<ActivitySnapshot> {
    return neonClient.activity<ActivitySnapshot>({ signal });
  }

  protected renderData(data: ActivitySnapshot): TemplateResult {
    // Same flood-collapse as the activity feed: adjacent identical events
    // become one line with a repeat count, then the window applies.
    const lines = collapseConsecutive(data.entries, (e) =>
      [e.runId, e.kind, e.status ?? "", e.title ?? "", e.summary ?? "", e.channel ?? "", e.agentId ?? ""].join(" "),
    ).slice(0, 120);
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.logs")}</h1>
            <p class="page__sub">${fmtInt(data.totals.entries)} events · ${fmtInt(data.totals.errors)} errors</p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <div class="card">
          <div class="logwrap scrolly">
            ${lines.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : lines.map(({ item: e, count }) => {
                  const lvl = level(e.status);
                  return html`
                    <div class="logline">
                      <span class="logline__t">${shortTime(e.startedAt)}</span>
                      <span class=${"logline__lvl logline__lvl--" + lvl}>${lvl}</span>
                      <span class="logline__src">${e.agentId ?? e.channel ?? e.kind}</span>
                      <span class="logline__msg">
                        ${e.title ?? e.kind}${e.summary ? ` — ${e.summary}` : ""}
                        ${count > 1 ? html`<span class="mult">× ${fmtInt(count)}</span>` : ""}
                      </span>
                    </div>
                  `;
                })}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-logs", NeonLogs);
