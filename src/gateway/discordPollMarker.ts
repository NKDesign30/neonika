import { redactText } from "../harness/redaction.js";
import {
  NEON_DISCORD_STICKER_POLL_LIMITS,
  type INeonDiscordPoll
} from "./discordStickerPollPayload.js";

/**
 * Agent-authored poll marker, pattern-following the capacity-upgrade marker
 * (discordCapacityRouter.ts). An agent appends exactly one marker to its final
 * answer; the reply loop strips it from the outgoing text and posts a native
 * Discord poll alongside the reply.
 *
 * Marker shape (single line, attributes in fixed order, optional ones may be
 * omitted):
 *   <NEON_POLL question="..." duration_hours="24" multi="false">A|B|C</NEON_POLL>
 *
 * Pure parser: no client, no send. Question and answers are redacted at the
 * source so a leaked credential inside an agent answer can never ride into a
 * poll payload. Invalid markers are still stripped from the text — raw marker
 * syntax must never reach a Discord message.
 */

export interface INeonDiscordPollMarkerParseResult {
  /** Reply text with every poll marker removed. */
  readonly text: string;
  /** First valid poll found in the text, if any. */
  readonly poll?: INeonDiscordPoll;
}

const POLL_MARKER_PATTERN =
  /<NEON_POLL question="([^"<>\r\n]{1,300})"(?: duration_hours="(\d{1,3})")?(?: multi="(true|false)")?>([^<>\r\n]{1,600})<\/NEON_POLL>/gu;

export const NEON_DISCORD_POLL_MARKER_DEFAULT_DURATION_HOURS = 24;

/**
 * Extract the first valid `<NEON_POLL …>` marker from an agent reply and strip
 * every marker occurrence from the text. Returns the cleaned text plus the
 * parsed poll when the marker validates against the Discord poll limits.
 */
export function parseNeonDiscordPollMarker(text: string): INeonDiscordPollMarkerParseResult {
  let poll: INeonDiscordPoll | undefined;

  const cleaned = text.replace(
    POLL_MARKER_PATTERN,
    (_match, question: string, durationHours: string | undefined, multi: string | undefined, answers: string) => {
      poll = poll ?? buildPollFromMarker(question, durationHours, multi, answers);
      return "";
    }
  );

  return {
    text: cleaned.replace(/\n{3,}/gu, "\n\n").trim(),
    ...(poll ? { poll } : {})
  };
}

function buildPollFromMarker(
  question: string,
  durationHours: string | undefined,
  multi: string | undefined,
  answers: string
): INeonDiscordPoll | undefined {
  const limits = NEON_DISCORD_STICKER_POLL_LIMITS;
  const cleanQuestion = redactText(question.trim());
  if (cleanQuestion.length === 0 || cleanQuestion.length > limits.pollQuestion) {
    return undefined;
  }

  const answerTexts = answers
    .split("|")
    .map((answer) => redactText(answer.trim()))
    .filter((answer) => answer.length > 0);
  if (answerTexts.length < 2 || answerTexts.length > limits.pollAnswers) {
    return undefined;
  }
  if (answerTexts.some((answer) => answer.length > limits.pollAnswerText)) {
    return undefined;
  }

  const duration =
    durationHours === undefined
      ? NEON_DISCORD_POLL_MARKER_DEFAULT_DURATION_HOURS
      : Number.parseInt(durationHours, 10);
  if (
    !Number.isSafeInteger(duration) ||
    duration < limits.pollDurationHoursMin ||
    duration > limits.pollDurationHoursMax
  ) {
    return undefined;
  }

  return {
    question: cleanQuestion,
    answers: answerTexts.map((answer) => ({ text: answer })),
    durationHours: duration,
    ...(multi === "true" ? { allowMultiselect: true } : {})
  };
}
