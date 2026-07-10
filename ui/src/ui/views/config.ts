import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface DoctorCheck {
  readonly id: string;
  readonly label?: string;
  readonly state?: string;
  readonly summary?: string;
}
interface CutoverGate {
  readonly id: string;
  readonly label?: string;
  readonly state?: string;
  readonly summary?: string;
}
interface ConfigData {
  readonly doctor: { readonly checks: readonly DoctorCheck[]; readonly totals: { readonly pass: number; readonly warn: number; readonly fail: number }; readonly currentStage?: string };
  readonly cutover: { readonly gates: readonly CutoverGate[]; readonly currentStage?: string; readonly nextStage?: string };
}

type SubTab = "doctor" | "cutover";

export class NeonConfig extends NeonView<ConfigData> {
  @state() private sub: SubTab = "doctor";

  protected async load(signal: AbortSignal): Promise<ConfigData> {
    const [doctor, cutover] = await Promise.all([
      neonClient.doctor<ConfigData["doctor"]>({ signal }),
      neonClient.cutover<ConfigData["cutover"]>({ signal }),
    ]);
    return { doctor, cutover };
  }

  protected renderData(data: ConfigData): TemplateResult {
    const d = data.doctor;
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.config")}</h1>
            <p class="page__sub">
              stage ${d.currentStage ?? "shadow"} ·
              <span class="ok">${fmtInt(d.totals.pass)} pass</span> ·
              <span class="warn">${fmtInt(d.totals.warn)} warn</span> ·
              <span class="err">${fmtInt(d.totals.fail)} fail</span>
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <div class="settings-tabs">
          <button class=${"settings-tab" + (this.sub === "doctor" ? " settings-tab--active" : "")} @click=${() => (this.sub = "doctor")}>Doctor</button>
          <button class=${"settings-tab" + (this.sub === "cutover" ? " settings-tab--active" : "")} @click=${() => (this.sub = "cutover")}>Cutover</button>
        </div>

        ${this.sub === "doctor"
          ? html`<div class="card"><div class="card__body"><div class="rowlist">
              ${d.checks.map(
                (c) => html`
                  <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                    <div style="min-width:0">
                      <div class="row__key">${c.label ?? c.id}</div>
                      <div class="row__sub">${c.summary ?? ""}</div>
                    </div>
                    ${renderBadge(statusBadge(c.state))}
                  </div>
                `,
              )}
            </div></div></div>`
          : html`<div class="card"><div class="card__body"><div class="rowlist">
              ${data.cutover.gates.map(
                (g) => html`
                  <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                    <div style="min-width:0">
                      <div class="row__key">${g.label ?? g.id}</div>
                      <div class="row__sub">${g.summary ?? ""}</div>
                    </div>
                    ${renderBadge(statusBadge(g.state))}
                  </div>
                `,
              )}
            </div></div></div>`}
      </div>
    `;
  }
}

customElements.define("neon-config", NeonConfig);
