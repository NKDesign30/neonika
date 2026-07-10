import type { Locale } from "./types.js";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "de", "sl"] as const;
export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "EN",
  de: "DE",
  sl: "SL",
};

export function isSupportedLocale(value: string | null | undefined): value is Locale {
  return value != null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

// Map a navigator language tag ("de-DE", "sl", "en-US") to a supported locale.
export function resolveNavigatorLocale(language: string): Locale {
  const base = language.toLowerCase().split("-")[0] ?? "";
  return isSupportedLocale(base) ? base : DEFAULT_LOCALE;
}
