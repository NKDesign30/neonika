// Neonika Mission Control speaks three languages only: English, German, Slovenian.
export type Locale = "en" | "de" | "sl";

export type TranslationMap = { readonly [key: string]: string | TranslationMap };
