import { Client, GatewayIntentBits, type MessageCreateOptions } from "discord.js";

import { Buffer } from "node:buffer";

import { chunkNeonDiscordText } from "./discordChunk.js";
import {
  buildNeonDiscordComponentPayload,
  type TNeonDiscordActionRow
} from "./discordComponentPayload.js";
import {
  buildNeonDiscordMediaPayload,
  fetchNeonMediaBuffer,
  type IFetchNeonMediaBufferOptions,
  type TNeonDiscordMediaAttachment
} from "./discordMediaPayload.js";
import { buildNeonDiscordEmbedPayload, type INeonDiscordEmbed } from "./discordRichPayload.js";
import {
  buildNeonDiscordPollPayload,
  buildNeonDiscordStickerPayload,
  type INeonDiscordPoll
} from "./discordStickerPollPayload.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type { INeonOutboundTransport } from "./outboundSender.js";

/**
 * Real Discord outbound transport for the gated canary sender.
 *
 * This is the ONLY place in Neon Core that performs a live Discord side effect.
 * It is constructed exclusively by the canary live smoke, behind the full canary
 * gate (stage=canary + approved + outbound-enabled + allowlisted channel).
 *
 * Behaviour:
 * - Long bodies are split via `chunkNeonDiscordText` (2000 chars / 17 lines,
 *   code-fence aware) and sent sequentially, so a reply over the Discord limit
 *   does not fail hard. The returned `messageId` is the first chunk's id.
 * - `target.threadId`, when present, is the post destination (post into the
 *   thread, not the parent channel).
 * - `target.replyToMessageId`, when present, is attached to the first chunk only
 *   as a non-failing reply reference.
 *
 * Leak-safety contract:
 * - The bot token is received once and handed straight to `client.login`. It is
 *   never stored on the returned object, returned from any method, logged, or
 *   persisted. The smoke that owns the env never prints it either.
 * - `postMessage` only ever sends the already-redacted/bounded `body` produced by
 *   the canary sender, and returns only the Discord message id.
 * - The caller MUST `close()` to destroy the gateway connection.
 */
export interface INeonDiscordOutboundTransport extends INeonOutboundTransport {
  /**
   * Send a validated embed payload to the same gated canary destination as
   * postMessage. Embeds are validated up front (buildNeonDiscordEmbedPayload);
   * an invalid payload throws before any login/send so nothing leaves suppressed.
   */
  postEmbed(
    target: INeonDeliveryQueueTarget,
    embeds: readonly INeonDiscordEmbed[]
  ): Promise<{ readonly messageId: string }>;
  /**
   * Send interactive components (button/select action rows) alongside a text
   * body to the same gated canary destination. Components are validated up front
   * (buildNeonDiscordComponentPayload); an invalid payload throws before any
   * login/send so nothing leaves suppressed. `content` is required because a
   * classic (V1) component message with no text/embed is rejected by Discord.
   */
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }>;
  /**
   * Upload media attachments (inline bytes and/or SSRF-guarded url-sourced bytes)
   * with an optional text body to the gated canary destination. Attachments are
   * validated up front (buildNeonDiscordMediaPayload); an invalid set throws
   * before any login/fetch/send. url attachments are fetched by Neon (NOT
   * discord.js) via fetchNeonMediaBuffer so a private/rebinding host can never
   * become an SSRF egress. `content` is optional — Discord allows a files-only
   * message.
   */
  postMedia(
    target: INeonDeliveryQueueTarget,
    content: string | undefined,
    attachments: readonly TNeonDiscordMediaAttachment[],
    options?: IFetchNeonMediaBufferOptions
  ): Promise<{ readonly messageId: string }>;
  /**
   * Send up to 3 stickers with a text body. Validated up front; `content` is
   * required because a sticker message still needs a body to be accepted.
   */
  postStickers(
    target: INeonDeliveryQueueTarget,
    content: string,
    stickerIds: readonly string[]
  ): Promise<{ readonly messageId: string }>;
  /** Send a poll (question/answers/duration). Validated up front. */
  postPoll(
    target: INeonDeliveryQueueTarget,
    poll: INeonDiscordPoll
  ): Promise<{ readonly messageId: string }>;
  close(): Promise<void>;
}

