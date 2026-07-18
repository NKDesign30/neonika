import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { neonClient } from "../gateway.js";
import { icon, type IconName } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface RouteRow {
  readonly id: string;
  readonly channel: string;
  readonly accountId?: string;
  readonly agentId?: string;
  readonly agentDisplayName?: string;
  readonly mode?: string;
  readonly delivery?: string;
  readonly authState?: string;
}
interface RoutesSnapshot {
  readonly state?: string;
  readonly routes: readonly RouteRow[];
  readonly recovery?: readonly string[];
}

function channelIcon(channel: string): IconName {
  const c = channel.toLowerCase();
  if (c.includes("discord") || c.includes("slack")) return "messageSquare";
  if (c.includes("telegram") || c.includes("signal")) return "send";
  if (c.includes("nostr")) return "radio";
  if (c.includes("mail")) return "send";
  return "link";
}
const CHANNEL_TINT: Record<string, string> = {
  discord: "#5865F2",
  slack: "#611f69",
  telegram: "#2AABEE",
  signal: "#3A76F0",
  nostr: "#8E44AD",
};

export class NeonChannels extends NeonView<RoutesSnapshot> {
  protected load(signal: AbortSignal): Promise<RoutesSnapshot> {
    return neonClient.routes<RoutesSnapshot>({ signal });
  }

  protected renderData(data: RoutesSnapshot): TemplateResult {
    const routes = data.routes;
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.channels")}</h1>
            <p class="page__sub">${routes.length} routes · gateway ${data.state ?? "—"}</p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        ${routes.length === 0
          ? html`<div class="card"><div class="empty">${t("state.empty")}</div></div>`
          : html`<div class="chgrid">
              ${routes.map((r) => {
                const tint = CHANNEL_TINT[r.channel.toLowerCase()] ?? "var(--brand-primary)";
                return html`
                  <div class="chcard">
                    <div class="chcard__top">
                      <div class="chcard__ico" style=${`background:${tint}`}>${icon(channelIcon(r.channel), 18)}</div>
                      ${renderBadge(statusBadge(r.authState))}
                    </div>
                    <div>
                      <div class="chcard__name">${r.channel}</div>
                      <div class="chcard__meta">${r.agentDisplayName ?? r.agentId ?? "—"} · ${r.mode ?? "shadow"}</div>
                    </div>
                    <div class="chcard__foot">
                      <span class="cellmuted">${r.accountId ?? "—"}</span>
                      <span class="cellmuted">${r.delivery ?? "suppressed"}</span>
                    </div>
                  </div>
                `;
              })}
            </div>`}

        ${data.recovery && data.recovery.length > 0
          ? html`<div class="card" style="margin-top:14px">
              <div class="card__head"><span class="card__title">Setup needed</span></div>
              <div class="card__body">
                ${data.recovery.map((r) => html`<div class="feed__item"><div class="feed__ico feed__ico--warn">${icon("alertTriangle", 13)}</div><div class="feed__text">${r}</div></div>`)}
              </div>
            </div>`
          : ""}
      </div>
    `;
  }
}

customElements.define("neon-channels", NeonChannels);
