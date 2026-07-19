// Adapted from NK Design's Mission Control Workboard for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { html, nothing, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type { PropertyValues } from "lit";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon, type IconName } from "../icons.js";
import { NeonView, renderEmpty, renderError, renderLoading } from "../components/state-pane.js";

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

// Card-detail overlay: read-only replay of the run behind a card. Terminal
// runs only (shadow contract — no live in-flight streaming), see
// /api/neon-replay in the gateway HTTP server.
export interface IReplayEvent {
  readonly id: string;
  readonly kind: string;
  readonly title?: string;
  readonly summary?: string;
  readonly preview?: string;
}

export interface IReplayRun {
  readonly runId: string;
  readonly status: string;
  readonly channel?: string;
  readonly agentId?: string;
  readonly userDisplayName?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly inboundPreview?: string;
  readonly finalPreview?: string;
  readonly eventCount: number;
  readonly events: readonly IReplayEvent[];
}

export interface IReplaySnapshot {
  readonly runs: readonly IReplayRun[];
}

type DetailPhase = "loading" | "ready" | "empty" | "error";

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
  @state() private detailRun: IReplayRun | null = null;
  @state() private detailPhase: DetailPhase = "empty";
  @state() private detailErrorMessage = "";

  private detailAbort: AbortController | null = null;

  protected load(signal: AbortSignal): Promise<IWorkboardCardsSnapshot> {
    return neonClient.workboardCards<IWorkboardCardsSnapshot>({ signal });
  }

  override updated(changed: PropertyValues): void {
    if (changed.has("detailCard") && this.detailCard) {
      queueMicrotask(() => {
        this.querySelector<HTMLElement>(".detail__panel")?.focus();
      });
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.detailAbort?.abort();
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

  // Lazy, click-triggered load of a card's run replay. Guards against races
  // from fast card-switching by capturing the requested card id and only
  // committing the result if the selection hasn't moved on.
  private openDetail(card: IWorkboardCard): void {
    this.detailAbort?.abort();
    this.detailCard = card;
    this.detailErrorMessage = "";

    if (!card.runId) {
      this.detailRun = null;
      this.detailPhase = "empty";
      return;
    }

    this.detailRun = null;
    this.detailPhase = "loading";
    const controller = new AbortController();
    this.detailAbort = controller;
    const requestedCardId = card.id;

    neonClient
      .replay<IReplaySnapshot>(card.runId, { signal: controller.signal, events: 200 })
      .then((snapshot) => {
        if (this.detailCard?.id !== requestedCardId) return;
        const run = pickReplayRun(snapshot);
        if (!run) {
          this.detailPhase = "empty";
          return;
        }
        this.detailRun = run;
        this.detailPhase = "ready";
      })
      .catch((error: unknown) => {
        if (this.detailCard?.id !== requestedCardId) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        this.detailErrorMessage = error instanceof Error ? error.message : String(error);
        this.detailPhase = "error";
      });
  }

  private closeDetail(): void {
    this.detailAbort?.abort();
    this.detailAbort = null;
    this.detailCard = null;
    this.detailRun = null;
  }

  private renderDetailOverlay(): TemplateResult | typeof nothing {
    const card = this.detailCard;
    if (!card) return nothing;

    return html`
      <div
        class="palette-overlay"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this.closeDetail();
        }}
      >
        <div
          class="detail__panel"
          role="dialog"
          aria-label=${card.title}
          tabindex="-1"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.preventDefault();
              this.closeDetail();
            }
          }}
        >
          <div class="detail__head">
            <span class="card__title">${card.title}</span>
            <button class="btn btn--sm" @click=${() => this.closeDetail()}>${t("common.close")}</button>
          </div>
          <div class="detail__body">${this.renderDetailBody()}</div>
        </div>
      </div>
    `;
  }

  private renderDetailBody(): TemplateResult {
    if (this.detailPhase === "loading") return renderLoading();
    if (this.detailPhase === "error") {
      return renderError(this.detailErrorMessage, () => {
        if (this.detailCard) this.openDetail(this.detailCard);
      });
    }
    if (this.detailPhase === "empty" || !this.detailRun) {
      return renderEmpty(t("workboard.detailNoRun"));
    }

    const run = this.detailRun;

    return html`
      <div class="detail__meta">
        ${renderBadge(statusBadge(run.status))}
        <span class="row__sub">${formatDetailMeta(run)}</span>
      </div>
      ${run.finalPreview
        ? html`<div class="detail__section">
            <div class="row__sub">${t("workboard.detailResult")}</div>
            <p>${run.finalPreview}</p>
          </div>`
        : nothing}
      <div class="detail__section">
        <div class="row__sub">${t("workboard.detailEvents", { count: fmtInt(run.eventCount) })}</div>
        <div class="rowlist">
          ${run.events.map(
            (event) => html`
              <div class="row" style="grid-template-columns:minmax(0,1fr)">
                <div style="min-width:0">
                  <div class="row__key">${event.title ?? event.kind}</div>
                  <div class="row__sub">${event.summary ?? event.preview ?? event.kind}</div>
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
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
                    ? html`<div class="empty">${t("state.empty")}</div>`
                    : html`<div class="rowlist">
                        ${visible.map((card) => renderCardRow(card, () => this.openDetail(card)))}
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

// Pure, unit-tested: which run a replay snapshot's runs[] array resolves to
// (noUncheckedIndexedAccess makes runs[0] possibly-undefined — an empty array
// means the run fell out of the store, not an error).
export function pickReplayRun(snapshot: IReplaySnapshot): IReplayRun | undefined {
  return snapshot.runs[0];
}

// Pure, unit-tested: the compact meta line under the status badge.
export function formatDetailMeta(run: IReplayRun): string {
  return [
    run.channel,
    run.agentId ? `@${run.agentId}` : undefined,
    run.userDisplayName,
    typeof run.durationMs === "number" ? `${Math.round(run.durationMs / 1000)}s` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
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
