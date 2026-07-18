import { LitElement, html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { I18nController, LOCALE_LABELS, SUPPORTED_LOCALES, t, type Locale } from "../../i18n/index.js";
import { NEON_ENDPOINTS, neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { type Tab } from "../navigation.js";
import type { ThemeName } from "../theme.js";

interface GatewayStatusSummary {
  readonly state?: string;
}

// Top bar: breadcrumb, command-palette search, gateway status, locale + theme.
export class NeonTopbar extends LitElement {
  @property({ attribute: false }) tab: Tab = "overview";
  @property({ attribute: false }) theme: ThemeName = "dark";
  @property({ attribute: false }) locale: Locale = "en";
  // null = still probing; true/false = real gateway reachability.
  @state() private gatewayOnline: boolean | null = null;

  private statusTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    new I18nController(this);
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.probeGateway();
    this.statusTimer = setInterval(() => void this.probeGateway(), 15_000);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.statusTimer) clearInterval(this.statusTimer);
  }

  private async probeGateway(): Promise<void> {
    try {
      await neonClient.get<GatewayStatusSummary>(NEON_ENDPOINTS.gatewayStatus);
      this.gatewayOnline = true;
    } catch {
      this.gatewayOnline = false;
    }
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  override render(): TemplateResult {
    return html`
      <header class="topbar">
        <nav class="crumb">
          <button class="crumb__root" @click=${() => this.emit("tab-select", "overview")}>
            ${t("brand.title")}
          </button>
          <span class="crumb__sep">›</span>
          <span class="crumb__current">${t(`tabs.${this.tab}`)}</span>
        </nav>
        <div class="topbar__spacer"></div>

        <button class="search" @click=${() => this.emit("open-palette")}>
          ${icon("search", 14)}
          <span class="search__label">${t("common.search")}</span>
          <span class="kbd"><span style="font-size:12px">⌘</span>K</span>
        </button>

        <span class="statuspill" title=${this.gatewayOnline === false ? "offline" : "online"}>
          <span class=${"dot" + (this.gatewayOnline === false ? " dot--idle" : " dot--pulse")}></span>
          ${t("gateway.status")}
        </span>

        <div class="seg" role="group" aria-label="Language">
          ${SUPPORTED_LOCALES.map(
            (loc) => html`
              <button
                class=${"seg__btn" + (loc === this.locale ? " seg__btn--active" : "")}
                @click=${() => this.emit("locale-change", loc)}
              >
                ${LOCALE_LABELS[loc]}
              </button>
            `,
          )}
        </div>

        <button class="iconbtn" title="Toggle theme" @click=${() => this.emit("theme-toggle")}>
          ${icon(this.theme === "dark" ? "sun" : "moon", 15)}
        </button>
      </header>
    `;
  }
}

customElements.define("neon-topbar", NeonTopbar);
