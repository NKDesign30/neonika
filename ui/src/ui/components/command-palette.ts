import { LitElement, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { buildPaletteItems, filterPaletteItems, type PaletteItem } from "../command-palette-model.js";
import { icon } from "../icons.js";
import { type Tab } from "../navigation.js";

// Command palette overlay. Read-only navigation only: it indexes the existing
// NAV_GROUPS and, on selection, dispatches the same `tab-select` event the shell
// already handles — no mutation, no slash-command execution. Opened by the
// topbar's `open-palette` event or Cmd/Ctrl+K (wired in app.ts), closed via
// `palette-close`.
export class NeonCommandPalette extends LitElement {
  @property({ type: Boolean }) open = false;
  @state() private query = "";
  @state() private activeIndex = 0;

  private readonly allItems: readonly PaletteItem[] = buildPaletteItems();

  // Render into light DOM so the existing .palette* styles in views.css apply.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override updated(changed: PropertyValues): void {
    if (changed.has("open") && this.open) {
      this.query = "";
      this.activeIndex = 0;
      queueMicrotask(() => {
        this.querySelector<HTMLInputElement>(".palette__input")?.focus();
      });
    }
  }

  private get filtered(): PaletteItem[] {
    return filterPaletteItems(this.allItems, this.query);
  }

  private close(): void {
    this.dispatchEvent(new CustomEvent("palette-close", { bubbles: true, composed: true }));
  }

  private selectItem(item: PaletteItem): void {
    this.dispatchEvent(new CustomEvent<Tab>("tab-select", { detail: item.id, bubbles: true, composed: true }));
    this.close();
  }

  private onInput(event: Event): void {
    this.query = (event.target as HTMLInputElement).value;
    this.activeIndex = 0;
  }

  private onKeydown(event: KeyboardEvent): void {
    const items = this.filtered;
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      this.activeIndex = items.length === 0 ? 0 : Math.min(this.activeIndex + 1, items.length - 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      this.activeIndex = Math.max(this.activeIndex - 1, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[this.activeIndex];
      if (item) this.selectItem(item);
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (!this.open) return nothing;
    const items = this.filtered;
    return html`
      <div
        class="palette-overlay"
        @click=${(event: Event) => {
          if (event.target === event.currentTarget) this.close();
        }}
      >
        <div class="palette" role="dialog" aria-label="Command palette" @keydown=${this.onKeydown}>
          <div class="palette__inputrow">
            ${icon("search", 16)}
            <input
              class="palette__input"
              type="text"
              placeholder="Jump to a view…"
              aria-label="Search views"
              .value=${this.query}
              @input=${this.onInput}
            />
          </div>
          <div class="palette__list" role="listbox">
            ${items.length === 0
              ? html`<div class="palette__item"><span class="palette__label">No match</span></div>`
              : items.map(
                  (item, index) => html`
                    <div
                      class=${"palette__item" + (index === this.activeIndex ? " palette__item--active" : "")}
                      role="option"
                      aria-selected=${index === this.activeIndex}
                      @click=${() => this.selectItem(item)}
                      @mouseenter=${() => {
                        this.activeIndex = index;
                      }}
                    >
                      <span class="palette__ico">${icon(item.icon, 14)}</span>
                      <span class="palette__label">${item.name}</span>
                      <span class="palette__hint">${item.group}</span>
                    </div>
                  `,
                )}
          </div>
          <div class="palette__foot">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>esc close</span>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define("neon-command-palette", NeonCommandPalette);
