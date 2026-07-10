import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
  type Message
} from "discord.js";

import type { ICodexHarness, IMemoryAttachment } from "../harness/types.js";
import type {
  INeonGatewayInboundAttachment,
  INeonGatewayInboundMessage,
  INeonGatewayShadowRun,
  TNeonGatewayInboundAttachmentKind
} from "./types.js";
import type {
  INeonDiscordIngressPolicy,
  INeonDiscordMessageEnvelope,
  INeonDiscordSlashInteractionEnvelope,
  INeonDiscordSlashOption,
  TNeonDiscordDropReason,
  TNeonDiscordMemoryResolver,
  TNeonDiscordSlashOptionValue,
  TNeonGatewayRunWriter
} from "./discordIngress.js";
import { runNeonDiscordShadowIngress } from "./discordIngress.js";
import { markNeonGatewayRunDelivered } from "./shadowGateway.js";
import {
  createNeonSessionActorQueue,
  type INeonSessionActorQueue
} from "./sessionActorQueue.js";
import {
  createNeonInboundDebouncer,
  type INeonInboundDebouncer,
  type INeonInboundDebounceScheduler
} from "./inboundDebouncer.js";
import {
  resolveNeonInboundDebounceMs,
  shouldDebounceNeonTextInbound
} from "./inboundDebouncePolicy.js";
import {
  runNeonDiscordSlashInteractionShadow,
  type TNeonSlashDispatchDropReason
} from "./discordSlashDispatch.js";
import type { INeonDiscordVoiceTranscriptionOptions } from "./discordVoiceTranscription.js";
import {
  writeNeonDiscordRouteProbe,
  type INeonDiscordRouteProbe
} from "./discordRouteProbe.js";
import {
  buildNeonInboundReplayKey,
  claimNeonInboundReplay,
  createNeonDiscordInboundReplayFileStore,
  createNeonDiscordInboundReplayGuard,
  resolveNeonDiscordInboundReplayPath,
  type INeonDiscordInboundReplayGuard
} from "./discordInboundReplayGuard.js";
import {
  deliverNeonCanaryReplyForRun,
  type INeonCanaryReplyLoopResult,
  type TNeonCanaryReplyMode,
  type TNeonCanaryReplyLoopState
} from "./canaryReplyLoop.js";
import type { INeonDiscordVoiceReplyOptions } from "./discordVoiceReplySynthesis.js";
import type { INeonOutboundSender } from "./outboundSender.js";
import {
  resolveNeonStatusReactionEmoji,
  type TNeonStatusReactionState
} from "../channels/statusReactions.js";

// Tap-local drop reason: the inbound replay guard adds "duplicate" on top of the
// ingress drop reasons and the unmapped-message tap reason.
type TNeonDiscordTapDropReason = TNeonDiscordDropReason | "duplicate" | "unmapped-message";
type TNeonDiscordTapReactionState = Extract<
  TNeonStatusReactionState,
  "queued" | "done" | "error"
>;
type TNeonDiscordTapReactionOutcome = "sent" | "failed";

export interface INeonDiscordMessageMapper<TMessage> {
  (message: TMessage): INeonDiscordMessageEnvelope | undefined;
}

export interface INeonDiscordInteractionMapper<TInteraction> {
  (interaction: TInteraction): INeonDiscordSlashInteractionEnvelope | undefined;
}

export interface INeonDiscordTapAdapter<TMessage, TInteraction = never> {
  listen(
    onMessage: (message: TMessage) => void | Promise<void>,
    onError: (error: Error) => void
  ): void;
  /**
   * Optional native slash-interaction listening on the SAME client. When the
   * adapter and a `mapInteraction` are both present, the tap dispatches each
   * interaction through the shadow slash pipeline (no extra gateway connection).
   */
  listenInteractions?(
    onInteraction: (interaction: TInteraction) => void | Promise<void>,
    onError: (error: Error) => void
  ): void;
  sendTyping?(message: TMessage): Promise<void>;
  addReaction?(message: TMessage, emoji: string): Promise<void>;
  login(token: string): Promise<void>;
  close(): Promise<void>;
}

export interface INeonDiscordProbeHeartbeatScheduler {
  schedule(callback: () => void | Promise<void>, intervalMs: number): unknown;
  cancel(handle: unknown): void;
}

export interface INeonDiscordProbeHeartbeatOptions {
  readonly intervalMs?: number;
  readonly scheduler?: INeonDiscordProbeHeartbeatScheduler;
}

export interface INeonDiscordInboundDebounceOptions {
  readonly debounceMs?: number;
  readonly scheduler?: INeonInboundDebounceScheduler;
}

