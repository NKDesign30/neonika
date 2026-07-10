import { classifyNeonWebFetchHost, classifyNeonWebFetchTarget } from "../tools/webFetch.js";
import { NeonResponseBodyLimitError, readNeonResponseBodyLimited } from "./boundedResponseBody.js";

/**
 * Pure, side-effect-free builder + validator for Discord outbound media
 * attachments, plus a gated, SSRF-guarded binary fetch for url-sourced media.
 * Mirrors discordRichPayload.ts / discordComponentPayload.ts: it validates a
 * leak-safe Neon attachment model up front so the gated canary transport never
 * hands discord.js a payload the API would reject — and never lets a url
 * attachment turn into an SSRF egress.
 *
 * Two attachment sources:
 *  - inline: raw bytes already held in process (a generated image/file). Fully
 *    validated offline (size, filename safety, mime shape).
 *  - url: a remote reference. The pure builder runs the existing Neon SSRF guard
 *    (classifyNeonWebFetchTarget) so a private/loopback/link-local target is
 *    rejected before anything is sent. The transport, NOT discord.js, fetches
 *    the bytes (discord.js would fetch a url itself inside the bot process, which
 *    is the SSRF vector) via fetchNeonMediaBuffer, which re-checks every resolved
 *    IP (DNS-rebind) and caps the download size.
 *
 * No client, no token in this module. The transport (the only live-side-effect
 * site) consumes the validated output. Validation uses a Result shape so the
 * transport can stay suppressed and surface the reason.
 */

// Discord platform constants. 25 MiB is the default per-file upload cap for a
// non-boosted server; callers may lower it, never silently raise it past what a
// server accepts. Attachment count cap is a stable API limit.
export const NEON_DISCORD_MEDIA_LIMITS = {
  maxAttachments: 10,
  maxFileBytes: 25 * 1024 * 1024,
  filenameMax: 256
} as const;

export interface INeonDiscordInlineAttachment {
  readonly name: string;
  readonly data: Uint8Array;
  readonly contentType?: string;
}

export interface INeonDiscordUrlAttachment {
  readonly name: string;
  readonly url: string;
  readonly contentType?: string;
}

export type TNeonDiscordMediaAttachment = INeonDiscordInlineAttachment | INeonDiscordUrlAttachment;

export type TNeonValidatedMediaAttachment =
  | { readonly kind: "inline"; readonly name: string; readonly data: Uint8Array; readonly contentType?: string }
  | {
      readonly kind: "url";
      readonly name: string;
      readonly url: string;
      readonly host: string;
      readonly contentType?: string;
    };

export type TNeonDiscordMediaBuildResult =
  | { readonly ok: true; readonly attachments: readonly TNeonValidatedMediaAttachment[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface IBuildNeonDiscordMediaOptions {
  /** Per-file byte cap; defaults to the Discord non-boost limit. Never raised silently. */
  readonly maxFileBytes?: number;
}

// RFC 6838-ish media type shape: type "/" subtype, restricted token chars.
const MIME_SHAPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function isInlineAttachment(attachment: TNeonDiscordMediaAttachment): attachment is INeonDiscordInlineAttachment {
  return "data" in attachment;
}

function validateFilename(name: string, where: string, errors: string[]): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    errors.push(`${where} requires a non-empty filename`);
    return false;
  }
  if (trimmed.length > NEON_DISCORD_MEDIA_LIMITS.filenameMax) {
    errors.push(`${where} filename exceeds ${NEON_DISCORD_MEDIA_LIMITS.filenameMax} chars`);
    return false;
  }
  // Reject path separators and traversal so a filename can never escape a
  // directory if a downstream consumer ever writes it to disk.
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    errors.push(`${where} filename must not contain path separators or '..'`);
    return false;
  }
  return true;
}

function validateContentType(contentType: string | undefined, where: string, errors: string[]): boolean {
  if (contentType === undefined) {
    return true;
  }
  if (!MIME_SHAPE.test(contentType)) {
    errors.push(`${where} contentType "${contentType}" is not a valid MIME type`);
    return false;
  }
  return true;
}

/**
 * Validate + classify a bounded set of media attachments. Returns every
 * validation error at once. On any error the result is `ok: false` and the
 * transport stays suppressed.
 */
