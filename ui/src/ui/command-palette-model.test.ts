import { describe, expect, it } from "vitest";
import { buildPaletteItems, filterPaletteItems } from "./command-palette-model.js";
import { ALL_TABS, NAV_GROUPS } from "./navigation.js";

describe("buildPaletteItems", () => {
  it("maps every nav item to a palette item with its group label", () => {
    const items = buildPaletteItems();
    expect(items).toHaveLength(ALL_TABS.length);
    expect(items.map((i) => i.id)).toEqual([...ALL_TABS]);
    const groups = new Set(items.map((i) => i.group));
    expect(groups).toEqual(new Set(NAV_GROUPS.map((g) => g.label)));
    for (const item of items) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("filterPaletteItems", () => {
  const items = buildPaletteItems();

  it("returns every item in source order for an empty or whitespace query", () => {
    expect(filterPaletteItems(items, "").map((i) => i.id)).toEqual([...ALL_TABS]);
    expect(filterPaletteItems(items, "   ").map((i) => i.id)).toEqual([...ALL_TABS]);
  });

  it("matches a view by name, case-insensitively", () => {
    expect(filterPaletteItems(items, "sess").map((i) => i.id)).toEqual(["sessions"]);
    expect(filterPaletteItems(items, "SESS").map((i) => i.id)).toEqual(["sessions"]);
  });

  it("matches a view by its id even when the display name differs", () => {
    // "Dreaming" is the name, "dreams" is the tab id.
    expect(filterPaletteItems(items, "dreams").map((i) => i.id)).toContain("dreams");
  });

  it("matches all views sharing a group label", () => {
    // "work" matches the Workboard name first, then every view in the Work group.
    const workGroup = filterPaletteItems(items, "work").map((i) => i.id);
    expect(workGroup).toEqual(["workboard", "sessions", "transcript", "dreams"]);
  });

  it("ranks a name-prefix match ahead of a group-only match", () => {
    // "c" prefixes Chat/Cron/Config/Channels names; group-only matches rank lower.
    const ids = filterPaletteItems(items, "c").map((i) => i.id);
    const firstGroupOnly = items.find((i) => !i.name.toLowerCase().includes("c") && i.group.toLowerCase().includes("c"));
    if (firstGroupOnly) {
      expect(ids.indexOf("chat")).toBeLessThan(ids.indexOf(firstGroupOnly.id));
    }
    expect(ids[0]).toBe("chat");
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterPaletteItems(items, "zzzznope")).toEqual([]);
  });
});
