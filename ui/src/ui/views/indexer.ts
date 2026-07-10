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

interface IndexerViewData {
  readonly indexer: IndexerSnapshot;
  readonly liveDaemon: LiveIndexDaemonSnapshot;
  readonly liveSync: LiveIndexSyncResult;
}

export class NeonIndexer extends NeonView<IndexerViewData> {
  protected async load(signal: AbortSignal): Promise<IndexerViewData> {
    const [indexer, liveDaemon, liveSync] = await Promise.all([
      neonClient.indexer<IndexerSnapshot>({ signal }),
      neonClient.liveIndexDaemon<LiveIndexDaemonSnapshot>({ signal }),
      neonClient.liveIndexSync<LiveIndexSyncResult>({ signal })
    ]);

    return { indexer, liveDaemon, liveSync };
  }

  protected renderData(data: IndexerViewData): TemplateResult {
    const { indexer, liveDaemon, liveSync } = data;
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
