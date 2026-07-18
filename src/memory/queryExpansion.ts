// Query-Expansion für den FTS-basierten Memory-Recall von Neonika.
//
// Neonika delegiert Recall an die `memory-search` CLI (FTS5 im Hintergrund).
// FTS arbeitet am besten mit konkreten Keywords, Nutzer fragen aber oft
// konversationell ("das Ding von gestern über die API"). Dieser Modul zieht die
// bedeutungstragenden Keywords aus so einer Query, damit die FTS-Treffer
// fokussierter werden.
//
// Bewusst rebuild-native statt 1:1-Kopie der upstream-Vorlage
// (`packages/memory-host-sdk/src/host/query-expansion.ts`):
//   1. Backend-agnostisch — KEIN `original OR kw1 OR kw2`-FTS5-Syntax (das setzt
//      ein OR-fähiges Backend voraus; die `memory-search` CLI bekommt einen
//      schlichten Term-String, konsistent mit `composeScopedQuery`).
//   2. Neon ist DE+EN — upstream projects Set hat EN/ES/PT/AR/KO/JA/ZH, aber KEIN
//      Deutsch (the operator's language). CJK-Tokenizer wären YAGNI; hier ein
//      fokussiertes EN+DE-Stopword-Set mit Whitespace/Punktuation-Tokenizer.
//
// Stopwords stehen in kanonischer Umlaut-Schreibweise ("für"/"über"), weil der
// Tokenizer lowercased ("Für" -> "für"); ASCII-Ersatzformen würden echte
// deutsche Queries nicht matchen.
//
// Rein darstellend: keine Command-Execution, kein File-I/O, deterministisch.

const NEON_QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  // --- Englisch: Artikel / Determiner ---
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  // --- Englisch: Pronomen ---
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  // --- Englisch: Hilfsverben ---
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "can",
  "may",
  "might",
  // --- Englisch: Präpositionen / Konjunktionen ---
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "about",
  "into",
  "and",
  "or",
  "but",
  "if",
  "then",
  "because",
  "as",
  "while",
  "when",
  "where",
  "what",
  "which",
  "who",
  "how",
  "why",
  // --- Englisch: vage Zeit-/Ding-Referenzen ---
  "yesterday",
  "today",
  "tomorrow",
  "earlier",
  "later",
  "recently",
  "ago",
  "just",
  "now",
  "thing",
  "things",
  "stuff",
  "something",
  "anything",
  "everything",
  "nothing",
  // --- Englisch: Höflichkeits-/Anfrage-Wörter ---
  "please",
  "help",
  "find",
  "show",
  "get",
  "tell",
  "give",
  // --- Deutsch: Artikel / Determiner ---
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "eines",
  "dieser",
  "diese",
  "dieses",
  "diesem",
  "diesen",
  "jener",
  "jene",
  "jenes",
  // --- Deutsch: Pronomen ---
  "ich",
  "du",
  "er",
  "sie",
  "es",
  "wir",
  "ihr",
  "mich",
  "mir",
  "dich",
  "dir",
  "uns",
  "euch",
  "mein",
  "meine",
  "dein",
  "deine",
  "sein",
  "ihre",
  "unser",
  "man",
  // --- Deutsch: Hilfsverben ---
  "ist",
  "sind",
  "war",
  "waren",
  "bin",
  "bist",
  "habe",
  "hast",
  "hat",
  "haben",
  "hatte",
  "hatten",
  "wird",
  "werden",
  "wurde",
  "wurden",
  "kann",
  "können",
  "muss",
  "soll",
  "will",
  "wollte",
  // --- Deutsch: Präpositionen / Konjunktionen ---
  "an",
  "auf",
  "zu",
  "für",
  "von",
  "mit",
  "bei",
  "aus",
  "über",
  "unter",
  "und",
  "oder",
  "aber",
  "wenn",
  "dann",
  "weil",
  "als",
  "wie",
  "wo",
  "wer",
  "warum",
  "welche",
  "welcher",
  "welches",
  // --- Deutsch: vage Zeit-/Ding-Referenzen ---
  "gestern",
  "heute",
  "morgen",
  "früher",
  "später",
  "kürzlich",
  "jetzt",
  "ding",
  "dinge",
  "sache",
  "sachen",
  "etwas",
  "nichts",
  "alles",
  // --- Deutsch: Höflichkeits-/Anfrage-Wörter ---
  "bitte",
  "hilf",
  "zeig",
  "finde",
  "sag",
  "gib",
  "mal"
]);

/** Prüft, ob ein bereits lowercase-normalisierter Token ein Stopword ist. */
export function isNeonQueryStopWord(token: string): boolean {
  return NEON_QUERY_STOP_WORDS.has(token);
}

/**
 * Schlichter Tokenizer für DE+EN: lowercase, Split auf Whitespace und
 * Punktuation. Bewusst kein CJK-Handling (YAGNI für Neon).
 */
export function tokenizeNeonQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Prüft, ob ein Token ein brauchbares Keyword ist: keine sehr kurzen reinen
 * ASCII-Wörter (< 3), keine reinen Zahlen, keine reine Punktuation/Symbolik.
 */
export function isNeonQueryKeyword(token: string): boolean {
  if (token.length === 0) {
    return false;
  }

  // Sehr kurze reine ASCII-Buchstaben-Token sind meist Fragmente/Stopwords.
  if (/^[a-z]+$/.test(token) && token.length < 3) {
    return false;
  }

  // Reine Zahlen tragen für den semantischen Recall nichts bei.
  if (/^\d+$/.test(token)) {
    return false;
  }

  // Reine Punktuation/Symbole.
  if (/^[\p{P}\p{S}]+$/u.test(token)) {
    return false;
  }

  return true;
}

/**
 * Extrahiert die bedeutungstragenden Keywords aus einer konversationellen Query
 * (Stopwords raus, Duplikate raus, Erst-Auftritt-Reihenfolge erhalten).
 *
 * Beispiele:
 * - "was war die Lösung für den Bug" -> ["lösung", "bug"]
 * - "that thing we discussed about the API" -> ["discussed", "api"]
 */
export function extractNeonQueryKeywords(query: string): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const token of tokenizeNeonQuery(query)) {
    if (isNeonQueryStopWord(token) || !isNeonQueryKeyword(token)) {
      continue;
    }

    if (seen.has(token)) {
      continue;
    }

    seen.add(token);
    keywords.push(token);
  }

  return keywords;
}