export interface INeonDiscordShadowTapOptions<TMessage, TInteraction = never> {
  readonly token: string;
  readonly projectRoot: string;
  readonly accountId?: string;
  readonly adapter: INeonDiscordTapAdapter<TMessage, TInteraction>;
  readonly mapMessage: INeonDiscordMessageMapper<TMessage>;
  /** Maps a native slash interaction; required to arm interaction dispatch. */
  readonly mapInteraction?: INeonDiscordInteractionMapper<TInteraction>;
  readonly policy: INeonDiscordIngressPolicy;
  readonly memory?: IMemoryAttachment;
  readonly resolveMemory?: TNeonDiscordMemoryResolver;
  readonly harness: ICodexHarness;
  readonly resolveHarness?: (message: INeonGatewayInboundMessage) => ICodexHarness | undefined;
  readonly resolveContext?: (
    message: INeonGatewayInboundMessage,
    envelope: INeonDiscordMessageEnvelope
  ) =>
    | INeonGatewayInboundMessage["context"]
    | Promise<INeonGatewayInboundMessage["context"]>;
  readonly now?: () => Date;
  readonly onEvent?: (event: TNeonDiscordShadowTapEvent) => void;
  readonly writeRun?: TNeonGatewayRunWriter;
  readonly writeRunningRun?: TNeonGatewayRunWriter;
  readonly voiceTranscription?: INeonDiscordVoiceTranscriptionOptions;
  /**
   * Optional private canary reply loop. Default omitted = no outbound path. When
   * injected, the sender's own Canary gate + channel allowlist still decides
   * whether a real reply leaves the process.
   */
  readonly canaryReplySender?: INeonOutboundSender;
  readonly canaryReplyMode?: TNeonCanaryReplyMode;
  readonly canaryVoiceReply?: INeonDiscordVoiceReplyOptions;
  readonly startTyping?: (
    message: TMessage,
    envelope: INeonGatewayInboundMessage
  ) => Promise<void> | void;
  readonly addStatusReaction?: (
    message: TMessage,
    envelope: INeonGatewayInboundMessage,
    state: TNeonDiscordTapReactionState,
    emoji: string
  ) => Promise<void> | void;
  readonly typingPulseMs?: number;
  readonly resolveAbortSignal?: (
    runId: string,
    message: INeonGatewayInboundMessage
  ) => AbortSignal | undefined;
  readonly sessionQueue?: INeonSessionActorQueue;
  readonly probeHeartbeat?: INeonDiscordProbeHeartbeatOptions;
  readonly inboundDebounce?: INeonDiscordInboundDebounceOptions;
  /** Injectable inbound replay guard for deterministic tests. Defaults to a fresh in-memory guard. */
  readonly replayGuard?: INeonDiscordInboundReplayGuard;
}

export interface INeonDiscordShadowTapStats {
  readonly accepted: number;
  readonly dropped: number;
  readonly errors: number;
  // Slash-interaction dispatch counters (separate from message accept/drop).
  readonly interactionsAccepted: number;
  readonly interactionsDropped: number;
  readonly running: boolean;
  readonly startedAt: string;
  readonly stoppedAt?: string;
  readonly lastProbeAt?: string;
  readonly lastRunId?: string;
  readonly repliesDelivered: number;
  readonly repliesSuppressed: number;
  readonly replyErrors: number;
  readonly typingStarted: number;
  readonly typingErrors: number;
  readonly reactionsSent: number;
  readonly reactionErrors: number;
  readonly lastReplyState?: TNeonCanaryReplyLoopState;
  readonly lastReplyMessageId?: string;
  readonly lastTypingState?: "started" | "failed";
  readonly lastReactionState?: TNeonDiscordTapReactionState;
  readonly lastReactionOutcome?: TNeonDiscordTapReactionOutcome;
  readonly lastInteractionRunId?: string;
  readonly lastDropReason?: TNeonDiscordTapDropReason;
  readonly lastInteractionDropReason?: TNeonSlashDispatchDropReason | "unmapped-interaction";
  readonly lastErrorMessage?: string;
}

export interface INeonDiscordShadowTapHandle {
  readonly stats: INeonDiscordShadowTapStats;
  close(): Promise<void>;
}

export type TNeonDiscordShadowTapEvent =
  | {
      readonly kind: "accepted";
      readonly runId: string;
    }
  | {
      readonly kind: "dropped";
      readonly reason: TNeonDiscordTapDropReason;
    }
  | {
      readonly kind: "interaction-accepted";
      readonly runId: string;
    }
  | {
      readonly kind: "interaction-dropped";
      readonly reason: TNeonSlashDispatchDropReason | "unmapped-interaction";
    }
  | {
      readonly kind: "reply";
      readonly runId: string;
      readonly state: TNeonCanaryReplyLoopState;
      readonly outboundSent: boolean;
      readonly messageId?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "typing";
      readonly state: "started" | "failed";
    }
  | {
      readonly kind: "reaction";
      readonly state: TNeonDiscordTapReactionState;
      readonly emoji: string;
      readonly outcome: TNeonDiscordTapReactionOutcome;
    }
  | {
      readonly kind: "error";
      readonly message: string;
    };

export interface INeonDiscordJsTapOptions {
  readonly intents?: readonly GatewayIntentBits[];
}

export interface IDiscordJsUserLike {
  readonly id: string;
  readonly username: string;
  readonly bot: boolean;
}

export interface IDiscordJsGuildMemberLike {
  readonly displayName: string;
}

export interface IDiscordJsChannelLike {
  readonly id: string;
  readonly parentId?: string | null;
  isThread?(): boolean;
}

export interface IDiscordJsMentionUsersLike {
  keys(): IterableIterator<string>;
}