export function buildNeonDiscordMediaPayload(
  attachments: readonly TNeonDiscordMediaAttachment[],
  options: IBuildNeonDiscordMediaOptions = {}
): TNeonDiscordMediaBuildResult {
  const errors: string[] = [];
  const maxFileBytes = options.maxFileBytes ?? NEON_DISCORD_MEDIA_LIMITS.maxFileBytes;

  if (attachments.length === 0) {
    return { ok: false, errors: ["at least one attachment is required"] };
  }
  if (attachments.length > NEON_DISCORD_MEDIA_LIMITS.maxAttachments) {
    errors.push(`a message carries at most ${NEON_DISCORD_MEDIA_LIMITS.maxAttachments} attachments`);
  }

  const built: TNeonValidatedMediaAttachment[] = [];
  attachments.forEach((attachment, index) => {
    const where = `attachment ${index}`;
    const before = errors.length;
    const nameOk = validateFilename(attachment.name, where, errors);
    const mimeOk = validateContentType(attachment.contentType, where, errors);

    if (isInlineAttachment(attachment)) {
      if (attachment.data.byteLength === 0) {
        errors.push(`${where} inline data is empty`);
      } else if (attachment.data.byteLength > maxFileBytes) {
        errors.push(`${where} inline data ${attachment.data.byteLength} bytes exceeds the ${maxFileBytes}-byte cap`);
      }
      if (errors.length === before && nameOk && mimeOk) {
        built.push({
          kind: "inline",
          name: attachment.name.trim(),
          data: attachment.data,
          ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {})
        });
      }
      return;
    }

    // url-sourced: run the existing SSRF guard before anything leaves.
    const decision = classifyNeonWebFetchTarget(attachment.url);
    if (!decision.allowed) {
      errors.push(`${where} url blocked by SSRF guard (${decision.reason}): ${decision.detail}`);
    }
    if (errors.length === before && nameOk && mimeOk && decision.allowed) {
      built.push({
        kind: "url",
        name: attachment.name.trim(),
        url: decision.url,
        host: decision.host,
        ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {})
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, attachments: built };
}

export interface INeonMediaFetchResponse {
  readonly status: number;
  /** Declared body size (content-length). When over the cap, the download is refused before reading. */
  readonly contentLength?: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface IFetchNeonMediaBufferOptions {
  readonly maxFileBytes?: number;
  /** Injected for tests/smoke so no real network call is made. Returns resolved IP literals. */
  readonly lookupImpl?: (host: string) => Promise<readonly string[]>;
  readonly fetchImpl?: (url: string, init: { readonly signal: AbortSignal }) => Promise<INeonMediaFetchResponse>;
  readonly timeoutMs?: number;
}

const DEFAULT_MEDIA_TIMEOUT_MS = 20_000;

/**
 * Fetch url-sourced media bytes with the SSRF guard re-applied to every resolved
 * IP (DNS-rebind defence) and a hard size cap. This is the ONLY path that turns a
 * url attachment into bytes; discord.js never sees the url. Network impls are
 * injectable so tests never touch the network.
 */
export async function fetchNeonMediaBuffer(
  url: string,
  host: string,
  options: IFetchNeonMediaBufferOptions = {}
): Promise<Uint8Array> {
  const maxFileBytes = options.maxFileBytes ?? NEON_DISCORD_MEDIA_LIMITS.maxFileBytes;
  const lookup = options.lookupImpl ?? defaultMediaLookup;
  const resolvedIps = await lookup(host);
  if (resolvedIps.length === 0) {
    throw new Error(`media host ${host} did not resolve to any address`);
  }
  for (const ip of resolvedIps) {
    const blocked = classifyNeonWebFetchHost(ip);
    if (blocked) {
      throw new Error(`media host ${host} resolved to blocked ${ip} (${blocked})`);
    }
  }

  const fetchImpl = options.fetchImpl ?? defaultMediaFetch;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS)
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`media fetch for ${host} returned HTTP ${response.status}`);
  }
  // Refuse before reading the body when the server declares an over-cap size, so
  // a huge response cannot be pulled into memory. The post-read check below still
  // guards a server that lies about (or omits) content-length.
  if (response.contentLength !== undefined && response.contentLength > maxFileBytes) {
    throw new Error(
      `media fetch for ${host} declared ${response.contentLength} bytes, over the ${maxFileBytes}-byte cap`
    );
  }
  const buffer = response.body
    ? await readMediaResponseBody(response.body, maxFileBytes, host)
    : new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error(`media fetch for ${host} returned an empty body`);
  }
  if (buffer.byteLength > maxFileBytes) {
    throw new Error(`media fetch for ${host} returned ${buffer.byteLength} bytes, over the ${maxFileBytes}-byte cap`);
  }
  return buffer;
}

