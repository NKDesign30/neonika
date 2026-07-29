// Adapted from NK Design's Neon runtime for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import type { DatabaseSync } from "node:sqlite";

/**
 * Wie lange ist der letzte registrierte Recall her?
 *
 * Zwei Wartungsschritte entscheiden anhand von "wurde nie abgerufen": der
 * Ebbinghaus-Decay lässt solche Einträge verblassen, der Prune archiviert sie.
 * Beide setzen still voraus, dass die Suche funktioniert — nur dann bedeutet
 * "nie gefunden" auch "unwichtig".
 *
 * Am 24.07.2026 stimmte das fünf Tage lang nicht: die Recall-API lief mit
 * zwei Tage altem Code im FTS-Fallback, `access_count` blieb überall bei 0.
 * Der Decay lief weiter, und der Prune hätte Einträge archiviert, die schlicht
 * nicht auffindbar waren. Fehlt die Telemetrie länger als das Fenster, ist das
 * ein Systemfehler und kein Signal — dann wird nicht gerechnet und nicht
 * archiviert.
 *
 * Beide Aufrufer teilen sich diese Naht, damit der Schutz nicht an einer
 * Stelle nachgezogen und an der anderen vergessen wird.
 */

export const NEON_DEFAULT_RECALL_GAP_HOURS = 24;

const msPerHour = 3_600_000;

/**
 * Stunden seit dem jüngsten `last_accessed_at` über alle Einträge.
 * `Infinity`, wenn nie ein Recall registriert wurde (leere DB oder nur NULLs) —
 * dann ist der Decay erst recht kein Signal.
 */
export function readNeonRecallGapHours(database: DatabaseSync, nowMs: number): number {
  const row = database
    .prepare("SELECT MAX(last_accessed_at) AS lastAccess FROM memory_entries")
    .get() as Record<string, unknown>;
  const lastAccess = row["lastAccess"];
  if (typeof lastAccess !== "string" || lastAccess.length === 0) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(lastAccess);
  if (Number.isNaN(parsed)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (nowMs - parsed) / msPerHour);
}

/** Leak-safe Begründung für den eingefrorenen Lauf. */
export function describeNeonRecallGap(gapHours: number, limitHours: number): string {
  const since = Number.isFinite(gapHours) ? `${Math.round(gapHours)}h` : "nie";
  return `last recall ${since} ago (limit ${limitHours}h) - treating this as a broken search, not as unimportant entries`;
}
