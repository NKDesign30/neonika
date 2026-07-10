import { Client, Events, GatewayIntentBits } from "discord.js";

import {
  buildNeonSlashCommandPayload,
  type INeonSlashCommand
} from "./discordSlashCommandPayload.js";

/**
 * Real Discord slash-command deploy transport for the gated canary registration.
 *
 * Like the other live transports, this is a side-effect module constructed ONLY
 * behind the full canary gate. It performs a GUILD-scoped bulk overwrite
 * (`client.application.commands.set(commands, guildId)` = the REST PUT of guild
 * application commands). It deliberately exposes NO global-deploy path: the
 * registration plan (resolveNeonSlashCommandRegistrationPlan) blocks global, and
 * this transport can only ever target a guild, so a global push is unreachable
 * here by construction.
 *
 * Leak-safety: the bot token is handed straight to `client.login`; never stored,
 * returned, or logged. The command set is validated BEFORE login, so an invalid
 * payload never logs in. The caller MUST `close()`.
 */
export interface INeonDiscordSlashDeployTransport {
  deployGuildCommands(
    guildId: string,
    commands: readonly INeonSlashCommand[]
  ): Promise<{ readonly deployedCount: number }>;
  close(): Promise<void>;
}

export interface ICreateNeonDiscordSlashDeployTransportOptions {
  readonly token: string;
  readonly intents?: readonly GatewayIntentBits[];
  /** Injection seam for tests so the live-side-effect path runs without a real token. */
  readonly createClient?: (intents: readonly GatewayIntentBits[]) => Client;
}

function defaultCreateNeonDiscordSlashDeployClient(intents: readonly GatewayIntentBits[]): Client {
  return new Client({ intents: [...intents] });
}

export function createNeonDiscordSlashDeployTransport(
  options: ICreateNeonDiscordSlashDeployTransportOptions
): INeonDiscordSlashDeployTransport {
  const client = (options.createClient ?? defaultCreateNeonDiscordSlashDeployClient)(
    options.intents ?? [GatewayIntentBits.Guilds]
  );
  let loggedIn = false;

  const ensureReady = async (): Promise<void> => {
    if (!loggedIn) {
      await client.login(options.token);
      loggedIn = true;
    }
    // The application command manager needs the ready client application.
    if (!client.isReady()) {
      await new Promise<void>((resolve) => {
        client.once(Events.ClientReady, () => resolve());
      });
    }
  };

  return {
    async deployGuildCommands(
      guildId: string,
      commands: readonly INeonSlashCommand[]
    ): Promise<{ readonly deployedCount: number }> {
      const targetGuildId = guildId.trim();
      if (targetGuildId.length === 0) {
        throw new Error("Refusing to deploy slash commands without a guild id (global deploy is not allowed)");
      }
      // Validate before any side effect: an invalid command set never logs in.
      const payload = buildNeonSlashCommandPayload(commands);
      if (!payload.ok) {
        throw new Error(`Refusing to deploy invalid slash commands: ${payload.errors.join("; ")}`);
      }
      await ensureReady();
      if (!client.application) {
        throw new Error("Discord client has no application after ready; cannot deploy commands");
      }

      await client.application.commands.set([...payload.commands], targetGuildId);
      return { deployedCount: payload.commands.length };
    },

    async close(): Promise<void> {
      if (loggedIn) {
        await client.destroy();
        loggedIn = false;
      }
    }
  };
}
