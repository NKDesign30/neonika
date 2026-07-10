import { Client, GatewayIntentBits } from "discord.js";

import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";

/**
 * Real Discord typing transport for the gated canary typing indicator.
 *
 * Live-side-effect module constructed ONLY behind the full canary gate; the
 * typing start guard (createNeonTypingStartGuard) stays sealed without it, so
 * the default path never types. `sendTyping` triggers discord.js
 * `channel.sendTyping()` (a ~10s typing indicator, no message, no content).
 *
 * Leak-safety: the bot token is handed straight to `client.login` and never
 * stored/returned/logged. sendTyping returns void. The caller MUST `close()`.
 */
export interface INeonDiscordTypingTransport {
  sendTyping(target: INeonDeliveryQueueTarget): Promise<void>;
  close(): Promise<void>;
}

export interface ICreateNeonDiscordTypingTransportOptions {
  readonly token: string;
  readonly intents?: readonly GatewayIntentBits[];
  /** Injection seam for tests so the live-side-effect path runs without a real token. */
  readonly createClient?: (intents: readonly GatewayIntentBits[]) => Client;
}

function defaultCreateNeonDiscordTypingClient(intents: readonly GatewayIntentBits[]): Client {
  return new Client({ intents: [...intents] });
}

export function createNeonDiscordTypingTransport(
  options: ICreateNeonDiscordTypingTransportOptions
): INeonDiscordTypingTransport {
  const client = (options.createClient ?? defaultCreateNeonDiscordTypingClient)(
    options.intents ?? [GatewayIntentBits.Guilds]
  );
  let loggedIn = false;

  const ensureLogin = async (): Promise<void> => {
    if (loggedIn) {
      return;
    }
    await client.login(options.token);
    loggedIn = true;
  };

  return {
    async sendTyping(target: INeonDeliveryQueueTarget): Promise<void> {
      await ensureLogin();

      const destinationId = target.threadId ?? target.channelId;
      const channel = await client.channels.fetch(destinationId);
      if (!channel) {
        throw new Error(`Canary channel ${destinationId} not found or not visible to the bot`);
      }
      if (!channel.isTextBased() || !("sendTyping" in channel)) {
        throw new Error(`Canary channel ${destinationId} is not a text channel that supports typing`);
      }

      await channel.sendTyping();
    },

    async close(): Promise<void> {
      if (loggedIn) {
        await client.destroy();
        loggedIn = false;
      }
    }
  };
}
