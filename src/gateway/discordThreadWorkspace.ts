/**
 * Adapted in part from OpenClaw extensions/discord/src/monitor/thread-title.ts.
 * See THIRD_PARTY_NOTICES.md for attribution and license details.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText } from "../harness/redaction.js";
import type { INeonDiscordMessageEnvelope } from "./discordIngress.js";

export interface INeonDiscordThreadWorkspaceRecord {
  readonly version: 1;
  readonly workspaceId: string;
  readonly accountId: string;
  readonly guildId: string;
  readonly parentChannelId: string;
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly sourceMessageId: string;
  readonly kind: "pdf" | "long-task" | "manual";
  readonly createdAt: string;
}

export interface INeonDiscordThreadWorkspaceTransport<TMessage> {
  createThread(
    message: TMessage,
    input: { readonly name: string; readonly reason: string }
  ): Promise<{ readonly threadId: string }>;
}

export interface ICreateNeonDiscordThreadWorkspaceRuntimeOptions<TMessage> {
  readonly projectRoot: string;
  readonly transport: INeonDiscordThreadWorkspaceTransport<TMessage>;
  readonly disabledChannelIds?: readonly string[];
  readonly now?: () => Date;
}

export interface INeonDiscordThreadWorkspaceRuntime<TMessage> {
  route(
    message: TMessage,
    envelope: INeonDiscordMessageEnvelope
  ): Promise<INeonDiscordMessageEnvelope>;
  list(): readonly INeonDiscordThreadWorkspaceRecord[];
}

export function resolveNeonDiscordThreadWorkspaceStatePath(projectRoot: string): string {
  return join(projectRoot, "state", "gateway", "discord-thread-workspaces.json");
}

export function shouldCreateNeonDiscordThreadWorkspace(
  envelope: INeonDiscordMessageEnvelope
): "pdf" | "long-task" | "manual" | undefined {
  if (envelope.threadId || !envelope.guildId) {
    return undefined;
  }
  const content = envelope.content.trim();
  if (/^\/thread(?:\s|$)/iu.test(content)) {
    return "manual";
  }
  const hasPdfSubject = /\b(?:pdf|prospekt|broschüre|angebot|dokument)\b/iu.test(content);
  const hasWorkIntent = /\b(?:erstell|erzeug|bau|gestalt|überarbeit|änder|mach|entwerf)/iu.test(content);
  if (hasPdfSubject && hasWorkIntent) {
    return "pdf";
  }
  if (content.length >= 800 && /\b(?:analys|implement|recherch|plan|prüf|arbeite)\b/iu.test(content)) {
    return "long-task";
  }
  return undefined;
}

export function createNeonDiscordThreadWorkspaceRuntime<TMessage>(
  options: ICreateNeonDiscordThreadWorkspaceRuntimeOptions<TMessage>
): INeonDiscordThreadWorkspaceRuntime<TMessage> {
  const statePath = resolveNeonDiscordThreadWorkspaceStatePath(options.projectRoot);
  const now = options.now ?? (() => new Date());
  const records = loadThreadWorkspaceRecords(statePath);
  const disabledChannelIds = new Set(
    (options.disabledChannelIds ?? [])
      .map((channelId) => channelId.trim())
      .filter((channelId) => channelId.length > 0)
  );
  const inFlight = new Map<string, Promise<INeonDiscordMessageEnvelope>>();

  const route = async (
    message: TMessage,
    envelope: INeonDiscordMessageEnvelope
  ): Promise<INeonDiscordMessageEnvelope> => {
    if (disabledChannelIds.has(envelope.channelId)) {
      return envelope;
    }
    const kind = shouldCreateNeonDiscordThreadWorkspace(envelope);
    if (!kind) {
      return envelope;
    }
    const key = createSourceKey(envelope);
    const existing = records.get(key);
    if (existing) {
      return { ...envelope, threadId: existing.threadId };
    }
    const pending = inFlight.get(key);
    if (pending) {
      return await pending;
    }

    const create = (async () => {
      try {
        const created = await options.transport.createThread(message, {
          name: createThreadName(kind, envelope.messageId, envelope.content),
          reason: "Neonika private task workspace"
        });
        const threadId = requireSnowflakeLike(created.threadId, "threadId");
        const record: INeonDiscordThreadWorkspaceRecord = {
          version: 1,
          workspaceId: createWorkspaceId(envelope, threadId),
          accountId: requireBounded(envelope.accountId, "accountId"),
          guildId: requireSnowflakeLike(envelope.guildId ?? "", "guildId"),
          parentChannelId: requireSnowflakeLike(envelope.channelId, "channelId"),
          threadId,
          ownerUserId: requireBounded(envelope.author.id, "ownerUserId"),
          sourceMessageId: requireSnowflakeLike(envelope.messageId, "messageId"),
          kind,
          createdAt: now().toISOString()
        };
        records.set(key, record);
        await writeThreadWorkspaceRecords(statePath, records);
        return { ...envelope, threadId };
      } catch {
        return envelope;
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, create);
    return await create;
  };

  return {
    route,
    list: () => Array.from(records.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  };
}

export async function readNeonDiscordThreadWorkspaces(
  projectRoot: string
): Promise<readonly INeonDiscordThreadWorkspaceRecord[]> {
  return Array.from(loadThreadWorkspaceRecords(resolveNeonDiscordThreadWorkspaceStatePath(projectRoot)).values());
}

function createSourceKey(envelope: INeonDiscordMessageEnvelope): string {
  return `${envelope.accountId}:${envelope.channelId}:${envelope.messageId}`;
}

function createWorkspaceId(envelope: INeonDiscordMessageEnvelope, threadId: string): string {
  return createHash("sha256")
    .update(`${createSourceKey(envelope)}:${envelope.author.id}:${threadId}`)
    .digest("hex")
    .slice(0, 32);
}

function createThreadName(
  kind: "pdf" | "long-task" | "manual",
  messageId: string,
  content?: string
): string {
  const label = kind === "pdf" ? "PDF-Arbeitsraum" : kind === "manual" ? "Arbeitsraum" : "Langauftrag";
  const topic = deriveThreadTopic(content);
  return topic ? `${label} · ${topic}` : `${label} · ${messageId.slice(-6)}`;
}

const threadTopicStopwords: ReadonlySet<string> = new Set([
  "bitte", "kannst", "kann", "gerne", "eine", "einen", "einem", "einer",
  "und", "oder", "der", "die", "das", "den", "dem", "mit", "für", "auf",
  "aus", "von", "dann", "noch", "auch", "wenn", "nutze", "mach", "mir",
  "mal", "ein", "wie", "was", "ist", "sind", "hier", "dort", "the", "and",
  "with", "for", "this", "that", "please", "can", "you"
]);

// kiss: word heuristic instead of OpenClaw's utility-LLM thread titler
// (openclaw extensions/discord/src/monitor/thread-title.ts). Upgrade path:
// route through the Claude harness (Haiku) when heuristic titles feel blunt.
export function deriveThreadTopic(content: string | undefined): string | undefined {
  if (!content) {
    return undefined;
  }
  const words = redactText(content)
    .replace(/https?:\/\/\S+/gu, "")
    .replace(/<[@#:][^>]*>/gu, "")
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]{3,}/u.test(word) && !threadTopicStopwords.has(word.toLowerCase()));
  const topic = words.slice(0, 5).join(" ").slice(0, 60).trim();
  return topic.length >= 6 ? topic : undefined;
}

function loadThreadWorkspaceRecords(
  statePath: string
): Map<string, INeonDiscordThreadWorkspaceRecord> {
  const records = new Map<string, INeonDiscordThreadWorkspaceRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return records;
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["workspaces"])) {
    return records;
  }
  for (const value of parsed["workspaces"]) {
    const record = parseThreadWorkspaceRecord(value);
    if (record) {
      records.set(`${record.accountId}:${record.parentChannelId}:${record.sourceMessageId}`, record);
    }
  }
  return records;
}

async function writeThreadWorkspaceRecords(
  statePath: string,
  records: ReadonlyMap<string, INeonDiscordThreadWorkspaceRecord>
): Promise<void> {
  const state = {
    version: 1,
    workspaces: Array.from(records.values()).sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
  };
  await mkdir(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, statePath);
}

function parseThreadWorkspaceRecord(value: unknown): INeonDiscordThreadWorkspaceRecord | undefined {
  if (!isRecord(value) || value["version"] !== 1) {
    return undefined;
  }
  const workspaceId = readBounded(value["workspaceId"], 32);
  const accountId = readBounded(value["accountId"], 100);
  const guildId = readBounded(value["guildId"], 100);
  const parentChannelId = readBounded(value["parentChannelId"], 100);
  const threadId = readBounded(value["threadId"], 100);
  const ownerUserId = readBounded(value["ownerUserId"], 100);
  const sourceMessageId = readBounded(value["sourceMessageId"], 100);
  const kind = value["kind"] === "pdf" || value["kind"] === "long-task" || value["kind"] === "manual"
    ? value["kind"]
    : undefined;
  const createdAt = readTimestamp(value["createdAt"]);
  if (!workspaceId || !accountId || !guildId || !parentChannelId || !threadId || !ownerUserId || !sourceMessageId || !kind || !createdAt) {
    return undefined;
  }
  return { version: 1, workspaceId, accountId, guildId, parentChannelId, threadId, ownerUserId, sourceMessageId, kind, createdAt };
}

function requireBounded(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 100) {
    throw new Error(`Discord thread workspace ${field} is invalid`);
  }
  return normalized;
}

function requireSnowflakeLike(value: string, field: string): string {
  const normalized = requireBounded(value, field);
  if (!/^\d{10,25}$/u.test(normalized)) {
    throw new Error(`Discord thread workspace ${field} is not a snowflake`);
  }
  return normalized;
}

function readBounded(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
