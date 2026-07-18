import { Client, GatewayIntentBits } from "discord.js";

import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type { INeonReactionTransport } from "./reactionSender.js";

/**
 * Real Discord reaction transport for the gated canary reaction sender.
 *
 * Like discordOutboundTransport, this is a live-side-effect module constructed
 * ONLY behind the full canary gate (the sender stays no-send without it). It
 * implements INeonReactionTransport by fetching the target message and calling
 * discord.js `message.react(emoji)` with the already-normalized emoji handed in
 * by the sender.
 *
 * Leak-safety contract: the bot token is received once and handed straight to
 * `client.login`; it is never stored on the returned object, returned, logged,
 * or persisted. addReaction returns void — no message content crosses back. The
 * caller MUST `close()` to destroy the gateway connection.
 */
export interface INeonDiscordReactionTransport extends INeonReactionTransport {
  close(): Promise<void>;
}

export interface ICreateNeonDiscordReactionTransportOptions {
  readonly token: string;
  readonly intents?: readonly GatewayIntentBits[];
  /**
   * Injection seam for tests so the only live-side-effect path can be verified
   * without a real bot token. Defaults to a real discord.js Client.
   */
  readonly createClient?: (intents: readonly GatewayIntentBits[]) => Client;
}

function defaultCreateNeonDiscordReactionClient(intents: readonly GatewayIntentBits[]): Client {
  return new Client({ intents: [...intents] });
}

export function createNeonDiscordReactionTransport(
  options: ICreateNeonDiscordReactionTransportOptions
): INeonDiscordReactionTransport {
  const client = (options.createClient ?? defaultCreateNeonDiscordReactionClient)(
    options.intents ?? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions]
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
    async addReaction(
      target: INeonDeliveryQueueTarget,
      messageId: string,
      emoji: string
    ): Promise<void> {
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isTextBased()) {
        throw new Error(`Canary channel ${destinationId} is not a text channel with messages`);
      }

      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    },

    async close(): Promise<void> {
      if (loggedIn) {
        await client.destroy();
        loggedIn = false;
      }
    }
  };
}
