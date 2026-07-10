import { Client, Events, GatewayIntentBits } from "discord.js";

import { buildNeonDiscordPresencePayload, type INeonDiscordPresence } from "./discordPresencePayload.js";

/**
 * Real Discord presence transport for the gated canary presence update.
 *
 * Like the other live transports, this is a side-effect module constructed ONLY
 * behind the full canary gate. Presence is client-global (the bot status applies
 * everywhere), so it sets `client.user.setPresence(...)` after the client reaches
 * the ready state — there is no channel target.
 *
 * Leak-safety contract: the bot token is received once and handed straight to
 * `client.login`; it is never stored on the returned object, returned, logged, or
 * persisted. setPresence returns void. The presence payload is validated BEFORE
 * login, so an invalid update never logs in. The caller MUST `close()`.
 */
export interface INeonDiscordPresenceTransport {
  setPresence(presence: INeonDiscordPresence): Promise<void>;
  close(): Promise<void>;
}

export interface ICreateNeonDiscordPresenceTransportOptions {
  readonly token: string;
  readonly intents?: readonly GatewayIntentBits[];
  /** Injection seam for tests so the live-side-effect path runs without a real token. */
  readonly createClient?: (intents: readonly GatewayIntentBits[]) => Client;
}

function defaultCreateNeonDiscordPresenceClient(intents: readonly GatewayIntentBits[]): Client {
  return new Client({ intents: [...intents] });
}

export function createNeonDiscordPresenceTransport(
  options: ICreateNeonDiscordPresenceTransportOptions
): INeonDiscordPresenceTransport {
  const client = (options.createClient ?? defaultCreateNeonDiscordPresenceClient)(
    options.intents ?? [GatewayIntentBits.Guilds]
  );
  let loggedIn = false;

  const ensureReady = async (): Promise<void> => {
    if (!loggedIn) {
      await client.login(options.token);
      loggedIn = true;
    }
    // setPresence needs the client user, which only exists after the ready state.
    if (!client.isReady()) {
      await new Promise<void>((resolve) => {
        client.once(Events.ClientReady, () => resolve());
      });
    }
  };

  return {
    async setPresence(presence: INeonDiscordPresence): Promise<void> {
      // Validate before any side effect: an invalid presence never logs in.
      const payload = buildNeonDiscordPresencePayload(presence);
      if (!payload.ok) {
        throw new Error(`Refusing to set invalid presence: ${payload.errors.join("; ")}`);
      }
      await ensureReady();
      if (!client.user) {
        throw new Error("Discord client has no user after ready; cannot set presence");
      }
      client.user.setPresence(payload.presence);
    },

    async close(): Promise<void> {
      if (loggedIn) {
        await client.destroy();
        loggedIn = false;
      }
    }
  };
}
