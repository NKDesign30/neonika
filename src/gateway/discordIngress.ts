import { deriveCodexSessionKey } from "../harness/sessionKey.js";
import type {
  ICodexHarness,
  IMemoryAttachment,
  TCodexHarnessEvent,
  THarnessRunMode
} from "../harness/types.js";
import {
  resolveNeonInboundAccessDecision,
  type TNeonInboundAccessBlockReason
} from "../channels/inboundAccessDecision.js";
import type { TNeonAccessGroup } from "../channels/inboundAccessGroups.js";
import type { TNeonDmPolicy } from "../channels/inboundDirectDmAccess.js";
import type { TNeonImplicitMentionKind } from "../channels/inboundMentionDecision.js";
import { redactText } from "../harness/redaction.js";
import { createSessionBindingFromGatewayMessage, runNeonGatewayShadow } from "./shadowGateway.js";
import {
  processNeonCronCommand,
  type INeonCronCommandResult
} from "../automation/cronCommandIngress.js";
import type { INeonCronStoreGate } from "../automation/cronStore.js";
import {
  captureNeonCommitmentsFromRun,
  type INeonCommitmentCaptureGate
} from "../commitments/commitmentCapture.js";
import {
  recordNeonDiscordWorkboardCard,
  type TNeonDiscordWorkboardIngestionResult
} from "../workboard/discordWorkboardProducer.js";
import {
  blockNeonWorkboardCard,
  claimNeonWorkboardCard,
  completeNeonWorkboardCard,
  type INeonWorkboardClaimResult
} from "../workboard/workboardStore.js";
import { syncNeonWorkboardCardTask } from "../workboard/workboardTaskSync.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import type {
  INeonGatewayInboundAttachment,
  INeonGatewayInboundMessage,
  INeonGatewayShadowResult,
  INeonGatewayShadowRun
} from "./types.js";
import { writeNeonGatewayRun } from "./runStore.js";
import type { INeonSessionActorQueue } from "./sessionActorQueue.js";
import {
  enrichNeonDiscordMessageWithVoiceTranscription,
  type INeonDiscordVoiceTranscriptionOptions
} from "./discordVoiceTranscription.js";

export type TDiscordMentionPolicy = "always" | "guild" | "never";
export type TNeonDiscordIngressDecisionState = "accepted" | "dropped";
export type TNeonDiscordDropReason =
  | "bot-author"
  | "ignored-user"
  | "ignored-mentioned-user"
  | "guild-not-allowed"
  | "channel-not-allowed"
  | "sender-not-allowed"
  | "dm-not-allowed"
  | "dm-pairing-required"
  | "command-not-authorized"
  | "mention-required"
  | "empty-content";

export interface INeonDiscordAuthor {
  readonly id: string;
  readonly username: string;
  readonly displayName?: string;
  readonly bot?: boolean;
}

export interface INeonDiscordMessageEnvelope {
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly author: INeonDiscordAuthor;
  readonly content: string;
  readonly attachments?: readonly INeonGatewayInboundAttachment[];
  readonly createdAt: string;
  readonly mentionedUserIds?: readonly string[];
}

export type TNeonDiscordSlashOptionValue = boolean | number | string;

const slashCommandPartMaxLength = 80;
const slashOptionValueMaxLength = 240;
const slashOptionsTextMaxLength = 1200;

export interface INeonDiscordSlashOption {
  readonly name: string;
  readonly value: TNeonDiscordSlashOptionValue;
}

export interface INeonDiscordSlashInteractionEnvelope {
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly interactionId: string;
  readonly commandName: string;
  readonly subcommandName?: string;
  readonly author: INeonDiscordAuthor;
  readonly options?: readonly INeonDiscordSlashOption[];
  readonly createdAt: string;
}

