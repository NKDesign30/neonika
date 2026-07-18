export function normalizeNeonDiscordVoiceReplyTextForTts(text: string): string {
  let normalized = cleanupVoiceReplyText(text);

  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*°\s*C\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Grad Celsius`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*°(?!\w)/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Grad`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*%/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Prozent`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*(?:s|sek\.?|sec\.?)\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Sekunden`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*ms\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Millisekunden`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*km\/h\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Kilometer pro Stunde`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*km\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Kilometer`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*cm\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Zentimeter`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*mm\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Millimeter`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*m\b/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Meter`;
  });
  normalized = normalized.replace(/€\s*(-?\d+(?:[,.]\d+)?)/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Euro`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*€/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Euro`;
  });
  normalized = normalized.replace(/\$\s*(-?\d+(?:[,.]\d+)?)/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Dollar`;
  });
  normalized = normalized.replace(/(?<![\p{L}\d])(-?\d+(?:[,.]\d+)?)\s*\$/giu, (_match, value: string) => {
    return `${spellGermanNumber(value)} Dollar`;
  });
  normalized = normalized.replace(/\b(\d{1,2}):00\s*Uhr\b/gu, (_match, hours: string) => {
    return `${spellGermanInteger(Number(hours))} Uhr`;
  });
  normalized = normalized.replace(/\b(\d{1,2}):(\d{2})\s*Uhr\b/gu, (_match, hours: string, minutes: string) => {
    return spellGermanTime(Number(hours), Number(minutes));
  });
  normalized = normalized.replace(/\bum\s+(\d{1,2}):00\b/gu, (_match, hours: string) => {
    return `um ${spellGermanInteger(Number(hours))} Uhr`;
  });
  normalized = normalized.replace(/\bum\s+(\d{1,2}):(\d{2})\b/gu, (_match, hours: string, minutes: string) => {
    return `um ${spellGermanTime(Number(hours), Number(minutes))}`;
  });
  normalized = normalized.replace(/°\s*C\b/giu, " Grad Celsius");
  normalized = normalized.replace(/%/gu, " Prozent");
  normalized = normalized.replace(/€/gu, " Euro");
  normalized = normalized.replace(/\$/gu, " Dollar");

  return cleanupVoiceReplyText(normalized);
}

function cleanupVoiceReplyText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/\s+([.,!?;:])/gu, "$1")
    .trim();
}

function spellGermanNumber(value: string): string {
  const normalized = value.replace(",", ".");
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) {
    return value;
  }

  const sign = numeric < 0 ? "minus " : "";
  const absolute = Math.abs(numeric);
  const [integerPart = "0", decimalPart] = String(absolute).split(".");
  const integerText = spellGermanInteger(Number(integerPart));
  if (!decimalPart || decimalPart.length === 0) {
    return `${sign}${integerText}`;
  }

  const decimalText = decimalPart
    .split("")
    .map((digit) => spellGermanInteger(Number(digit)))
    .join(" ");
  return `${sign}${integerText} Komma ${decimalText}`;
}

function spellGermanTime(hours: number, minutes: number): string {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return `${hours}:${String(minutes).padStart(2, "0")}`;
  }
  if (minutes === 0) {
    return `${spellGermanInteger(hours)} Uhr`;
  }
  return `${spellGermanInteger(hours)} Uhr ${spellGermanInteger(minutes)}`;
}

function spellGermanInteger(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999999) {
    return String(value);
  }

  if (value < 100) {
    return spellGermanBelowHundred(value);
  }
  if (value < 1000) {
    return spellGermanBelowThousand(value);
  }

  const thousands = Math.floor(value / 1000);
  const rest = value % 1000;
  const prefix = `${spellGermanBelowThousand(thousands)}tausend`;
  return rest === 0 ? prefix : `${prefix}${spellGermanBelowThousand(rest)}`;
}

function spellGermanBelowThousand(value: number): string {
  if (value < 100) {
    return spellGermanBelowHundred(value);
  }

  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const prefix = `${spellGermanHundredPrefix(hundreds)}hundert`;
  return rest === 0 ? prefix : `${prefix}${spellGermanBelowHundred(rest)}`;
}

function spellGermanBelowHundred(value: number): string {
  const units = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"] as const;
  const unitPrefixes = ["", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"] as const;
  const tens = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"] as const;
  const teens: Readonly<Record<number, string>> = {
    10: "zehn",
    11: "elf",
    12: "zwölf",
    13: "dreizehn",
    14: "vierzehn",
    15: "fünfzehn",
    16: "sechzehn",
    17: "siebzehn",
    18: "achtzehn",
    19: "neunzehn"
  };

  if (value < 10) {
    return units[value] ?? String(value);
  }
  if (value < 20) {
    return teens[value] ?? String(value);
  }

  const ten = Math.floor(value / 10);
  const unit = value % 10;
  if (unit === 0) {
    return tens[ten] ?? String(value);
  }

  return `${unitPrefixes[unit] ?? String(unit)}und${tens[ten] ?? String(ten)}`;
}

function spellGermanHundredPrefix(value: number): string {
  return value === 1 ? "ein" : spellGermanBelowHundred(value);
}