export interface IDiscordJsAttachmentLike {
  readonly id: string;
  readonly name?: string | null;
  readonly url: string;
  readonly contentType?: string | null;
  readonly size?: number;
  readonly duration?: number | null;
  readonly waveform?: string | null;
}

export interface IDiscordJsAttachmentCollectionLike {
  values(): IterableIterator<IDiscordJsAttachmentLike>;
}

export interface IDiscordJsMessageLike {
  readonly id: string;
  readonly content: string;
  readonly createdTimestamp: number;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly channel: IDiscordJsChannelLike;
  readonly author: IDiscordJsUserLike;
  readonly member: IDiscordJsGuildMemberLike | null;
  readonly mentions: {
    readonly users: IDiscordJsMentionUsersLike;
  };
  readonly attachments?: IDiscordJsAttachmentCollectionLike;
}

interface IMutableDiscordShadowTapStats {
  accepted: number;
  dropped: number;
  errors: number;
  interactionsAccepted: number;
  interactionsDropped: number;
  running: boolean;
  startedAt: string;
  stoppedAt?: string;
  lastProbeAt?: string;
  lastRunId?: string;
  repliesDelivered: number;
  repliesSuppressed: number;
  replyErrors: number;
  typingStarted: number;
  typingErrors: number;
  reactionsSent: number;
  reactionErrors: number;
  lastReplyState?: TNeonCanaryReplyLoopState;
  lastReplyMessageId?: string;
  lastTypingState?: "started" | "failed";
  lastReactionState?: TNeonDiscordTapReactionState;
  lastReactionOutcome?: TNeonDiscordTapReactionOutcome;
  lastInteractionRunId?: string;
  lastDropReason?: TNeonDiscordTapDropReason;
  lastInteractionDropReason?: TNeonSlashDispatchDropReason | "unmapped-interaction";
  lastErrorMessage?: string;
}

interface IDiscordTapInboundDebounceItem<TMessage> {
  readonly message: TMessage;
  readonly envelope: INeonDiscordMessageEnvelope;
}

const defaultProbeHeartbeatMs = 30_000;
const defaultTypingPulseMs = 8_000;
const defaultProbeHeartbeatScheduler: INeonDiscordProbeHeartbeatScheduler = {
  schedule: (callback, intervalMs) => setInterval(() => {
    void callback();
  }, intervalMs),
  cancel: (handle) => {
    clearInterval(handle as NodeJS.Timeout);
  }
};

export async function startNeonDiscordShadowTap<TMessage, TInteraction = never>(
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>
): Promise<INeonDiscordShadowTapHandle> {
  const startedAt = createTapTimestamp(options);
  const stats: IMutableDiscordShadowTapStats = {
    accepted: 0,
    dropped: 0,
    errors: 0,
    interactionsAccepted: 0,
    interactionsDropped: 0,
    repliesDelivered: 0,
    repliesSuppressed: 0,
    replyErrors: 0,
    typingStarted: 0,
    typingErrors: 0,
    reactionsSent: 0,
    reactionErrors: 0,
    running: true,
    startedAt,
    lastProbeAt: startedAt
  };

  await persistDiscordTapProbe(options, stats);
  const heartbeat = startDiscordTapProbeHeartbeat(options, stats);

  // One replay guard per tap so a gateway resume/reconnect cannot re-process the
  // same inbound message twice. Default uses a best-effort Neon-owned state file
  // so a short process restart does not drop still-live replay claims.
  const replayGuard =
    options.replayGuard ??
    createNeonDiscordInboundReplayGuard({
      persistentStore: createNeonDiscordInboundReplayFileStore(
        resolveNeonDiscordInboundReplayPath(options.projectRoot)
      )
    });
  const sessionQueue = options.sessionQueue ?? createNeonSessionActorQueue();
  const inboundDebouncer = createDiscordTapInboundDebouncer(options, stats, sessionQueue);

  options.adapter.listen(
    async (message) => {
      await handleTapMessage(message, options, stats, replayGuard, sessionQueue, inboundDebouncer);
    },
    (error) => {
      recordTapError(error, options, stats);
      void persistDiscordTapProbe(options, stats);
    }
  );

  // Arm slash-interaction dispatch on the same client when both the adapter
  // supports it and a mapper is configured. Absent either, the tap is
  // message-only (unchanged behavior).
  const mapInteraction = options.mapInteraction;
  if (options.adapter.listenInteractions && mapInteraction) {
    options.adapter.listenInteractions(
      async (interaction) => {
        await handleTapInteraction(interaction, mapInteraction, options, stats);
      },
      (error) => {
        recordTapError(error, options, stats);
        void persistDiscordTapProbe(options, stats);
      }
    );
  }

  await options.adapter.login(options.token);

  return {
    stats,
    close: async () => {
      heartbeat.stop();
      await inboundDebouncer?.flushAll();
      await options.adapter.close();
      stats.running = false;
      stats.stoppedAt = createTapTimestamp(options);
      await persistDiscordTapProbe(options, stats);
    }
  };
}

