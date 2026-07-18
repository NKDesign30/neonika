import { html, type TemplateResult } from "lit";
import { titleCase } from "./format.js";

export interface BadgeStyle {
  readonly label: string;
  readonly color: string;
  readonly bg: string;
}

// Maps a runtime status string to the design's badge palette.
export function statusBadge(status: string | undefined): BadgeStyle {
  const s = (status ?? "").toLowerCase();
  if (["completed", "active", "online", "ready", "ok", "done", "pass", "connected", "enabled"].includes(s)) {
    return { label: titleCase(s || "active"), color: "var(--brand-primary)", bg: "var(--brand-faint)" };
  }
  if (["failed", "error", "offline", "fail", "blocked"].includes(s)) {
    return { label: titleCase(s || "error"), color: "var(--status-error)", bg: "rgba(255,98,89,0.12)" };
  }
  if (["warn", "warning", "degraded", "needs-config", "pending"].includes(s)) {
    return { label: titleCase(s || "warn"), color: "var(--status-warning)", bg: "rgba(255,179,64,0.14)" };
  }
  return { label: titleCase(s || "idle"), color: "var(--text-tertiary)", bg: "var(--color-alpha-white-06)" };
}

export function renderBadge(badge: BadgeStyle): TemplateResult {
  return html`<span class="badge" style=${`background:${badge.bg};color:${badge.color}`}>
    <span class="badge__dot" style=${`background:${badge.color}`}></span>${badge.label}
  </span>`;
}
