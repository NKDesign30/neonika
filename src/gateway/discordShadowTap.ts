/**
 * Adapted in part from OpenClaw src/channels/status-reactions.ts.
 * See THIRD_PARTY_NOTICES.md for attribution and license details.
 */
import {
  Client,
  ActionRowBuilder,
  ComponentType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction
} from "discord.js";

import { deriveCodexSessionKey } from "../harness/sessionKey.js";
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
import { createNeonDiscordIngressDecision, runNeonDiscordShadowIngress } from "./discordIngress.js";
import { createSessionBindingFromGatewayMessage, markNeonGatewayRunDelivered } from "./shadowGateway.js";
import {
  createNeonSessionActorQueue,
  isNeonSessionActorQueueCancellationError,
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
  planNeonStatusReactionEmit,
  resolveNeonStatusReactionEmoji,
  resolveNeonToolReactionState,
  type TNeonStatusReactionState
} from "../channels/statusReactions.js";
import type { TCodexHarnessEvent } from "../harness/types.js";
import type {
  INeonDiscordComponentActionRegistry,
  INeonDiscordComponentInteractionEvent,
  INeonDiscordModal,
  TNeonDiscordComponentActionRejectReason
} from "./discordComponentActionRegistry.js";
import {
  parseNeonDiscordRunControlCommand,
  type INeonDiscordRunControlRuntime,
  type TNeonDiscordRunControlState
} from "./discordRunControl.js";
import type {
  INeonDiscordProgressCardHandle,
  INeonDiscordProgressCardRuntime
} from "./discordProgressCard.js";
import { shouldStartNeonDiscordProgressCard } from "./discordProgressCard.js";
import type { INeonPdfReviewRuntime } from "./pdfReviewFlow.js";
import type { INeonDiscordThreadWorkspaceRuntime } from "./discordThreadWorkspace.js";
import {
  isNeonDiscordSessionRuntimePickerCommand,
  type INeonDiscordSessionRuntimePicker
} from "./discordSessionRuntimePicker.js";
import type { INeonDiscordRecoveryRuntime } from "./discordRecoveryFlow.js";
import type { INeonDiscordAgentButtonsRuntime } from "./discordAgentButtons.js";
import type { INeonDiscordPlanApprovalRuntime } from "./discordPlanApproval.js";
import {
  createNeonDiscordCapacityUpgradeDecision,
  createNeonDiscordCapacityFingerprint,
  neonDiscordCapacityRuntimes,
  parseNeonDiscordCapacityUpgradeRequest,
  resolveNeonDiscordCapacityDecision,
  type INeonDiscordCapacityGate
} from "./discordCapacityRouter.js";