export function createDiscordJsShadowTapAdapter(
  options: INeonDiscordJsTapOptions = {}
): INeonDiscordTapAdapter<Message, ChatInputCommandInteraction> {
  const client = new Client({
    intents: options.intents ?? [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  return {
    listen: (onMessage, onError) => {
      client.on(Events.MessageCreate, (message) => {
        void onMessage(message);
      });
      client.on(Events.Error, onError);
    },
    listenInteractions: (onInteraction, onError) => {
      client.on(Events.InteractionCreate, (interaction) => {
        // Only native chat-input slash commands; component/autocomplete
        // interactions are out of scope for the shadow dispatch.
        if (!interaction.isChatInputCommand()) {
          return;
        }
        void onInteraction(interaction);
      });
      client.on(Events.Error, onError);
    },
    sendTyping: async (message) => {
      if (isDiscordTypingChannel(message.channel)) {
        await message.channel.sendTyping();
      }
    },
    addReaction: async (message, emoji) => {
      await message.react(emoji);
    },
    login: async (token) => {
      await client.login(token);
    },
    close: async () => {
      await client.destroy();
    }
  };
}

export function mapDiscordJsMessageToEnvelope(
  message: IDiscordJsMessageLike,
  accountId: string
): INeonDiscordMessageEnvelope {
  const threadId = isThreadChannel(message.channel) ? message.channel.id : undefined;
  const parentChannelId = threadId && message.channel.parentId ? message.channel.parentId : undefined;
  const attachments = mapDiscordJsMessageAttachments(message.attachments);

  return {
    accountId,
    channelId: parentChannelId ?? message.channelId,
    messageId: message.id,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.username,
      bot: message.author.bot
    },
    content: message.content,
    ...(attachments.length > 0 ? { attachments } : {}),
    createdAt: new Date(message.createdTimestamp).toISOString(),
    mentionedUserIds: Array.from(message.mentions.users.keys()),
    ...(message.guildId ? { guildId: message.guildId } : {}),
    ...(threadId ? { threadId } : {})
  };
}

function mapDiscordJsMessageAttachments(
  attachments: IDiscordJsAttachmentCollectionLike | undefined
): readonly INeonGatewayInboundAttachment[] {
  if (!attachments) {
    return [];
  }

  return Array.from(attachments.values()).map((attachment) => {
    const contentType = attachment.contentType ?? undefined;
    const name = attachment.name ?? `discord-attachment-${attachment.id}`;
    const kind = resolveDiscordAttachmentKind(name, contentType);
    const voiceMessage = kind === "audio" && typeof attachment.waveform === "string" && attachment.waveform.length > 0;

    return {
      id: attachment.id,
      name,
      url: attachment.url,
      ...(contentType ? { contentType } : {}),
      ...(typeof attachment.size === "number" ? { sizeBytes: attachment.size } : {}),
      ...(typeof attachment.duration === "number" ? { durationSeconds: attachment.duration } : {}),
      kind,
      ...(voiceMessage ? { voiceMessage } : {})
    };
  });
}

function resolveDiscordAttachmentKind(
  name: string,
  contentType: string | undefined
): TNeonGatewayInboundAttachmentKind {
  if (contentType?.startsWith("audio/")) {
    return "audio";
  }
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (contentType?.startsWith("video/")) {
    return "video";
  }

  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"].includes(extension)) {
    return "audio";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(extension)) {
    return "image";
  }
  if (["mp4", "mov", "webm", "mkv"].includes(extension)) {
    return "video";
  }
  return "file";
}

// discord.js ApplicationCommandOptionType.Subcommand. Kept as a local literal so
// the mapping does not depend on a runtime enum import.
const DISCORD_SUBCOMMAND_OPTION_TYPE = 1;

export interface IDiscordJsCommandOptionLike {
  readonly name: string;
  readonly type: number;
  readonly value?: string | number | boolean;
  readonly options?: readonly IDiscordJsCommandOptionLike[];
}

export interface IDiscordJsInteractionLike {
  readonly id: string;
  readonly commandName: string;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly createdTimestamp: number;
  readonly user: { readonly id: string; readonly username: string };
  // `nick` is shared by both discord.js member shapes (GuildMember and the raw
  // APIInteractionGuildMember); `displayName` only exists on GuildMember. Reading
  // both keeps the structural type assignable from the discord.js union.
  readonly member?: { readonly displayName?: string; readonly nick?: string | null } | null;
  readonly options: { readonly data: readonly IDiscordJsCommandOptionLike[] };
}

function toNeonSlashOptions(
  data: readonly IDiscordJsCommandOptionLike[]
): INeonDiscordSlashOption[] {
  return data
    .filter((option): option is IDiscordJsCommandOptionLike & { value: TNeonDiscordSlashOptionValue } =>
      option.value !== undefined
    )
    .map((option) => ({ name: option.name, value: option.value }));
}

/**
 * Maps a discord.js chat-input interaction into the deterministic Neon slash
 * envelope. A single leading subcommand is lifted into `subcommandName` and its
 * nested options are used; otherwise the top-level options are taken. Pure.
 */
export function mapDiscordJsInteractionToSlashEnvelope(
  interaction: IDiscordJsInteractionLike,
  accountId: string
): INeonDiscordSlashInteractionEnvelope {
  const topLevel = interaction.options.data;
  const subcommand = topLevel.find((option) => option.type === DISCORD_SUBCOMMAND_OPTION_TYPE);
  const optionSource = subcommand?.options ?? topLevel;
  const options = toNeonSlashOptions(optionSource);
  const displayName =
    interaction.member?.displayName ?? interaction.member?.nick ?? interaction.user.username;

  return {
    accountId,
    channelId: interaction.channelId,
    interactionId: interaction.id,
    commandName: interaction.commandName,
    author: {
      id: interaction.user.id,
      username: interaction.user.username,
      displayName
    },
    createdAt: new Date(interaction.createdTimestamp).toISOString(),
    ...(subcommand ? { subcommandName: subcommand.name } : {}),
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    ...(options.length > 0 ? { options } : {})
  };
}

function resolveDiscordTapInboundDebounceMs<TMessage, TInteraction>(
  options: Pick<INeonDiscordShadowTapOptions<TMessage, TInteraction>, "inboundDebounce">
): number {
  const overrideMs = options.inboundDebounce?.debounceMs;
  return resolveNeonInboundDebounceMs({
    ...(overrideMs !== undefined ? { overrideMs } : {})
  });
}

function createDiscordTapInboundDebouncer<TMessage, TInteraction>(
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats,
  sessionQueue: INeonSessionActorQueue
): INeonInboundDebouncer<IDiscordTapInboundDebounceItem<TMessage>> | undefined {
  const debounceMs = resolveDiscordTapInboundDebounceMs(options);
  if (debounceMs <= 0) {
    return undefined;
  }

  const scheduler = options.inboundDebounce?.scheduler;

  return createNeonInboundDebouncer<IDiscordTapInboundDebounceItem<TMessage>>({
    ...(scheduler ? { scheduler } : {}),
    onFlush: async (items) => {
      const item = coalesceDiscordTapInboundDebounceItems(items);
      await processTapMessage(item.message, item.envelope, options, stats, sessionQueue);
    },
    onError: async (error) => {
      recordTapError(error, options, stats);
      await persistDiscordTapProbe(options, stats);
    }
  });
}

function createDiscordTapInboundDebounceKey(envelope: INeonDiscordMessageEnvelope): string {
  const conversationId = envelope.threadId ?? envelope.channelId;
  return `discord:${envelope.accountId}:${conversationId}:${envelope.author.id}`;
}

function shouldDebounceDiscordTapInbound(envelope: INeonDiscordMessageEnvelope): boolean {
  return shouldDebounceNeonTextInbound({
    text: envelope.content,
    isControlCommand: envelope.content.trimStart().startsWith("/"),
    hasMedia: (envelope.attachments?.length ?? 0) > 0
  });
}

function coalesceDiscordTapInboundDebounceItems<TMessage>(
  items: readonly IDiscordTapInboundDebounceItem<TMessage>[]
): IDiscordTapInboundDebounceItem<TMessage> {
  const first = items[0];
  if (!first) {
    throw new Error("Cannot flush an empty Discord inbound debounce batch");
  }
  if (items.length === 1) {
    return first;
  }

  const last = items[items.length - 1];
  if (!last) {
    return first;
  }

  const content = items
    .map((item) => item.envelope.content.trim())
    .filter((contentPart) => contentPart.length > 0)
    .join("\n");
  const mentionedUserIds = Array.from(
    new Set(
      items
        .flatMap((item) => item.envelope.mentionedUserIds ?? [])
        .filter((id): id is string => typeof id === "string")
    )
  );

  return {
    message: last.message,
    envelope: {
      accountId: last.envelope.accountId,
      channelId: last.envelope.channelId,
      messageId: last.envelope.messageId,
      author: last.envelope.author,
      content,
      createdAt: last.envelope.createdAt,
      mentionedUserIds,
      ...(last.envelope.guildId ? { guildId: last.envelope.guildId } : {}),
      ...(last.envelope.threadId ? { threadId: last.envelope.threadId } : {})
    }
  };
}

async function handleTapMessage<TMessage, TInteraction>(
  message: TMessage,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats,
  replayGuard: INeonDiscordInboundReplayGuard,
  sessionQueue: INeonSessionActorQueue,
  inboundDebouncer: INeonInboundDebouncer<IDiscordTapInboundDebounceItem<TMessage>> | undefined
): Promise<void> {
  try {
    const envelope = options.mapMessage(message);

    if (!envelope) {
      recordDrop("unmapped-message", options, stats);
      await persistDiscordTapProbe(options, stats);
      return;
    }

    // Drop a redelivered MessageCreate (gateway resume/reconnect) before it is
    // processed and persisted a second time.
    const replayKey = buildNeonInboundReplayKey({
      accountId: envelope.accountId,
      channelId: envelope.channelId,
      messageId: envelope.messageId
    });
    if ((await claimNeonInboundReplay(replayGuard, replayKey)) === "duplicate") {
      recordDrop("duplicate", options, stats);
      await persistDiscordTapProbe(options, stats);
      return;
    }

    if (inboundDebouncer) {
      const key = createDiscordTapInboundDebounceKey(envelope);
      await inboundDebouncer.enqueue({
        key,
        item: { message, envelope },
        delayMs: resolveDiscordTapInboundDebounceMs(options),
        shouldDebounce: shouldDebounceDiscordTapInbound(envelope)
      });
      return;
    }

    await processTapMessage(message, envelope, options, stats, sessionQueue);
  } catch (error) {
    recordTapError(error instanceof Error ? error : new Error("Unknown Discord tap error"), options, stats);
    await persistDiscordTapProbe(options, stats);
  }
}

async function processTapMessage<TMessage, TInteraction>(
  message: TMessage,
  envelope: INeonDiscordMessageEnvelope,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats,
  sessionQueue: INeonSessionActorQueue
): Promise<void> {
  let stopTypingPulse: (() => void) | undefined;
  let acceptedMessageForFailureReaction: INeonGatewayInboundMessage | undefined;

  try {
    const result = await runNeonDiscordShadowIngress(
      {
        message: envelope,
        policy: options.policy,
        ...(options.memory ? { memory: options.memory } : {}),
        ...(options.resolveMemory ? { resolveMemory: options.resolveMemory } : {})
      },
      {
        projectRoot: options.projectRoot,
        harness: options.harness,
        ...(options.resolveHarness ? { resolveHarness: options.resolveHarness } : {}),
        ...(options.resolveContext ? { resolveContext: options.resolveContext } : {}),
        ...(options.voiceTranscription ? { voiceTranscription: options.voiceTranscription } : {}),
        sessionQueue,
        ...(options.now ? { now: options.now } : {}),
        ...(options.writeRun ? { writeRun: options.writeRun } : {}),
        ...(options.writeRunningRun ? { writeRunningRun: options.writeRunningRun } : {}),
        ...(options.startTyping || options.addStatusReaction
          ? {
              onAcceptedMessage: async (acceptedMessage) => {
                acceptedMessageForFailureReaction = acceptedMessage;
                if (options.addStatusReaction) {
                  await emitDiscordTapStatusReaction(message, acceptedMessage, "queued", options, stats);
                  await persistDiscordTapProbe(options, stats);
                }
                if (options.startTyping) {
                  await startDiscordTapTyping(message, acceptedMessage, options, stats);
                  stopTypingPulse = startDiscordTapTypingPulse(message, acceptedMessage, options, stats);
                  await persistDiscordTapProbe(options, stats);
                }
              }
            }
          : {}),
        ...(options.resolveAbortSignal ? { resolveAbortSignal: options.resolveAbortSignal } : {})
      }
    );

    if (result.state === "dropped") {
      recordDrop(result.reason, options, stats);
      await persistDiscordTapProbe(options, stats);
      return;
    }

    stats.accepted += 1;
    stats.lastRunId = result.result.run.runId;
    stats.lastProbeAt = createTapTimestamp(options);
    const terminalReactionState = resolveDiscordTapTerminalReactionState(result.result.run.status);
    if (terminalReactionState && acceptedMessageForFailureReaction) {
      await emitDiscordTapStatusReaction(
        message,
        acceptedMessageForFailureReaction,
        terminalReactionState,
        options,
        stats
      );
    }
    const reply = await maybeDeliverCanaryReply(result.result.run, options, stats);
    if (reply?.outboundSent && reply.messageId && options.writeRun) {
      // The run was persisted as shadow/suppressed before the reply went out.
      // Now that a real message id came back, re-persist it (upsert by runId) so
      // the audit record stops claiming the delivery was suppressed.
      await options.writeRun(
        options.projectRoot,
        markNeonGatewayRunDelivered(result.result.run, {
          messageId: reply.messageId,
          ...(reply.reason ? { reason: reply.reason } : {})
        })
      );
    }
    await persistDiscordTapProbe(options, stats);
    options.onEvent?.({
      kind: "accepted",
      runId: result.result.run.runId
    });
    if (reply) {
      options.onEvent?.({
        kind: "reply",
        runId: reply.runId,
        state: reply.state,
        outboundSent: reply.outboundSent,
        ...(reply.messageId ? { messageId: reply.messageId } : {}),
        ...(reply.reason ? { reason: reply.reason } : {})
      });
    }
  } catch (error) {
    if (acceptedMessageForFailureReaction && options.addStatusReaction) {
      await emitDiscordTapStatusReaction(
        message,
        acceptedMessageForFailureReaction,
        "error",
        options,
        stats
      );
    }
    recordTapError(error instanceof Error ? error : new Error("Unknown Discord tap error"), options, stats);
    await persistDiscordTapProbe(options, stats);
  } finally {
    stopTypingPulse?.();
  }
}

async function maybeDeliverCanaryReply<TMessage, TInteraction>(
  run: INeonGatewayShadowRun,
  options: Pick<
    INeonDiscordShadowTapOptions<TMessage, TInteraction>,
    "canaryReplyMode" | "canaryReplySender" | "canaryVoiceReply"
  >,
  stats: IMutableDiscordShadowTapStats
): Promise<INeonCanaryReplyLoopResult | undefined> {
  if (!options.canaryReplySender) {
    return undefined;
  }

  const result = await deliverNeonCanaryReplyForRun({
    run,
    ...(options.canaryReplyMode ? { replyMode: options.canaryReplyMode } : {}),
    ...(options.canaryVoiceReply ? { voiceReply: options.canaryVoiceReply } : {}),
    sender: options.canaryReplySender
  });
  stats.lastReplyState = result.state;

  if (result.state === "delivered") {
    stats.repliesDelivered += 1;
    if (result.messageId) {
      stats.lastReplyMessageId = result.messageId;
    }
    return result;
  }

  if (result.state === "transport-error") {
    stats.replyErrors += 1;
    return result;
  }

  stats.repliesSuppressed += 1;
  return result;
}

async function emitDiscordTapStatusReaction<TMessage, TInteraction>(
  message: TMessage,
  envelope: INeonGatewayInboundMessage,
  state: TNeonDiscordTapReactionState,
  options: Pick<INeonDiscordShadowTapOptions<TMessage, TInteraction>, "now" | "onEvent" | "addStatusReaction">,
  stats: IMutableDiscordShadowTapStats
): Promise<void> {
  if (!options.addStatusReaction) {
    return;
  }

  const emoji = resolveNeonStatusReactionEmoji(state);

  try {
    await options.addStatusReaction(message, envelope, state, emoji);
    stats.reactionsSent += 1;
    stats.lastReactionState = state;
    stats.lastReactionOutcome = "sent";
    stats.lastProbeAt = createTapTimestamp(options);
    options.onEvent?.({ kind: "reaction", state, emoji, outcome: "sent" });
  } catch {
    stats.reactionErrors += 1;
    stats.lastReactionState = state;
    stats.lastReactionOutcome = "failed";
    stats.lastProbeAt = createTapTimestamp(options);
    options.onEvent?.({ kind: "reaction", state, emoji, outcome: "failed" });
  }
}

function resolveDiscordTapTerminalReactionState(
  status: INeonGatewayShadowRun["status"]
): TNeonDiscordTapReactionState | undefined {
  if (status === "completed") {
    return "done";
  }
  if (status === "failed") {
    return "error";
  }
  return undefined;
}

async function startDiscordTapTyping<TMessage, TInteraction>(
  message: TMessage,
  envelope: INeonGatewayInboundMessage,
  options: Pick<INeonDiscordShadowTapOptions<TMessage, TInteraction>, "now" | "onEvent" | "startTyping">,
  stats: IMutableDiscordShadowTapStats
): Promise<void> {
  if (!options.startTyping) {
    return;
  }

  try {
    await options.startTyping(message, envelope);
    stats.typingStarted += 1;
    stats.lastTypingState = "started";
    stats.lastProbeAt = createTapTimestamp(options);
    options.onEvent?.({ kind: "typing", state: "started" });
  } catch {
    stats.typingErrors += 1;
    stats.lastTypingState = "failed";
    stats.lastProbeAt = createTapTimestamp(options);
    options.onEvent?.({ kind: "typing", state: "failed" });
  }
}

function startDiscordTapTypingPulse<TMessage, TInteraction>(
  message: TMessage,
  envelope: INeonGatewayInboundMessage,
  options: Pick<
    INeonDiscordShadowTapOptions<TMessage, TInteraction>,
    "now" | "onEvent" | "startTyping" | "typingPulseMs"
  >,
  stats: IMutableDiscordShadowTapStats
): (() => void) | undefined {
  if (!options.startTyping) {
    return undefined;
  }

  const intervalMs = resolveTypingPulseMs(options.typingPulseMs);
  const handle = setInterval(() => {
    void startDiscordTapTyping(message, envelope, options, stats);
  }, intervalMs);

  return () => {
    clearInterval(handle);
  };
}

function resolveTypingPulseMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.max(1_000, Math.trunc(value));
  }

  return defaultTypingPulseMs;
}

