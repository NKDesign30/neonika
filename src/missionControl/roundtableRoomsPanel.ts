/**
 * Read-only Mission-Control panel for the Neonika Roundtable (spec issue #15,
 * ticket #22). Renders the live rooms snapshot from
 * `roundtable/roundtableRoomsSnapshot.ts` — the running (or last) round, its
 * participants and a bounded, most-recent slice of its turn log.
 *
 * No fabricated state: the panel renders exactly what the store persisted, read
 * back through the store's normalizer; an absent rooms directory renders an
 * honest "no rounds yet" line. Leak-safe: the snapshot carries no filesystem
 * paths and every turn preview already crossed the redaction seam, and every
 * string is HTML-escaped here anyway.
 */

import type {
  INeonRoundtableRoomProjection,
  INeonRoundtableRoomsSnapshot
} from "../roundtable/roundtableRoomsSnapshot.js";
import type { TNeonRoundtableRoomStatus } from "../roundtable/roundtableRoomStore.js";

const STATUS_TAGS: Readonly<Record<TNeonRoundtableRoomStatus, string>> = {
  open: "ok",
  "awaiting-judge": "warn",
  resolved: "muted",
  abandoned: "muted"
};

export function renderNeonMissionControlRoundtableRoomsPanel(
  snapshot?: INeonRoundtableRoomsSnapshot
): string {
  if (!snapshot) {
    return `<article class="panel" id="roundtableRoomsPanel">
          <div class="panel-header">
            <h2 class="panel-title">Neonika Roundtable</h2>
            <span class="tag muted">not loaded</span>
          </div>
          <div class="panel-body stack">
            <div class="line muted">Roundtable rooms are not loaded for this view.</div>
          </div>
        </article>`;
  }

  // Interpolation invariant: every STRING from the snapshot goes through
  // escapeRoundtableHtml; raw interpolation is reserved for normalized NUMBERS
  // (counts, seq) and closed-enum values used as CSS class keys. A future string
  // field must be escaped here.
  const runningTag = `<span class="tag ${snapshot.runningCount > 0 ? "ok" : "muted"}" id="roundtableRunningCount">${snapshot.runningCount} running</span>`;
  const roomsLine = `${snapshot.roomCount} room(s) · ${snapshot.runningCount} running`;

  if (!snapshot.current) {
    return `<article class="panel" id="roundtableRoomsPanel">
          <div class="panel-header">
            <h2 class="panel-title">Neonika Roundtable</h2>
            ${runningTag}
          </div>
          <div class="panel-body stack">
            <div class="line"><strong>rooms</strong> <span id="roundtableRooms">${roomsLine}</span></div>
            <div class="line muted" id="roundtableCurrent">No rounds yet — the discourse loop has not written a room.</div>
            <div class="line"><strong>safety</strong> <span class="muted">read-only projection · no live run · outbound suppressed under the shadow contract</span></div>
          </div>
        </article>`;
  }

  return `<article class="panel" id="roundtableRoomsPanel">
          <div class="panel-header">
            <h2 class="panel-title">Neonika Roundtable</h2>
            ${runningTag}
            <span class="tag ${STATUS_TAGS[snapshot.current.status]}" id="roundtableCurrentStatus">${escapeRoundtableHtml(snapshot.current.status)}</span>
          </div>
          <div class="panel-body stack">
            <div class="line"><strong>rooms</strong> <span id="roundtableRooms">${roomsLine}</span></div>
            ${renderCurrentRound(snapshot.current)}
            <div class="line"><strong>safety</strong> <span class="muted">read-only projection · no live run · outbound suppressed under the shadow contract</span></div>
          </div>
        </article>`;
}

function renderCurrentRound(current: INeonRoundtableRoomProjection): string {
  const participants =
    current.participants.length > 0
      ? current.participants
          .map((p) => `${escapeRoundtableHtml(p.id)}(${escapeRoundtableHtml(p.runtime)}/${escapeRoundtableHtml(p.role)})`)
          .join(", ")
      : "none";
  const turnsHeading = `${current.turnCount} turn(s)${current.turnsTruncated ? ` · showing last ${current.turns.length}` : ""}`;
  const turnLines =
    current.turns.length > 0
      ? current.turns
          .map(
            (turn) =>
              `<div class="line" data-turn-seq="${turn.seq}">#${turn.seq} ${escapeRoundtableHtml(turn.at)} <strong>${escapeRoundtableHtml(turn.speaker)}</strong> [${escapeRoundtableHtml(turn.kind)}]: ${escapeRoundtableHtml(turn.preview)}</div>`
          )
          .join("\n            ")
      : `<div class="line muted">No turns yet.</div>`;

  return `<div class="line"><strong>current</strong> <span id="roundtableCurrentRound">${escapeRoundtableHtml(current.roundId)} · ${escapeRoundtableHtml(current.purpose)} · ${escapeRoundtableHtml(current.status)}${current.running ? " (running)" : ""}</span></div>
            <div class="line"><strong>participants</strong> <span id="roundtableParticipants">${participants}</span></div>
            <div class="line"><strong>turns</strong> <span id="roundtableTurnsHeading">${turnsHeading}</span></div>
            ${turnLines}`;
}

function escapeRoundtableHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