// Tap-local drop reason: the inbound replay guard adds "duplicate" on top of the
// ingress drop reasons and the unmapped-message tap reason.
type TNeonDiscordTapDropReason = TNeonDiscordDropReason | "duplicate" | "unmapped-message";
type TNeonDiscordTapReactionState = TNeonStatusReactionState;
type TNeonDiscordTapReactionOutcome = "sent" | "failed";
type TNeonDiscordComponentInteractionDropReason =
  | TNeonDiscordComponentActionRejectReason
  | "handler-failed";

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
  listenComponentInteractions?(
    onInteraction: (interaction: INeonDiscordComponentInteractionEvent) => void | Promise<void>,
    onError: (error: Error) => void
  ): void;
  deferInteractionReply?(interaction: TInteraction): Promise<void>;
  editInteractionReply?(interaction: TInteraction, message: string): Promise<void>;
  fetchMessage?(
    input: { readonly channelId: string; readonly threadId?: string; readonly messageId: string }
  ): Promise<TMessage | undefined>;
  sendTyping?(message: TMessage): Promise<void>;
  addReaction?(message: TMessage, emoji: string): Promise<void>;
  removeReaction?(message: TMessage, emoji: string): Promise<void>;
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
  /** Optional server-side component registry. Omitted keeps component ingress disabled. */
  readonly componentActionRegistry?: INeonDiscordComponentActionRegistry;
  /** Optional fast-path control runtime. Exact stop commands bypass the normal session queue. */
  readonly runControl?: INeonDiscordRunControlRuntime;
  /** Optional one-message live progress surface. Omitted keeps progress cards disabled. */
  readonly progressCards?: INeonDiscordProgressCardRuntime;
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
  readonly pdfReview?: INeonPdfReviewRuntime;
  /** Optional agent quick-reply buttons; presents NEON_BUTTONS labels after a delivered reply. */
  readonly agentButtons?: INeonDiscordAgentButtonsRuntime;
  /** Explicit execution gate for clarified work plans emitted via NEON_PLAN_APPROVAL. */
  readonly planApproval?: INeonDiscordPlanApprovalRuntime;
  readonly threadWorkspaces?: INeonDiscordThreadWorkspaceRuntime<TMessage>;
  readonly runtimePicker?: INeonDiscordSessionRuntimePicker;
  /** Optional task-scoped Luna/Terra/Sol router. Heavy tasks pause behind an owner-bound card. */
  readonly capacityGate?: INeonDiscordCapacityGate;
  readonly recoveryCards?: INeonDiscordRecoveryRuntime;
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
  readonly removeStatusReaction?: (
    message: TMessage,
    envelope: INeonGatewayInboundMessage,
    emoji: string
  ) => Promise<void> | void;
  /**
   * History mode: worked-through status icons stay on the message as a visible
   * timeline (👀🧠💻✅) instead of being replaced. Removes are skipped entirely.
   */
  readonly statusReactionHistory?: boolean;
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
  readonly componentInteractionsAccepted: number;
  readonly componentInteractionsDropped: number;
  readonly controlsAccepted: number;
  readonly controlsDropped: number;
  readonly progressCardsStarted: number;
  readonly progressCardUpdates: number;
  readonly progressCardErrors: number;
  readonly runtimePickersOpened: number;
  readonly runtimePickerErrors: number;
  readonly capacityPromptsOpened: number;
  readonly capacityPromptErrors: number;
  readonly recoveryCardsStarted: number;
  readonly recoveryCardErrors: number;
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
  readonly lastComponentActionId?: string;
  readonly lastComponentActionType?: string;
  readonly lastControlState?: TNeonDiscordRunControlState;
  readonly lastControlAt?: string;
  readonly lastProgressCardMessageId?: string;
  readonly lastRuntimePickerMessageId?: string;
  readonly lastCapacityPromptMessageId?: string;
  readonly lastRecoveryCardMessageId?: string;
  readonly lastDropReason?: TNeonDiscordTapDropReason;
  readonly lastInteractionDropReason?: TNeonSlashDispatchDropReason | "unmapped-interaction";
  readonly lastComponentInteractionDropReason?: TNeonDiscordComponentInteractionDropReason;
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
      readonly kind: "component-interaction-accepted";
      readonly actionId: string;
      readonly actionType: string;
    }
  | {
      readonly kind: "component-interaction-dropped";
      readonly reason: TNeonDiscordComponentInteractionDropReason;
    }
  | {
      readonly kind: "control-accepted";
      readonly state: TNeonDiscordRunControlState;
      readonly activeRunsMatched: number;
      readonly pendingTasksCancelled: number;
      readonly acknowledgementSent: boolean;
    }
  | {
      readonly kind: "control-dropped";
      readonly reason: TNeonDiscordDropReason | "runtime-blocked";
    }
  | {
      readonly kind: "progress-card";
      readonly state: "started" | "finished" | "failed";
      readonly messageId?: string;
      readonly updates?: number;
    }
  | {
      readonly kind: "capacity-prompt";
      readonly state: "opened" | "failed";
      readonly messageId?: string;
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
  componentInteractionsAccepted: number;
  componentInteractionsDropped: number;
  controlsAccepted: number;
  controlsDropped: number;
  progressCardsStarted: number;
  progressCardUpdates: number;
  progressCardErrors: number;
  runtimePickersOpened: number;
  runtimePickerErrors: number;
  capacityPromptsOpened: number;
  capacityPromptErrors: number;
  recoveryCardsStarted: number;
  recoveryCardErrors: number;
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
  lastComponentActionId?: string;
  lastComponentActionType?: string;
  lastControlState?: TNeonDiscordRunControlState;
  lastControlAt?: string;
  lastProgressCardMessageId?: string;
  lastRuntimePickerMessageId?: string;
  lastCapacityPromptMessageId?: string;
  lastRecoveryCardMessageId?: string;
  lastDropReason?: TNeonDiscordTapDropReason;
  lastInteractionDropReason?: TNeonSlashDispatchDropReason | "unmapped-interaction";
  lastComponentInteractionDropReason?: TNeonDiscordComponentInteractionDropReason;
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
    componentInteractionsAccepted: 0,
    componentInteractionsDropped: 0,
    controlsAccepted: 0,
    controlsDropped: 0,
    progressCardsStarted: 0,
    progressCardUpdates: 0,
    progressCardErrors: 0,
    runtimePickersOpened: 0,
    runtimePickerErrors: 0,
    capacityPromptsOpened: 0,
    capacityPromptErrors: 0,
    recoveryCardsStarted: 0,
    recoveryCardErrors: 0,
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

  const componentActionRegistry = options.componentActionRegistry;
  if (options.adapter.listenComponentInteractions && componentActionRegistry) {
    options.adapter.listenComponentInteractions(
      async (interaction) => {
        await handleTapComponentInteraction(interaction, componentActionRegistry, options, stats);
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
        if (!interaction.isChatInputCommand()) {
          return;
        }
        void onInteraction(interaction);
      });
      client.on(Events.Error, onError);
    },
    listenComponentInteractions: (onInteraction, onError) => {
      client.on(Events.InteractionCreate, (interaction) => {
        if (
          !interaction.isButton() &&
          !interaction.isStringSelectMenu() &&
          !interaction.isModalSubmit()
        ) {
          return;
        }
        const event = mapDiscordJsComponentInteractionEvent(interaction);
        if (event) {
          void onInteraction(event);
        }
      });
      client.on(Events.Error, onError);
    },
    deferInteractionReply: async (interaction) => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    },
    editInteractionReply: async (interaction, message) => {
      await interaction.editReply({
        content: message,
        allowedMentions: { parse: [] }
      });
    },
    fetchMessage: async (input) => {
      try {
        const channel = await client.channels.fetch(input.threadId ?? input.channelId);
        if (!channel?.isTextBased()) {
          return undefined;
        }
        return await channel.messages.fetch(input.messageId);
      } catch {
        return undefined;
      }
    },
    sendTyping: async (message) => {
      if (isDiscordTypingChannel(message.channel)) {
        await message.channel.sendTyping();
      }
    },
    addReaction: async (message, emoji) => {
      await message.react(emoji);
    },
    removeReaction: async (message, emoji) => {
      const botUserId = message.client.user?.id;
      if (!botUserId) {
        return;
      }
      await message.reactions.resolve(emoji)?.users.remove(botUserId);
    },
    login: async (token) => {
      await client.login(token);
    },
    close: async () => {
      await client.destroy();
    }
  };
}

type TDiscordJsSupportedComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

function mapDiscordJsComponentInteractionEvent(
  interaction: TDiscordJsSupportedComponentInteraction
): INeonDiscordComponentInteractionEvent | undefined {
  if (!interaction.channelId) {
    return undefined;
  }

  const messageId = interaction.message?.id;
  const base = {
    interactionId: interaction.id,
    customId: interaction.customId,
    userId: interaction.user.id,
    userDisplayName: interaction.user.globalName ?? interaction.user.username,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    channelId: interaction.channelId,
    ...(messageId ? { messageId } : {}),
    createdAt: new Date(interaction.createdTimestamp).toISOString()
  };
  const normalizedInteraction = interaction.isButton()
    ? { ...base, kind: "button" as const }
    : interaction.isStringSelectMenu()
      ? { ...base, kind: "string-select" as const, values: [...interaction.values] }
      : {
          ...base,
          kind: "modal-submit" as const,
          fields: mapDiscordJsModalTextFields(interaction)
        };

  return {
    interaction: normalizedInteraction,
    deferEphemeral: async () => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    },
    editEphemeral: async (message) => {
      await interaction.editReply({
        content: message,
        allowedMentions: { parse: [] }
      });
    },
    postPublic: async (message) => {
      await interaction.followUp({
        content: message,
        allowedMentions: { parse: [] }
      });
    },
    ...(interaction.isButton() || interaction.isStringSelectMenu()
      ? {
          showModal: async (modal: INeonDiscordModal) => {
            await interaction.showModal(buildDiscordJsModal(modal));
          }
        }
      : {})
  };
}

