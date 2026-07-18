import { LitElement, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { I18nController, t } from "../../i18n/index.js";
import { icon, type IconName } from "../icons.js";
import { titleForTab, type Tab } from "../navigation.js";

// Honest placeholder for tabs whose live view is not wired yet. No fake data —
// it states plainly that the live view is in progress.
const TAB_META: Record<Tab, { icon: IconName; sub: string }> = {
  chat: { icon: "messageSquare", sub: "Talk to your agents across every connected gateway." },
  overview: { icon: "barChart", sub: "Fleet status at a glance." },
  activity: { icon: "activity", sub: "A unified stream of every tool event across your fleet." },
  workboard: { icon: "folder", sub: "Tasks and goals your agents are working on." },
  sessions: { icon: "fileText", sub: "Every run, grouped by channel and agent." },
  usage: { icon: "coins", sub: "Tokens and cost across sessions." },
  cron: { icon: "loader", sub: "Scheduled jobs and wake timers." },
  agents: { icon: "folder", sub: "Identities, files and skills per agent." },
  skills: { icon: "zap", sub: "Enable, block and configure agent capabilities." },
  nodes: { icon: "monitor", sub: "Connected devices running the Neon runtime." },
  dreams: { icon: "moon", sub: "Background reflection and memory consolidation." },
  indexer: { icon: "brain", sub: "Decision candidates the indexer derives from gateway runs." },
  transcript: { icon: "fileText", sub: "Claude Code transcript session digests from ~/.claude/projects." },
  config: { icon: "settings", sub: "Gateway, model and runtime configuration." },
  channels: { icon: "link", sub: "Connect Slack, Telegram, Discord, Signal and more." },
  logs: { icon: "scrollText", sub: "Live runtime logs and diagnostics." },
};

export class NeonPlaceholder extends LitElement {
  @property({ attribute: false }) tab: Tab = "overview";

  constructor() {
    super();
    new I18nController(this);
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override render(): TemplateResult {
    const meta = TAB_META[this.tab];
    const title = titleForTab(this.tab);
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${title}</h1>
            <p class="page__sub">${meta.sub}</p>
          </div>
        </div>
        <div class="card" style="display:grid;place-items:center;min-height:360px">
          <div style="text-align:center;max-width:380px;padding:24px">
            <div
              style="width:56px;height:56px;border-radius:14px;margin:0 auto 18px;display:grid;place-items:center;background:var(--brand-faint);color:var(--brand-primary)"
            >
              ${icon(meta.icon, 26)}
            </div>
            <div
              style="font-family:var(--font-display);font-size:22px;letter-spacing:-0.02em;color:var(--text-primary);margin-bottom:8px"
            >
              ${title}
            </div>
            <p style="font-size:13.5px;color:var(--text-secondary);line-height:1.6;margin:0">${meta.sub}</p>
            <div style="margin-top:18px"><span class="eyebrow-m">${t("comingSoon")}</span></div>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-placeholder", NeonPlaceholder);
