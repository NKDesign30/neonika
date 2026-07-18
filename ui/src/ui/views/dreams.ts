import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";
import {
  lastReflectionLabelForDream,
  phaseLabelForDream,
  reflectionLabelForDream
} from "./dream-status.js";

interface DreamRow {
  readonly id: string;
  readonly state?: string;
  readonly policy?: string;
  readonly phase?: string;
  readonly reflectionEnabled?: boolean;
  readonly lastReflectionAt?: string | null;
  readonly source?: string;
  readonly summary?: string;
}
interface AutomationSnapshot {
  readonly dreams: readonly DreamRow[];
  readonly recovery: readonly string[];
  readonly policy?: string;
}

interface WorkspaceFileSnapshot {
  readonly exists: boolean;
  readonly noteCount: number;
  readonly bytes: number;
  readonly path: string;
}

interface WorkspaceSnapshot {
  readonly totals: { readonly filesPresent: number; readonly noteCount: number };
  readonly files: {
    readonly dreams: WorkspaceFileSnapshot;
    readonly notes: WorkspaceFileSnapshot;
    readonly dailyMemory: WorkspaceFileSnapshot;
  };
  readonly safety: { readonly semanticMemoryWritten: boolean; readonly outboundSent: boolean };
}

interface DreamViewData {
  readonly automation: AutomationSnapshot;
  readonly workspace: WorkspaceSnapshot | null;
}

export class NeonDreams extends NeonView<DreamViewData> {
  protected async load(signal: AbortSignal): Promise<DreamViewData> {
    const [automation, workspace] = await Promise.all([
      neonClient.automation<AutomationSnapshot>({ signal }),
      neonClient.workspace<WorkspaceSnapshot>({ signal }).catch(() => null),
    ]);
    return { automation, workspace };
  }

  protected renderData(data: DreamViewData): TemplateResult {
    const { automation, workspace } = data;
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.dreams")}</h1>
            <p class="page__sub">
              ${fmtInt(automation.dreams.length)} dreams · ${fmtInt(workspace?.files.dreams.noteCount ?? 0)} dream notes ·
              policy ${automation.policy ?? "shadow"}
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <div class="card">
          <div class="card__head"><span class="card__title">${t("tabs.dreams")}</span></div>
          <div class="card__body">
            ${automation.dreams.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${automation.dreams.map(
                    (d) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto auto">
                        <div style="min-width:0">
                          <div class="row__key">${d.id}</div>
                          <div class="row__sub">${d.summary ?? d.source ?? ""}</div>
                          <div class="row__sub">
                            ${phaseLabelForDream(d)} · ${reflectionLabelForDream(d)} · ${lastReflectionLabelForDream(d)}
                          </div>
                        </div>
                        ${d.policy ? html`<span class="tag">${d.policy}</span>` : ""}
                        ${renderBadge(statusBadge(d.state))}
                      </div>
                    `,
                  )}
                </div>`}
          </div>
        </div>

        <div class="card">
          <div class="card__head"><span class="card__title">Workspace</span></div>
          <div class="card__body">
            ${workspace
              ? html`<div class="rowlist">
                  ${this.renderWorkspaceRow("DREAMS.md", workspace.files.dreams)}
                  ${this.renderWorkspaceRow("NOTES.md", workspace.files.notes)}
                  ${this.renderWorkspaceRow("Daily memory", workspace.files.dailyMemory)}
                  <div class="row" style="grid-template-columns:minmax(0,1fr)">
                    <div class="row__sub">
                      safety: semanticMemoryWritten=${String(workspace.safety.semanticMemoryWritten)} ·
                      outboundSent=${String(workspace.safety.outboundSent)}
                    </div>
                  </div>
                </div>`
              : html`<div class="empty">Workspace nicht verfügbar.</div>`}
          </div>
        </div>

        ${automation.recovery.length > 0
          ? html`<div class="card">
              <div class="card__head"><span class="card__title">Recovery</span></div>
              <div class="card__body"><div class="rowlist">
                ${automation.recovery.map(
                  (note) => html`
                    <div class="row" style="grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start">
                      <span style="color:var(--brand-primary);margin-top:1px">${icon("check", 14)}</span>
                      <div class="row__sub" style="white-space:normal">${note}</div>
                    </div>
                  `,
                )}
              </div></div>
            </div>`
          : ""}
      </div>
    `;
  }

  private renderWorkspaceRow(label: string, file: WorkspaceFileSnapshot): TemplateResult {
    return html`
      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
        <div style="min-width:0">
          <div class="row__key">${label}</div>
          <div class="row__sub">${file.path}</div>
        </div>
        <span class="tag">${file.exists ? `${fmtInt(file.noteCount)} notes` : "absent"}</span>
      </div>
    `;
  }
}

customElements.define("neon-dreams", NeonDreams);
