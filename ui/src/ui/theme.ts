export type ThemeName = "dark" | "light";

const THEME_KEY = "neon.control.theme";
const ACCENT_KEY = "neon.control.accent";
const DEFAULT_THEME: ThemeName = "dark";
const DEFAULT_ACCENT = "#F28A4B"; // Solar — Neonika brand.

// Accent options offered by the Tweaks panel (brand + sub-brand accents).
export const ACCENT_OPTIONS = ["#F28A4B", "#2EAB73", "#409CFF", "#FFB340", "#7C8AFF"] as const;
export type Density = "regular" | "compact";

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Ignore storage failures; the value still applies for the session.
  }
}

export function loadTheme(): ThemeName {
  const stored = read(THEME_KEY);
  return stored === "light" || stored === "dark" ? stored : DEFAULT_THEME;
}

export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  write(THEME_KEY, theme);
}

export function loadAccent(): string {
  return read(ACCENT_KEY) ?? DEFAULT_ACCENT;
}

// Maps a single accent hex onto the brand token family, matching the design's
// App effect (--brand-primary/bright/faint/muted/stroke-brand).
export function applyAccent(hex: string): void {
  const root = document.documentElement.style;
  root.setProperty("--brand-primary", hex);
  root.setProperty("--brand-bright", hex);
  root.setProperty("--brand-faint", `${hex}1a`);
  root.setProperty("--brand-muted", `${hex}38`);
  root.setProperty("--stroke-brand", `${hex}99`);
  write(ACCENT_KEY, hex);
}
