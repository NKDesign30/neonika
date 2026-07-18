import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { NEON_DISCORD_MEDIA_LIMITS, type TNeonDiscordMediaAttachment } from "./discordMediaPayload.js";
import { NeonResponseBodyLimitError, readNeonResponseBodyLimited } from "./boundedResponseBody.js";
import { resolveElevenLabsApiKey } from "./elevenLabsConfig.js";
import { normalizeNeonDiscordVoiceReplyTextForTts } from "./discordVoiceReplyTextNormalizer.js";
import { resolveOpenAiApiKey } from "./openAiConfig.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";

export type TNeonDiscordVoiceReplyMode = "off" | "explicit" | "always";

export interface INeonDiscordVoiceReplySynthesisInput {
  readonly text: string;
  readonly apiKey: string;
  readonly voiceId: string;
  readonly modelId: string;
  readonly outputFormat: string;
  readonly fetchImpl: typeof fetch;
}

export interface INeonOpenAiVoiceReplySynthesisInput {
  readonly text: string;
  readonly apiKey: string;
  readonly voice: string;
  readonly modelId: string;
  readonly outputFormat: string;
  readonly instructions: string;
  readonly fetchImpl: typeof fetch;
}

export interface INeonMacOsVoiceReplySynthesisInput {
  readonly text: string;
  readonly voice: string;
}

export interface INeonDiscordVoiceReplyOptions {
  readonly mode: TNeonDiscordVoiceReplyMode;
  readonly apiKey?: string;
  readonly apiKeyEnvFile?: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly outputFormat?: string;
  readonly openAiApiKey?: string;
  readonly openAiApiKeyEnvFile?: string;
  readonly openAiVoice?: string;
  readonly openAiModelId?: string;
  readonly openAiOutputFormat?: string;
  readonly openAiInstructions?: string;
  readonly macOsTtsEnabled?: boolean;
  readonly macOsVoice?: string;
  readonly maxTextChars?: number;
  readonly synthesize?: (
    input: INeonDiscordVoiceReplySynthesisInput
  ) => Promise<TNeonDiscordMediaAttachment | undefined>;
  readonly synthesizeOpenAi?: (
    input: INeonOpenAiVoiceReplySynthesisInput
  ) => Promise<TNeonDiscordMediaAttachment | undefined>;
  readonly synthesizeMacOs?: (
    input: INeonMacOsVoiceReplySynthesisInput
  ) => Promise<TNeonDiscordMediaAttachment | undefined>;
  readonly fetchImpl?: typeof fetch;
}

const defaultElevenLabsVoiceId = "JBFqnCBsd6RMkjVDRZzb";
const defaultElevenLabsModelId = "eleven_multilingual_v2";
const defaultElevenLabsOutputFormat = "mp3_44100_128";
const defaultOpenAiModelId = "gpt-4o-mini-tts";
const defaultOpenAiVoice = "marin";
const defaultOpenAiOutputFormat = "mp3";
const defaultOpenAiInstructions =
  "Use the language of the input. Speak naturally and clearly with conversational pacing.";
const defaultMacOsVoice = "Anna";
const defaultMaxVoiceReplyChars = 1200;
export const NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES = NEON_DISCORD_MEDIA_LIMITS.maxFileBytes;
const execFileAsync = promisify(execFile);

export function resolveNeonDiscordVoiceReplyOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonDiscordVoiceReplyOptions | undefined {
  const mode = normalizeVoiceReplyMode(env["NEON_DISCORD_VOICE_REPLY"]);
  if (mode === "off") {
    return undefined;
  }
  const openAiTtsFallbackEnabled =
    normalizeOpenAiTtsFallbackMode(env["NEON_OPENAI_TTS_FALLBACK"]) || Boolean(env["OPENAI_API_KEY"]);
  const openAiApiKeyEnvFile = env["NEON_OPENAI_ENV_FILE"] ?? env["NEON_ELEVENLABS_ENV_FILE"];

  return {
    mode,
    ...(env["ELEVENLABS_API_KEY"] ? { apiKey: env["ELEVENLABS_API_KEY"] } : {}),
    ...(env["NEON_ELEVENLABS_ENV_FILE"] ? { apiKeyEnvFile: env["NEON_ELEVENLABS_ENV_FILE"] } : {}),
    ...(env["NEON_ELEVENLABS_VOICE_ID"] ? { voiceId: env["NEON_ELEVENLABS_VOICE_ID"] } : {}),
    ...(env["NEON_ELEVENLABS_TTS_MODEL"] ? { modelId: env["NEON_ELEVENLABS_TTS_MODEL"] } : {}),
    ...(env["NEON_ELEVENLABS_TTS_OUTPUT_FORMAT"]
      ? { outputFormat: env["NEON_ELEVENLABS_TTS_OUTPUT_FORMAT"] }
      : {}),
    ...(openAiTtsFallbackEnabled && env["OPENAI_API_KEY"] ? { openAiApiKey: env["OPENAI_API_KEY"] } : {}),
    ...(openAiTtsFallbackEnabled && openAiApiKeyEnvFile ? { openAiApiKeyEnvFile } : {}),
    ...(openAiTtsFallbackEnabled && env["NEON_OPENAI_TTS_VOICE"]
      ? { openAiVoice: env["NEON_OPENAI_TTS_VOICE"] }
      : {}),
    ...(openAiTtsFallbackEnabled && env["NEON_OPENAI_TTS_MODEL"]
      ? { openAiModelId: env["NEON_OPENAI_TTS_MODEL"] }
      : {}),
    ...(openAiTtsFallbackEnabled && env["NEON_OPENAI_TTS_OUTPUT_FORMAT"]
      ? { openAiOutputFormat: env["NEON_OPENAI_TTS_OUTPUT_FORMAT"] }
      : {}),
    ...(openAiTtsFallbackEnabled && env["NEON_OPENAI_TTS_INSTRUCTIONS"]
      ? { openAiInstructions: env["NEON_OPENAI_TTS_INSTRUCTIONS"] }
      : {}),
    ...(normalizeMacOsTtsFallbackMode(env["NEON_MACOS_TTS_FALLBACK"]) ? { macOsTtsEnabled: true } : {}),
    ...(env["NEON_MACOS_TTS_VOICE"] ? { macOsVoice: env["NEON_MACOS_TTS_VOICE"] } : {}),
    ...(env["NEON_DISCORD_VOICE_REPLY_MAX_CHARS"]
      ? { maxTextChars: Number(env["NEON_DISCORD_VOICE_REPLY_MAX_CHARS"]) }
      : {})
  };
}

