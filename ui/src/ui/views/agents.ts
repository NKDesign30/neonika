import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface AgentRow {
  readonly id: string;
  readonly displayName: string;
  readonly role?: string;
  readonly runtime?: string;
  readonly capabilityCount?: number;
  readonly memorySeedCount?: number;
}
interface AgentsSnapshot {
  readonly defaultAgentId?: string;
  readonly agents: readonly AgentRow[];
}

const ACCENTS = [
  "var(--brand-primary)",
  "var(--subbrand-wispr)",
  "var(--subbrand-quill)",
  "var(--subbrand-bar)",
  "var(--subbrand-nkdesign)",
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/[\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export class NeonAgents extends NeonView<AgentsSnapshot> {
  protected load(signal: AbortSignal): Promise<AgentsSnapshot> {
    return neonClient.agents<AgentsSnapshot>({ signal });
  }

  protected renderData(data: AgentsSnapshot): TemplateResult {
    const agents = data.agents;
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.agents")}</h1>
            <p class="page__sub">${fmtInt(agents.length)} agents · default ${data.defaultAgentId ?? "—"}</p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        ${agents.length === 0
          ? html`<div class="card"><div class="empty">${t("state.empty")}</div></div>`
          : html`<div class="agentgrid">
              ${agents.map((a, i) => {
                const accent = ACCENTS[i % ACCENTS.length] ?? "var(--brand-primary)";
                const isDefault = a.id === data.defaultAgentId;
                return html`
                  <div class="agentcard">
                    <div class="agentcard__head">
                      <div class="agentcard__badge" style=${`background:${accent}`}>${initials(a.displayName)}</div>
                      <div style="min-width:0">
                        <div class="agentcard__name">${a.displayName}${isDefault ? html` <span class="tag">default</span>` : ""}</div>
                        <div class="agentcard__role">${a.role ?? a.id}</div>
                      </div>
                    </div>
                    <div class="agentcard__desc">${a.runtime ? `Runtime: ${a.runtime}` : "Neon agent"}</div>
                    <div class="agentcard__meta">
                      <div class="agentstat">
                        <span class="agentstat__v">${fmtInt(a.capabilityCount ?? 0)}</span>
                        <span class="agentstat__l">Skills</span>
                      </div>
                      <div class="agentstat">
                        <span class="agentstat__v">${fmtInt(a.memorySeedCount ?? 0)}</span>
                        <span class="agentstat__l">Memory</span>
                      </div>
                    </div>
                  </div>
                `;
              })}
            </div>`}
      </div>
    `;
  }
}

customElements.define("neon-agents", NeonAgents);
