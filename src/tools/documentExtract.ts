import { redactText } from "../harness/redaction.js";

// Read-only document content extraction (parity rows 247 / 223).
//
// Pure + dependency-free for text-based formats (text/markdown/html/json/csv);
// binary formats (PDF/Docx) go through a pluggable provider seam so Neonika's
// minimal dependency floor stays intact until an operator registers a parser. No
// network, no exec, no send — extraction runs on bytes already in hand. Output text
// is redacted (it crosses the HTTP boundary) and byte/character-capped. When a
// binary format arrives with no registered provider, the result is the honest
// `provider-not-configured` state — never a thrown stub.

export type TNeonDocFormat = "text" | "markdown" | "html" | "json" | "csv" | "pdf" | "docx" | "unknown";

export type TNeonDocExtractState =
  | "extracted"
  | "empty"
  | "too-large"
  | "unsupported-format"
  | "provider-not-configured"
  | "extract-failed";

export interface INeonDocExtractRequest {
  /** Raw document bytes, base64-encoded. Takes precedence over `text`. */
  readonly contentBase64?: string;
  /** Inline UTF-8 text (skips the base64 decode path). */
  readonly text?: string;
  readonly mimeType?: string;
  readonly fileName?: string;
  readonly maxBytes?: number;
}

export interface INeonDocExtractResult {
  readonly state: TNeonDocExtractState;
  readonly format: TNeonDocFormat;
  readonly text: string;
  readonly byteLength: number;
  readonly characters: number;
  readonly truncated: boolean;
}

/** A pluggable extractor for a binary format Neonika does not parse natively. */
export interface INeonDocExtractProvider {
  readonly format: TNeonDocFormat;
  readonly mimeTypes: readonly string[];
  /**
   * Returns extracted text, or null when this provider declines the bytes. May be
   * async (binary parsers like PDF are). A thrown error surfaces as `extract-failed`.
   */
  readonly extract: (bytes: Buffer) => Promise<string | null> | string | null;
}

const DEFAULT_MAX_BYTES = 1_048_576; // 1 MiB
const MAX_OUTPUT_CHARS = 200_000;
const TEXT_FORMATS: ReadonlySet<TNeonDocFormat> = new Set(["text", "markdown", "html", "json", "csv"]);
const BINARY_FORMATS: ReadonlySet<TNeonDocFormat> = new Set(["pdf", "docx"]);

const EXTENSION_FORMATS: Readonly<Record<string, TNeonDocFormat>> = {
  txt: "text",
  text: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  json: "json",
  csv: "csv",
  tsv: "csv",
  pdf: "pdf",
  docx: "docx"
};

const MIME_FORMATS: Readonly<Record<string, TNeonDocFormat>> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/html": "html",
  "application/json": "json",
  "text/csv": "csv",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx"
};

export function detectNeonDocFormat(mimeType?: string, fileName?: string): TNeonDocFormat {
  const mime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (mime && MIME_FORMATS[mime]) {
    return MIME_FORMATS[mime];
  }
  const ext = fileName?.includes(".") ? fileName.split(".").pop()?.trim().toLowerCase() : undefined;
  if (ext && EXTENSION_FORMATS[ext]) {
    return EXTENSION_FORMATS[ext];
  }
  return "unknown";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, " ");
}

function stripHtml(value: string): string {
  const withoutScripts = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/gu, " ");
  return decodeHtmlEntities(withoutTags).replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/gu, " ") // fenced code blocks
    .replace(/`([^`]+)`/gu, "$1") // inline code
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1") // links/images -> label
    .replace(/^#{1,6}\s+/gmu, "") // ATX headers
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/gu, "$1") // emphasis
    .replace(/^>\s?/gmu, "") // blockquotes
    .replace(/^[-*+]\s+/gmu, "") // bullet markers
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function flattenJson(value: unknown, path: string, lines: string[], depth: number): void {
  if (lines.length >= 5000 || depth > 12) {
    return;
  }
  if (value === null || typeof value !== "object") {
    lines.push(`${path}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flattenJson(entry, `${path}[${index}]`, lines, depth + 1));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    flattenJson(entry, path ? `${path}.${key}` : key, lines, depth + 1);
  }
}

