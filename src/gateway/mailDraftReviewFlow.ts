import {
  buildNeonDiscordComponentCustomId,
  isNeonDiscordCustomIdWithinLimit,
  parseNeonDiscordComponentCustomId
} from "./discordComponentCustomId.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";

export type TNeonMailDraftReviewAction = "send" | "edit" | "discard";

export interface INeonMailDraftReviewPromptInput {
  readonly reviewId: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly inboundPreview: string;
  readonly draftPreview: string;
  readonly receivedAt?: string;
}

export interface INeonMailDraftReviewPrompt {
  readonly content: string;
  readonly components: readonly TNeonDiscordActionRow[];
}

export interface INeonMailDraftReviewSelection {
  readonly reviewId: string;
  readonly action: TNeonMailDraftReviewAction;
}

export interface INeonMailDraftReviewActionHandlers {
  sendDraft(selection: INeonMailDraftReviewSelection): Promise<void> | void;
  requestEdit(selection: INeonMailDraftReviewSelection): Promise<void> | void;
  discardDraft(selection: INeonMailDraftReviewSelection): Promise<void> | void;
}

export type TNeonMailDraftReviewActionResult =
  | {
      readonly state: "ignored";
      readonly reason: "not-mail-draft-review";
      readonly customId: string;
    }
  | {
      readonly state: "sent" | "edit-requested" | "discarded";
      readonly selection: INeonMailDraftReviewSelection;
      readonly message: string;
    }
  | {
      readonly state: "failed";
      readonly selection: INeonMailDraftReviewSelection;
      readonly message: string;
    };

const MAIL_DRAFT_REVIEW_COMPONENT_PREFIX = "mail-draft-review";
const MAIL_DRAFT_REVIEW_ID_MAX_LENGTH = 48;
const MAIL_DRAFT_REVIEW_FIELD_MAX_LENGTH = 140;
const MAIL_DRAFT_REVIEW_INBOUND_PREVIEW_MAX_LENGTH = 420;
const MAIL_DRAFT_REVIEW_DRAFT_PREVIEW_MAX_LENGTH = 760;

const MAIL_DRAFT_REVIEW_BUTTONS: readonly {
  readonly action: TNeonMailDraftReviewAction;
  readonly label: string;
  readonly style: "success" | "primary" | "danger";
}[] = [
  { action: "send", label: "Senden", style: "success" },
  { action: "edit", label: "Bearbeiten", style: "primary" },
  { action: "discard", label: "Verwerfen", style: "danger" }
];

export function buildNeonMailDraftReviewCustomId(selection: INeonMailDraftReviewSelection): string {
  const reviewId = selection.reviewId.trim();
  if (reviewId.length === 0) {
    throw new Error("Mail draft review id must not be empty");
  }
  if (reviewId.length > MAIL_DRAFT_REVIEW_ID_MAX_LENGTH) {
    throw new Error(`Mail draft review id exceeds ${MAIL_DRAFT_REVIEW_ID_MAX_LENGTH} chars`);
  }

  const customId = buildNeonDiscordComponentCustomId({
    componentId: `${MAIL_DRAFT_REVIEW_COMPONENT_PREFIX}:${selection.action}:${encodeURIComponent(reviewId)}`
  });
  if (!isNeonDiscordCustomIdWithinLimit(customId)) {
    throw new Error("Mail draft review custom id exceeds Discord's 100 char limit");
  }
  return customId;
}

export function parseNeonMailDraftReviewCustomId(
  customId: string
): INeonMailDraftReviewSelection | null {
  const parsed = parseNeonDiscordComponentCustomId(customId);
  if (parsed === null) {
    return null;
  }

  const parts = parsed.componentId.split(":");
  if (parts.length !== 3 || parts[0] !== MAIL_DRAFT_REVIEW_COMPONENT_PREFIX) {
    return null;
  }

  const action = parseNeonMailDraftReviewAction(parts[1]);
  if (action === null) {
    return null;
  }

  const reviewId = decodeReviewId(parts[2]);
  if (reviewId === null || reviewId.trim().length === 0) {
    return null;
  }

  return { action, reviewId };
}

export function buildNeonMailDraftReviewPrompt(
  input: INeonMailDraftReviewPromptInput
): INeonMailDraftReviewPrompt {
  const reviewId = input.reviewId.trim();
  if (reviewId.length === 0) {
    throw new Error("Mail draft review id must not be empty");
  }

  const receivedAtLine = input.receivedAt
    ? [`Eingang: ${formatMailDraftReviewField(input.receivedAt)}`]
    : [];
  const content = [
    "Neue Mail mit vorbereitetem Antwort-Entwurf:",
    `Von: ${formatMailDraftReviewField(input.from)}`,
    `An: ${formatMailDraftReviewField(input.to)}`,
    `Betreff: ${formatMailDraftReviewField(input.subject)}`,
    ...receivedAtLine,
    "",
    "Mail:",
    formatMailDraftReviewPreview(input.inboundPreview, MAIL_DRAFT_REVIEW_INBOUND_PREVIEW_MAX_LENGTH),
    "",
    "Entwurf:",
    formatMailDraftReviewPreview(input.draftPreview, MAIL_DRAFT_REVIEW_DRAFT_PREVIEW_MAX_LENGTH),
    "",
    "OK raus?"
  ].join("\n");

  return {
    content,
    components: [
      {
        buttons: MAIL_DRAFT_REVIEW_BUTTONS.map((button) => ({
          label: button.label,
          style: button.style,
          customId: buildNeonMailDraftReviewCustomId({ reviewId, action: button.action })
        }))
      }
    ]
  };
}

export async function runNeonMailDraftReviewAction(
  customId: string,
  handlers: INeonMailDraftReviewActionHandlers
): Promise<TNeonMailDraftReviewActionResult> {
  const selection = parseNeonMailDraftReviewCustomId(customId);
  if (selection === null) {
    return { state: "ignored", reason: "not-mail-draft-review", customId };
  }

  try {
    if (selection.action === "send") {
      await handlers.sendDraft(selection);
      return { state: "sent", selection, message: "Entwurf gesendet." };
    }

    if (selection.action === "edit") {
      await handlers.requestEdit(selection);
      return { state: "edit-requested", selection, message: "Änderungswunsch angefragt." };
    }

    await handlers.discardDraft(selection);
    return { state: "discarded", selection, message: "Entwurf verworfen." };
  } catch (error) {
    return {
      state: "failed",
      selection,
      message: error instanceof Error ? error.message : "Unknown mail draft review action error"
    };
  }
}

function parseNeonMailDraftReviewAction(value: string | undefined): TNeonMailDraftReviewAction | null {
  if (value === "send" || value === "edit" || value === "discard") {
    return value;
  }
  return null;
}

function decodeReviewId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function formatMailDraftReviewField(value: string): string {
  return truncateMailDraftReviewText(value, MAIL_DRAFT_REVIEW_FIELD_MAX_LENGTH);
}

function formatMailDraftReviewPreview(value: string, maxLength: number): string {
  const formatted = truncateMailDraftReviewText(value, maxLength);
  return formatted.length > 0 ? formatted : "(leer)";
}

function truncateMailDraftReviewText(value: string, maxLength: number): string {
  const normalized = neutralizeDiscordMentions(value)
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function neutralizeDiscordMentions(value: string): string {
  return value.replace(/@/g, "@\u200B");
}