export interface ICreateNeonDiscordOutboundTransportOptions {
  readonly token: string;
  readonly intents?: readonly GatewayIntentBits[];
  readonly suppressEmbeds?: boolean;
  /**
   * Injection seam for tests so the only live-side-effect module can be verified
   * without a real bot token. Defaults to a real discord.js Client; production
   * never passes this.
   */
  readonly createClient?: (intents: readonly GatewayIntentBits[]) => Client;
}

function defaultCreateNeonDiscordClient(intents: readonly GatewayIntentBits[]): Client {
  return new Client({ intents: [...intents] });
}

export function createNeonDiscordOutboundTransport(
  options: ICreateNeonDiscordOutboundTransportOptions
): INeonDiscordOutboundTransport {
  const client = (options.createClient ?? defaultCreateNeonDiscordClient)(
    options.intents ?? [GatewayIntentBits.Guilds]
  );
  let loggedIn = false;

  const ensureLogin = async (): Promise<void> => {
    if (loggedIn) {
      return;
    }
    // The token leaves the env only here; discord.js holds it internally.
    await client.login(options.token);
    loggedIn = true;
  };

  return {
    async postMessage(
      target: INeonDeliveryQueueTarget,
      body: string
    ): Promise<{ readonly messageId: string }> {
      await ensureLogin();

      // Thread targeting: when the candidate carries a threadId, post into that
      // thread channel directly; otherwise into the parent channel.
      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isSendable()) {
        throw new Error(`Canary channel ${destinationId} is not a sendable text channel`);
      }

      // Split before sending so a reply over 2000 chars / 17 lines does not fail
      // hard at the Discord limit. The body is already redacted/bounded.
      const chunks = chunkNeonDiscordText(body);
      if (chunks.length === 0) {
        throw new Error("Canary outbound body is empty; refusing to send an empty Discord message");
      }

      let firstMessageId = "";
      let index = 0;
      for (const content of chunks) {
        // Anchor the reply reference on the first chunk only; follow-up chunks
        // are plain sends so the threaded reply is established exactly once.
        const replyToId = index === 0 ? target.replyToMessageId : undefined;
        const sendOptions: MessageCreateOptions = {
          content,
          ...(options.suppressEmbeds ? { flags: ["SuppressEmbeds"] } : {}),
          ...(replyToId ? { reply: { messageReference: replyToId, failIfNotExists: false } } : {})
        };
        const sent = await channel.send(options.suppressEmbeds || replyToId ? sendOptions : content);
        if (index === 0) {
          firstMessageId = sent.id;
        }
        index += 1;
      }

      return { messageId: firstMessageId };
    },

    async postEmbed(
      target: INeonDeliveryQueueTarget,
      embeds: readonly INeonDiscordEmbed[]
    ): Promise<{ readonly messageId: string }> {
      // Validate before any side effect: an invalid embed never logs in or sends.
      const payload = buildNeonDiscordEmbedPayload(embeds);
      if (!payload.ok) {
        throw new Error(`Refusing to send invalid embed payload: ${payload.errors.join("; ")}`);
      }
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isSendable()) {
        throw new Error(`Canary channel ${destinationId} is not a sendable text channel`);
      }

      const sent = target.replyToMessageId
        ? await channel.send({
            embeds: [...payload.embeds],
            reply: { messageReference: target.replyToMessageId, failIfNotExists: false }
          })
        : await channel.send({ embeds: [...payload.embeds] });
      return { messageId: sent.id };
    },

    async postComponents(
      target: INeonDeliveryQueueTarget,
      content: string,
      rows: readonly TNeonDiscordActionRow[]
    ): Promise<{ readonly messageId: string }> {
      // Validate before any side effect: an invalid component set never logs in
      // or sends. A V1 component message also needs body text, so reject empty.
      if (content.trim().length === 0) {
        throw new Error("Refusing to send components without body text (Discord rejects an empty message)");
      }
      const payload = buildNeonDiscordComponentPayload(rows);
      if (!payload.ok) {
        throw new Error(`Refusing to send invalid component payload: ${payload.errors.join("; ")}`);
      }
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isSendable()) {
        throw new Error(`Canary channel ${destinationId} is not a sendable text channel`);
      }

      const sent = target.replyToMessageId
        ? await channel.send({
            content,
            components: [...payload.components],
            reply: { messageReference: target.replyToMessageId, failIfNotExists: false }
          })
        : await channel.send({ content, components: [...payload.components] });
      return { messageId: sent.id };
    },

    async postMedia(
      target: INeonDeliveryQueueTarget,
      content: string | undefined,
      attachments: readonly TNeonDiscordMediaAttachment[],
      options?: IFetchNeonMediaBufferOptions
    ): Promise<{ readonly messageId: string }> {
      // Validate (and SSRF-classify url sources) before any side effect.
      const payload = buildNeonDiscordMediaPayload(
        attachments,
        options?.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}
      );
      if (!payload.ok) {
        throw new Error(`Refusing to send invalid media payload: ${payload.errors.join("; ")}`);
      }
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isSendable()) {
        throw new Error(`Canary channel ${destinationId} is not a sendable text channel`);
      }

      // url sources are fetched HERE (not by discord.js) with the SSRF guard
      // re-applied to resolved IPs, so discord.js only ever receives raw bytes.
      const files: { readonly attachment: Buffer; readonly name: string }[] = [];
      for (const attachment of payload.attachments) {
        const data =
          attachment.kind === "inline"
            ? attachment.data
            : await fetchNeonMediaBuffer(attachment.url, attachment.host, options);
        files.push({ attachment: Buffer.from(data), name: attachment.name });
      }

      const replyText = content !== undefined && content.length > 0 ? content : undefined;
      const sent = await channel.send({
        files,
        ...(replyText !== undefined ? { content: replyText } : {}),
        ...(target.replyToMessageId
          ? { reply: { messageReference: target.replyToMessageId, failIfNotExists: false } }
          : {})
      });
      return { messageId: sent.id };
    },

    async postStickers(
      target: INeonDeliveryQueueTarget,
      content: string,
      stickerIds: readonly string[]
    ): Promise<{ readonly messageId: string }> {
      if (content.trim().length === 0) {
        throw new Error("Refusing to send stickers without body text (Discord rejects an empty message)");
      }
      const built = buildNeonDiscordStickerPayload(stickerIds);
      if (!built.ok) {
        throw new Error(`Refusing to send invalid sticker payload: ${built.errors.join("; ")}`);
      }
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isSendable()) {
        throw new Error(`Canary channel ${destinationId} is not a sendable text channel`);
      }

      const sent = await channel.send({ content, stickers: [...built.stickerIds] });
      return { messageId: sent.id };
    },

    async postPoll(
      target: INeonDeliveryQueueTarget,
      poll: INeonDiscordPoll
    ): Promise<{ readonly messageId: string }> {
      const built = buildNeonDiscordPollPayload(poll);
      if (!built.ok) {
        throw new Error(`Refusing to send invalid poll payload: ${built.errors.join("; ")}`);
      }
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isSendable()) {
        throw new Error(`Canary channel ${destinationId} is not a sendable text channel`);
      }

      const sent = await channel.send({ poll: built.poll });
      return { messageId: sent.id };
    },

    async close(): Promise<void> {
      if (loggedIn) {
        await client.destroy();
        loggedIn = false;
      }
    }
  };
}
