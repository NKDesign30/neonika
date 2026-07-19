// Adapted from NK Design's Mission Control Sites view for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { html, svg, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { fmtInt } from "../format.js";
import { neonClient } from "../gateway.js";
import { icon } from "../icons.js";
import { NeonView } from "../components/state-pane.js";

// Reichweite der Neonika-Seiten. Links die Seitenliste, rechts ein Performance-
// Dashboard pro Seite: Cloudflare (volle Reichweite inkl. Bots) und GA4 (nur mit
// Cookie-Einwilligung) nebeneinander, dazu ein SVG-Verlaufs-Chart. Datenquelle
// ist /api/neon-sites + /api/neon-sites/analytics (public-safe konfiguriert).
// Visuell auf die bestehende Mission-Control-Sprache gehoben (dichte
// Stat-Cards, Premium-Chart mit Hover-Tooltip, Top-Listen mit Flaggen). Das CSS
// dazu lebt scoped unter `neon-sites` in styles/views.css.

interface INeonSite {
  readonly property: string;
  readonly label: string;
  readonly domain: string;
}
interface IGa4Totals {
  readonly users: number;
  readonly sessions: number;
  readonly pageViews: number;
  readonly downloads: number;
}
interface IGa4DailyPoint {
  readonly date: string;
  readonly users: number;
  readonly pageViews: number;
}
interface ITopPage {
  readonly path: string;
  readonly views: number;
}
interface ITopCountry {
  readonly country: string;
  readonly users: number;
}
interface IGa4Block {
  readonly totals?: IGa4Totals;
  readonly topPages?: readonly ITopPage[];
  readonly topCountries?: readonly ITopCountry[];
  readonly daily?: readonly IGa4DailyPoint[];
  readonly hasData?: boolean;
  readonly error?: string;
}
interface ICfTotals {
  readonly requests: number;
  readonly pageViews: number;
  readonly uniques: number;
  readonly bytes: number;
}
interface ICfDailyPoint {
  readonly date: string;
  readonly requests: number;
  readonly pageViews: number;
  readonly uniques: number;
}
interface ICfBlock {
  readonly totals?: ICfTotals;
  readonly daily?: readonly ICfDailyPoint[];
  readonly hasData?: boolean;
  readonly error?: string;
}
interface ISiteAnalytics {
  readonly property: string;
  readonly label: string;
  readonly days: number;
  readonly ga4: IGa4Block | null;
  readonly cloudflare: ICfBlock | null;
}
interface ISitesData {
  readonly sites: readonly INeonSite[];
  readonly selected: string;
  readonly days: number;
  readonly analytics: ISiteAnalytics | null;
  readonly analyticsError: string | null;
}

// Ein Punkt der Verlaufs-Serie: Requests (Balken) + eindeutige Besucher (Linie).
interface ISeriesPoint {
  readonly req: number;
  readonly vis: number;
  readonly date: string;
}

const DAY_RANGES: readonly number[] = [7, 28, 90];

// Akzent-Punkt pro Seite: Neonika Solar, Sub-Brands in ihren Farben. Per
// Domain/Property erkannt, damit neue Properties ohne Code-Änderung mitlaufen.
function siteAccent(site: INeonSite): string {
  const key = `${site.property} ${site.domain}`.toLowerCase();
  if (key.includes("wispr")) return "var(--subbrand-wispr)";
  if (key.includes("bar")) return "var(--subbrand-bar)";
  if (key.includes("quill")) return "var(--subbrand-quill)";
  if (key.includes("nk") || key.includes("design")) return "var(--subbrand-nkdesign)";
  return "var(--brand-primary)";
}

// Mini-Flaggen als CSS-Gradient (DE/AT/CH/US/NL), deutsche und GA4-englische
// Ländernamen gemappt. Unbekannt -> neutraler grauer Streifen statt Fehler.
type FlagStops = readonly [string, string, string];
const FLAGS: Record<string, FlagStops | "ch"> = {
  deutschland: ["#000000", "#DD0000", "#FFCE00"],
  germany: ["#000000", "#DD0000", "#FFCE00"],
  österreich: ["#C8102E", "#FFFFFF", "#C8102E"],
  austria: ["#C8102E", "#FFFFFF", "#C8102E"],
  schweiz: "ch",
  switzerland: "ch",
  usa: ["#3C3B6E", "#FFFFFF", "#B22234"],
  "united states": ["#3C3B6E", "#FFFFFF", "#B22234"],
  niederlande: ["#AE1C28", "#FFFFFF", "#21468B"],
  netherlands: ["#AE1C28", "#FFFFFF", "#21468B"],
};
function renderFlag(name: string): TemplateResult {
  const f = FLAGS[name.toLowerCase()];
  if (f === "ch") {
    return html`<span class="flag" style="background:#D52B1E">
      <span style="position:absolute;inset:0;margin:auto;width:7px;height:2px;background:#fff"></span>
      <span style="position:absolute;inset:0;margin:auto;width:2px;height:7px;background:#fff"></span>
    </span>`;
  }
  const s: FlagStops = f ?? ["#444", "#666", "#888"];
  return html`<span
    class="flag"
    style=${`background:linear-gradient(${s[0]} 0 33.3%, ${s[1]} 33.3% 66.6%, ${s[2]} 66.6%)`}
  ></span>`;
}