export interface INeonDiscordIngressPolicy {
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly mode: THarnessRunMode;
  readonly botUserId?: string;
  readonly mentionPolicy: TDiscordMentionPolicy;
  readonly allowedGuildIds?: readonly string[];
  readonly allowedChannelIds?: readonly string[];
  readonly ignoredUserIds?: readonly string[];
  readonly ignoredMentionedUserIds?: readonly string[];
  readonly ignoredMentionAliases?: readonly string[];
  readonly allowBotAuthors?: boolean;
  /**
   * Inbound access stack (all optional, opt-in). Omitting them keeps the legacy
   * behavior: anyone in an allowed guild/channel reaches the bot, DMs are open,
   * and only the plain mention gate applies. See `channels/inboundAccessDecision`.
   */
  readonly allowFrom?: readonly (string | number)[];
  readonly accessGroups?: Readonly<Record<string, TNeonAccessGroup>>;
  readonly dmPolicy?: TNeonDmPolicy;
  readonly useAccessGroups?: boolean;
  readonly allowTextCommands?: boolean;
  readonly allowedImplicitMentionKinds?: readonly TNeonImplicitMentionKind[];
  readonly agentMentionRoutes?: readonly INeonDiscordAgentMentionRoute[];
}

export interface INeonDiscordAgentMentionRoute {
  readonly agentId: string;
  readonly aliases?: readonly string[];
  readonly mentionedUserIds?: readonly string[];
}

export interface INeonDiscordIngressInput {
  readonly message: INeonDiscordMessageEnvelope;
  readonly policy: INeonDiscordIngressPolicy;
  readonly memory?: IMemoryAttachment;
  readonly resolveMemory?: TNeonDiscordMemoryResolver;
}

export type TNeonDiscordMemoryResolver = (
  message: INeonGatewayInboundMessage,
  envelope: INeonDiscordMessageEnvelope
) => IMemoryAttachment | Promise<IMemoryAttachment>;

export type TNeonDiscordIngressDecision =
  | {
      readonly state: "accepted";
      readonly message: INeonGatewayInboundMessage;
      readonly wasMentioned: boolean;
    }
  | {
      readonly state: "dropped";
      readonly reason: TNeonDiscordDropReason;
      readonly wasMentioned: boolean;
    };

export interface INeonDiscordShadowIngressOptions {
  readonly projectRoot: string;
  readonly harness: ICodexHarness;
  readonly resolveHarness?: (message: INeonGatewayInboundMessage) => ICodexHarness | undefined;
  readonly resolveContext?: (
    message: INeonGatewayInboundMessage,
    envelope: INeonDiscordMessageEnvelope
  ) =>
    | INeonGatewayInboundMessage["context"]
    | Promise<INeonGatewayInboundMessage["context"]>;
  readonly now?: () => Date;
  readonly sessionQueue?: INeonSessionActorQueue;
  readonly writeRun?: TNeonGatewayRunWriter;
  readonly writeRunningRun?: TNeonGatewayRunWriter;
  readonly onAcceptedMessage?: (message: INeonGatewayInboundMessage) => Promise<void> | void;
  readonly onHarnessEvent?: (event: TCodexHarnessEvent) => void;
  readonly voiceTranscription?: INeonDiscordVoiceTranscriptionOptions;
  readonly workboardIngestion?: false;
  // Force action-request workboard intent past the narrow verb-regex — for
  // callers that already have an explicit user confirmation (capacity-gate
  // button click) as a stronger work signal.
  readonly workboardAssumeActionRequest?: boolean;
  readonly cronCommand?:
    | false
    | {
        readonly gate?: INeonCronStoreGate;
        readonly env?: Readonly<Record<string, string | undefined>>;
      };
  readonly commitmentCapture?:
    | false
    | {
        readonly gate?: INeonCommitmentCaptureGate;
        readonly env?: Readonly<Record<string, string | undefined>>;
        readonly storePath?: string;
      };
  readonly resolveAbortSignal?: (
    runId: string,
    message: INeonGatewayInboundMessage
  ) => AbortSignal | undefined;
}

export type TNeonDiscordShadowIngressResult =
  | {
      readonly state: "accepted";
      readonly result: INeonGatewayShadowResult;
      readonly wasMentioned: boolean;
      readonly workboard: TNeonDiscordWorkboardIngestionResult;
    }
  | {
      readonly state: "dropped";
      readonly reason: TNeonDiscordDropReason;
      readonly wasMentioned: boolean;
    };

