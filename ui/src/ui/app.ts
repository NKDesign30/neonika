import { LitElement, html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { I18nController, i18n, isSupportedLocale, type Locale } from "../i18n/index.js";
import { isMissionControlLocation, missionControlPath, tabFromLocation, type Tab } from "./navigation.js";
import { applyAccent, applyTheme, loadAccent, loadTheme, type ThemeName } from "./theme.js";

// Register the shell + view custom elements (side-effect imports).
import "./components/sidebar.js";
import "./components/topbar.js";
import "./components/command-palette.js";
import "./views/overview.js";
import "./views/sessions.js";
import "./views/activity.js";
import "./views/agents.js";
import "./views/chat.js";
import "./views/cron.js";
import "./views/channels.js";
import "./views/nodes.js";
import "./views/skills.js";
import "./views/usage.js";
import "./views/config.js";
import "./views/logs.js";
import "./views/dreams.js";
import "./views/indexer.js";
import "./views/transcript.js";
import "./views/workboard.js";
import "./views/placeholder.js";

// Root of Neon Mission Control: owns route/theme/locale state and composes the
// shell. Views are self-loading custom elements that read live /api/neon-* data.
export class NeonControlApp extends LitElement {
  @state() private tab: Tab = "overview";
  @state() private theme: ThemeName = "dark";
  @state() private locale: Locale = "en";
  @state() private paletteOpen = false;
  @state() private chatComposeNonce = 0;

  private readonly onLocationChange = (): void => {
    this.tab = tabFromLocation(window.location.pathname, window.location.hash);
  };

  // Cmd/Ctrl+K opens the command palette (the topbar advertises the shortcut).
  private readonly onGlobalKeydown = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      this.paletteOpen = true;
    }
  };

  constructor() {
    super();
    new I18nController(this);
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.theme = loadTheme();
    applyTheme(this.theme);
    applyAccent(loadAccent());
    this.locale = i18n.getLocale();
    this.tab = tabFromLocation(window.location.pathname, window.location.hash);
    window.addEventListener("hashchange", this.onLocationChange);
    window.addEventListener("popstate", this.onLocationChange);
    window.addEventListener("keydown", this.onGlobalKeydown);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.onLocationChange);
    window.removeEventListener("popstate", this.onLocationChange);
    window.removeEventListener("keydown", this.onGlobalKeydown);
  }

  // "New session": jump to chat and start a fresh dry-run compose. Always bumps
  // the nonce (even when already on chat) so the chat view re-focuses/clears.
  private startNewSession(): void {
    this.chatComposeNonce += 1;
    if (this.tab !== "chat") this.setTab("chat");
  }

  private setTab(tab: Tab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    // Keep the URL in sync: a real /mission-control/<view> path in production,
    // a #<view> hash when running standalone in dev.
    if (isMissionControlLocation(window.location.pathname)) {
      history.replaceState(null, "", missionControlPath(tab));
    } else {
      history.replaceState(null, "", `#${tab}`);
    }
  }

  private toggleTheme(): void {
    this.theme = this.theme === "dark" ? "light" : "dark";
    applyTheme(this.theme);
  }

  private setLocale(locale: Locale): void {
    if (!isSupportedLocale(locale)) return;
    this.locale = locale;
    i18n.setLocale(locale);
  }

  private renderView(): TemplateResult {
    switch (this.tab) {
      case "overview":
        return html`<neon-overview></neon-overview>`;
      case "sessions":
        return html`<neon-sessions></neon-sessions>`;
      case "activity":
        return html`<neon-activity></neon-activity>`;
      case "agents":
        return html`<neon-agents></neon-agents>`;
      case "chat":
        return html`<neon-chat .composeNonce=${this.chatComposeNonce}></neon-chat>`;
      case "cron":
        return html`<neon-cron></neon-cron>`;
      case "channels":
        return html`<neon-channels></neon-channels>`;
      case "nodes":
        return html`<neon-nodes></neon-nodes>`;
      case "skills":
        return html`<neon-skills></neon-skills>`;
      case "usage":
        return html`<neon-usage></neon-usage>`;
      case "config":
        return html`<neon-config></neon-config>`;
      case "logs":
        return html`<neon-logs></neon-logs>`;
      case "dreams":
        return html`<neon-dreams></neon-dreams>`;
      case "indexer":
        return html`<neon-indexer></neon-indexer>`;
      case "transcript":
        return html`<neon-transcript></neon-transcript>`;
      case "workboard":
        return html`<neon-workboard></neon-workboard>`;
      default:
        return html`<neon-placeholder .tab=${this.tab}></neon-placeholder>`;
    }
  }

  override render(): TemplateResult {
    const shellClass = "shell" + (this.tab === "chat" ? " shell--chat" : "");
    return html`
      <div
        class=${shellClass}
        @tab-select=${(e: Event) => this.setTab((e as CustomEvent<Tab>).detail)}
        @new-session=${() => this.startNewSession()}
        @theme-toggle=${() => this.toggleTheme()}
        @locale-change=${(e: Event) => this.setLocale((e as CustomEvent<Locale>).detail)}
        @open-palette=${() => {
          this.paletteOpen = true;
        }}
        @palette-close=${() => {
          this.paletteOpen = false;
        }}
      >
        <neon-sidebar .tab=${this.tab}></neon-sidebar>
        <neon-topbar .tab=${this.tab} .theme=${this.theme} .locale=${this.locale}></neon-topbar>
        <main class="content scrolly">${this.renderView()}</main>
        <neon-command-palette .open=${this.paletteOpen}></neon-command-palette>
      </div>
    `;
  }
}

customElements.define("neon-control-app", NeonControlApp);