function extractJson(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    const lines: string[] = [];
    flattenJson(parsed, "", lines, 0);
    return lines.join("\n");
  } catch {
    return value.trim();
  }
}

function extractCsv(value: string): string {
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(/[,\t]/u).map((cell) => cell.trim()).join(" | "))
    .join("\n");
}

function extractTextFormat(format: TNeonDocFormat, raw: string): string {
  switch (format) {
    case "markdown":
      return stripMarkdown(raw);
    case "html":
      return stripHtml(raw);
    case "json":
      return extractJson(raw);
    case "csv":
      return extractCsv(raw);
    default:
      return raw.trim();
  }
}

function resolveBytes(request: INeonDocExtractRequest): Buffer {
  if (typeof request.contentBase64 === "string" && request.contentBase64.length > 0) {
    return Buffer.from(request.contentBase64, "base64");
  }
  return Buffer.from(request.text ?? "", "utf8");
}

function finalize(
  state: TNeonDocExtractState,
  format: TNeonDocFormat,
  byteLength: number,
  rawText: string
): INeonDocExtractResult {
  const redacted = redactText(rawText);
  const capped = redacted.length > MAX_OUTPUT_CHARS ? redacted.slice(0, MAX_OUTPUT_CHARS) : redacted;
  return {
    state,
    format,
    text: capped,
    byteLength,
    characters: capped.length,
    truncated: redacted.length > MAX_OUTPUT_CHARS
  };
}

export async function extractNeonDocument(
  request: INeonDocExtractRequest,
  providers: readonly INeonDocExtractProvider[] = []
): Promise<INeonDocExtractResult> {
  const bytes = resolveBytes(request);
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
  const format = detectNeonDocFormat(request.mimeType, request.fileName);

  if (bytes.byteLength > maxBytes) {
    return finalize("too-large", format, bytes.byteLength, "");
  }
  if (bytes.byteLength === 0) {
    return finalize("empty", format, 0, "");
  }

  if (TEXT_FORMATS.has(format)) {
    const text = extractTextFormat(format, bytes.toString("utf8"));
    return finalize(text.length > 0 ? "extracted" : "empty", format, bytes.byteLength, text);
  }

  if (BINARY_FORMATS.has(format)) {
    const mime = request.mimeType?.split(";")[0]?.trim();
    const provider = providers.find(
      (entry) => entry.format === format || (mime ? entry.mimeTypes.includes(mime) : false)
    );
    if (!provider) {
      return finalize("provider-not-configured", format, bytes.byteLength, "");
    }
    try {
      const extracted = await provider.extract(bytes);
      if (extracted === null) {
        return finalize("provider-not-configured", format, bytes.byteLength, "");
      }
      return finalize(extracted.length > 0 ? "extracted" : "empty", format, bytes.byteLength, extracted);
    } catch {
      // A registered provider that throws (e.g. a corrupt PDF) is a real failure,
      // distinct from "no provider configured". Never surface the raw parser error.
      return finalize("extract-failed", format, bytes.byteLength, "");
    }
  }

  return finalize("unsupported-format", format, bytes.byteLength, "");
}

// Leak-safe report: format/state/sizes + a short redacted text head, never the full body.
export function renderNeonDocExtractReport(result: INeonDocExtractResult): string {
  const head = result.text.slice(0, 160).replace(/\n/gu, " ");
  return (
    `Neon doc-extract: ${result.state} (${result.format}) · ` +
    `${result.byteLength} byte(s) -> ${result.characters} char(s)${result.truncated ? " [truncated]" : ""}` +
    (head.length > 0 ? `\n  ${head}` : "")
  );
}
