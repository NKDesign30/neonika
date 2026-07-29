import { html, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { neonClient, NeonApiError } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";
import { renderChatToolEvents, type ChatToolEvent } from "./chat-tool-events.js";

interface ChatMessage {
  readonly messageId: string;
  readonly direction: "inbound" | "agent";
  readonly userDisplayName?: string;
  readonly agentId?: string;
  readonly textPreview?: string;
  readonly status?: string;
  readonly toolEvents?: readonly ChatToolEvent[];
}
interface ChatConversation {
  readonly conversationId: string;
  readonly title?: string;
  readonly channel?: string;
  readonly runCount?: number;
  readonly messageCount?: number;
  readonly agents?: readonly string[];
  readonly users?: readonly string[];
  readonly messages: readonly ChatMessage[];
}
interface ChatSnapshot {
  readonly totals: { readonly conversations: number; readonly messages: number; readonly runs: number };
  readonly conversations: readonly ChatConversation[];
}

export class NeonChat extends NeonView<ChatSnapshot> {
  // Bumped by the shell when the sidebar's "New session" button fires. Each
  // bump starts a fresh dry-run compose: clear the draft and focus the composer.
  @property({ type: Number }) composeNonce = 0;
  @state() private selectedId: string | null = null;
  @state() private draft = "";
  @state() private sending = false;
  @state() private sendStatus: { readonly kind: "ok" | "error"; readonly text: string } | null = null;

  protected load(signal: AbortSignal): Promise<ChatSnapshot> {
    return neonClient.chat<ChatSnapshot>({ signal });
  }

  override updated(changed: PropertyValues): void {
    super.updated(changed);
    // Ignore the initial render (old value undefined) — only react to real bumps.
    if (changed.has("composeNonce") && changed.get("composeNonce") !== undefined) {
      this.draft = "";
      this.sendStatus = null;
      queueMicrotask(() => this.querySelector<HTMLTextAreaElement>(".composer__input")?.focus());
    }
  }

  private select(id: string): void {
    this.selectedId = id;
    this.sendStatus = null;
  }

  private async send(conversation: ChatConversation): Promise<void> {
    const text = this.draft.trim();
    if (text.length === 0 || this.sending) {
      return;
    }
    this.sending = true;
    this.sendStatus = null;
    try {
      const response = await neonClient.postChatSend({
        channelId: conversation.conversationId,
        text,
        ...(conversation.channel ? { channel: conversation.channel } : {}),
        ...(conversation.agents?.[0] ? { agentId: conversation.agents[0] } : {}),
      });
      this.draft = "";
      this.sendStatus = {
        kind: "ok",
        text: `Dry-run queued · not sent · ${response.chat.candidateId}`,
      };
    } catch (error) {
      const detail = error instanceof NeonApiError ? ` (${error.status})` : "";
      this.sendStatus = { kind: "error", text: `Send failed${detail}` };
    } finally {
      this.sending = false;
    }
  }

  protected renderData(data: ChatSnapshot): TemplateResult {
    const conversations = data.conversations;
    if (conversations.length === 0) {
      return html`<div class="page"><div class="empty">${t("state.empty")}</div></div>`;
    }
    const active = conversations.find((c) => c.conversationId === this.selectedId) ?? conversations[0]!;
    const agentName = active.agents?.[0] ?? "agent";

    return html`
      <div class="chat">
        <aside class="chat__threads">
          <div class="chat__threadhead">
            <span class="chat__threadtitle">${t("tabs.chat")}</span>
            <span class="cellmuted">${data.totals.conversations}</span>
          </div>
          <div class="chat__threadlist scrolly">
            ${conversations.map((c) => {
              const isActive = c.conversationId === active.conversationId;
              const last = c.messages.at(-1)?.textPreview ?? "";
              return html`
                <button
                  class=${"chat__thread" + (isActive ? " chat__thread--active" : " chat__thread--live")}
                  @click=${() => this.select(c.conversationId)}
                >
                  <span class="chat__threaddot"></span>
                  <span class="chat__threadcopy">
                    <span class="chat__threadname">${c.title ?? c.conversationId}</span>
                    <span class="chat__threadlast">${last}</span>
                  </span>
                </button>
              `;
            })}
          </div>
        </aside>

        <section class="chat__main">
          <div class="chat__bar">
            <div class="chat__avatar">${icon("messageSquare", 14)}</div>
            <div style="min-width:0">
              <div class="chat__threadname">${active.title ?? active.conversationId}</div>
              <div class="row__sub">${active.channel ?? "—"} · ${agentName} · ${active.messageCount ?? active.messages.length} msgs</div>
            </div>
          </div>

          <div class="chat__msgs scrolly">
            ${active.messages.map((m) => {
              const isUser = m.direction === "inbound";
              const who = isUser ? m.userDisplayName ?? "user" : m.agentId ?? "agent";
              const text = (m.textPreview ?? "").trim();
              const toolEvents = !isUser && m.toolEvents ? m.toolEvents : undefined;
              // Tool-only turns keep their events but drop the hollow bubble;
              // turns with neither text nor events render nothing at all.
              if (text.length === 0 && (!toolEvents || toolEvents.length === 0)) return html``;
              return html`
                <div class=${"msg " + (isUser ? "msg--user" : "msg--assistant")}>
                  <span class="msg__who">${who}</span>
                  ${text.length > 0 ? html`<div class="msg__bubble">${text}</div>` : html``}
                  ${toolEvents ? renderChatToolEvents(toolEvents) : html``}
                </div>
              `;
            })}
          </div>

          <div class="composer">
            <div class="composer__box">
              <textarea
                class="composer__input"
                rows="1"
                placeholder="Dry-run reply · shadow mode (never sent)"
                .value=${this.draft}
                ?disabled=${this.sending}
                @input=${(event: Event) => {
                  this.draft = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
              <button
                class="composer__send"
                ?disabled=${this.sending || this.draft.trim().length === 0}
                title="Queues a dry-run delivery candidate — never sends"
                @click=${() => void this.send(active)}
              >
                ${icon("send", 15)}
              </button>
            </div>
            <div class="composer__hint">
              ${this.sendStatus
                ? html`<span
                    style=${`color:var(--status-${this.sendStatus.kind === "error" ? "error" : "success"})`}
                    >${this.sendStatus.text}</span
                  >`
                : html`<span>Shadow mode — outbound suppressed, sends queue as dry-run</span>`}
            </div>
          </div>
        </section>
      </div>
    `;
  }
}

customElements.define("neon-chat", NeonChat);
