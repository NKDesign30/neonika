// Adapted from NK Design's Mission Control Workboard for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { renderEmpty, renderError, renderLoading } from "./state-pane.js";

// Read-only replay of a terminal run, shown as a modal overlay. Deep module:
// callers hand over a runId and a heading, everything else — fetch, phases,
// race guarding, focus, escape/backdrop close — lives inside. Terminal runs
// only (shadow contract — no live in-flight streaming), see /api/neon-replay.
// Closing is announced via a bubbling "detail-close" event; the host removes
// the element from its template.
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

export class NeonRunDetail extends LitElement {
  // Empty string means "the entry has no run behind it" — the overlay still
  // opens and explains that instead of silently doing nothing.
  @property({ type: String }) runId = "";
  @property({ type: String }) heading = "";

  @state() private phase: DetailPhase = "empty";
  @state() private run: IReplayRun | null = null;
  @state() private errorMessage = "";

  private abortController: AbortController | null = null;

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.loadRun();
    queueMicrotask(() => {
      this.querySelector<HTMLElement>(".detail__panel")?.focus();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.abortController?.abort();
  }

  override updated(changed: PropertyValues): void {
    if (changed.has("runId") && changed.get("runId") !== undefined) {
      this.loadRun();
    }
  }

  private loadRun(): void {
    this.abortController?.abort();
    if (!this.runId) {
      this.run = null;
      this.phase = "empty";
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    const requestedRunId = this.runId;
    this.run = null;
    this.phase = "loading";

    neonClient
      .replay<IReplaySnapshot>(requestedRunId, { signal: controller.signal, events: 200 })
      .then((snapshot) => {
        if (this.runId !== requestedRunId) return;
        const run = pickReplayRun(snapshot);
        if (!run) {
          this.phase = "empty";
          return;
        }
        this.run = run;
        this.phase = "ready";
      })
      .catch((error: unknown) => {
        if (this.runId !== requestedRunId) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        this.errorMessage = error instanceof Error ? error.message : String(error);
        this.phase = "error";
      });
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent("detail-close", { bubbles: true, composed: true }));
  }

  private renderBody(): TemplateResult {
    if (this.phase === "loading") return renderLoading();
    if (this.phase === "error") {
      return renderError(this.errorMessage, () => this.loadRun());
    }
    if (this.phase === "empty" || !this.run) {
      return renderEmpty(t("workboard.detailNoRun"));
    }

    const run = this.run;
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

  override render(): TemplateResult {
    return html`
      <div
        class="palette-overlay"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this.close();
        }}
      >
        <div
          class="detail__panel"
          role="dialog"
          aria-label=${this.heading}
          tabindex="-1"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Escape") {
              event.preventDefault();
              this.close();
            }
          }}
        >
          <div class="detail__head">
            <span class="card__title">${this.heading}</span>
            <button class="btn btn--sm" @click=${() => this.close()}>${t("common.close")}</button>
          </div>
          <div class="detail__body">${this.renderBody()}</div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-run-detail", NeonRunDetail);
