import { PollLayoutType } from "discord.js";
import type { PollData } from "discord.js";

/**
 * Pure, side-effect-free builders + validators for Discord sticker ids and poll
 * payloads. Mirrors the other discord*Payload builders: leak-safe Neon models
 * validated against Discord's documented limits up front, so the gated outbound
 * transport never hands discord.js a sticker/poll the API would reject.
 *
 * No client, no token here. The gated transport (discordOutboundTransport) is the
 * only live-side-effect site.
 */

export const NEON_DISCORD_STICKER_POLL_LIMITS = {
  maxStickers: 3,
  pollQuestion: 300,
  pollAnswers: 10,
  pollAnswerText: 55,
  pollDurationHoursMin: 1,
  pollDurationHoursMax: 768
} as const;

// Discord snowflakes are 17–20 digit numeric strings.
const SNOWFLAKE_SHAPE = /^\d{17,20}$/;

export type TNeonStickerBuildResult =
  | { readonly ok: true; readonly stickerIds: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validate 1–3 sticker snowflake ids. */
export function buildNeonDiscordStickerPayload(stickerIds: readonly string[]): TNeonStickerBuildResult {
  const errors: string[] = [];
  if (stickerIds.length === 0) {
    return { ok: false, errors: ["at least one sticker id is required"] };
  }
  if (stickerIds.length > NEON_DISCORD_STICKER_POLL_LIMITS.maxStickers) {
    errors.push(`a message carries at most ${NEON_DISCORD_STICKER_POLL_LIMITS.maxStickers} stickers`);
  }
  stickerIds.forEach((id, index) => {
    if (!SNOWFLAKE_SHAPE.test(id.trim())) {
      errors.push(`sticker ${index} id "${id}" is not a valid snowflake`);
    }
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, stickerIds: stickerIds.map((id) => id.trim()) };
}

export interface INeonDiscordPollAnswer {
  readonly text: string;
  readonly emoji?: string;
}

export interface INeonDiscordPoll {
  readonly question: string;
  readonly answers: readonly INeonDiscordPollAnswer[];
  readonly durationHours: number;
  readonly allowMultiselect?: boolean;
}

export type TNeonPollBuildResult =
  | { readonly ok: true; readonly poll: PollData }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validate a poll (question/answers/duration) and build the discord.js PollData. */
export function buildNeonDiscordPollPayload(poll: INeonDiscordPoll): TNeonPollBuildResult {
  const errors: string[] = [];
  const limits = NEON_DISCORD_STICKER_POLL_LIMITS;

  const question = poll.question.trim();
  if (question.length === 0 || question.length > limits.pollQuestion) {
    errors.push(`poll question must be 1–${limits.pollQuestion} chars`);
  }

  if (poll.answers.length === 0) {
    errors.push("poll requires at least one answer");
  } else if (poll.answers.length > limits.pollAnswers) {
    errors.push(`poll carries at most ${limits.pollAnswers} answers`);
  }
  const answers: { text: string; emoji?: string }[] = [];
  poll.answers.forEach((answer, index) => {
    const text = answer.text.trim();
    if (text.length === 0 || text.length > limits.pollAnswerText) {
      errors.push(`poll answer ${index} text must be 1–${limits.pollAnswerText} chars`);
      return;
    }
    answers.push({ text, ...(answer.emoji !== undefined && answer.emoji.length > 0 ? { emoji: answer.emoji } : {}) });
  });

  if (
    !Number.isInteger(poll.durationHours) ||
    poll.durationHours < limits.pollDurationHoursMin ||
    poll.durationHours > limits.pollDurationHoursMax
  ) {
    errors.push(`poll durationHours must be an integer ${limits.pollDurationHoursMin}–${limits.pollDurationHoursMax}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    poll: {
      question: { text: question },
      answers,
      duration: poll.durationHours,
      allowMultiselect: poll.allowMultiselect ?? false,
      layoutType: PollLayoutType.Default
    }
  };
}