async function handleTapInteraction<TMessage, TInteraction>(
  interaction: TInteraction,
  mapInteraction: INeonDiscordInteractionMapper<TInteraction>,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<void> {
  try {
    const envelope = mapInteraction(interaction);

    if (!envelope) {
      recordInteractionDrop("unmapped-interaction", options, stats);
      await persistDiscordTapProbe(options, stats);
      return;
    }

    const result = await runNeonDiscordSlashInteractionShadow(
      {
        interaction: envelope,
        policy: options.policy,
        ...(options.memory ? { memory: options.memory } : {}),
        ...(options.resolveMemory ? { resolveMemory: options.resolveMemory } : {})
      },
      {
        projectRoot: options.projectRoot,
        harness: options.harness,
        ...(options.now ? { now: options.now } : {})
      }
    );

    if (result.state === "dropped") {
      recordInteractionDrop(result.reason, options, stats);
      await persistDiscordTapProbe(options, stats);
      return;
    }

    stats.interactionsAccepted += 1;
    stats.lastInteractionRunId = result.result.run.runId;
    stats.lastProbeAt = createTapTimestamp(options);
    await persistDiscordTapProbe(options, stats);
    options.onEvent?.({
      kind: "interaction-accepted",
      runId: result.result.run.runId
    });
  } catch (error) {
    recordTapError(
      error instanceof Error ? error : new Error("Unknown Discord interaction tap error"),
      options,
      stats
    );
    await persistDiscordTapProbe(options, stats);
  }
}

function startDiscordTapProbeHeartbeat<TMessage, TInteraction>(
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): { stop(): void } {
  const intervalMs = options.probeHeartbeat?.intervalMs ?? defaultProbeHeartbeatMs;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { stop: () => undefined };
  }

  const scheduler = options.probeHeartbeat?.scheduler ?? defaultProbeHeartbeatScheduler;
  const handle = scheduler.schedule(async () => {
    if (!stats.running) {
      return;
    }

    stats.lastProbeAt = createTapTimestamp(options);
    await persistDiscordTapProbe(options, stats);
  }, intervalMs);

  return {
    stop: () => {
      scheduler.cancel(handle);
    }
  };
}

