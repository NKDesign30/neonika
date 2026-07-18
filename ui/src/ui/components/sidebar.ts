import { LitElement, html, svg, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { I18nController, t } from "../../i18n/index.js";
import { icon } from "../icons.js";
import { NAV_GROUPS, type Tab } from "../navigation.js";

// Neonika brand mark: a solar disc behind four waves whose amplitude falls
// toward the bottom — the sun has not fully risen, which is the shadow contract
// as a picture. Inlined with fill="currentColor" so the sidebar colors it per
// theme (#F28A4B dark / #B84A1B light) independently of the user-chosen accent.
// The waves are cut out through a mask, not painted in the surface colour, so
// the mark survives on any background. Flat by brand rule — no shadow, no
// gradient, no glow.
const brandMark = (): TemplateResult => svg`
  <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
    <mask id="neonika-mark-waves">
      <rect width="64" height="64" fill="#fff"></rect>
      <path d="M0 36 Q8 34.3 16 36 Q24 37.7 32 36 Q40 34.3 48 36 Q56 37.7 64 36 L64 38 Q56 39.7 48 38 Q40 36.3 32 38 Q24 39.7 16 38 Q8 36.3 0 38 Z"></path>
      <path d="M0 40.2 Q8 39 16 40.2 Q24 41.4 32 40.2 Q40 39 48 40.2 Q56 41.4 64 40.2 L64 41.9 Q56 43.1 48 41.9 Q40 40.7 32 41.9 Q24 43.1 16 41.9 Q8 40.7 0 41.9 Z"></path>
      <path d="M0 43.6 Q8 42.8 16 43.6 Q24 44.4 32 43.6 Q40 42.8 48 43.6 Q56 44.4 64 43.6 L64 45.05 Q56 45.85 48 45.05 Q40 44.25 32 45.05 Q24 45.85 16 45.05 Q8 44.25 0 45.05 Z"></path>
      <path d="M0 46.3 Q8 45.85 16 46.3 Q24 46.75 32 46.3 Q40 45.85 48 46.3 Q56 46.75 64 46.3 L64 47.5 Q56 47.95 48 47.5 Q40 47.05 32 47.5 Q24 47.95 16 47.5 Q8 47.05 0 47.5 Z"></path>
    </mask>
    <circle cx="32" cy="32" r="19" mask="url(#neonika-mark-waves)"></circle>
  </svg>
`;

// Left navigation rail: brand mark, "new session", grouped tabs, footer identity.
export class NeonSidebar extends LitElement {
  @property({ attribute: false }) tab: Tab = "overview";

  constructor() {
    super();
    new I18nController(this);
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  private select(tab: Tab): void {
    this.dispatchEvent(new CustomEvent<Tab>("tab-select", { detail: tab, bubbles: true, composed: true }));
  }

  private newSession(): void {
    this.dispatchEvent(new CustomEvent("new-session", { bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    return html`
      <nav class="nav">
        <div class="nav__head">
          <span class="nav__logo" role="img" aria-label="Neon">${brandMark()}</span>
          <div class="nav__brandcopy">
            <span class="nav__eyebrow">${t("brand.eyebrow")}</span>
            <span class="nav__title">${t("brand.title")}</span>
          </div>
        </div>

        <button class="nav__new" @click=${this.newSession}>
          ${icon("plus", 15, "bold")} ${t("common.newSession")}
        </button>

        <div class="nav__scroll scrolly">
          ${NAV_GROUPS.map(
            (group) => html`
              <div class="nav__group">
                <div class="nav__grouplabel">${t(`groups.${group.label}`)}</div>
                ${group.items.map((item) => {
                  const active = item.id === this.tab;
                  return html`
                    <button
                      class=${"nav__item" + (active ? " nav__item--active" : "")}
                      @click=${() => this.select(item.id)}
                      aria-current=${active ? "page" : "false"}
                    >
                      ${icon(item.icon, 16)}
                      <span>${t(`tabs.${item.id}`)}</span>
                    </button>
                  `;
                })}
              </div>
            `,
          )}
        </div>

        <div class="nav__foot">
          <div class="nav__avatar">NK</div>
          <div class="nav__footcopy">
            <div class="nav__footname">Operator</div>
            <div class="nav__footmeta">Neonika</div>
          </div>
        </div>
      </nav>
    `;
  }
}

customElements.define("neon-sidebar", NeonSidebar);