function buildDiscordJsModal(modal: INeonDiscordModal): ModalBuilder {
  const builder = new ModalBuilder().setCustomId(modal.customId).setTitle(modal.title);
  const rows = modal.inputs.map((input) => {
    const textInput = new TextInputBuilder()
      .setCustomId(input.customId)
      .setLabel(input.label)
      .setStyle(input.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(input.required ?? true)
      .setMinLength(input.minLength ?? 0)
      .setMaxLength(input.maxLength ?? 4_000);
    if (input.placeholder) {
      textInput.setPlaceholder(input.placeholder);
    }
    return new ActionRowBuilder<TextInputBuilder>().addComponents(textInput);
  });
  return builder.addComponents(...rows);
}

function mapDiscordJsModalTextFields(
  interaction: ModalSubmitInteraction
): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const [customId, field] of interaction.fields.fields) {
    if (field.type === ComponentType.TextInput) {
      fields[customId] = field.value;
    }
  }
  return fields;
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

    if (await tryHandleTapRunControl(envelope, options, stats)) {
      return;
    }

    if (await tryHandleTapRuntimePicker(envelope, options, stats)) {
      return;
    }

    if (await tryHandleTapCapacityGate(envelope, options, stats)) {
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
  let progressCard: INeonDiscordProgressCardHandle | undefined;
  let progressCardStart: Promise<INeonDiscordProgressCardHandle | undefined> | undefined;

  // Live status-reaction driver rebuilt after OpenClaw's StatusReactionController
  // (openclaw src/channels/status-reactions.ts): the single bot reaction on the
  // trigger message follows the current work category (🧠💻🌐🏗️🛫💁), debounced
  // by the pure policy in channels/statusReactions.ts, replaced flicker-free.
  let intermediateReactionEmoji: string | undefined;
  let reactionFinished = false;
  let reactionLastEmitAt: number | null = null;
  let reactionChain: Promise<void> = Promise.resolve();

  const driveStatusReaction = (event: Parameters<INeonDiscordProgressCardHandle["observe"]>[0]): void => {
    const acceptedMessage = acceptedMessageForFailureReaction;
    if (!options.addStatusReaction || !acceptedMessage) {
      return;
    }
    const nextState = reactionStateFromHarnessEvent(event);
    if (!nextState) {
      return;
    }
    const nowMs = (options.now?.() ?? new Date()).getTime();
    const plan = planNeonStatusReactionEmit({
      nextState,
      currentEmoji: intermediateReactionEmoji ?? "",
      finished: reactionFinished,
      lastIntermediateEmitAt: reactionLastEmitAt,
      now: nowMs
    });
    if (plan.action !== "emit") {
      return;
    }
    reactionLastEmitAt = nowMs;
    const previous = intermediateReactionEmoji;
    intermediateReactionEmoji = plan.emoji;
    reactionChain = reactionChain.then(async () => {
      // Add-before-remove: the new emoji lands first, then the old one leaves,
      // so the message always shows exactly one status icon (no flicker gap).
      // In history mode nothing is removed — icons accumulate as a timeline.
      await emitDiscordTapStatusReaction(message, acceptedMessage, plan.state, options, stats);
      if (!options.statusReactionHistory && previous && previous !== plan.emoji) {
        try {
          await options.removeStatusReaction?.(message, acceptedMessage, previous);
        } catch {
          // fail-soft: a stuck old emoji must never break the run
        }
      }
    });
  };

  const finishStatusReaction = async (
    terminalState: Extract<TNeonDiscordTapReactionState, "done" | "error">,
    emitTerminal: boolean
  ): Promise<void> => {
    if (!options.addStatusReaction || !acceptedMessageForFailureReaction) {
      return;
    }
    reactionFinished = true;
    const previous = intermediateReactionEmoji;
    intermediateReactionEmoji = undefined;
    await reactionChain;
    // Add-before-remove here too: terminal ✅/❌ lands, then the work icon leaves.
    if (emitTerminal || previous) {
      await emitDiscordTapStatusReaction(
        message,
        acceptedMessageForFailureReaction,
        terminalState,
        options,
        stats
      );
    }
    if (!options.statusReactionHistory && previous) {
      try {
        await options.removeStatusReaction?.(message, acceptedMessageForFailureReaction, previous);
      } catch {
        // fail-soft
      }
    }
  };

  const observeProgressEvent = (event: Parameters<INeonDiscordProgressCardHandle["observe"]>[0]): void => {
    const acceptedMessage = acceptedMessageForFailureReaction;
    if (!options.progressCards || !acceptedMessage) {
      return;
    }
    // Start-worthy events open the card; once it exists, follow-up events
    // (assistant deltas, final) still flow to observe() for state updates.
    if (!progressCardStart && !shouldStartNeonDiscordProgressCard(event)) {
      return;
    }
    progressCardStart ??= (async () => {
      try {
        const sessionKey = deriveCodexSessionKey(createSessionBindingFromGatewayMessage(acceptedMessage));
        const handle = await options.progressCards?.start({
          target: {
            channel: "discord",
            accountId: acceptedMessage.accountId,
            channelId: acceptedMessage.channelId,
            ...(acceptedMessage.guildId ? { guildId: acceptedMessage.guildId } : {}),
            ...(acceptedMessage.threadId ? { threadId: acceptedMessage.threadId } : {}),
            ...(acceptedMessage.messageId ? { replyToMessageId: acceptedMessage.messageId } : {})
          },
          ownerUserId: acceptedMessage.userId,
          ...(acceptedMessage.guildId ? { guildId: acceptedMessage.guildId } : {}),
          channelId: acceptedMessage.threadId ?? acceptedMessage.channelId,
          sessionKey
        });
        if (!handle) {
          return undefined;
        }
        stopTypingPulse?.();
        stopTypingPulse = undefined;
        stats.progressCardsStarted += 1;
        stats.lastProgressCardMessageId = handle.messageId;
        options.onEvent?.({ kind: "progress-card", state: "started", messageId: handle.messageId });
        return handle;
      } catch {
        stats.progressCardErrors += 1;
        options.onEvent?.({ kind: "progress-card", state: "failed" });
        return undefined;
      }
    })();
    void progressCardStart.then((handle) => {
      handle?.observe(event);
    });
  };

  try {
    const routedEnvelope = options.threadWorkspaces
      ? await options.threadWorkspaces.route(message, envelope)
      : envelope;
    const result = await runNeonDiscordShadowIngress(
      {
        message: routedEnvelope,
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
        ...(options.startTyping || options.addStatusReaction || options.progressCards
          ? {
              onAcceptedMessage: async (acceptedMessage) => {
                acceptedMessageForFailureReaction = acceptedMessage;
                if (options.addStatusReaction) {
                  await emitDiscordTapStatusReaction(message, acceptedMessage, "queued", options, stats);
                  intermediateReactionEmoji = resolveNeonStatusReactionEmoji("queued");
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
        ...(options.progressCards || options.addStatusReaction
          ? {
              onHarnessEvent: (event: Parameters<INeonDiscordProgressCardHandle["observe"]>[0]) => {
                observeProgressEvent(event);
                driveStatusReaction(event);
              }
            }
          : {}),
        ...(options.resolveAbortSignal
          ? { resolveAbortSignal: options.resolveAbortSignal }
          : options.runControl
            ? {
                resolveAbortSignal: (runId, acceptedMessage) =>
                  options.runControl?.resolveAbortSignal(
                    runId,
                    deriveCodexSessionKey(createSessionBindingFromGatewayMessage(acceptedMessage)),
                    acceptedMessage.createdAt
                  )
              }
            : {})
      }
    );

    if (result.state === "dropped") {
      recordDrop(result.reason, options, stats);
      await persistDiscordTapProbe(options, stats);
      return;
    }

    if (
      await tryOpenSelfRequestedCapacityUpgrade(
        routedEnvelope,
        result.result.run,
        options,
        stats
      )
    ) {
      return;
    }

    stats.accepted += 1;
    stats.lastRunId = result.result.run.runId;
    stats.lastProbeAt = createTapTimestamp(options);
    await options.runtimePicker?.confirmRun(result.result.run);
    progressCard = await progressCardStart;
    if (progressCard) {
      const progressResult = await progressCard.finish(result.result.run.status);
      stats.progressCardUpdates += progressResult.updateCount;
      stats.progressCardErrors += progressResult.errorCount;
      stats.lastProgressCardMessageId = progressResult.messageId;
      options.onEvent?.({
        kind: "progress-card",
        state: progressResult.errorCount > 0 ? "failed" : "finished",
        messageId: progressResult.messageId,
        updates: progressResult.updateCount
      });
    }
    const terminalReactionState = resolveDiscordTapTerminalReactionState(result.result.run.status);
    if (terminalReactionState && acceptedMessageForFailureReaction) {
      // Without a progress card the terminal emoji is the only completion
      // signal; with one it still replaces a lingering intermediate emoji.
      await finishStatusReaction(terminalReactionState, !progressCard);
    }
    if (result.result.run.status === "failed" && options.recoveryCards) {
      try {
        const recovery = await options.recoveryCards.start(result.result.run);
        if (recovery.state === "recovery-pending") {
          stats.recoveryCardsStarted += 1;
          stats.lastRecoveryCardMessageId = recovery.messageId;
        } else if (recovery.state === "transport-error") {
          stats.recoveryCardErrors += 1;
        }
      } catch {
        stats.recoveryCardErrors += 1;
      }
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
    if (isNeonSessionActorQueueCancellationError(error)) {
      return;
    }
    progressCard = progressCard ?? await progressCardStart;
    if (progressCard) {
      const progressResult = await progressCard.finish("failed");
      stats.progressCardUpdates += progressResult.updateCount;
      stats.progressCardErrors += progressResult.errorCount;
      stats.lastProgressCardMessageId = progressResult.messageId;
    }
    if (acceptedMessageForFailureReaction && options.addStatusReaction) {
      await finishStatusReaction("error", true);
    }
    recordTapError(error instanceof Error ? error : new Error("Unknown Discord tap error"), options, stats);
    await persistDiscordTapProbe(options, stats);
  } finally {
    stopTypingPulse?.();
  }
}

async function tryOpenSelfRequestedCapacityUpgrade<TMessage, TInteraction>(
  envelope: INeonDiscordMessageEnvelope,
  run: INeonGatewayShadowRun,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<boolean> {
  const request = parseNeonDiscordCapacityUpgradeRequest(run.finalText);
  if (!request || !options.capacityGate) {
    return false;
  }
  const authorization = createNeonDiscordIngressDecision(envelope, options.policy);
  if (authorization.state !== "accepted") {
    throw new Error("Discord capacity upgrade source is no longer authorized");
  }
  const sessionKey = deriveCodexSessionKey(
    createSessionBindingFromGatewayMessage(authorization.message)
  );
  if (options.runtimePicker?.resolve(sessionKey, run.request.userId)) {
    return false;
  }
  const currentTier = resolveCapacityTierForModel(run.runtime?.model);
  const requestedTier = currentTier
    ? resolveStrongerCapacityTier(currentTier, request.tier)
    : undefined;
  if (!requestedTier) {
    throw new Error("Discord runtime requested a non-upgrading capacity tier");
  }
  const result = await options.capacityGate.request({
    target: {
      channel: "discord",
      accountId: run.request.accountId,
      ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
      channelId: run.request.channelId,
      ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
      ...(run.request.messageId ? { replyToMessageId: run.request.messageId } : {})
    },
    ownerUserId: run.request.userId,
    ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
    channelId: run.request.threadId ?? run.request.channelId,
    sessionKey,
    messageId: run.request.messageId ?? envelope.messageId,
    fingerprint: createNeonDiscordCapacityFingerprint(envelope),
    decision: createNeonDiscordCapacityUpgradeDecision({ ...request, tier: requestedTier })
  });
  stats.accepted += 1;
  stats.lastRunId = run.runId;
  stats.capacityPromptsOpened += 1;
  stats.lastCapacityPromptMessageId = result.messageId;
  stats.lastProbeAt = createTapTimestamp(options);
  options.onEvent?.({ kind: "capacity-prompt", state: "opened", messageId: result.messageId });
  await persistDiscordTapProbe(options, stats);
  return true;
}

function resolveCapacityTierForModel(model: string | undefined): "luna" | "terra" | "sol" | undefined {
  if (model === neonDiscordCapacityRuntimes.luna.model) {
    return "luna";
  }
  if (model === neonDiscordCapacityRuntimes.terra.model) {
    return "terra";
  }
  return model === neonDiscordCapacityRuntimes.sol.model ? "sol" : undefined;
}

function capacityTierRank(tier: "luna" | "terra" | "sol"): number {
  return tier === "luna" ? 1 : tier === "terra" ? 2 : 3;
}

function resolveStrongerCapacityTier(
  currentTier: "luna" | "terra" | "sol",
  requestedTier: "terra" | "sol"
): "terra" | "sol" | undefined {
  if (capacityTierRank(requestedTier) > capacityTierRank(currentTier)) {
    return requestedTier;
  }
  if (currentTier === "terra") {
    return "sol";
  }
  return currentTier === "luna" ? "terra" : undefined;
}

async function tryHandleTapRuntimePicker<TMessage, TInteraction>(
  envelope: INeonDiscordMessageEnvelope,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<boolean> {
  if (!options.runtimePicker || !isNeonDiscordSessionRuntimePickerCommand(envelope.content)) {
    return false;
  }

  const decision = createNeonDiscordIngressDecision(envelope, options.policy);
  if (decision.state === "dropped") {
    recordDrop(decision.reason, options, stats);
    await persistDiscordTapProbe(options, stats);
    return true;
  }

  try {
    const sessionKey = deriveCodexSessionKey(createSessionBindingFromGatewayMessage(decision.message));
    const result = await options.runtimePicker.open({
      target: {
        channel: "discord",
        accountId: decision.message.accountId,
        ...(decision.message.guildId ? { guildId: decision.message.guildId } : {}),
        channelId: decision.message.channelId,
        ...(decision.message.threadId ? { threadId: decision.message.threadId } : {}),
        ...(decision.message.messageId ? { replyToMessageId: decision.message.messageId } : {})
      },
      ownerUserId: decision.message.userId,
      ...(decision.message.guildId ? { guildId: decision.message.guildId } : {}),
      channelId: decision.message.threadId ?? decision.message.channelId,
      sessionKey
    });
    stats.runtimePickersOpened += 1;
    stats.lastRuntimePickerMessageId = result.messageId;
  } catch {
    stats.runtimePickerErrors += 1;
  }
  stats.lastProbeAt = createTapTimestamp(options);
  await persistDiscordTapProbe(options, stats);
  return true;
}

async function tryHandleTapCapacityGate<TMessage, TInteraction>(
  envelope: INeonDiscordMessageEnvelope,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<boolean> {
  if (!options.capacityGate) {
    return false;
  }
  const capacity = resolveNeonDiscordCapacityDecision(envelope);
  if (!capacity.requiresConfirmation) {
    return false;
  }
  const decision = createNeonDiscordIngressDecision(envelope, options.policy);
  if (decision.state === "dropped") {
    recordDrop(decision.reason, options, stats);
    await persistDiscordTapProbe(options, stats);
    return true;
  }
  const sessionKey = deriveCodexSessionKey(createSessionBindingFromGatewayMessage(decision.message));
  if (options.runtimePicker?.resolve(sessionKey, decision.message.userId)) {
    return false;
  }

  try {
    const result = await options.capacityGate.request({
      target: {
        channel: "discord",
        accountId: decision.message.accountId,
        ...(decision.message.guildId ? { guildId: decision.message.guildId } : {}),
        channelId: decision.message.channelId,
        ...(decision.message.threadId ? { threadId: decision.message.threadId } : {}),
        ...(decision.message.messageId ? { replyToMessageId: decision.message.messageId } : {})
      },
      ownerUserId: decision.message.userId,
      ...(decision.message.guildId ? { guildId: decision.message.guildId } : {}),
      channelId: decision.message.threadId ?? decision.message.channelId,
      sessionKey,
      messageId: decision.message.messageId ?? envelope.messageId,
      fingerprint: createNeonDiscordCapacityFingerprint(envelope),
      decision: capacity
    });
    stats.capacityPromptsOpened += 1;
    stats.lastCapacityPromptMessageId = result.messageId;
    options.onEvent?.({ kind: "capacity-prompt", state: "opened", messageId: result.messageId });
  } catch {
    stats.capacityPromptErrors += 1;
    options.onEvent?.({ kind: "capacity-prompt", state: "failed" });
  }
  stats.lastProbeAt = createTapTimestamp(options);
  await persistDiscordTapProbe(options, stats);
  return true;
}

async function tryHandleTapRunControl<TMessage, TInteraction>(
  envelope: INeonDiscordMessageEnvelope,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<boolean> {
  const command = parseNeonDiscordRunControlCommand(envelope.content);
  if (!command || !options.runControl) {
    return false;
  }

  const decision = createNeonDiscordIngressDecision(envelope, options.policy);
  if (decision.state === "dropped") {
    stats.controlsDropped += 1;
    recordDrop(decision.reason, options, stats);
    options.onEvent?.({ kind: "control-dropped", reason: decision.reason });
    await persistDiscordTapProbe(options, stats);
    return true;
  }

  const sessionKey = deriveCodexSessionKey(createSessionBindingFromGatewayMessage(decision.message));
  const result = await options.runControl.stopSession(sessionKey);
  let acknowledgementSent = false;
  if (options.canaryReplySender) {
    try {
      const acknowledgement = await options.canaryReplySender.sendText(
        {
          channel: "discord",
          accountId: decision.message.accountId,
          ...(decision.message.guildId ? { guildId: decision.message.guildId } : {}),
          channelId: decision.message.channelId,
          ...(decision.message.threadId ? { threadId: decision.message.threadId } : {}),
          ...(decision.message.messageId ? { replyToMessageId: decision.message.messageId } : {})
        },
        result.message
      );
      acknowledgementSent = acknowledgement.outboundSent;
    } catch {
      stats.replyErrors += 1;
    }
  }

  stats.lastControlState = result.state;
  stats.lastControlAt = result.controlledAt;
  stats.lastProbeAt = createTapTimestamp(options);
  if (result.state === "blocked") {
    stats.controlsDropped += 1;
    options.onEvent?.({ kind: "control-dropped", reason: "runtime-blocked" });
  } else {
    stats.controlsAccepted += 1;
    options.onEvent?.({
      kind: "control-accepted",
      state: result.state,
      activeRunsMatched: result.activeRunsMatched,
      pendingTasksCancelled: result.pendingTasksCancelled,
      acknowledgementSent
    });
  }
  await persistDiscordTapProbe(options, stats);
  return true;
}

async function maybeDeliverCanaryReply<TMessage, TInteraction>(
  run: INeonGatewayShadowRun,
  options: Pick<
    INeonDiscordShadowTapOptions<TMessage, TInteraction>,
    | "canaryReplyMode"
    | "canaryReplySender"
    | "canaryVoiceReply"
    | "pdfReview"
    | "projectRoot"
    | "agentButtons"
    | "planApproval"
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
    ...(options.pdfReview ? { pdfReview: options.pdfReview } : {}),
    projectRoot: options.projectRoot,
    sender: options.canaryReplySender
  });
  stats.lastReplyState = result.state;

  if (result.state === "delivered" || result.state === "review-pending") {
    stats.repliesDelivered += 1;
    if (result.messageId) {
      stats.lastReplyMessageId = result.messageId;
    }
    if (result.state === "delivered" && result.buttons && result.target && options.agentButtons) {
      // Fail-soft by contract: present() swallows transport errors internally.
      await options.agentButtons.present(run, result.target, result.buttons);
    }
    if (
      result.state === "delivered" &&
      result.planApproval &&
      result.target &&
      options.planApproval
    ) {
      await options.planApproval.present(run, result.target, result.planApproval.planText);
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

// Maps a harness event to the semantic status-reaction category. Hidden
// bookkeeping events and text deltas never move the reaction.
function reactionStateFromHarnessEvent(
  event: TCodexHarnessEvent
): TNeonStatusReactionState | undefined {
  switch (event.kind) {
    case "tool-start":
    case "tool-output":
      if (event.hideFromChannelProgress === true) {
        return undefined;
      }
      return resolveNeonToolReactionState(event.toolName);
    case "file-write":
    case "command-exit":
      return "coding";
    case "assistant-delta":
    case "token-usage":
    case "final":
    case "failed":
      return undefined;
  }
}

function resolveDiscordTapTerminalReactionState(
  status: INeonGatewayShadowRun["status"]
): Extract<TNeonDiscordTapReactionState, "done" | "error"> | undefined {
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
    await options.adapter.deferInteractionReply?.(interaction);
    const envelope = mapInteraction(interaction);

    if (!envelope) {
      recordInteractionDrop("unmapped-interaction", options, stats);
      await editTapInteractionReply(
        interaction,
        "Diese Interaktion ist ungültig.",
        options,
        stats
      );
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
      await editTapInteractionReply(
        interaction,
        "Diese Interaktion ist nicht autorisiert.",
        options,
        stats
      );
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
    await editTapInteractionReply(interaction, "✓ Auftrag verarbeitet.", options, stats);
  } catch (error) {
    recordTapError(
      error instanceof Error ? error : new Error("Unknown Discord interaction tap error"),
      options,
      stats
    );
    await persistDiscordTapProbe(options, stats);
  }
}

async function editTapInteractionReply<TMessage, TInteraction>(
  interaction: TInteraction,
  message: string,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<void> {
  if (!options.adapter.editInteractionReply) {
    return;
  }

  try {
    await options.adapter.editInteractionReply(interaction, message);
  } catch (error) {
    recordTapError(
      error instanceof Error ? error : new Error("Unknown Discord interaction reply error"),
      options,
      stats
    );
  }
}

async function handleTapComponentInteraction<TMessage, TInteraction>(
  event: INeonDiscordComponentInteractionEvent,
  registry: INeonDiscordComponentActionRegistry,
  options: INeonDiscordShadowTapOptions<TMessage, TInteraction>,
  stats: IMutableDiscordShadowTapStats
): Promise<void> {
  try {
    const responseMode = registry.resolveResponseMode(event.interaction.customId);
    if (responseMode !== "modal") {
      await event.deferEphemeral();
    }
    const result = await registry.dispatch(event.interaction);

    if (result.state === "completed") {
      stats.componentInteractionsAccepted += 1;
      stats.lastComponentActionId = result.actionId;
      stats.lastComponentActionType = result.actionType;
      stats.lastProbeAt = createTapTimestamp(options);
      options.onEvent?.({
        kind: "component-interaction-accepted",
        actionId: result.actionId,
        actionType: result.actionType
      });
    } else {
      recordComponentInteractionDrop(
        result.state === "rejected" ? result.reason : "handler-failed",
        options,
        stats
      );
    }

    await persistDiscordTapProbe(options, stats);
    if (responseMode === "modal" && result.state === "completed" && result.modal && event.showModal) {
      await event.showModal(result.modal);
      return;
    }
    if (responseMode === "modal") {
      await event.deferEphemeral();
    }
    try {
      await event.editEphemeral(result.message);
    } catch (error) {
      recordTapError(
        error instanceof Error ? error : new Error("Unknown Discord component reply error"),
        options,
        stats
      );
      await persistDiscordTapProbe(options, stats);
    }
    if (result.state === "completed" && result.publicMessage && event.postPublic) {
      try {
        await event.postPublic(result.publicMessage);
      } catch (error) {
        recordTapError(
          error instanceof Error ? error : new Error("Unknown Discord public component reply error"),
          options,
          stats
        );
        await persistDiscordTapProbe(options, stats);
      }
    }
  } catch (error) {
    recordTapError(
      error instanceof Error ? error : new Error("Unknown Discord component interaction error"),
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

function recordComponentInteractionDrop(
  reason: TNeonDiscordComponentInteractionDropReason,
  options: Pick<INeonDiscordShadowTapOptions<unknown>, "now" | "onEvent">,
  stats: IMutableDiscordShadowTapStats
): void {
  stats.componentInteractionsDropped += 1;
  stats.lastComponentInteractionDropReason = reason;
  stats.lastProbeAt = createTapTimestamp(options);
  options.onEvent?.({
    kind: "component-interaction-dropped",
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
  options: Pick<INeonDiscordShadowTapOptions<TMessage>, "accountId" | "now" | "policy" | "projectRoot">,
  stats: INeonDiscordShadowTapStats
): Promise<void> {
  await writeNeonDiscordRouteProbe(
    options.projectRoot,
    createDiscordTapProbe(options.accountId ?? "default", options.policy.allowedChannelIds, stats)
  );
}

function createDiscordTapProbe(
  accountId: string,
  allowedChannelIds: readonly string[] | undefined,
  stats: INeonDiscordShadowTapStats
): INeonDiscordRouteProbe {
  return {
    channel: "discord",
    accountId,
    ...(allowedChannelIds ? { allowedChannelIds: [...allowedChannelIds].sort() } : {}),
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
      controlsAccepted: stats.controlsAccepted,
      controlsDropped: stats.controlsDropped,
      progressCardsStarted: stats.progressCardsStarted,
      progressCardUpdates: stats.progressCardUpdates,
      progressCardErrors: stats.progressCardErrors,
      runtimePickersOpened: stats.runtimePickersOpened,
      runtimePickerErrors: stats.runtimePickerErrors,
      capacityPromptsOpened: stats.capacityPromptsOpened,
      capacityPromptErrors: stats.capacityPromptErrors,
      recoveryCardsStarted: stats.recoveryCardsStarted,
      recoveryCardErrors: stats.recoveryCardErrors,
      ...(stats.lastRunId ? { lastRunId: stats.lastRunId } : {}),
      ...(stats.lastReplyState ? { lastReplyState: stats.lastReplyState } : {}),
      ...(stats.lastReplyMessageId ? { lastReplyMessageId: stats.lastReplyMessageId } : {}),
      ...(stats.lastTypingState ? { lastTypingState: stats.lastTypingState } : {}),
      ...(stats.lastReactionState ? { lastReactionState: stats.lastReactionState } : {}),
      ...(stats.lastReactionOutcome ? { lastReactionOutcome: stats.lastReactionOutcome } : {}),
      ...(stats.lastControlState ? { lastControlState: stats.lastControlState } : {}),
      ...(stats.lastControlAt ? { lastControlAt: stats.lastControlAt } : {}),
      ...(stats.lastProgressCardMessageId
        ? { lastProgressCardMessageId: stats.lastProgressCardMessageId }
        : {}),
      ...(stats.lastRuntimePickerMessageId
        ? { lastRuntimePickerMessageId: stats.lastRuntimePickerMessageId }
        : {}),
      ...(stats.lastCapacityPromptMessageId
        ? { lastCapacityPromptMessageId: stats.lastCapacityPromptMessageId }
        : {}),
      ...(stats.lastRecoveryCardMessageId
        ? { lastRecoveryCardMessageId: stats.lastRecoveryCardMessageId }
        : {}),
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
