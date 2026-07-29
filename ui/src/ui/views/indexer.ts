import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface IndexerSignalCounts {
  readonly fileWrites: number;
  readonly commandExits: number;
  readonly finals: number;
  readonly failures: number;
  readonly decisionSignals: number;
}
interface IndexerSessionDigest {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channel: string;
  readonly runCount: number;
  readonly signals: IndexerSignalCounts;
  readonly latestRunId: string;
  readonly latestPreview: string;
  readonly updatedAt: string;
}
interface IndexerCandidate {
  readonly candidateId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly decisionSignals: number;
  readonly summary: string;
  readonly runIds: readonly string[];
}
interface IndexerSnapshot {
  readonly state: "ready" | "empty";
  readonly generatedAt: string;
  readonly totals: {
    readonly sessions: number;
    readonly runs: number;
    readonly candidates: number;
    readonly decisionSignals: number;
  };
  readonly sessions: readonly IndexerSessionDigest[];
  readonly candidates: readonly IndexerCandidate[];
}

type LiveIndexSource = "discord" | "claude" | "codex";
type LiveIndexSyncState = "planned" | "written" | "blocked";

interface LiveIndexRecord {
  readonly source: LiveIndexSource;
  readonly sourceKey: string;
  readonly sourceFile: string;
  readonly agent: string;
  readonly category: "live-index";
  readonly content: string;
  readonly entryDate: string;
  readonly importanceScore: number;
}

interface LiveIndexWrite {
  readonly state: "written" | "blocked";
  readonly inserted: boolean;
  readonly updated: boolean;
  readonly embedded: boolean;
}

interface LiveIndexSyncResult {
  readonly state: LiveIndexSyncState;
  readonly collection: {
    readonly generatedAt: string;
    readonly totals: {
      readonly discord: number;
      readonly claude: number;
      readonly codex: number;
      readonly records: number;
    };
    readonly records: readonly LiveIndexRecord[];
    readonly diagnostics: readonly string[];
  };
  readonly dbPath?: string;
  readonly writes: readonly LiveIndexWrite[];
  readonly safety: { readonly targetedRealMemoryDb: boolean };
  readonly diagnostics: readonly string[];
}

interface LiveIndexDaemonSourceState {
  readonly source: LiveIndexSource;
  readonly records: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly lastScanAt: string;
}

interface LiveIndexDaemonState {
  readonly version: 1;
  readonly scanCount: number;
  readonly lastScanAt: string;
  readonly lastScanReason: "startup" | "interval" | "api" | "cli" | "smoke";
  readonly sources: Record<LiveIndexSource, LiveIndexDaemonSourceState>;
}

interface LiveIndexMemoryPromotion {
  readonly state: "disabled" | "planned" | "written" | "blocked";
  readonly dbPath?: string;
  readonly changedRecords: number;
  readonly promotableRecords: number;
  readonly writes: readonly LiveIndexWrite[];
  readonly safety: { readonly targetedRealMemoryDb: boolean };
}

interface LiveIndexDaemonSnapshot {
  readonly running: boolean;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly statePath: string;
  readonly metricsPath: string;
  readonly state?: LiveIndexDaemonState;
  readonly collection?: LiveIndexSyncResult["collection"];
  readonly memoryPromotion: LiveIndexMemoryPromotion;
  readonly diagnostics: readonly string[];
}

interface IMemoryIndexEntry {
  readonly id: number;
  readonly category: "session-summary" | "decision";
  readonly entryDate: string;
  readonly createdAt: string;
  readonly project: string;
  readonly sessionShort: string;
  readonly preview: string;
  readonly importance: number;
}

interface IMemoryIndexEntryDetail extends IMemoryIndexEntry {
  readonly content: string;
}

interface IMemoryIndexDay {
  readonly day: string;
  readonly summaries: number;
  readonly decisions: number;
}