const MONTHS: readonly string[] = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
function fmtDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()}. ${MONTHS[d.getMonth()] ?? ""}`;
}

export class NeonSites extends NeonView<ISitesData> {
  @state() private selected = "";
  @state() private days = 28;
  // Index des gehoverten Chart-Punkts; steuert Tooltip + Balken-Highlight.
  @state() private hover: number | null = null;

  protected async load(signal: AbortSignal): Promise<ISitesData> {
    const list = await neonClient.sites<{ sites: readonly INeonSite[] }>({ signal });
    const sites = list.sites ?? [];
    const selected = sites.some((s) => s.property === this.selected)
      ? this.selected
      : sites[0]?.property ?? "";

    let analytics: ISiteAnalytics | null = null;
    let analyticsError: string | null = null;
    if (selected) {
      try {
        analytics = await neonClient.siteAnalytics<ISiteAnalytics>(selected, this.days, { signal });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        analyticsError = err instanceof Error ? err.message : String(err);
      }
    }
    return { sites, selected, days: this.days, analytics, analyticsError };
  }

  private pick(property: string): void {
    if (property === this.selected) return;
    this.selected = property;
    this.hover = null;
    void this.reload();
  }

  private setDays(days: number): void {
    if (days === this.days) return;
    this.days = days;
    this.hover = null;
    void this.reload();
  }

  private setHover(index: number | null): void {
    this.hover = index;
  }

  protected renderData(data: ISitesData): TemplateResult {
    return html`
      <div class="page">
        <header class="head">
          <div>
            <h1 class="head__title">Neonika Sites</h1>
            <div class="head__sub">
              <span>Reichweite der Neonika-Seiten</span>
              <span style="color:var(--text-quaternary)">·</span>
              <span class="head__src"><span class="src-dot" style="background:var(--brand-primary)"></span> Cloudflare</span>
              <span class="head__src"><span class="src-dot" style="background:var(--text-tertiary)"></span> Google Analytics</span>
            </div>
          </div>
          <button class="btn" @click=${() => void this.reload()}>${icon("refresh", 14)} Aktualisieren</button>
        </header>

        <div class="grid">${this.renderRail(data)} ${this.renderMain(data)}</div>
      </div>
    `;
  }

  private renderRail(data: ISitesData): TemplateResult {
    return html`
      <aside class="rail">
        <div class="rail__label eyebrow-m">Seiten</div>
        ${data.sites.map((site) => {
          const active = site.property === data.selected;
          const req = active && data.analytics?.cloudflare?.totals
            ? fmtInt(data.analytics.cloudflare.totals.requests)
            : "";
          return html`
            <button class="site ${active ? "site--active" : ""}" @click=${() => this.pick(site.property)}>
              <span class="site__dot" style=${`background:${siteAccent(site)}`}></span>
              <span class="site__copy">
                <span class="site__name">${site.label}</span>
                <span class="site__domain">${site.domain}</span>
              </span>
              <span class="site__req">${req}</span>
            </button>
          `;
        })}
      </aside>
    `;
  }

  private renderMain(data: ISitesData): TemplateResult {
    const site = data.sites.find((s) => s.property === data.selected);
    const segBar = html`
      <div class="bar">
        <div class="seg">
          ${DAY_RANGES.map(
            (d) => html`
              <button
                class="seg__btn ${d === data.days ? "seg__btn--active" : ""}"
                @click=${() => this.setDays(d)}
              >
                ${d} Tage
              </button>
            `,
          )}
        </div>
        <span class="bar__meta">${site?.domain ?? ""} · ${data.days} Tage</span>
      </div>
    `;

    if (data.analyticsError) {
      return html`<main>
        ${segBar}
        <div class="card"><div class="empty">Daten nicht verfügbar: ${data.analyticsError}</div></div>
      </main>`;
    }
    const a = data.analytics;
    if (!a) {
      return html`<main>${segBar}<div class="card"><div class="empty">Keine Seite ausgewählt.</div></div></main>`;
    }

    const cf = a.cloudflare ?? {};
    const ga = a.ga4 ?? {};
    const cfT = cf.totals;
    const gaT = ga.totals;
    const downloads = gaT?.downloads ?? 0;

    const stats: ReadonlyArray<{
      icon: "activity" | "monitor" | "users" | "download";
      label: string;
      src: "CF" | "GA4";
      value: number;
      brand?: boolean;
      hint: string;
    }> = [
      { icon: "activity", label: "Requests", src: "CF", value: cfT?.requests ?? 0, brand: true, hint: "alle Zugriffe" },
      { icon: "monitor", label: "Besucher", src: "CF", value: cfT?.uniques ?? 0, hint: "eindeutig" },
      { icon: "users", label: "Nutzer", src: "GA4", value: gaT?.users ?? 0, hint: "mit Einwilligung" },
      { icon: "download", label: "Downloads", src: "GA4", value: downloads, hint: downloads === 1 ? "Event" : "Events" },
    ];

    const series: readonly ISeriesPoint[] = (cf.daily ?? []).map((d) => ({
      req: d.requests,
      vis: d.uniques,
      date: d.date,
    }));

    return html`
      <main>
        ${segBar}

        <section class="stats">
          ${stats.map(
            (s) => html`
              <div class="stat">
                <div class="stat__label">
                  ${icon(s.icon, 12)} ${s.label}
                  <span class="stat__src ${s.src === "CF" ? "stat__src--cf" : ""}">${s.src}</span>
                </div>
                <div class="stat__value ${s.brand ? "stat__value--brand" : ""}">${fmtInt(s.value)}</div>
                <div class="stat__foot"><span class="stat__hint">${s.hint}</span></div>
              </div>
            `,
          )}
        </section>

        <section class="card">
          <div class="card__head">
            <span class="card__title">Verlauf — Requests &amp; Besucher</span>
            <span class="tag-cf">${icon("cloud", 11)} CLOUDFLARE</span>
          </div>
          <div class="chart">${this.renderChart(series)}</div>
        </section>

        <div class="cols">
          <section class="card">
            <div class="card__head">
              <span class="card__title">Top-Seiten</span>
              <span class="tag-ga">${icon("fileText", 11)} GA4</span>
            </div>
            ${this.renderBarList(
              (ga.topPages ?? []).map((p) => [p.path, p.views] as const),
              { mono: true },
            )}
          </section>
          <section class="card">
            <div class="card__head">
              <span class="card__title">Top-Länder</span>
              <span class="tag-ga">${icon("globe", 11)} GA4</span>
            </div>
            ${this.renderBarList(
              (ga.topCountries ?? []).map((c) => [c.country, c.users] as const),
              { flags: true },
            )}
          </section>
        </div>
      </main>
    `;
  }

  // Premium-Verlaufs-Chart aus den Cloudflare-Tagesdaten: Balken = Requests
  // (eigene Skala), Linie = eindeutige Besucher (eigene Skala, damit beide
  // sichtbar bleiben), Peak-Annotation und Hover-Tooltip. Geometrie 1:1 aus dem
  // Design-Export. Selbst gezeichnet, keine Chart-Lib.
  private renderChart(series: readonly ISeriesPoint[]): TemplateResult {
    if (series.length === 0) return html`<div class="empty">Keine Verlaufsdaten im Zeitraum.</div>`;

    const VW = 1000;
    const VH = 300;
    const padL = 14;
    const padR = 14;
    const padT = 42;
    const plotW = VW - padL - padR;
    const plotH = VH - padT - 40;
    const baseY = padT + plotH;
    const n = series.length;
    const maxReq = Math.max(1, ...series.map((s) => s.req));
    const maxVis = Math.max(1, ...series.map((s) => s.vis));
    const bandW = plotW / n;
    const barW = Math.min(bandW * 0.54, 56);
    const cx = (i: number): number => padL + bandW * (i + 0.5);
    const yReq = (v: number): number => baseY - (v / maxReq) * plotH;
    const yVis = (v: number): number => baseY - (v / maxVis) * plotH * 0.88;
    const peakIdx = series.reduce((bi, s, i) => (s.req > (series[bi]?.req ?? -Infinity) ? i : bi), 0);
    const peakReq = series[peakIdx]?.req ?? 0;
    const linePts = series
      .map((s, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${yVis(s.vis).toFixed(1)}`)
      .join(" ");
    const grid: readonly number[] = [0.25, 0.5, 0.75, 1];
    const axisIdx: readonly number[] = [0, Math.floor((n - 1) / 2), n - 1];
    const hover = this.hover;

    const hoverPoint = hover != null ? series[hover] : undefined;
    const tip = hoverPoint ? this.chartPoint(series, hover ?? 0) : null;

    return html`
      <div class="chartwrap">
        ${svg`
          <svg viewBox="0 0 ${VW} ${VH}" role="img" aria-label="Verlauf Requests und Besucher"
            @mouseleave=${() => this.setHover(null)}>
            ${grid.map(
              (g, i) => svg`<line class="grid-line" x1=${padL} x2=${VW - padR}
                y1=${baseY - g * plotH} y2=${baseY - g * plotH} opacity=${i === grid.length - 1 ? 0 : 1}></line>`,
            )}
            <line class="grid-line" x1=${padL} x2=${VW - padR} y1=${baseY} y2=${baseY}></line>
            ${series.map(
              (s, i) => svg`
              <g @mouseenter=${() => this.setHover(i)}>
                <rect class="bar-hit" x=${padL + bandW * i} y=${padT - 8} width=${bandW} height=${plotH + 8}></rect>
                <rect class="bar-rect ${hover === i ? "is-hover" : ""}"
                  x=${cx(i) - barW / 2} y=${yReq(s.req)} width=${barW}
                  height=${Math.max(2, baseY - yReq(s.req))} rx="4" ry="4" fill="var(--brand-muted)"></rect>
              </g>`,
            )}
            <text class="peak-text" x=${cx(peakIdx)} y=${yReq(peakReq) - 12} text-anchor="middle">max ${fmtInt(peakReq)} req</text>
            <path class="vis-line" d=${linePts}></path>
            ${series.map(
              (s, i) => svg`<circle class="vis-dot" cx=${cx(i)} cy=${yVis(s.vis)} r=${hover === i ? 5 : 3.2}></circle>`,
            )}
            ${axisIdx.map(
              (i, k) => svg`<text class="axis-text" x=${cx(i)} y=${baseY + 26}
                text-anchor=${k === 0 ? "start" : k === 2 ? "end" : "middle"}>${fmtDay(series[i]?.date ?? "")}</text>`,
            )}
          </svg>
        `}
        ${tip && hoverPoint
          ? html`
              <div class="tip" style=${`left:${tip.leftPct}%;top:calc(${tip.topPct}% - 10px)`}>
                <div class="tip__date">${fmtDay(hoverPoint.date)}</div>
                <div class="tip__row">
                  <span class="tip__sw" style="background:var(--brand-muted)"></span>
                  <span class="tip__k">Requests</span>
                  <span class="tip__v">${fmtInt(hoverPoint.req)}</span>
                </div>
                <div class="tip__row">
                  <span class="tip__sw" style="background:var(--brand-bright)"></span>
                  <span class="tip__k">Besucher</span>
                  <span class="tip__v">${fmtInt(hoverPoint.vis)}</span>
                </div>
              </div>
            `
          : null}
      </div>
      <div class="legend">
        <span class="legend__item"><span class="legend__sw" style="background:var(--brand-muted)"></span> Requests</span>
        <span class="legend__item"><span class="legend__line"></span> Eindeutige Besucher</span>
      </div>
    `;
  }

  // Geteilte Geometrie, damit der Tooltip exakt auf dem Besucher-Datenpunkt sitzt.
  private chartPoint(series: readonly ISeriesPoint[], i: number): { leftPct: number; topPct: number } {
    const VW = 1000;
    const VH = 300;
    const padL = 14;
    const padR = 14;
    const padT = 42;
    const plotW = VW - padL - padR;
    const plotH = VH - padT - 40;
    const baseY = padT + plotH;
    const n = series.length;
    const maxVis = Math.max(1, ...series.map((s) => s.vis));
    const cx = padL + (plotW / n) * (i + 0.5);
    const cy = baseY - ((series[i]?.vis ?? 0) / maxVis) * plotH * 0.88;
    return { leftPct: (cx / VW) * 100, topPct: (cy / VH) * 100 };
  }

  private renderBarList(
    rows: ReadonlyArray<readonly [string, number]>,
    opts: { mono?: boolean; flags?: boolean },
  ): TemplateResult {
    if (rows.length === 0) return html`<div class="empty">Keine Daten im Zeitraum.</div>`;
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return html`
      <div class="blist">
        ${rows.map(
          ([key, val]) => html`
            <div class="brow">
              <div class="brow__keywrap">
                ${opts.flags ? renderFlag(key) : null}
                <span class="brow__key ${opts.mono ? "brow__key--mono" : ""}">${key}</span>
              </div>
              <span class="brow__track">
                <span class="brow__fill" style=${`width:${(val / max) * 100}%`}></span>
              </span>
              <span class="brow__val">${fmtInt(val)}</span>
            </div>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("neon-sites", NeonSites);