function recordDrop(
  reason: TNeonDiscordTapDropReason,
  options: Pick<INeonDiscordShadowTapOptions<unknown>, "now" | "onEvent">,
  stats: IMutableDiscordShadowTapStats
): void {
  stats.dropped += 1;
  stats.lastDropReason = reason;
  stats.lastProbeAt = createTapTimestamp(options);
  options.onEvent?.({
    kind: "dropped",
    reason
  });
}

function recordInteractionDrop(
  reason: TNeonSlashDispatchDropReason | "unmapped-interaction",
  options: Pick<INeonDiscordShadowTapOptions<unknown>, "now" | "onEvent">,
  stats: IMutableDiscordShadowTapStats
): void {
  stats.interactionsDropped += 1;
  stats.lastInteractionDropReason = reason;
  stats.lastProbeAt = createTapTimestamp(options);
  options.onEvent?.({
    kind: "interaction-dropped",
    reason
  });
}

function recordTapError(
  error: Error,
  options: Pick<INeonDiscordShadowTapOptions<unknown>, "now" | "onEvent">,
  stats: IMutableDiscordShadowTapStats
): void {
  stats.errors += 1;
  stats.lastErrorMessage = error.message;
  stats.lastProbeAt = createTapTimestamp(options);
  options.onEvent?.({
    kind: "error",
    message: error.message
  });
}

