import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface SkillRow {
  readonly name: string;
  readonly description?: string;
  readonly loadState?: string;
  readonly trust?: string;
  readonly rootLabel?: string;
  readonly sourceKind?: string;
  readonly disableModelInvocation?: boolean;
}
interface SkillsSnapshot {
  readonly skills: readonly SkillRow[];
  readonly totals: { readonly skills: number; readonly availableSkills: number; readonly extensionManifests: number };
}

export class NeonSkills extends NeonView<SkillsSnapshot> {
  @state() private query = "";

  protected load(signal: AbortSignal): Promise<SkillsSnapshot> {
    return neonClient.skills<SkillsSnapshot>({ signal });
  }

  private onSearch(e: Event): void {
    this.query = (e.target as HTMLInputElement).value.toLowerCase();
  }

  protected renderData(data: SkillsSnapshot): TemplateResult {
    const rows = data.skills.filter((s) => {
      if (this.query === "") return true;
      return `${s.name} ${s.description ?? ""}`.toLowerCase().includes(this.query);
    });

    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.skills")}</h1>
            <p class="page__sub">
              ${fmtInt(data.totals.availableSkills)} available · ${fmtInt(data.totals.skills)} total ·
              ${fmtInt(data.totals.extensionManifests)} extensions
            </p>
          </div>
          <div class="field">
            ${icon("search", 13)}
            <input type="text" .value=${this.query} @input=${this.onSearch} placeholder="skill / description" style="width:180px" />
          </div>
        </div>

        <div class="card">
          <div class="card__body">
            ${rows.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${rows.slice(0, 120).map(
                    (s) => html`
                      <div class="row" style="grid-template-columns:16px minmax(0,1fr) auto">
                        <span
                          class=${"dot" + (s.loadState === "available" ? "" : " dot--idle")}
                          title=${s.loadState ?? "unknown"}
                        ></span>
                        <div style="min-width:0">
                          <div class="row__key">${s.name}</div>
                          <div class="row__sub">${s.description ?? s.rootLabel ?? ""}</div>
                        </div>
                        <span class="tag">${s.trust ?? s.sourceKind ?? "local"}</span>
                      </div>
                    `,
                  )}
                  ${rows.length > 120 ? html`<div class="empty">+${fmtInt(rows.length - 120)} more</div>` : ""}
                </div>`}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-skills", NeonSkills);
