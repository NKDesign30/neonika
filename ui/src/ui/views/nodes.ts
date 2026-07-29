import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface LocalNode {
  readonly nodeId: string;
  readonly displayName?: string;
  readonly hostName?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly processId?: number;
  readonly health?: string;
  readonly heartbeatAt?: string;
}
interface NodeCapability {
  readonly id: string;
  readonly label?: string;
  readonly state?: string;
  readonly policy?: string;
  readonly summary?: string;
}
interface SafeRoot {
  readonly id: string;
  readonly kind?: string;
  readonly path?: string;
  readonly readable?: boolean;
  readonly writeAccess?: boolean;
}
interface NodesSnapshot {
  readonly localNode: LocalNode;
  readonly capabilities: readonly NodeCapability[];
  readonly safeRoots: readonly SafeRoot[];
  readonly totals: { readonly nodes: number; readonly onlineNodes: number; readonly capabilities: number };
}

export class NeonNodes extends NeonView<NodesSnapshot> {
  protected load(signal: AbortSignal): Promise<NodesSnapshot> {
    return neonClient.nodes<NodesSnapshot>({ signal });
  }

  protected renderData(data: NodesSnapshot): TemplateResult {
    const node = data.localNode;
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.nodes")}</h1>
            <p class="page__sub">
              ${fmtInt(data.totals.onlineNodes)}/${fmtInt(data.totals.nodes)} online ·
              ${fmtInt(data.totals.capabilities)} capabilities
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <div class="nodegrid">
          <div class="nodecard">
            <div class="nodecard__head">
              <div class="nodecard__ico">${icon("monitor", 18)}</div>
              <div style="min-width:0">
                <div class="nodecard__name">${node.displayName ?? node.nodeId}</div>
                <div class="nodecard__role">${node.hostName ?? "—"} · Host</div>
              </div>
            </div>
            <div class="rowlist">
              <div class="row" style="grid-template-columns:1fr auto"><span class="row__sub">Platform</span><span class="cellmuted">${node.platform ?? "—"} · ${node.arch ?? "—"}</span></div>
              <div class="row" style="grid-template-columns:1fr auto"><span class="row__sub">Process</span><span class="cellmuted">${node.processId ?? "—"}</span></div>
            </div>
            <div class="nodecard__foot">
              <span>${node.heartbeatAt ? "heartbeat live" : "no heartbeat"}</span>
              ${renderBadge(statusBadge(node.health))}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card__head"><span class="card__title">Capabilities</span></div>
          <div class="card__body">
            ${data.capabilities.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${data.capabilities.map(
                    (c) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                        <div style="min-width:0">
                          <div class="row__key">${c.label ?? c.id}</div>
                          <div class="row__sub">${c.summary ?? c.policy ?? ""}</div>
                        </div>
                        ${renderBadge(statusBadge(c.state))}
                      </div>
                    `,
                  )}
                </div>`}
          </div>
        </div>

        ${data.safeRoots.length > 0
          ? html`<div class="card">
              <div class="card__head"><span class="card__title">Safe roots</span></div>
              <div class="card__body">
                <div class="rowlist">
                  ${data.safeRoots.map(
                    (r) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                        <div style="min-width:0"><div class="row__key">${r.path ?? r.id}</div><div class="row__sub">${r.kind ?? ""}</div></div>
                        <span class="cellmuted">${r.writeAccess ? "rw" : r.readable ? "ro" : "—"}</span>
                      </div>
                    `,
                  )}
                </div>
              </div>
            </div>`
          : ""}
      </div>
    `;
  }
}

customElements.define("neon-nodes", NeonNodes);
