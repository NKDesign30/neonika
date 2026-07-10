import { redactText } from "../harness/redaction.js";
import { deriveCodexSessionKey } from "../harness/sessionKey.js";
import { createSessionBindingFromGatewayMessage } from "../gateway/shadowGateway.js";
import type { INeonGatewayInboundMessage } from "../gateway/types.js";
import type {
  INeonWorkboardCard,
  TNeonWorkboardPriority,
  TNeonWorkboardStatus
} from "./workboardModel.js";
import { createNeonWorkboardCard, readNeonWorkboardCards } from "./workboardStore.js";

export type TNeonDiscordWorkboardIntentKind =
  | "workboard-command"
  | "task-command"
  | "todo-command"
  | "action-request";

export type TNeonDiscordWorkboardSkipReason =
  | "disabled"
  | "non-discord"
  | "missing-message-id"
  | "no-work-intent";

export interface INeonDiscordWorkboardIntent {
  readonly kind: TNeonDiscordWorkboardIntentKind;
  readonly title: string;
  readonly status: TNeonWorkboardStatus;
  readonly priority: TNeonWorkboardPriority;
  readonly labels: readonly string[];
}

export interface INeonDiscordWorkboardIngestionOptions {
  readonly enabled?: boolean;
  readonly now?: () => Date;
}

export type TNeonDiscordWorkboardIngestionResult =
  | {
      readonly state: "created";
      readonly card: INeonWorkboardCard;
      readonly dedupeKey: string;
      readonly intent: INeonDiscordWorkboardIntent;
    }
  | {
      readonly state: "existing";
      readonly card: INeonWorkboardCard;
      readonly dedupeKey: string;
      readonly intent: INeonDiscordWorkboardIntent;
    }
  | {
      readonly state: "skipped";
      readonly reason: TNeonDiscordWorkboardSkipReason;
    }
  | {
      readonly state: "failed";
      readonly reason: string;
      readonly message: string;
    };

const commandPrefixes: readonly {
  readonly kind: TNeonDiscordWorkboardIntentKind;
  readonly pattern: RegExp;
}[] = [
  { kind: "workboard-command", pattern: /^\/?workboard(?:\s+|$)/i },
  { kind: "task-command", pattern: /^\/?task(?:\s+|$)/i },
  { kind: "todo-command", pattern: /^(?:\/?todo|!todo|todo:)(?:\s+|$)/i }
];

const actionRequestPattern =
  /\b(?:bitte\s+)?(?:bau|bauen|baue|fix|reparier|repariere|mach|mache|prüf|prüfe|pruef|pruefe|schau|check|review|scan|such|suche|erstell|erstelle|leg|lege|pack|setze?|zieh|ziehe|merge|deploy|ship|update|verdrahte|integrier|integriere)\b/i;

export async function recordNeonDiscordWorkboardCard(
  projectRoot: string,
  message: INeonGatewayInboundMessage,
  options: INeonDiscordWorkboardIngestionOptions = {}
): Promise<TNeonDiscordWorkboardIngestionResult> {
  if (options.enabled === false) {
    return { state: "skipped", reason: "disabled" };
  }

  const intent = resolveNeonDiscordWorkboardIntent(message);
  if (!intent) {
    return {
      state: "skipped",
      reason: message.channel === "discord" ? "no-work-intent" : "non-discord"
    };
  }

  if (!message.messageId) {
    return { state: "skipped", reason: "missing-message-id" };
  }

  const dedupeKey = createNeonDiscordWorkboardDedupeKey(message);

  try {
    const existing = await findExistingDiscordWorkboardCard(projectRoot, dedupeKey);
    if (existing) {
      return {
        state: "existing",
        card: existing,
        dedupeKey,
        intent
      };
    }

    const createdAtMs = (options.now?.() ?? new Date()).getTime();
    const card = await createNeonWorkboardCard(
      projectRoot,
      {
        title: intent.title,
        notes: createDiscordWorkboardNotes(message),
        status: intent.status,
        priority: intent.priority,
        labels: intent.labels,
        agentId: message.agentId,
        sessionKey: deriveCodexSessionKey(createSessionBindingFromGatewayMessage(message)),
        taskId: dedupeKey,
        sourceUrl: createNeonDiscordWorkboardSourceUrl(message),
        source: {
          kind: "discord-message",
          channel: "discord",
          accountId: message.accountId,
          ...(message.guildId ? { guildId: message.guildId } : {}),
          channelId: message.channelId,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          messageId: message.messageId,
          userId: message.userId,
          ...(message.userDisplayName ? { userDisplayName: message.userDisplayName } : {}),
          ...(message.createdAt ? { createdAt: message.createdAt } : {}),
          dedupeKey
        }
      },
      createdAtMs
    );

    return {
      state: "created",
      card,
      dedupeKey,
      intent
    };
  } catch (error) {
    return {
      state: "failed",
      reason: "workboard-write-failed",
      message: redactText(error instanceof Error ? error.message : "Unknown Workboard write error")
    };
  }
}