export type TNeonGatewayRunWriter = (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;

export function mapDiscordSlashInteractionToMessageEnvelope(
  interaction: INeonDiscordSlashInteractionEnvelope
): INeonDiscordMessageEnvelope | undefined {
  const commandName = normalizeSlashCommandPart(interaction.commandName);
  if (!commandName) {
    return undefined;
  }

  const subcommandName = normalizeSlashCommandPart(interaction.subcommandName);
  const optionText = formatSlashOptions(interaction.options ?? []);
  const content = [`/${commandName}${subcommandName ? ` ${subcommandName}` : ""}`, optionText]
    .filter((part) => part.length > 0)
    .join(" ");

  return {
    accountId: interaction.accountId,
    ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
    channelId: interaction.channelId,
    ...(interaction.threadId ? { threadId: interaction.threadId } : {}),
    messageId: `interaction:${interaction.interactionId}`,
    author: interaction.author,
    content,
    createdAt: interaction.createdAt,
    mentionedUserIds: []
  };
}

export async function runNeonDiscordShadowIngress(
  input: INeonDiscordIngressInput,
  options: INeonDiscordShadowIngressOptions
): Promise<TNeonDiscordShadowIngressResult> {
  const decision = createNeonDiscordIngressDecision(input.message, input.policy);

  if (decision.state === "dropped") {
    return decision;
  }

  const sessionKey = deriveCodexSessionKey(createSessionBindingFromGatewayMessage(decision.message));
  const runAcceptedMessage = async (): Promise<TNeonDiscordShadowIngressResult> => {
    await options.onAcceptedMessage?.(decision.message);
    const message = await enrichNeonDiscordMessageWithVoiceTranscription(
      decision.message,
      options.voiceTranscription
    );
    const cronCommand =
      options.cronCommand === false
        ? undefined
        : await processNeonCronCommand(options.projectRoot, message, {
            ...(options.now ? { now: options.now } : {}),
            ...(options.cronCommand?.gate ? { gate: options.cronCommand.gate } : {}),
            ...(options.cronCommand?.env ? { env: options.cronCommand.env } : {})
          });
    if (cronCommand && cronCommand.state !== "not-cron-command") {
      const run = buildDiscordCronCommandRun(message, cronCommand, sessionKey, options.now);
      const writeRun = options.writeRun ?? writeNeonGatewayRun;
      await writeRun(options.projectRoot, run);
      return {
        state: "accepted",
        result: {
          run,
          harness: {
            sessionKey,
            memoryState: "skipped",
            events: [{ kind: "final", text: cronCommand.report }],
            finalText: cronCommand.report
          }
        },
        wasMentioned: decision.wasMentioned,
        workboard: { state: "skipped", reason: "disabled" }
      };
    }
    const workboard = await recordNeonDiscordWorkboardCard(options.projectRoot, message, {
      enabled: options.workboardIngestion !== false,
      ...(options.now ? { now: options.now } : {}),
      ...(options.workboardAssumeActionRequest ? { assumeActionRequest: true } : {})
    });
    const workboardClaim = await claimDiscordWorkboardRunCard(
      options.projectRoot,
      workboard,
      message.agentId,
      options.now
    );
    const context = await resolveDiscordContext(options, input, message);
    const messageWithContext =
      context && context.length > 0
        ? {
            ...message,
            context
          }
        : message;
    const memory = await resolveDiscordMemory(input, messageWithContext);
    const harness = options.resolveHarness?.(messageWithContext) ?? options.harness;
    const writeRun = options.writeRun ?? writeNeonGatewayRun;
    const result = await runNeonGatewayShadow(
      {
        message: messageWithContext,
        memory
      },
      {
        harness,
        ...(options.now ? { now: options.now } : {}),
        ...(options.resolveAbortSignal ? { resolveAbortSignal: options.resolveAbortSignal } : {}),
        ...(options.onHarnessEvent ? { onHarnessEvent: options.onHarnessEvent } : {}),
        ...(options.writeRunningRun
          ? {
              onRunStarted: async (run) => {
                await options.writeRunningRun?.(options.projectRoot, run);
              }
            }
          : {})
      }
    );

    await writeRun(options.projectRoot, result.run);
    if (options.commitmentCapture !== false) {
      await captureNeonCommitmentsFromRun({
        projectRoot: options.projectRoot,
        run: result.run,
        message,
        ...(options.now ? { now: options.now } : {}),
        ...(options.commitmentCapture?.gate ? { gate: options.commitmentCapture.gate } : {}),
        ...(options.commitmentCapture?.env ? { env: options.commitmentCapture.env } : {}),
        ...(options.commitmentCapture?.storePath ? { storePath: options.commitmentCapture.storePath } : {})
      });
    }
    await finalizeDiscordWorkboardRunCard(options.projectRoot, workboardClaim, result.run, options.now);

    return {
      state: "accepted",
      result,
      wasMentioned: decision.wasMentioned,
      workboard
    };
  };

  return options.sessionQueue ? await options.sessionQueue.run(sessionKey, runAcceptedMessage) : await runAcceptedMessage();
}

async function claimDiscordWorkboardRunCard(
  projectRoot: string,
  workboard: TNeonDiscordWorkboardIngestionResult,
  agentId: string,
  now?: () => Date
): Promise<INeonWorkboardClaimResult | undefined> {
  if (workboard.state !== "created" && workboard.state !== "existing") {
    return undefined;
  }

  if (
    workboard.card.status !== "ready" &&
    workboard.card.status !== "todo" &&
    workboard.card.status !== "backlog"
  ) {
    return undefined;
  }

  try {
    return await claimNeonWorkboardCard(
      projectRoot,
      {
        id: workboard.card.id,
        ownerId: agentId,
        ttlSeconds: 30 * 60
      },
      resolveDiscordIngressNowMs(now)
    );
  } catch {
    return undefined;
  }
}

async function finalizeDiscordWorkboardRunCard(
  projectRoot: string,
  claim: INeonWorkboardClaimResult | undefined,
  run: INeonGatewayShadowRun,
  now?: () => Date
): Promise<void> {
  if (!claim) {
    return;
  }

  const proof = {
    status: run.status === "completed" ? "passed" : run.status === "cancelled" ? "skipped" : "failed",
    label: "discord-ingress-run",
    command: `harness:${run.harnessId}`,
    note: `run=${run.runId}`
  };

  try {
    if (run.status === "completed") {
      const nowMs = resolveDiscordIngressNowMs(now);
      await completeNeonWorkboardCard(
        projectRoot,
        {
          id: claim.card.id,
          token: claim.token,
          summary: run.finalText || `Discord ingress run ${run.runId} completed.`,
          proof
        },
        nowMs
      );
      await syncNeonWorkboardCardTask(projectRoot, {
        card: claim.card,
        status: "done",
        summary: run.finalText || `Discord ingress run ${run.runId} completed.`,
        runId: run.runId,
        nowMs
      });
      return;
    }

    const nowMs = resolveDiscordIngressNowMs(now);
    await blockNeonWorkboardCard(
      projectRoot,
      {
        id: claim.card.id,
        token: claim.token,
        reason: run.finalText || `Discord ingress run ${run.runId} ended ${run.status}.`
      },
      nowMs
    );
    await syncNeonWorkboardCardTask(projectRoot, {
      card: claim.card,
      status: run.status === "cancelled" ? "cancelled" : "blocked",
      summary: run.finalText || `Discord ingress run ${run.runId} ended ${run.status}.`,
      runId: run.runId,
      nowMs
    });
  } catch {
    return;
  }
}

function buildDiscordCronCommandRun(
  message: INeonGatewayInboundMessage,
  command: INeonCronCommandResult,
  sessionKey: string,
  now?: () => Date
): INeonGatewayShadowRun {
  const completedAt = (now?.() ?? new Date()).toISOString();
  const suffix = sanitizeDiscordCronRunIdPart(message.messageId ?? completedAt);
  const runId = `discord-cron-${suffix}`;
  return {
    runId,
    mode: "shadow",
    status: command.state === "rejected" || command.state === "blocked" ? "failed" : "completed",
    request: {
      channel: message.channel,
      accountId: message.accountId,
      channelId: message.channelId,
      ...(message.messageId ? { messageId: `cron:${message.messageId}` } : {}),
      userId: message.userId,
      agentId: message.agentId,
      workspaceRoot: message.workspaceRoot,
      mode: message.mode,
      goal: "cron command",
      contentPreview: redactCronContentPreview(message.content),
      receivedAt: message.createdAt ?? completedAt
    },
    harnessId: "codex-app-server",
    harnessSessionKey: sessionKey,
    memoryState: "skipped",
    events: [{ kind: "final", text: command.report }],
    finalText: command.report,
    delivery: {
      state: "suppressed",
      targetChannel: message.channel,
      targetChannelId: message.channelId,
      reason: "discord cron command - outbound gated",
      finalText: command.report
    },
    startedAt: completedAt,
    completedAt
  };
}

function redactCronContentPreview(content: string): string {
  return truncateUtf16Safe(redactText(content.replace(/\s+/g, " ").trim()), 240);
}

function sanitizeDiscordCronRunIdPart(value: string): string {
  return value.replace(/[^a-z0-9._:-]+/giu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "command";
}

function resolveDiscordIngressNowMs(now?: () => Date): number {
  return now ? now().getTime() : Date.now();
}

async function resolveDiscordMemory(
  input: INeonDiscordIngressInput,
  message: INeonGatewayInboundMessage
): Promise<IMemoryAttachment> {
  if (input.resolveMemory) {
    return await input.resolveMemory(message, input.message);
  }

  if (input.memory) {
    return input.memory;
  }

  throw new Error("Discord shadow ingress requires memory or resolveMemory");
}

async function resolveDiscordContext(
  options: INeonDiscordShadowIngressOptions,
  input: INeonDiscordIngressInput,
  message: INeonGatewayInboundMessage
): Promise<INeonGatewayInboundMessage["context"]> {
  return options.resolveContext ? await options.resolveContext(message, input.message) : undefined;
}

export function createNeonDiscordIngressDecision(
  envelope: INeonDiscordMessageEnvelope,
  policy: INeonDiscordIngressPolicy
): TNeonDiscordIngressDecision {
  const botWasMentioned = isBotMentioned(envelope, policy.botUserId);
  const normalizedBotContent = normalizeDiscordContent(envelope.content, policy.botUserId);
  const agentMention = resolveAgentMentionRoute(envelope, normalizedBotContent, policy.agentMentionRoutes);
  const wasMentioned = botWasMentioned || Boolean(agentMention);

  if (envelope.author.bot && policy.allowBotAuthors !== true) {
    return {
      state: "dropped",
      reason: "bot-author",
      wasMentioned
    };
  }

  if (policy.ignoredUserIds?.includes(envelope.author.id)) {
    return {
      state: "dropped",
      reason: "ignored-user",
      wasMentioned
    };
  }

  if (!wasMentioned && hasIgnoredMentionedUser(envelope, policy)) {
    return {
      state: "dropped",
      reason: "ignored-mentioned-user",
      wasMentioned
    };
  }

  if (!wasMentioned && hasIgnoredMentionAlias(normalizedBotContent, policy.ignoredMentionAliases)) {
    return {
      state: "dropped",
      reason: "ignored-mentioned-user",
      wasMentioned
    };
  }

  if (!isGuildAllowed(envelope.guildId, policy.allowedGuildIds)) {
    return {
      state: "dropped",
      reason: "guild-not-allowed",
      wasMentioned
    };
  }

  if (!isChannelAllowed(envelope, policy.allowedChannelIds)) {
    return {
      state: "dropped",
      reason: "channel-not-allowed",
      wasMentioned
    };
  }

  const content = agentMention?.content ?? normalizedBotContent;

  const access = resolveNeonInboundAccessDecision({
    channel: "discord",
    isGroup: Boolean(envelope.guildId),
    senderId: envelope.author.id,
    ...(policy.allowFrom ? { allowFrom: policy.allowFrom } : {}),
    ...(policy.accessGroups ? { accessGroups: policy.accessGroups } : {}),
    ...(policy.dmPolicy ? { dmPolicy: policy.dmPolicy } : {}),
    ...(policy.useAccessGroups !== undefined ? { useAccessGroups: policy.useAccessGroups } : {}),
    ...(policy.allowTextCommands !== undefined ? { allowTextCommands: policy.allowTextCommands } : {}),
    hasControlCommand: content.startsWith("/"),
    requireMention: requiresMention(envelope.guildId, policy.mentionPolicy),
    canDetectMention: true,
    wasMentioned,
    ...(policy.allowedImplicitMentionKinds
      ? { allowedImplicitMentionKinds: policy.allowedImplicitMentionKinds }
      : {})
  });

  if (access.outcome === "block") {
    return {
      state: "dropped",
      reason: mapAccessBlockReasonToDropReason(access.blockReason),
      wasMentioned
    };
  }

  if (content.length === 0 && (envelope.attachments?.length ?? 0) === 0) {
    return {
      state: "dropped",
      reason: "empty-content",
      wasMentioned
    };
  }

  return {
    state: "accepted",
    wasMentioned,
    message: {
      channel: "discord",
      accountId: envelope.accountId,
      channelId: envelope.channelId,
      messageId: envelope.messageId,
      userId: envelope.author.id,
      userDisplayName: envelope.author.displayName ?? envelope.author.username,
      agentId: agentMention?.agentId ?? policy.agentId,
      workspaceRoot: policy.workspaceRoot,
      mode: policy.mode,
      content,
      ...(envelope.attachments && envelope.attachments.length > 0 ? { attachments: envelope.attachments } : {}),
      createdAt: envelope.createdAt,
      ...(envelope.guildId ? { guildId: envelope.guildId } : {}),
      ...(envelope.threadId ? { threadId: envelope.threadId } : {})
    }
  };
}

export function normalizeDiscordContent(content: string, botUserId: string | undefined): string {
  const withoutBotMention = botUserId
    ? content
        .replace(new RegExp(`<@!?${escapeRegExp(botUserId)}>`, "g"), " ")
        .replace(new RegExp(`<@!?${escapeRegExp(botUserId)}\\s*>`, "g"), " ")
    : content;

  return withoutBotMention
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatSlashOptions(options: readonly INeonDiscordSlashOption[]): string {
  const optionText = options
    .map((option) => formatSlashOption(option))
    .filter((part) => part.length > 0)
    .join(" ");

  return truncateSlashText(optionText, slashOptionsTextMaxLength);
}

function formatSlashOption(option: INeonDiscordSlashOption): string {
  const name = normalizeSlashCommandPart(option.name);
  const value = formatSlashOptionValue(option.value);

  if (!name) {
    return "";
  }

  return value ? `${name}=${value}` : name;
}

function normalizeSlashCommandPart(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return truncateSlashText(value.replace(/^\/+/, "").trim().replace(/\s+/g, "-"), slashCommandPartMaxLength);
}

function formatSlashOptionValue(value: TNeonDiscordSlashOptionValue): string {
  const normalized = truncateSlashText(String(value).replace(/\s+/g, " ").trim(), slashOptionValueMaxLength);

  if (/\s/.test(normalized)) {
    return JSON.stringify(normalized);
  }

  return normalized;
}

function truncateSlashText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${truncateUtf16Safe(value, Math.max(0, maxLength - 3))}...`;
}

function isBotMentioned(envelope: INeonDiscordMessageEnvelope, botUserId: string | undefined): boolean {
  if (!botUserId) {
    return false;
  }

  return Boolean(
    envelope.mentionedUserIds?.includes(botUserId) ||
      new RegExp(`<@!?${escapeRegExp(botUserId)}>`).test(envelope.content)
  );
}

function hasIgnoredMentionedUser(
  envelope: INeonDiscordMessageEnvelope,
  policy: INeonDiscordIngressPolicy
): boolean {
  const ignoredMentionedUserIds = policy.ignoredMentionedUserIds;

  if (!ignoredMentionedUserIds || ignoredMentionedUserIds.length === 0) {
    return false;
  }

  const ignoredIds = new Set(ignoredMentionedUserIds);

  return (
    envelope.mentionedUserIds?.some((mentionedUserId) => {
      if (mentionedUserId === policy.botUserId) {
        return false;
      }

      return ignoredIds.has(mentionedUserId);
    }) ?? false
  );
}

function hasIgnoredMentionAlias(content: string, aliases: readonly string[] | undefined): boolean {
  if (!aliases || aliases.length === 0) {
    return false;
  }

  return Boolean(resolveAliasAgentRoute(content, { agentId: "ignored", aliases }));
}

function resolveAgentMentionRoute(
  envelope: INeonDiscordMessageEnvelope,
  content: string,
  routes: readonly INeonDiscordAgentMentionRoute[] | undefined
): { readonly agentId: string; readonly content: string } | undefined {
  if (!routes || routes.length === 0) {
    return undefined;
  }

  for (const route of routes) {
    const mentionedUserMatch = resolveMentionedUserAgentRoute(envelope, content, route);
    if (mentionedUserMatch) {
      return mentionedUserMatch;
    }

    const aliasMatch = resolveAliasAgentRoute(content, route);
    if (aliasMatch) {
      return aliasMatch;
    }
  }

  return undefined;
}

function resolveMentionedUserAgentRoute(
  envelope: INeonDiscordMessageEnvelope,
  content: string,
  route: INeonDiscordAgentMentionRoute
): { readonly agentId: string; readonly content: string } | undefined {
  const mentionedUserIds = route.mentionedUserIds ?? [];
  if (mentionedUserIds.length === 0) {
    return undefined;
  }

  const mentionedIds = new Set(envelope.mentionedUserIds ?? []);
  const mentionedUserId = mentionedUserIds.find((userId) => mentionedIds.has(userId));
  if (!mentionedUserId) {
    return undefined;
  }

  const strippedContent = content
    .replace(new RegExp(`^\\s*<@!?${escapeRegExp(mentionedUserId)}>[:,]?\\s*`, "u"), "")
    .trim();

  return { agentId: route.agentId, content: strippedContent };
}

function resolveAliasAgentRoute(
  content: string,
  route: INeonDiscordAgentMentionRoute
): { readonly agentId: string; readonly content: string } | undefined {
  for (const alias of route.aliases ?? []) {
    const normalizedAlias = alias.trim().replace(/^@/u, "");
    if (normalizedAlias.length === 0) {
      continue;
    }

    const pattern = new RegExp(`^\\s*@${escapeRegExp(normalizedAlias)}\\b[:,]?\\s*`, "iu");
    if (pattern.test(content)) {
      return {
        agentId: route.agentId,
        content: content.replace(pattern, "").trim()
      };
    }
  }

  return undefined;
}

function isGuildAllowed(
  guildId: string | undefined,
  allowedGuildIds: readonly string[] | undefined
): boolean {
  return !allowedGuildIds || allowedGuildIds.length === 0 || Boolean(guildId && allowedGuildIds.includes(guildId));
}

function isChannelAllowed(
  envelope: INeonDiscordMessageEnvelope,
  allowedChannelIds: readonly string[] | undefined
): boolean {
  if (!allowedChannelIds || allowedChannelIds.length === 0) {
    return true;
  }

  return allowedChannelIds.includes(envelope.channelId) || Boolean(envelope.threadId && allowedChannelIds.includes(envelope.threadId));
}

// The access-chain block reasons are a strict subset of the Discord drop
// reasons (1:1). The exhaustive switch keeps them in lockstep if either grows.
function mapAccessBlockReasonToDropReason(
  blockReason: TNeonInboundAccessBlockReason | undefined
): TNeonDiscordDropReason {
  switch (blockReason) {
    case "sender-not-allowed":
      return "sender-not-allowed";
    case "dm-not-allowed":
      return "dm-not-allowed";
    case "dm-pairing-required":
      return "dm-pairing-required";
    case "command-not-authorized":
      return "command-not-authorized";
    case "mention-required":
    case undefined:
      return "mention-required";
  }
}

function requiresMention(guildId: string | undefined, mentionPolicy: TDiscordMentionPolicy): boolean {
  if (mentionPolicy === "always") {
    return true;
  }

  if (mentionPolicy === "guild") {
    return Boolean(guildId);
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
