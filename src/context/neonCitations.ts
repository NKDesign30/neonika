/**
 * Memory-Citations für Neon Core: nummeriert die Quellen eines Context-Packs und
 * dekoriert Item-Texte mit `[src:N]`-Markern. Rein darstellend, kein Side-Effect.
 *
 * Default-Modus ist `off` (keine Marker) — die Dekoration ist opt-in, damit der
 * bestehende Context-Pack-Report unverändert bleibt. Vorlage: upstream
 * `extensions/memory-core/src/tools.citations.ts` (`decorateCitations`,
 * `resolveMemoryCitationsMode`, `shouldIncludeCitations`).
 */
export type TNeonCitationsMode = "off" | "inline";

export function resolveNeonCitationsMode(value: string | undefined): TNeonCitationsMode {
  return value?.trim().toLowerCase() === "inline" ? "inline" : "off";
}

export function shouldIncludeNeonCitations(mode: TNeonCitationsMode): boolean {
  return mode === "inline";
}

/**
 * Baut einen stabilen Quellen-Index: jede distinkte `source` bekommt eine
 * 1-basierte Nummer in Erst-Auftritt-Reihenfolge. Items mit gleicher Quelle
 * teilen dieselbe Nummer.
 */
export function buildNeonCitationIndex(
  items: readonly { readonly source: string }[]
): ReadonlyMap<string, number> {
  const index = new Map<string, number>();

  for (const item of items) {
    if (!index.has(item.source)) {
      index.set(item.source, index.size + 1);
    }
  }

  return index;
}

export function formatNeonCitationMarker(citationNumber: number): string {
  return `[src:${citationNumber}]`;
}

/**
 * Setzt den `[src:N]`-Marker an den Text-Anfang, sofern die Quelle im Index
 * steht. Unbekannte Quelle -> Text unverändert (kein Marker, keine Exception).
 */
export function decorateNeonCitationText(
  text: string,
  source: string,
  index: ReadonlyMap<string, number>
): string {
  const citationNumber = index.get(source);

  if (citationNumber === undefined) {
    return text;
  }

  return `${formatNeonCitationMarker(citationNumber)} ${text}`;
}
