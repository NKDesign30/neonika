/**
 * Pure encode/decode for Neon's Discord component & modal custom-ids.
 *
 * Discord gives a button/select/modal a single opaque `custom_id` string (≤100
 * chars) and hands it straight back on click/submit. Neon routes interactions by
 * encoding a stable component id (and an optional modal id) into that string and
 * parsing it back out. The wire scheme mirrors upstream's occomp/ocmodal so the
 * shape is the same across runtimes:
 *
 *   occomp:cid=<componentId>
 *   occomp:cid=<componentId>;mid=<modalId>
 *   ocmodal:mid=<modalId>
 *
 * A value may itself contain the `;` separator or a literal `%`, so an `e=1` flag
 * marks a payload whose values are percent-escaped (`%`→`%25`, `;`→`%3B`). No
 * client, no token: this is a pure string layer the inbound component-click
 * dispatch (a later slice) consumes.
 */

export const NEON_DISCORD_COMPONENT_CUSTOM_ID_KEY = "occomp";
export const NEON_DISCORD_MODAL_CUSTOM_ID_KEY = "ocmodal";
/** Discord's hard cap for a custom_id. Build callers should check before sending. */
export const NEON_DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

const ENCODED_VERSION = "1";

export interface INeonDiscordComponentCustomIdInput {
  readonly componentId: string;
  readonly modalId?: string;
}

export interface INeonDiscordComponentCustomId {
  readonly componentId: string;
  readonly modalId?: string;
}

function needsEncoding(value: string): boolean {
  return /[%;]/.test(value);
}

function encodeValue(value: string): string {
  return value.replace(/%/g, "%25").replace(/;/g, "%3B");
}

function decodeValue(value: string): string {
  return value.replace(/%(25|3B)/gi, (match) => (match.toLowerCase() === "%25" ? "%" : ";"));
}

/**
 * Encode a component custom-id. When either id contains a `%` or `;`, the whole
 * payload is marked `e=1` and its values are percent-escaped so the separator
 * never collides with payload content.
 */
export function buildNeonDiscordComponentCustomId(input: INeonDiscordComponentCustomIdInput): string {
  const encoded = needsEncoding(input.componentId) || needsEncoding(input.modalId ?? "");
  const componentId = encoded ? encodeValue(input.componentId) : input.componentId;
  const head = encoded
    ? `${NEON_DISCORD_COMPONENT_CUSTOM_ID_KEY}:e=${ENCODED_VERSION};cid=${componentId}`
    : `${NEON_DISCORD_COMPONENT_CUSTOM_ID_KEY}:cid=${componentId}`;
  if (input.modalId === undefined || input.modalId.length === 0) {
    return head;
  }
  const modalId = encoded ? encodeValue(input.modalId) : input.modalId;
  return `${head};mid=${modalId}`;
}

/** Encode a modal custom-id (used on the modal itself, not its trigger component). */
export function buildNeonDiscordModalCustomId(modalId: string): string {
  return needsEncoding(modalId)
    ? `${NEON_DISCORD_MODAL_CUSTOM_ID_KEY}:e=${ENCODED_VERSION};mid=${encodeValue(modalId)}`
    : `${NEON_DISCORD_MODAL_CUSTOM_ID_KEY}:mid=${modalId}`;
}

interface IRawCustomId {
  readonly key: string;
  readonly data: Readonly<Record<string, string>>;
}

function parseRawCustomId(id: string): IRawCustomId | null {
  const colon = id.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const key = id.slice(0, colon);
  const data: Record<string, string> = {};
  for (const pair of id.slice(colon + 1).split(";")) {
    if (pair.length === 0) {
      continue;
    }
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    // First key wins; a duplicate is ignored rather than silently overriding.
    const field = pair.slice(0, eq);
    if (!(field in data)) {
      data[field] = pair.slice(eq + 1);
    }
  }
  return { key, data };
}

function decodeData(data: Readonly<Record<string, string>>): Record<string, string> {
  if (data["e"] !== ENCODED_VERSION) {
    return { ...data };
  }
  const decoded: Record<string, string> = {};
  for (const [field, value] of Object.entries(data)) {
    decoded[field] = decodeValue(value);
  }
  return decoded;
}

/**
 * Parse a component custom-id back into its ids. Returns `null` when the key is not
 * `occomp` or the component id is missing/blank.
 */
export function parseNeonDiscordComponentCustomId(id: string): INeonDiscordComponentCustomId | null {
  const parsed = parseRawCustomId(id);
  if (parsed === null || parsed.key !== NEON_DISCORD_COMPONENT_CUSTOM_ID_KEY) {
    return null;
  }
  const data = decodeData(parsed.data);
  const componentId = data["cid"];
  if (componentId === undefined || componentId.trim().length === 0) {
    return null;
  }
  const modalId = data["mid"];
  return {
    componentId,
    ...(modalId !== undefined && modalId.trim().length > 0 ? { modalId } : {})
  };
}

/**
 * Parse a modal custom-id. Returns `null` when the key is not `ocmodal` or the
 * modal id is missing/blank.
 */
export function parseNeonDiscordModalCustomId(id: string): string | null {
  const parsed = parseRawCustomId(id);
  if (parsed === null || parsed.key !== NEON_DISCORD_MODAL_CUSTOM_ID_KEY) {
    return null;
  }
  const data = decodeData(parsed.data);
  const modalId = data["mid"];
  if (modalId === undefined || modalId.trim().length === 0) {
    return null;
  }
  return modalId;
}

/** True when an encoded custom-id fits inside Discord's 100-char limit. */
export function isNeonDiscordCustomIdWithinLimit(id: string): boolean {
  return id.length <= NEON_DISCORD_CUSTOM_ID_MAX_LENGTH;
}