export async function createNeonDiscordVoiceReplyAttachment(
  text: string,
  options: INeonDiscordVoiceReplyOptions | undefined
): Promise<TNeonDiscordMediaAttachment | undefined> {
  if (!options || options.mode === "off") {
    return undefined;
  }

  const normalizedText = truncateVoiceReplyText(
    normalizeNeonDiscordVoiceReplyTextForTts(text),
    options.maxTextChars
  );
  if (normalizedText.length === 0) {
    return undefined;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const elevenLabsAttachment = await createElevenLabsVoiceReplyAttachment(normalizedText, options, fetchImpl);
  if (elevenLabsAttachment) {
    return elevenLabsAttachment;
  }

  const openAiAttachment = await createOpenAiVoiceReplyAttachment(normalizedText, options, fetchImpl);
  if (openAiAttachment) {
    return openAiAttachment;
  }

  return createMacOsVoiceReplyAttachment(normalizedText, options);
}

async function createElevenLabsVoiceReplyAttachment(
  text: string,
  options: INeonDiscordVoiceReplyOptions,
  fetchImpl: typeof fetch
): Promise<TNeonDiscordMediaAttachment | undefined> {
  const apiKey = await resolveElevenLabsApiKey(options);
  if (!apiKey) {
    return undefined;
  }

  const input: INeonDiscordVoiceReplySynthesisInput = {
    text,
    apiKey,
    voiceId: options.voiceId ?? defaultElevenLabsVoiceId,
    modelId: options.modelId ?? defaultElevenLabsModelId,
    outputFormat: options.outputFormat ?? defaultElevenLabsOutputFormat,
    fetchImpl
  };

  try {
    return options.synthesize ? await options.synthesize(input) : await synthesizeElevenLabsVoiceReply(input);
  } catch {
    return undefined;
  }
}

async function createOpenAiVoiceReplyAttachment(
  text: string,
  options: INeonDiscordVoiceReplyOptions,
  fetchImpl: typeof fetch
): Promise<TNeonDiscordMediaAttachment | undefined> {
  const apiKey = await resolveOpenAiApiKey(options);
  if (!apiKey) {
    return undefined;
  }

  const input: INeonOpenAiVoiceReplySynthesisInput = {
    text,
    apiKey,
    voice: options.openAiVoice ?? defaultOpenAiVoice,
    modelId: options.openAiModelId ?? defaultOpenAiModelId,
    outputFormat: options.openAiOutputFormat ?? defaultOpenAiOutputFormat,
    instructions: options.openAiInstructions ?? defaultOpenAiInstructions,
    fetchImpl
  };

  try {
    return options.synthesizeOpenAi ? await options.synthesizeOpenAi(input) : await synthesizeOpenAiVoiceReply(input);
  } catch {
    return undefined;
  }
}

async function createMacOsVoiceReplyAttachment(
  text: string,
  options: INeonDiscordVoiceReplyOptions
): Promise<TNeonDiscordMediaAttachment | undefined> {
  if (!options.macOsTtsEnabled && !options.synthesizeMacOs) {
    return undefined;
  }

  const input: INeonMacOsVoiceReplySynthesisInput = {
    text,
    voice: options.macOsVoice ?? defaultMacOsVoice
  };

  try {
    return options.synthesizeMacOs ? await options.synthesizeMacOs(input) : await synthesizeMacOsVoiceReply(input);
  } catch {
    return undefined;
  }
}

async function synthesizeElevenLabsVoiceReply(
  input: INeonDiscordVoiceReplySynthesisInput
): Promise<TNeonDiscordMediaAttachment | undefined> {
  const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voiceId)}`);
  url.searchParams.set("output_format", input.outputFormat);
  const response = await input.fetchImpl(url, {
    method: "POST",
    headers: {
      "xi-api-key": input.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text: input.text,
      model_id: input.modelId
    })
  });

  if (!response.ok) {
    return undefined;
  }

  return {
    name: "chaty-reply.mp3",
    data: await readVoiceReplyAudio(response),
    contentType: "audio/mpeg"
  };
}

async function synthesizeOpenAiVoiceReply(
  input: INeonOpenAiVoiceReplySynthesisInput
): Promise<TNeonDiscordMediaAttachment | undefined> {
  const response = await input.fetchImpl("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      Accept: resolveOpenAiAcceptHeader(input.outputFormat)
    },
    body: JSON.stringify({
      model: input.modelId,
      voice: input.voice,
      input: input.text,
      instructions: input.instructions,
      response_format: input.outputFormat
    })
  });

  if (!response.ok) {
    return undefined;
  }

  return {
    name: `chaty-reply-openai.${resolveOpenAiFileExtension(input.outputFormat)}`,
    data: await readVoiceReplyAudio(response),
    contentType: resolveOpenAiContentType(input.outputFormat)
  };
}

async function readVoiceReplyAudio(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isInteger(declared) && declared > NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES) {
    throw new NeonResponseBodyLimitError(
      "response-too-large",
      `Voice reply audio exceeded ${NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES} bytes`
    );
  }

  const data = await readNeonResponseBodyLimited(response.body, NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES);
  if (data.byteLength === 0) {
    throw new NeonResponseBodyLimitError("response-body-missing", "Voice reply audio is empty");
  }
  return data;
}

async function synthesizeMacOsVoiceReply(
  input: INeonMacOsVoiceReplySynthesisInput
): Promise<TNeonDiscordMediaAttachment | undefined> {
  const workDir = await mkdtemp(join(tmpdir(), "neon-tts-"));
  const textPath = join(workDir, "input.txt");
  const aiffPath = join(workDir, "reply.aiff");
  const m4aPath = join(workDir, "reply.m4a");

  try {
    await writeFile(textPath, input.text, "utf8");
    await execFileAsync("/usr/bin/say", ["-v", input.voice, "-f", textPath, "-o", aiffPath]);
    await execFileAsync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", aiffPath, m4aPath]);
    return {
      name: "chaty-reply-local.m4a",
      data: new Uint8Array(await readFile(m4aPath)),
      contentType: "audio/mp4"
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function normalizeVoiceReplyMode(value: string | undefined): TNeonDiscordVoiceReplyMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "always") {
    return "always";
  }

  return normalized === "explicit" ||
    normalized === "requested" ||
    normalized === "ready" ||
    normalized === "on" ||
    normalized === "1"
    ? "explicit"
    : "off";
}

function normalizeMacOsTtsFallbackMode(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "always" || normalized === "ready" || normalized === "on" || normalized === "1";
}

function normalizeOpenAiTtsFallbackMode(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "always" || normalized === "ready" || normalized === "on" || normalized === "1";
}

function truncateVoiceReplyText(text: string, maxChars: number | undefined): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : defaultMaxVoiceReplyChars;
  if (normalized.length <= limit) {
    return normalized;
  }
  const suffix = "...";
  const textLimit = Math.max(1, limit - suffix.length);
  return `${truncateUtf16Safe(normalized, textLimit).trim()}${suffix}`;
}

function resolveOpenAiFileExtension(format: string): string {
  const normalized = format.trim().toLowerCase();
  return normalized.length > 0 ? normalized : "mp3";
}

function resolveOpenAiContentType(format: string): string {
  switch (format.trim().toLowerCase()) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/ogg";
    case "pcm":
      return "audio/pcm";
    case "wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

function resolveOpenAiAcceptHeader(format: string): string {
  return resolveOpenAiContentType(format);
}
