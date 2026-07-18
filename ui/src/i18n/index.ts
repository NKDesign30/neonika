export type { Locale, TranslationMap } from "./lib/types.js";
export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  isSupportedLocale,
  resolveNavigatorLocale,
} from "./lib/registry.js";
export { i18n, t } from "./lib/translate.js";
export { I18nController } from "./lib/lit-controller.js";
