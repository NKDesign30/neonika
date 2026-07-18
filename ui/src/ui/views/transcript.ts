import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

type TranscriptMode = "live" | "wrapping" | "final";

interface TranscriptSessionDigest {
  readonly sessionKey: string;
  readonly project: string;
  readonly sessionId: string;
  readonly mode: TranscriptMode;
  readonly isSubagent: boolean;
  readonly messageCount: number;
  readonly userCount: number;
  readonly assistantCount: number;
  readonly toolFailureCount: number;
  readonly latestPreview: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

interface TranscriptSnapshot {
  readonly state: "ready" | "empty";
  readonly generatedAt: string;
  readonly totals: {
    readonly sessions: number;
    readonly messages: number;
    readonly projects: number;
    readonly subagentSessions: number;
  };
  readonly source: { readonly projectsDir: string };
  readonly sessions: readonly TranscriptSessionDigest[];
}

// Transcript indexer view: a read-only projection of Claude Code transcript
// session digests (~/.claude/projects). Deterministic, redaction-first — every
// preview crossed redactSnapshotText server-side. The LLM summary/decision/persist
// paths are gated server-side and not surfaced here.
export class NeonTranscript extends NeonView<TranscriptSnapshot> {
  protected load(signal: AbortSignal): Promise<TranscriptSnapshot> {
    return neonClient.transcript<TranscriptSnapshot>({ signal });
  }

  protected renderData(data: TranscriptSnapshot): TemplateResult {
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.transcript")}</h1>
            <p class="page__sub">
              ${fmtInt(data.totals.sessions)} sessions · ${fmtInt(data.totals.messages)} messages ·
              ${fmtInt(data.totals.projects)} projects · ${fmtInt(data.totals.subagentSessions)} subagent
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>
            ${icon("refresh", 13)} ${t("common.refresh")}
          </button>
        </div>

        <div class="card">
          <div class="card__head">
            <span class="card__title">Sessions</span>
          </div>
          <div class="card__body">
            ${data.sessions.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${data.sessions.slice(0, 120).map(
                    (session) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                        <div style="min-width:0">
                          <div class="row__key">
                            ${session.project} · ${session.mode}${session.isSubagent ? " · subagent" : ""}
                          </div>
                          <div class="row__sub">${session.latestPreview}</div>
                        </div>
                        <span class="tag">
                          ${session.messageCount}m · ${session.userCount}u/${session.assistantCount}a${session.toolFailureCount > 0
                            ? html` · ${session.toolFailureCount}✗`
                            : ""}
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
}

customElements.define("neon-transcript", NeonTranscript);