interface IMemoryIndexActivity {
  readonly state: "ready" | "empty" | "missing-db";
  readonly totals: {
    readonly summaries: number;
    readonly decisions: number;
    readonly last24h: number;
  };
  readonly lastWriteAt?: string;
  readonly days: readonly IMemoryIndexDay[];
  readonly offset: number;
  readonly filteredTotal: number;
  readonly entries: readonly IMemoryIndexEntry[];
}

type ActivityFilter = "all" | "summary" | "decision";

interface IndexerViewData {
  readonly indexer: IndexerSnapshot;
  readonly liveDaemon: LiveIndexDaemonSnapshot;
  readonly liveSync: LiveIndexSyncResult;
  readonly activity: IMemoryIndexActivity;
}

const ACTIVITY_PAGE_SIZE = 10;

export class NeonIndexer extends NeonView<IndexerViewData> {
  private activityFilter: ActivityFilter = "all";
  private activityPage = 0;
  private expandedEntryId: number | null = null;
  private readonly detailCache = new Map<number, IMemoryIndexEntryDetail>();
  private detailLoadingId: number | null = null;

  protected async load(signal: AbortSignal): Promise<IndexerViewData> {
    const [indexer, liveDaemon, liveSync, activity] = await Promise.all([
      neonClient.indexer<IndexerSnapshot>({ signal }),
      neonClient.liveIndexDaemon<LiveIndexDaemonSnapshot>({ signal }),
      neonClient.liveIndexSync<LiveIndexSyncResult>({ signal }),
      neonClient.indexerActivity<IMemoryIndexActivity>({
        signal,
        ...(this.activityFilter === "all" ? {} : { category: this.activityFilter }),
        ...(this.activityPage > 0 ? { offset: this.activityPage * ACTIVITY_PAGE_SIZE } : {})
      })
    ]);

    return { indexer, liveDaemon, liveSync, activity };
  }

  private setActivityFilter(filter: ActivityFilter): void {
    if (this.activityFilter === filter) {
      return;
    }
    this.activityFilter = filter;
    this.activityPage = 0;
    this.expandedEntryId = null;
    void this.reload();
  }

  private setActivityPage(page: number): void {
    if (page < 0 || page === this.activityPage) {
      return;
    }
    this.activityPage = page;
    this.expandedEntryId = null;
    void this.reload();
  }

  private toggleActivityEntry(entryId: number): void {
    if (this.expandedEntryId === entryId) {
      this.expandedEntryId = null;
      this.requestUpdate();
      return;
    }
    this.expandedEntryId = entryId;
    this.requestUpdate();
    if (!this.detailCache.has(entryId) && this.detailLoadingId !== entryId) {
      this.detailLoadingId = entryId;
      void neonClient
        .indexerActivityEntry<{ state: string; entry?: IMemoryIndexEntryDetail }>(entryId)
        .then((result) => {
          if (result.entry) {
            this.detailCache.set(entryId, result.entry);
          }
        })
        .catch(() => {
          // Row stays expanded with the "not loadable" message; a re-click retries.
        })
        .finally(() => {
          if (this.detailLoadingId === entryId) {
            this.detailLoadingId = null;
          }
          this.requestUpdate();
        });
    }
  }