async function persistDiscordTapProbe<TMessage>(
  options: Pick<INeonDiscordShadowTapOptions<TMessage>, "accountId" | "now" | "projectRoot">,
  stats: INeonDiscordShadowTapStats
): Promise<void> {
  await writeNeonDiscordRouteProbe(
    options.projectRoot,
    createDiscordTapProbe(options.accountId ?? "default", stats)
  );
}

function createDiscordTapProbe(accountId: string, stats: INeonDiscordShadowTapStats): INeonDiscordRouteProbe {
  return {
    channel: "discord",
    accountId,
    state: stats.running ? "running" : "stopped",
    running: stats.running,
    startedAt: stats.startedAt,
    ...(stats.stoppedAt ? { stoppedAt: stats.stoppedAt } : {}),
    ...(stats.lastProbeAt ? { lastProbeAt: stats.lastProbeAt } : {}),
    stats: {
      accepted: stats.accepted,
      dropped: stats.dropped,
      errors: stats.errors,
      repliesDelivered: stats.repliesDelivered,
      repliesSuppressed: stats.repliesSuppressed,
      replyErrors: stats.replyErrors,
      typingStarted: stats.typingStarted,
      typingErrors: stats.typingErrors,
      reactionsSent: stats.reactionsSent,
      reactionErrors: stats.reactionErrors,
      ...(stats.lastRunId ? { lastRunId: stats.lastRunId } : {}),
      ...(stats.lastReplyState ? { lastReplyState: stats.lastReplyState } : {}),
      ...(stats.lastReplyMessageId ? { lastReplyMessageId: stats.lastReplyMessageId } : {}),
      ...(stats.lastTypingState ? { lastTypingState: stats.lastTypingState } : {}),
      ...(stats.lastReactionState ? { lastReactionState: stats.lastReactionState } : {}),
      ...(stats.lastReactionOutcome ? { lastReactionOutcome: stats.lastReactionOutcome } : {}),
      // The persistent route probe only models ingress drop reasons; a
      // replay-guard "duplicate" drop still increments `dropped` but is not
      // surfaced as the probe's lastDropReason.
      ...(stats.lastDropReason && stats.lastDropReason !== "duplicate"
        ? { lastDropReason: stats.lastDropReason }
        : {}),
      ...(stats.lastErrorMessage ? { lastErrorMessage: stats.lastErrorMessage } : {})
    }
  };
}

function createTapTimestamp<TMessage>(
  options: Pick<INeonDiscordShadowTapOptions<TMessage>, "now">
): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function isThreadChannel(channel: IDiscordJsChannelLike): boolean {
  return typeof channel.isThread === "function" && channel.isThread();
}

interface IDiscordTypingChannelLike {
  sendTyping(): Promise<void>;
}

function isDiscordTypingChannel(channel: unknown): channel is IDiscordTypingChannelLike {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "sendTyping" in channel &&
    typeof channel.sendTyping === "function"
  );
}
