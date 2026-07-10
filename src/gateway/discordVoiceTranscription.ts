import type {
  INeonGatewayInboundAttachment,
  INeonGatewayInboundMessage
} from "./types.js";
import { resolveElevenLabsApiKey } from "./elevenLabsConfig.js";

export type TNeonDiscordVoiceTranscriptionMode = "off" | "on";

export interface INeonDiscordVoiceTranscriptionInput {
  readonly attachment: INeonGatewayInboundAttachment;
  readonly apiKey: string;
  readonly modelId: string;
  readonly maxAudioBytes: number;
  readonly fetchImpl: typeof fetch;
}

export interface INeonDiscordVoiceTranscriptionOptions {
  readonly mode: TNeonDiscordVoiceTranscriptionMode;
  readonly apiKey?: string;
  readonly apiKeyEnvFile?: string;
  readonly modelId?: string;
  readonly maxAudioBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly transcribe?: (input: INeonDiscordVoiceTranscriptionInput) => Promise<string | undefined>;
}

interface IVoiceTranscript {
  readonly attachment: INeonGatewayInboundAttachment;
  readonly text: string;
}

const defaultElevenLabsSttModelId = "scribe_v2";
const defaultMaxAudioBytes = 25 * 1024 * 1024;

export function resolveNeonDiscordVoiceTranscriptionOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonDiscordVoiceTranscriptionOptions | undefined {
  const mode = normalizeVoiceTranscriptionMode(env["NEON_DISCORD_VOICE_TRANSCRIPTION"]);
  if (mode === "off") {
    return undefined;
  }

  return {
    mode,
    ...(env["ELEVENLABS_API_KEY"] ? { apiKey: env["ELEVENLABS_API_KEY"] } : {}),
    ...(env["NEON_ELEVENLABS_ENV_FILE"] ? { apiKeyEnvFile: env["NEON_ELEVENLABS_ENV_FILE"] } : {}),
    ...(env["NEON_ELEVENLABS_STT_MODEL"] ? { modelId: env["NEON_ELEVENLABS_STT_MODEL"] } : {}),
    ...(env["NEON_DISCORD_VOICE_TRANSCRIPTION_MAX_BYTES"]
      ? { maxAudioBytes: Number(env["NEON_DISCORD_VOICE_TRANSCRIPTION_MAX_BYTES"]) }
      : {})
  };
}

export async function enrichNeonDiscordMessageWithVoiceTranscription(
  message: INeonGatewayInboundMessage,
  options: INeonDiscordVoiceTranscriptionOptions | undefined
): Promise<INeonGatewayInboundMessage> {
  if (!options || options.mode !== "on") {
    return message;
  }

  const audioAttachments = (message.attachments ?? []).filter(isTranscribableAudioAttachment);
  if (audioAttachments.length === 0) {
    return message;
  }

  const apiKey = await resolveElevenLabsApiKey(options);
  if (!apiKey) {
    return message;
  }

  const transcripts: IVoiceTranscript[] = [];
  for (const attachment of audioAttachments) {
    const text = await transcribeDiscordVoiceAttachment(attachment, apiKey, options);
    if (text) {
      transcripts.push({ attachment, text });
    }
  }

  if (transcripts.length === 0) {
    return message;
  }

  return {
    ...message,
    content: mergeVoiceTranscriptsIntoContent(message.content, transcripts)
  };
}

async function transcribeDiscordVoiceAttachment(
  attachment: INeonGatewayInboundAttachment,
  apiKey: string,
  options: INeonDiscordVoiceTranscriptionOptions
): Promise<string | undefined> {
  const input: INeonDiscordVoiceTranscriptionInput = {
    attachment,
    apiKey,
    modelId: options.modelId ?? defaultElevenLabsSttModelId,
    maxAudioBytes: normalizeMaxAudioBytes(options.maxAudioBytes),
    fetchImpl: options.fetchImpl ?? fetch
  };

  try {
    const text = options.transcribe ? await options.transcribe(input) : await transcribeWithElevenLabs(input);
    const normalized = text?.replace(/\s+/gu, " ").trim();
    return normalized && normalized.length > 0 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

async function transcribeWithElevenLabs(
  input: INeonDiscordVoiceTranscriptionInput
): Promise<string | undefined> {
  const audioResponse = await input.fetchImpl(input.attachment.url);
  if (!audioResponse.ok) {
    return undefined;
  }

  const contentLength = Number(audioResponse.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > input.maxAudioBytes) {
    return undefined;
  }

  const audioBytes = await audioResponse.arrayBuffer();
  if (audioBytes.byteLength > input.maxAudioBytes) {
    return undefined;
  }

  const form = new FormData();
  form.set("model_id", input.modelId);
  form.set(
    "file",
    new Blob([audioBytes], {
      type: input.attachment.contentType ?? "application/octet-stream"
    }),
    input.attachment.name
  );

  const response = await input.fetchImpl("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": input.apiKey
    },
    body: form
  });

  if (!response.ok) {
    return undefined;
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload)) {
    return undefined;
  }

  const text = payload["text"];
  return typeof text === "string" ? text.trim() : undefined;
}

function isTranscribableAudioAttachment(attachment: INeonGatewayInboundAttachment): boolean {
  return attachment.kind === "audio";
}

function mergeVoiceTranscriptsIntoContent(
  content: string,
  transcripts: readonly IVoiceTranscript[]
): string {
  const textContent = content.trim();
  const voiceContent = transcripts
    .map((transcript, index) => `Voice transcript ${index + 1} (${transcript.attachment.name}): ${transcript.text}`)
    .join("\n");

  return [textContent, voiceContent].filter((part) => part.length > 0).join("\n\n");
}

function normalizeVoiceTranscriptionMode(value: string | undefined): TNeonDiscordVoiceTranscriptionMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "ready" || normalized === "on" || normalized === "1" || normalized === "always"
    ? "on"
    : "off";
}

function normalizeMaxAudioBytes(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : defaultMaxAudioBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
