// Adapted from NK Design's Mission Control Workboard for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon, type IconName } from "../icons.js";
import { NeonView } from "../components/state-pane.js";
import "../components/run-detail.js";

type WorkboardStatus =
  | "triage"
  | "backlog"
  | "todo"
  | "scheduled"
  | "ready"
  | "running"
  | "review"
  | "blocked"
  | "done";

type WorkboardPriority = "low" | "normal" | "high" | "urgent";

interface IWorkboardSource {
  readonly kind?: string;
  readonly channel?: string;
  readonly channelId?: string;
  readonly messageId?: string;
  readonly userDisplayName?: string;
}

interface IWorkboardCard {
  readonly id: string;
  readonly title: string;
  readonly notes?: string;
  readonly status: WorkboardStatus;
  readonly priority: WorkboardPriority;
  readonly labels: readonly string[];
  readonly agentId?: string;
  readonly runId?: string;
  readonly sourceUrl?: string;
  readonly updatedAt: number;
  readonly metadata?: {
    readonly source?: IWorkboardSource;
    readonly dispatchCount?: number;
    readonly failureCount?: number;
  };
}

interface IWorkboardCardsSnapshot {
  readonly cards: readonly IWorkboardCard[];
  readonly statuses: readonly WorkboardStatus[];
}

interface IWorkboardTotals {
  readonly cards: number;
  readonly active: number;
  readonly ready: number;
  readonly running: number;
  readonly blocked: number;
}

const DISPLAY_STATUSES: readonly WorkboardStatus[] = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
];

// Cards render in a windowed list per column: newest first, VISIBLE_STEP at a
// time, expandable via the load-more button so large columns (done) stay usable.
const VISIBLE_STEP = 10;

export class NeonWorkboard extends NeonView<IWorkboardCardsSnapshot> {
  @state() private visibleByStatus: Partial<Record<WorkboardStatus, number>> = {};
  @state() private detailCard: IWorkboardCard | null = null;

  protected load(signal: AbortSignal): Promise<IWorkboardCardsSnapshot> {
    return neonClient.workboardCards<IWorkboardCardsSnapshot>({ signal });
  }

  private visibleCount(status: WorkboardStatus): number {
    return this.visibleByStatus[status] ?? VISIBLE_STEP;
  }

  private showMore(status: WorkboardStatus): void {
    this.visibleByStatus = {
      ...this.visibleByStatus,
      [status]: this.visibleCount(status) + VISIBLE_STEP,
    };
  }

  // The replay overlay itself (fetch, phases, focus, close) lives in
  // <neon-run-detail>; the board only tracks which card is open.
  private renderDetailOverlay(): TemplateResult | typeof nothing {
    const card = this.detailCard;
    if (!card) return nothing;
    return html`<neon-run-detail
      .runId=${card.runId ?? ""}
      .heading=${card.title}
      @detail-close=${() => {
        this.detailCard = null;
      }}
    ></neon-run-detail>`;
  }

  protected renderData(data: IWorkboardCardsSnapshot): TemplateResult {
    const totals = computeTotals(data.cards);
    const tiles: ReadonlyArray<{ label: string; icon: IconName; value: number }> = [
      { label: "Cards", icon: "kanban", value: totals.cards },
      { label: "Ready", icon: "check", value: totals.ready },
      { label: "Running", icon: "clock", value: totals.running },
      { label: "Blocked", icon: "alertTriangle", value: totals.blocked },
    ];

    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.workboard")}</h1>
            <p class="page__sub">${fmtInt(totals.active)} active cards · terminal run lifecycle · Discord ingress</p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        <section class="insights">
          ${tiles.map(
            (tile) => html`
              <div class="tile">
                <div class="tile__label">${icon(tile.icon, 12)} ${tile.label}</div>
                <div class="tile__value">${fmtInt(tile.value)}</div>
              </div>
            `,
          )}
        </section>

        <div class="agentgrid">
          ${visibleStatuses(data).map((status) => {
            const cards = data.cards
              .filter((card) => card.status === status)
              .sort((left, right) => right.updatedAt - left.updatedAt);
            const visible = cards.slice(0, this.visibleCount(status));
            const hidden = cards.length - visible.length;
            return html`
              <div class="card">
                <div class="card__head">
                  <span class="card__title">${statusLabel(status)}</span>
                  <span class="tag">${fmtInt(cards.length)}</span>
                </div>
                <div class="card__body">
                  ${cards.length === 0
                    ? html`<div class="empty empty--inline">${t("state.empty")}</div>`
                    : html`<div class="rowlist">
                        ${visible.map((card) => renderCardRow(card, () => { this.detailCard = card; }))}
                      </div>
                      ${hidden > 0
                        ? html`<button class="btn btn--sm" style="margin-top:10px" @click=${() => this.showMore(status)}>
                            ${t("workboard.loadMore", { count: fmtInt(hidden) })}
                          </button>`
                        : null}`}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
      ${this.renderDetailOverlay()}
    `;
  }
}

function computeTotals(cards: readonly IWorkboardCard[]): IWorkboardTotals {
  return {
    cards: cards.length,
    active: cards.filter((card) => card.status !== "done").length,
    ready: cards.filter((card) => card.status === "ready").length,
    running: cards.filter((card) => card.status === "running").length,
    blocked: cards.filter((card) => card.status === "blocked").length,
  };
}

function visibleStatuses(data: IWorkboardCardsSnapshot): readonly WorkboardStatus[] {
  const statuses = new Set<WorkboardStatus>([...DISPLAY_STATUSES, ...data.statuses]);
  return [...statuses];
}

function renderCardRow(card: IWorkboardCard, onOpen: () => void): TemplateResult {
  const source = card.metadata?.source;
  const sourceLabel = source?.kind === "discord-message" ? "discord" : source?.kind ?? "local";
  const detail = [card.agentId ? `@${card.agentId}` : undefined, source?.userDisplayName, source?.channelId]
    .filter((value): value is string => Boolean(value))
    .join(" · ");

  return html`
    <div class="row" style="grid-template-columns:minmax(0,1fr) auto" @click=${onOpen}>
      <div style="min-width:0">
        <div class="row__key">${card.title}</div>
        <div class="row__sub">${detail || card.id}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
          <span class="tag">${card.priority}</span>
          <span class="tag">${sourceLabel}</span>
          ${card.labels.slice(0, 3).map((label) => html`<span class="tag">${label}</span>`)}
        </div>
      </div>
      ${renderBadge(statusBadge(card.status))}
    </div>
  `;
}

function statusLabel(status: WorkboardStatus): string {
  return status.replace(/-/g, " ");
}

customElements.define("neon-workboard", NeonWorkboard);
