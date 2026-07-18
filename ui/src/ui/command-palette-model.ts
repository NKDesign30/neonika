import type { IconName } from "./icons.js";
import { NAV_GROUPS, type NavGroup, type Tab } from "./navigation.js";

// Pure, DOM-free model for the command palette. The Lit component is a thin view
// over these functions so the search/ranking logic stays unit-testable without a
// browser (same split as navigation.ts).

export interface PaletteItem {
  readonly id: Tab;
  readonly name: string;
  readonly group: string;
  readonly icon: IconName;
}

// Flatten the navigation groups into a single ranked-by-source-order list. The
// palette only navigates between existing views, so the items mirror NAV_GROUPS
// exactly — no actions, no slash commands.
export function buildPaletteItems(groups: readonly NavGroup[] = NAV_GROUPS): PaletteItem[] {
  return groups.flatMap((group) =>
    group.items.map((item) => ({
      id: item.id,
      name: item.name,
      group: group.label,
      icon: item.icon,
    })),
  );
}

// Rank a single item against a lowercase query. Lower is better; -1 means no
// match. Name-prefix beats name-substring beats group/id-substring, so typing
// "sess" surfaces Sessions before a view that merely sits in a matching group.
function scorePaletteItem(item: PaletteItem, query: string): number {
  const name = item.name.toLowerCase();
  const group = item.group.toLowerCase();
  const id = item.id.toLowerCase();
  if (name.startsWith(query)) return 0;
  if (name.includes(query)) return 1;
  if (id.includes(query)) return 2;
  if (group.includes(query)) return 3;
  return -1;
}

// Filter + rank items for a raw query. An empty/whitespace query returns every
// item in source order; otherwise matches are sorted by score, ties keeping
// source order (stable sort).
export function filterPaletteItems(items: readonly PaletteItem[], rawQuery: string): PaletteItem[] {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return [...items];
  const scored = items
    .map((item, index) => ({ item, index, score: scorePaletteItem(item, query) }))
    .filter((entry) => entry.score >= 0);
  scored.sort((a, b) => (a.score === b.score ? a.index - b.index : a.score - b.score));
  return scored.map((entry) => entry.item);
}