async function readMediaResponseBody(
  body: ReadableStream<Uint8Array>,
  maxFileBytes: number,
  host: string
): Promise<Uint8Array> {
  try {
    return await readNeonResponseBodyLimited(body, maxFileBytes);
  } catch (error) {
    if (error instanceof NeonResponseBodyLimitError && error.code === "response-too-large") {
      throw new Error(`media fetch for ${host} exceeded the ${maxFileBytes}-byte cap`);
    }
    throw error;
  }
}

async function defaultMediaLookup(host: string): Promise<readonly string[]> {
  const { lookup } = await import("node:dns/promises");
  const records = await lookup(host, { all: true });
  return records.map((record) => record.address);
}

async function defaultMediaFetch(
  url: string,
  init: { readonly signal: AbortSignal }
): Promise<INeonMediaFetchResponse> {
  const response = await fetch(url, { signal: init.signal, redirect: "error" });
  const declared = Number(response.headers.get("content-length"));
  const contentLength = Number.isInteger(declared) && declared >= 0 ? declared : undefined;
  return {
    status: response.status,
    ...(contentLength !== undefined ? { contentLength } : {}),
    ...(response.body ? { body: response.body } : {}),
    arrayBuffer: () => response.arrayBuffer()
  };
}

/** High-level media class derived from a filename/MIME without inspecting bytes. */
export type TNeonDiscordMediaKind = "video" | "image" | "audio" | "file";

const NEON_DISCORD_MEDIA_KINDS = ["video", "image", "audio"] as const;

// Extension → kind. Lower-case, dot-stripped. Covers the formats Discord renders
// inline (video/image embeds, audio players); anything else falls through to "file".
const NEON_DISCORD_MEDIA_EXTENSIONS: {
  readonly [kind in (typeof NEON_DISCORD_MEDIA_KINDS)[number]]: readonly string[];
} = {
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpeg", "mpg"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "tif", "svg", "heic", "heif"],
  audio: ["mp3", "wav", "ogg", "oga", "flac", "m4a", "aac", "opus"]
};

/**
 * Pure classification of a media attachment by MIME type and/or filename
 * extension — no bytes, no I/O, no token. A declared `contentType` wins over the
 * extension (it is harder to spoof than a renamed file); when no MIME is given,
 * the lower-cased extension decides. Unrecognised input is `"file"`. Used so an
 * inbound or outbound attachment can be labelled (e.g. video vs image) for
 * routing/preview decisions without downloading it.
 */
export function classifyNeonDiscordMediaKind(name: string, contentType?: string): TNeonDiscordMediaKind {
  const mime = contentType?.trim().toLowerCase();
  if (mime !== undefined && mime.length > 0) {
    if (mime.startsWith("video/")) {
      return "video";
    }
    if (mime.startsWith("image/")) {
      return "image";
    }
    if (mime.startsWith("audio/")) {
      return "audio";
    }
  }

  const ext = extractMediaExtension(name);
  if (ext !== undefined) {
    for (const kind of NEON_DISCORD_MEDIA_KINDS) {
      if (NEON_DISCORD_MEDIA_EXTENSIONS[kind].includes(ext)) {
        return kind;
      }
    }
  }

  return "file";
}

/** True when the attachment is a video by MIME or extension. Convenience over classifyNeonDiscordMediaKind. */
export function isNeonDiscordVideoMedia(name: string, contentType?: string): boolean {
  return classifyNeonDiscordMediaKind(name, contentType) === "video";
}

function extractMediaExtension(name: string): string | undefined {
  const trimmed = name.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  // Need a non-empty stem and a non-empty extension: ".env" and "trailingdot." don't count.
  if (dot <= 0 || dot === trimmed.length - 1) {
    return undefined;
  }
  return trimmed.slice(dot + 1);
}
