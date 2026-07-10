import { LitElement, html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { I18nController, t } from "../../i18n/index.js";
import { icon } from "../icons.js";

// Shared loading / empty / error renderers used across every view so states
// look consistent and are never silently blank.
export function renderLoading(): TemplateResult {
  return html`<div class="empty">${t("state.loading")}</div>`;
}

export function renderEmpty(message?: string): TemplateResult {
  return html`<div class="empty">${message ?? t("state.empty")}</div>`;
}

export function renderError(message: string, retry: () => void): TemplateResult {
  return html`<div class="empty">
    <div style="margin-bottom:12px">${t("state.errorTitle")} · ${message}</div>
    <button class="btn btn--sm" @click=${retry}>${icon("refresh", 13)} ${t("state.retry")}</button>
  </div>`;
}

// Base for data-backed views: loads on connect, exposes loading/error/data,
// and renders the right state. Concrete views implement load() + renderData().
export abstract class NeonView<T> extends LitElement {
  @state() protected loading = true;
  @state() protected error: string | null = null;
  @state() protected data: T | null = null;

  private controller?: AbortController;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    super();
    // Re-render this view when the active locale changes.
    new I18nController(this);
  }

  protected createRenderRoot(): HTMLElement {
    return this;
  }

  protected abstract load(signal: AbortSignal): Promise<T>;
  protected abstract renderData(data: T): TemplateResult;

  // Views that advertise live data override this with a refresh interval (ms).
  // Background reloads keep data fresh without a loading flash (render only
  // shows the loading state while data is still null). Default: no polling.
  protected pollIntervalMs(): number | null {
    return null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.reload();
    const interval = this.pollIntervalMs();
    if (interval && interval > 0) {
      this.pollTimer = setInterval(() => void this.reload(), interval);
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.controller?.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async reload(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading = true;
    this.error = null;
    try {
      const result = await this.load(controller.signal);
      if (controller.signal.aborted) return;
      this.data = result;
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (!controller.signal.aborted) this.loading = false;
    }
  }

  override render(): TemplateResult {
    if (this.error !== null) {
      return html`<div class="page">${renderError(this.error, () => void this.reload())}</div>`;
    }
    if (this.loading && this.data === null) {
      return html`<div class="page">${renderLoading()}</div>`;
    }
    if (this.data === null) {
      return html`<div class="page">${renderEmpty()}</div>`;
    }
    return this.renderData(this.data);
  }
}