  protected renderData(data: IndexerViewData): TemplateResult {
    const { indexer, liveDaemon, liveSync, activity } = data;
    const daemonTotals = liveDaemon.collection?.totals ?? liveSync.collection.totals;
    const inserted = liveSync.writes.filter((write) => write.inserted).length;
    const updated = liveSync.writes.filter((write) => write.updated).length;
    const blocked = liveSync.writes.filter((write) => write.state === "blocked").length;
    const daemonWritten = liveDaemon.memoryPromotion.writes.filter((write) => write.state === "written").length;
    const daemonBlocked = liveDaemon.memoryPromotion.writes.filter((write) => write.state === "blocked").length;

    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.indexer")}</h1>
            <p class="page__sub">
              ${fmtInt(daemonTotals.records)} live records ·
              ${fmtInt(daemonTotals.discord)} discord ·
              ${fmtInt(daemonTotals.claude)} claude ·
              ${fmtInt(daemonTotals.codex)} codex
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>
            ${icon("refresh", 13)} ${t("common.refresh")}
          </button>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">Zuletzt in die Memory geschrieben</span>
            ${this.renderActivityFreshness(activity)}
          </div>
          <div class="card__body">
            ${activity.state === "missing-db"
              ? html`<div class="empty">Memory-DB nicht gefunden</div>`
              : html`
                  ${this.renderActivityHistogram(activity.days)}
                  <div class="mem-activity__chips">
                    ${this.renderActivityChip("all", `alle`)}
                    ${this.renderActivityChip("summary", `${fmtInt(activity.totals.summaries)} summaries`)}
                    ${this.renderActivityChip("decision", `${fmtInt(activity.totals.decisions)} decisions`)}
                  </div>
                  ${activity.entries.length === 0
                    ? html`<div class="empty">
                        ${this.activityFilter === "all"
                          ? "Noch keine Summaries in der Memory"
                          : "Keine Einträge für diesen Filter"}
                      </div>`
                    : this.renderActivityGroups(activity.entries)}
                  ${this.renderActivityPagination(activity)}
                `}
          </div>
        </div>

        <div class="card live-index live-index--daemon">
          <div class="card__head">
            <span class="card__title">Live daemon</span>
            <span class=${`tag live-index__state live-index__state--${liveDaemon.running ? "written" : "blocked"}`}>
              ${liveDaemon.running ? "running" : liveDaemon.enabled ? "armed" : "manual"}
            </span>
          </div>
          <div class="card__body live-index__body">
            <div class="live-index__sources">
              ${this.renderDaemonSource("discord", liveDaemon.state?.sources.discord)}
              ${this.renderDaemonSource("claude", liveDaemon.state?.sources.claude)}
              ${this.renderDaemonSource("codex", liveDaemon.state?.sources.codex)}
            </div>

            <div class="live-index__summary">
              <span class="tag">scans ${fmtInt(liveDaemon.state?.scanCount ?? 0)}</span>
              <span class="tag">last ${liveDaemon.state ? this.formatDate(liveDaemon.state.lastScanAt) : "never"}</span>
              <span class="tag">reason ${liveDaemon.state?.lastScanReason ?? "none"}</span>
              <span class="tag">interval ${fmtInt(Math.round(liveDaemon.intervalMs / 1000))}s</span>
              <span class="tag">enabled ${String(liveDaemon.enabled)}</span>
            </div>

            <div class="live-index__summary live-index__summary--memory">
              <span class=${`tag live-index__state live-index__state--${liveDaemon.memoryPromotion.state}`}>
                memory ${liveDaemon.memoryPromotion.state}
              </span>
              <span class="tag">changed ${fmtInt(liveDaemon.memoryPromotion.changedRecords)}</span>
              <span class="tag">promotable ${fmtInt(liveDaemon.memoryPromotion.promotableRecords)}</span>
              <span class="tag">written ${fmtInt(daemonWritten)}</span>
              <span class="tag">blocked ${fmtInt(daemonBlocked)}</span>
              <span class="tag">db ${liveDaemon.memoryPromotion.dbPath ? "configured" : "missing"}</span>
              <span class="tag">real-db ${String(liveDaemon.memoryPromotion.safety.targetedRealMemoryDb)}</span>
            </div>

            <div class="live-index__paths">
              <span>${liveDaemon.statePath}</span>
              <span>${liveDaemon.metricsPath}</span>
            </div>

            ${liveDaemon.diagnostics.length === 0
              ? ""
              : html`<div class="live-index__diagnostics">
                  ${liveDaemon.diagnostics.slice(0, 4).map((diagnostic) => html`<span>${diagnostic}</span>`)}
                </div>`}
          </div>
        </div>

        <div class="card live-index">
          <div class="card__head">
            <span class="card__title">Memory sync gate</span>
            <span class=${`tag live-index__state live-index__state--${liveSync.state}`}>${liveSync.state}</span>
          </div>
          <div class="card__body live-index__body">
            <div class="live-index__sources">
              ${this.renderSource("discord", liveSync.collection.totals.discord)}
              ${this.renderSource("claude", liveSync.collection.totals.claude)}
              ${this.renderSource("codex", liveSync.collection.totals.codex)}
            </div>

            <div class="live-index__summary">
              <span class="tag">${liveSync.dbPath ? "memory db configured" : "plan-only"}</span>
              <span class="tag">inserted ${fmtInt(inserted)}</span>
              <span class="tag">updated ${fmtInt(updated)}</span>
              <span class="tag">blocked ${fmtInt(blocked)}</span>
              <span class="tag">real-db ${String(liveSync.safety.targetedRealMemoryDb)}</span>
            </div>

            ${liveSync.collection.records.length === 0
              ? html`<div class="empty">Keine Live-Records gefunden</div>`
              : html`<div class="live-index__records">
                  ${liveSync.collection.records.slice(0, 8).map((record) => this.renderLiveRecord(record))}
                </div>`}

            ${liveSync.diagnostics.length === 0
              ? ""
              : html`<div class="live-index__diagnostics">
                  ${liveSync.diagnostics.slice(0, 4).map((diagnostic) => html`<span>${diagnostic}</span>`)}
                </div>`}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">Decision candidates</span>
            <span class="tag">
              ${fmtInt(indexer.totals.candidates)} candidates · ${fmtInt(indexer.totals.decisionSignals)} signals
            </span>
          </div>
          <div class="card__body">
            ${indexer.candidates.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${indexer.candidates.slice(0, 120).map(
                    (candidate) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                        <div style="min-width:0">
                          <div class="row__key">${candidate.summary}</div>
                          <div class="row__sub">${candidate.candidateId}</div>
                        </div>
                        <span class="tag">${fmtInt(candidate.decisionSignals)} signal(s)</span>
                      </div>
                    `,
                  )}
                </div>`}
          </div>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">Sessions</span>
            <span class="tag">${fmtInt(indexer.totals.sessions)} sessions · ${fmtInt(indexer.totals.runs)} runs</span>
          </div>
          <div class="card__body">
            ${indexer.sessions.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${indexer.sessions.slice(0, 120).map(
                    (session) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                        <div style="min-width:0">
                          <div class="row__key">${session.agentId} · ${session.channel}</div>
                          <div class="row__sub">${session.latestPreview}</div>
                        </div>
                        <span class="tag">
                          ${session.signals.fileWrites}f · ${session.signals.commandExits}c · ${session.signals.finals}✓
                        </span>
                      </div>
                    `,
                  )}
                </div>`}
          </div>
        </div>
      </div>
    `;
  }

  // Freshness lamp: answers "is the indexer alive?" without reading a number.
  // Green within 6h, amber within 24h, red beyond — tuned to a 15-min cadence
  // that only writes when sessions actually produced content.
  private renderActivityFreshness(activity: IMemoryIndexActivity): TemplateResult {
    if (!activity.lastWriteAt) {
      return html`<span class="tag mem-activity__fresh mem-activity__fresh--stale">noch nie geschrieben</span>`;
    }
    const ageMinutes = (Date.now() - new Date(activity.lastWriteAt).getTime()) / 60_000;
    const level = ageMinutes <= 360 ? "ok" : ageMinutes <= 1440 ? "warn" : "stale";
    return html`
      <span class=${`tag mem-activity__fresh mem-activity__fresh--${level}`} title=${this.formatDate(activity.lastWriteAt)}>
        <span class="mem-activity__dot"></span>
        ${this.relativeTime(activity.lastWriteAt)} · ${fmtInt(activity.totals.last24h)} in 24h
      </span>
    `;
  }

  private renderActivityHistogram(days: readonly IMemoryIndexDay[]): TemplateResult {
    if (days.length === 0) {
      return html``;
    }
    const max = Math.max(1, ...days.map((day) => day.summaries + day.decisions));
    return html`
      <div class="mem-activity__chart">
        ${days.map((day) => {
          const total = day.summaries + day.decisions;
          const title = `${day.day} · ${fmtInt(day.summaries)} summaries · ${fmtInt(day.decisions)} decisions`;
          return html`
            <div class="mem-activity__col" title=${title}>
              <div class="mem-activity__bars">
                ${day.summaries > 0
                  ? html`<div
                      class="mem-activity__bar mem-activity__bar--summary"
                      style=${`height:${Math.max(6, (day.summaries / max) * 100)}%`}
                    ></div>`
                  : ""}
                ${day.decisions > 0
                  ? html`<div
                      class="mem-activity__bar mem-activity__bar--decision"
                      style=${`height:${Math.max(6, (day.decisions / max) * 100)}%`}
                    ></div>`
                  : ""}
                ${total === 0 ? html`<div class="mem-activity__bar mem-activity__bar--zero"></div>` : ""}
              </div>
              <span class="mem-activity__day">${day.day.slice(8)}</span>
            </div>
          `;
        })}
      </div>
    `;
  }

  private renderActivityChip(filter: ActivityFilter, label: string): TemplateResult {
    return html`
      <button
        class=${`mem-activity__chip${this.activityFilter === filter ? " mem-activity__chip--active" : ""}`}
        @click=${() => this.setActivityFilter(filter)}
      >
        ${label}
      </button>
    `;
  }

  // Stripe/Better-Stack style: entries grouped under day headers ("Heute",
  // "Gestern", date), relative time on the right, absolute time on hover.
  private renderActivityGroups(entries: readonly IMemoryIndexEntry[]): TemplateResult {
    const groups: Array<{ label: string; items: IMemoryIndexEntry[] }> = [];
    for (const entry of entries) {
      const label = this.dayLabel(entry.createdAt);
      const current = groups[groups.length - 1];
      if (current && current.label === label) {
        current.items.push(entry);
      } else {
        groups.push({ label, items: [entry] });
      }
    }
    return html`
      ${groups.map(
        (group) => html`
          <div class="mem-activity__group">${group.label}</div>
          <div class="rowlist">
            ${group.items.map((entry) => this.renderActivityRow(entry))}
          </div>
        `,
      )}
    `;
  }

  private renderActivityRow(entry: IMemoryIndexEntry): TemplateResult {
    const expanded = this.expandedEntryId === entry.id;
    return html`
      <div
        class=${`row mem-activity__row${expanded ? " mem-activity__row--open" : ""}`}
        style="grid-template-columns:auto minmax(0,1fr) auto"
        @click=${() => this.toggleActivityEntry(entry.id)}
      >
        <span class=${`tag mem-activity__cat mem-activity__cat--${entry.category === "decision" ? "decision" : "summary"}`}>
          ${entry.category === "decision" ? "decision" : "summary"}
        </span>
        <div style="min-width:0">
          <div class="row__key">
            ${entry.project}${entry.sessionShort ? ` · ${entry.sessionShort}` : ""}
          </div>
          <div class="row__sub">${entry.preview}</div>
        </div>
        <span class="tag" title=${this.formatDate(entry.createdAt)}>${this.relativeTime(entry.createdAt)}</span>
      </div>
      ${expanded ? this.renderActivityDetail(entry) : ""}
    `;
  }

  private renderActivityDetail(entry: IMemoryIndexEntry): TemplateResult {
    const detail = this.detailCache.get(entry.id);
    return html`
      <div class="mem-activity__detail">
        <div class="mem-activity__detail-meta">
          <span class="tag">${entry.entryDate}</span>
          <span class="tag">importance ${fmtInt(entry.importance)}</span>
          ${entry.sessionShort ? html`<span class="tag">session ${entry.sessionShort}</span>` : ""}
        </div>
        ${detail
          ? html`<div class="mem-activity__detail-content">${detail.content}</div>`
          : this.detailLoadingId === entry.id
            ? html`<div class="mem-activity__detail-content mem-activity__detail-content--pending">lädt…</div>`
            : html`<div class="mem-activity__detail-content mem-activity__detail-content--pending">
                Eintrag konnte nicht geladen werden — nochmal klicken für einen neuen Versuch.
              </div>`}
      </div>
    `;
  }

  private renderActivityPagination(activity: IMemoryIndexActivity): TemplateResult {
    if (activity.filteredTotal <= ACTIVITY_PAGE_SIZE) {
      return html``;
    }
    const from = activity.offset + 1;
    const to = activity.offset + activity.entries.length;
    const hasNewer = this.activityPage > 0;
    const hasOlder = activity.offset + activity.entries.length < activity.filteredTotal;
    return html`
      <div class="mem-activity__pager">
        <button
          class="btn btn--sm"
          ?disabled=${!hasNewer}
          @click=${() => this.setActivityPage(this.activityPage - 1)}
        >
          ‹ neuere
        </button>
        <span class="mem-activity__pager-info">
          ${fmtInt(from)}–${fmtInt(to)} von ${fmtInt(activity.filteredTotal)}
        </span>
        <button
          class="btn btn--sm"
          ?disabled=${!hasOlder}
          @click=${() => this.setActivityPage(this.activityPage + 1)}
        >
          ältere ›
        </button>
      </div>
    `;
  }

  private relativeTime(value: string): string {
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) {
      return value;
    }
    const minutes = Math.floor((Date.now() - timestamp) / 60_000);
    if (minutes < 1) {
      return "gerade eben";
    }
    if (minutes < 60) {
      return `vor ${minutes} min`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `vor ${hours} h`;
    }
    return this.formatDate(value);
  }

  private dayLabel(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    const startOfDay = (input: Date): number =>
      new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
    if (dayDiff === 0) {
      return "Heute";
    }
    if (dayDiff === 1) {
      return "Gestern";
    }
    return date.toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "2-digit" });
  }

  private renderSource(source: LiveIndexSource, count: number): TemplateResult {
    return html`
      <div class=${`live-index__source live-index__source--${count > 0 ? "active" : "empty"}`}>
        <span class="live-index__source-label">${source}</span>
        <span class="live-index__source-count">${fmtInt(count)}</span>
      </div>
    `;
  }

  private renderDaemonSource(label: LiveIndexSource, source?: LiveIndexDaemonSourceState): TemplateResult {
    const records = source?.records ?? 0;
    const changed = source?.changed ?? 0;
    const unchanged = source?.unchanged ?? 0;

    return html`
      <div class=${`live-index__source live-index__source--${records > 0 ? "active" : "empty"}`}>
        <span class="live-index__source-label">${label}</span>
        <span class="live-index__source-count">${fmtInt(records)}</span>
        <span class="live-index__source-meta">${fmtInt(changed)} changed · ${fmtInt(unchanged)} unchanged</span>
      </div>
    `;
  }

  private renderLiveRecord(record: LiveIndexRecord): TemplateResult {
    return html`
      <div class="live-index__record">
        <div class="live-index__record-head">
          <span class=${`tag live-index__source-tag live-index__source-tag--${record.source}`}>${record.source}</span>
          <span class="live-index__record-agent">${record.agent}</span>
          <span class="live-index__record-date">${this.formatDate(record.entryDate)}</span>
        </div>
        <div class="live-index__record-content">${this.truncate(record.content, 220)}</div>
        <div class="live-index__record-file">${record.sourceFile}</div>
      </div>
    `;
  }

  private truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
  }

  private formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString(undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  }
}

customElements.define("neon-indexer", NeonIndexer);
