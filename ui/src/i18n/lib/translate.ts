import { de } from "../locales/de.js";
import { en } from "../locales/en.js";
import { sl } from "../locales/sl.js";
import { DEFAULT_LOCALE, isSupportedLocale, resolveNavigatorLocale } from "./registry.js";
import type { Locale, TranslationMap } from "./types.js";

const TRANSLATIONS: Record<Locale, TranslationMap> = { en, de, sl };
const STORAGE_KEY = "neon.control.locale";

type Subscriber = (locale: Locale) => void;

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function lookup(map: TranslationMap | undefined, keys: readonly string[]): string | undefined {
  let value: string | TranslationMap | undefined = map;
  for (const k of keys) {
    if (value && typeof value === "object") {
      value = value[k];
    } else {
      return undefined;
    }
  }
  return typeof value === "string" ? value : undefined;
}

class I18nManager {
  private locale: Locale = DEFAULT_LOCALE;
  private readonly subscribers = new Set<Subscriber>();

  constructor() {
    const stored = readStored();
    if (isSupportedLocale(stored)) {
      this.locale = stored;
    } else {
      const nav = typeof globalThis.navigator?.language === "string" ? globalThis.navigator.language : "";
      this.locale = resolveNavigatorLocale(nav);
    }
  }

  getLocale(): Locale {
    return this.locale;
  }

  setLocale(locale: Locale): void {
    if (this.locale === locale) return;
    this.locale = locale;
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, locale);
    } catch {
      // Ignore storage failures (private mode); locale still applies in-session.
    }
    this.subscribers.forEach((sub) => sub(locale));
  }

  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  t(key: string, params?: Record<string, string>): string {
    const keys = key.split(".");
    const value = lookup(TRANSLATIONS[this.locale], keys) ?? lookup(TRANSLATIONS[DEFAULT_LOCALE], keys);
    if (value === undefined) return key;
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`);
  }
}

export const i18n = new I18nManager();
export const t = (key: string, params?: Record<string, string>): string => i18n.t(key, params);
