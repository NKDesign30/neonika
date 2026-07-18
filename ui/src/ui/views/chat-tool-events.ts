import { html, type TemplateResult } from "lit";

import { icon, type IconName } from "../icons.js";

export type ChatToolEventKind = "tool-start" | "tool-output" | "file-write" | "command-exit";
export type ChatToolEventStatus = "started" | "done" | "error";

export interface ChatToolEvent {
  readonly id?: string;
  readonly kind: ChatToolEventKind;
  readonly status: ChatToolEventStatus;
  readonly title: string;
  readonly summary: string;
  readonly preview?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly exitCode?: number;
  readonly sequence?: number;
}

const visibleToolEventLimit = 6;

const toolEventKindLabels = {
  "tool-start": "Start",
  "tool-output": "Output",
  "file-write": "File",
  "command-exit": "Exit"
} as const satisfies Record<ChatToolEventKind, string>;

const toolEventStatusLabels = {
  started: "läuft",
  done: "fertig",
  error: "Fehler"
} as const satisfies Record<ChatToolEventStatus, string>;

export function iconForChatToolEvent(event: ChatToolEvent): IconName {
  if (event.status === "error") {
    return "alertTriangle";
  }
  if (event.kind === "command-exit") {
    return "terminal";
  }
  if (event.kind === "file-write") {
    return "fileText";
  }
  return event.kind === "tool-start" ? "zap" : "scrollText";
}

export function labelForChatToolEvent(event: ChatToolEvent): string {
  const status = toolEventStatusLabels[event.status];
  const kind = toolEventKindLabels[event.kind];
  return `${kind} · ${status}`;
}

export function visibleChatToolEvents(events: readonly ChatToolEvent[]): readonly ChatToolEvent[] {
  return events.slice(0, visibleToolEventLimit);
}

export function renderChatToolEvents(events: readonly ChatToolEvent[]): TemplateResult {
  const visibleEvents = visibleChatToolEvents(events);
  if (visibleEvents.length === 0) {
    return html``;
  }

  const hiddenCount = events.length - visibleEvents.length;
  return html`
    <div class="toolcards" aria-label="Tool events">
      ${visibleEvents.map((event) => renderChatToolEvent(event))}
      ${hiddenCount > 0 ? html`<div class="toolcards__more">+${hiddenCount} weitere Tool-Events</div>` : html``}
    </div>
  `;
}

function renderChatToolEvent(event: ChatToolEvent): TemplateResult {
  const preview = event.preview ?? "";
  return html`
    <article class=${`toolcard toolcard--${event.status}`}>
      <div class="toolcard__ico">${icon(iconForChatToolEvent(event), 14)}</div>
      <div class="toolcard__body">
        <div class="toolcard__top">
          <span class="toolcard__name">${event.title}</span>
          <span class="toolcard__status">${labelForChatToolEvent(event)}</span>
        </div>
        <div class="toolcard__sum">${event.summary}</div>
        ${preview ? html`<div class="toolcard__preview">${preview}</div>` : html``}
      </div>
    </article>
  `;
}