export function resolveNeonDiscordWorkboardIntent(
  message: INeonGatewayInboundMessage
): INeonDiscordWorkboardIntent | undefined {
  if (message.channel !== "discord") {
    return undefined;
  }

  const content = normalizeDiscordWorkboardContent(message.content);
  if (!content) {
    return undefined;
  }

  for (const prefix of commandPrefixes) {
    if (prefix.pattern.test(content)) {
      const title = cleanIntentTitle(content.replace(prefix.pattern, ""));
      return createIntent(prefix.kind, title || content, message);
    }
  }

  if (!actionRequestPattern.test(content)) {
    return undefined;
  }

  return createIntent("action-request", cleanIntentTitle(content), message);
}

export function createNeonDiscordWorkboardDedupeKey(message: INeonGatewayInboundMessage): string {
  return [
    "discord",
    message.accountId,
    message.guildId ?? "dm",
    message.channelId,
    message.threadId ?? "main",
    message.messageId ?? "missing"
  ].join(":");
}

export function createNeonDiscordWorkboardSourceUrl(
  message: INeonGatewayInboundMessage
): string | undefined {
  if (!message.guildId || !message.messageId) {
    return undefined;
  }

  return `https://discord.com/channels/${message.guildId}/${message.threadId ?? message.channelId}/${message.messageId}`;
}

async function findExistingDiscordWorkboardCard(
  projectRoot: string,
  dedupeKey: string
): Promise<INeonWorkboardCard | undefined> {
  const cards = await readNeonWorkboardCards(projectRoot, { maxRecords: 2000 });

  return cards.find(
    (card) => card.taskId === dedupeKey || card.metadata?.source?.dedupeKey === dedupeKey
  );
}

function createIntent(
  kind: TNeonDiscordWorkboardIntentKind,
  title: string,
  message: INeonGatewayInboundMessage
): INeonDiscordWorkboardIntent {
  const labels = [
    "discord",
    "inbound",
    kind,
    ...(message.messageId?.startsWith("interaction:") ? ["slash"] : []),
    ...(message.guildId ? ["guild"] : ["dm"]),
    ...(message.threadId ? ["thread"] : [])
  ];

  return {
    kind,
    title: truncateTitle(title),
    status: "ready",
    priority: resolveDiscordWorkboardPriority(message.content),
    labels
  };
}

function createDiscordWorkboardNotes(message: INeonGatewayInboundMessage): string {
  const origin = [
    "Discord inbound work item.",
    `User: ${message.userDisplayName ?? message.userId}`,
    `Channel: ${message.channelId}`,
    ...(message.threadId ? [`Thread: ${message.threadId}`] : []),
    ...(message.guildId ? [`Guild: ${message.guildId}`] : []),
    ...(message.messageId ? [`Message: ${message.messageId}`] : [])
  ];

  return [...origin, "", message.content].join("\n");
}

function resolveDiscordWorkboardPriority(content: string): TNeonWorkboardPriority {
  if (/\b(?:urgent|p0|p1|asap|sofort|dringend|kritisch)\b/i.test(content)) {
    return "urgent";
  }
  if (/\b(?:high|p2|wichtig|prio\s*hoch)\b/i.test(content)) {
    return "high";
  }
  if (/\b(?:low|p4|später|spaeter|nice-to-have)\b/i.test(content)) {
    return "low";
  }
  return "normal";
}

function normalizeDiscordWorkboardContent(content: string): string {
  return content.replace(/\s+/g, " ").trim();
}

function cleanIntentTitle(content: string): string {
  const slashTaskOption = content.trim().match(/^(?:task|text|prompt|title)=(.+)$/i);
  const title = slashTaskOption ? unwrapSlashOptionValue(slashTaskOption[1] ?? "") : content;

  return title
    .replace(/^(?:add|create|new|neu|karte|card|aufgabe|task)\s+/i, "")
    .replace(/^(?:ah\s+nice\s+)?(?:ja\s+)?(?:bitte\s+)?/i, "")
    .trim();
}

function unwrapSlashOptionValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to conservative quote stripping below.
    }
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function truncateTitle(title: string): string {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) {
    return normalized;
  }
  return `${normalized.slice(0, 177)}...`;
}
