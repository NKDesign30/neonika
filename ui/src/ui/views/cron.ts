import { html, type TemplateResult } from "lit";
import { t } from "../../i18n/index.js";
import { renderBadge, statusBadge } from "../badges.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

interface AutomationJob {
  readonly id: string;
  readonly kind?: string;
  readonly label?: string;
  readonly state?: string;
  readonly policy?: string;
  readonly schedule?: string;
  readonly summary?: string;
}
interface AutomationHook {
  readonly id: string;
  readonly event?: string;
  readonly state?: string;
  readonly policy?: string;
  readonly summary?: string;
}
interface AutomationSnapshot {
  readonly policy?: string;
  readonly jobs: readonly AutomationJob[];
  readonly hooks: readonly AutomationHook[];
  readonly totals: { readonly jobs: number; readonly hooks: number; readonly enabled: number; readonly disabled: number };
  readonly recovery?: readonly string[];
}

export interface CronDaemonLive {
  readonly pid: number;
  readonly alive: boolean;
  readonly gateEnabled: boolean;
  readonly intervalMs: number;
  readonly startedAt: string;
  readonly lastTickAt?: string;
  readonly nextTickAt?: string;
  readonly tickCount: number;
  readonly dueIntentsLastTick: number;
  readonly catchupIntentsLastTick: number;
  readonly createdRunsTotal: number;
  readonly createdWorkspaceNotesTotal: number;
  readonly stoppedAt?: string;
}
export interface CronJob {
  readonly id: string;
  readonly schedule: string;
  readonly intervalMinutes?: number;
  readonly state: string;
  readonly nextRunAt?: string;
  readonly lastEmittedWindow?: string;
}
export interface CronSnapshot {
  readonly gate: { readonly enabled: boolean; readonly reason: string; readonly envKey: string };
  readonly cursorPresent: boolean;
  readonly cursor: { readonly ticks: number; readonly lastTickAt?: string; readonly emitted: Record<string, string> };
  readonly jobs: readonly CronJob[];
  readonly daemon?: CronDaemonLive;
  readonly daemonStale: boolean;
  readonly safety: { readonly agentExecuted: boolean; readonly outboundSent: boolean; readonly wroteLiveRun: boolean };
}

interface CronViewData {
  readonly automation: AutomationSnapshot;
  readonly cron: CronSnapshot | null;
}

export function cronStateLabel(cron: CronSnapshot): string {
  if (!cron.daemon) return "not running";
  if (cron.daemon.alive) return cron.daemonStale ? "alive · stale" : "alive";
  return "stopped";
}
export function cronBadgeStatus(cron: CronSnapshot): string {
  if (!cron.daemon) return "idle";
  if (cron.daemon.alive) return cron.daemonStale ? "warn" : "ok";
  return "idle";
}
export function cronGateLabel(cron: CronSnapshot): string {
  const enabled = cron.daemon ? cron.daemon.gateEnabled : cron.gate.enabled;
  return enabled ? "armed" : "shadow";
}
export function cronTickSummary(cron: CronSnapshot): string {
  if (!cron.daemon) return "no ticks yet";
  return `${cron.daemon.tickCount} tick(s) · ${cron.daemon.dueIntentsLastTick} due last tick · ${cron.daemon.catchupIntentsLastTick} catch-up last tick · ${cron.daemon.createdRunsTotal} shadow run(s) created · ${cron.daemon.createdWorkspaceNotesTotal} workspace note(s)`;
}
export function cronCursorLabel(cron: CronSnapshot): string {
  return cron.cursorPresent
    ? `present · tick #${cron.cursor.ticks}${cron.cursor.lastTickAt ? ` · last ${cron.cursor.lastTickAt}` : ""}`
    : "absent · never ticked";
}

export class NeonCron extends NeonView<CronViewData> {
  protected override pollIntervalMs(): number {
    return 10_000;
  }

  protected async load(signal: AbortSignal): Promise<CronViewData> {
    const [automation, cron] = await Promise.all([
      neonClient.automation<AutomationSnapshot>({ signal }),
      neonClient.cron<CronSnapshot>({ signal }).catch(() => null),
    ]);
    return { automation, cron };
  }

  protected renderData(data: CronViewData): TemplateResult {
    const { automation, cron } = data;
    const jobs: readonly CronJob[] = cron?.jobs ?? automation.jobs.map((job): CronJob => ({
      id: job.id,
      schedule: job.schedule ?? "—",
      state: job.state ?? "unknown",
    }));
    return html`
      <div class="page">
        <div class="page__head">
          <div>
            <h1 class="page__title">${t("tabs.cron")}</h1>
            <p class="page__sub">
              ${fmtInt(automation.totals.jobs)} jobs · ${fmtInt(automation.totals.hooks)} hooks ·
              ${fmtInt(automation.totals.enabled)} enabled · policy ${automation.policy ?? "shadow"}
            </p>
          </div>
          <button class="btn btn--sm" @click=${() => void this.reload()}>${icon("refresh", 13)} ${t("common.refresh")}</button>
        </div>

        ${this.renderCronDaemon(cron)}

        <div class="card" style="margin-top:14px">
          <div class="card__head"><span class="card__title">Scheduled jobs</span></div>
          <div class="tablewrap">
            <table class="dtable">
              <thead>
                <tr><th style="width:30%">Job</th><th>Schedule</th><th>Policy</th><th>Last emitted</th><th>State</th></tr>
              </thead>
              <tbody>
                ${jobs.length === 0
                  ? html`<tr><td colspan="5"><div class="empty">${t("state.empty")}</div></td></tr>`
                  : jobs.map((job) => {
                      const automationJob = automation.jobs.find((entry) => entry.id === job.id);
                      return html`
                        <tr>
                          <td>
                            <span class="cellkey">${automationJob?.label ?? job.id}</span>
                            ${automationJob?.summary ? html`<div class="cellmuted">${automationJob.summary}</div>` : ""}
                          </td>
                          <td><span class="cellmuted">${job.schedule}</span></td>
                          <td><span class="cellmuted">${automationJob?.policy ?? "—"}</span></td>
                          <td><span class="cellmuted">${job.lastEmittedWindow ?? "none"}</span></td>
                          <td>${renderBadge(statusBadge(job.state))}</td>
                        </tr>
                      `;
                    })}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="card__head"><span class="card__title">Hooks</span></div>
          <div class="card__body">
            ${automation.hooks.length === 0
              ? html`<div class="empty">${t("state.empty")}</div>`
              : html`<div class="rowlist">
                  ${automation.hooks.map(
                    (h) => html`
                      <div class="row" style="grid-template-columns:minmax(0,1fr) auto">
                        <div style="min-width:0">
                          <div class="row__key">${h.event ?? h.id}</div>
                          <div class="row__sub">${h.summary ?? h.policy ?? ""}</div>
                        </div>
                        ${renderBadge(statusBadge(h.state))}
                      </div>
                    `,
                  )}
                </div>`}
          </div>
        </div>

        ${automation.recovery && automation.recovery.length > 0
          ? html`<div class="card" style="margin-top:14px">
              <div class="card__head"><span class="card__title">Recovery</span></div>
              <div class="card__body">
                ${automation.recovery.map((r) => html`<div class="feed__item"><div class="feed__ico feed__ico--warn">${icon("alertTriangle", 13)}</div><div class="feed__text">${r}</div></div>`)}
              </div>
            </div>`
          : ""}
      </div>
    `;
  }

  private renderCronDaemon(cron: CronSnapshot | null): TemplateResult {
    if (!cron) {
      return html`<div class="card">
        <div class="card__head"><span class="card__title">Cron Daemon</span></div>
        <div class="card__body"><div class="empty">Status nicht verfügbar.</div></div>
      </div>`;
    }

    const stateBadge = { ...statusBadge(cronBadgeStatus(cron)), label: cronStateLabel(cron) };

    return html`<div class="card">
      <div class="card__head">
        <span class="card__title">Cron Daemon</span>
        <span class="tag">${cronGateLabel(cron)}</span>
        ${renderBadge(stateBadge)}
      </div>
      <div class="card__body">
        <div class="rowlist">
          <div class="row" style="grid-template-columns:minmax(0,1fr)">
            <div style="min-width:0">
              <div class="row__key">${cronTickSummary(cron)}</div>
              <div class="row__sub">
                lastTick ${cron.daemon?.lastTickAt ?? "none"} · nextTick ${cron.daemon?.nextTickAt ?? "none"}
              </div>
              <div class="row__sub">cursor ${cronCursorLabel(cron)}</div>
              <div class="row__sub">gate ${cron.gate.envKey} · ${cron.gate.reason}</div>
            </div>
          </div>
          <div class="row" style="grid-template-columns:minmax(0,1fr)">
            <div class="row__sub">
              safety: agentExecuted=${String(cron.safety.agentExecuted)} ·
              outboundSent=${String(cron.safety.outboundSent)} ·
              wroteLiveRun=${String(cron.safety.wroteLiveRun)} · run-records terminal shadow
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }
}

customElements.define("neon-cron", NeonCron);
