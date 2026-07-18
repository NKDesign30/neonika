import { WebhookClient, type APIEmbed } from "discord.js";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { buildNeonDiscordEmbedPayload } from "./discordRichPayload.js";
import { buildNeonWebhookPayload, type INeonWebhookPayload } from "./discordWebhookPayload.js";

/**
 * Gated Discord webhook transport (proxy-identity outbound) plus its OWN live
 * preconditions. Webhook send is a stronger trust vector than a normal bot send:
 * the webhook URL carries a token secret and lets the bot post under an arbitrary
 * username/avatar. So it has a dedicated identity gate ON TOP of the canary
 * stack: a real send needs the webhook url present, an explicit webhook-enable
 * flag, AND the canary stage+approval — any missing piece keeps it suppressed.
 *
 * Leak-safety: the webhook URL (with its token) is handed straight to the
 * WebhookClient and never stored on the returned object, returned, or logged.
 * The preconditions report only booleans — never the URL. The payload is
 * validated BEFORE the client is even constructed. The caller MUST `close()`.
 */

const webhookUrlEnvKey = "NEON_DISCORD_WEBHOOK_URL";
const webhookEnabledEnvKey = "NEON_WEBHOOK_OUTBOUND_ENABLED";
const canaryStageEnvKey = "NEON_CUTOVER_STAGE";
const canaryApprovedEnvKey = "NEON_CUTOVER_CANARY_APPROVED";

export interface INeonWebhookLivePreconditions {
  readonly webhookUrlPresent: boolean;
  readonly webhookEnabled: boolean;
  readonly stageIsCanary: boolean;
  /**
   * True when the current cutover stage is allowed to send real outbound
   * traffic (canary or primary). `ready` derives from this so the webhook path
   * stays open once the runtime is promoted from canary to primary, while
   * `stageIsCanary` keeps its exact `stage === "canary"` meaning.
   */
  readonly stageAllowsOutbound: boolean;
  readonly canaryApproved: boolean;
  readonly ready: boolean;
}

/**
 * Leak-safe evaluation of whether a real webhook send is allowed. Returns only
 * booleans; the webhook URL/token is checked for presence only and never
 * returned. `ready` is true only when every precondition holds.
 */
export function evaluateNeonWebhookLivePreconditions(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonWebhookLivePreconditions {
  const webhookUrlPresent = Boolean((env[webhookUrlEnvKey] ?? "").trim());
  const webhookEnabled = readReadyCutoverEnv(env, webhookEnabledEnvKey);
  const stage = env[canaryStageEnvKey];
  const stageIsCanary = stage === "canary";
  const stageAllowsOutbound = stage === "canary" || stage === "primary";
  const canaryApproved = readReadyCutoverEnv(env, canaryApprovedEnvKey);
  const ready = webhookUrlPresent && webhookEnabled && stageAllowsOutbound && canaryApproved;
  return { webhookUrlPresent, webhookEnabled, stageIsCanary, stageAllowsOutbound, canaryApproved, ready };
}

export interface INeonWebhookSendOptions {
  readonly content?: string;
  readonly username?: string;
  readonly avatarURL?: string;
  readonly threadId?: string;
  readonly embeds?: readonly APIEmbed[];
}

/** Minimal seam over discord.js WebhookClient so tests need no real webhook URL. */
export interface INeonWebhookClientLike {
  send(options: INeonWebhookSendOptions): Promise<{ readonly id: string }>;
  destroy(): void;
}

export interface INeonDiscordWebhookTransport {
  send(payload: INeonWebhookPayload): Promise<{ readonly messageId: string }>;
  close(): Promise<void>;
}

export interface ICreateNeonDiscordWebhookTransportOptions {
  readonly webhookUrl: string;
  /** Injection seam for tests so the live-side-effect path runs without a real webhook URL. */
  readonly createWebhookClient?: (url: string) => INeonWebhookClientLike;
}

function defaultCreateNeonWebhookClient(url: string): INeonWebhookClientLike {
  const client = new WebhookClient({ url });
  return {
    async send(options: INeonWebhookSendOptions): Promise<{ readonly id: string }> {
      const sent = await client.send({
        ...(options.content !== undefined ? { content: options.content } : {}),
        ...(options.username !== undefined ? { username: options.username } : {}),
        ...(options.avatarURL !== undefined ? { avatarURL: options.avatarURL } : {}),
        ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
        ...(options.embeds !== undefined ? { embeds: [...options.embeds] } : {})
      });
      return { id: sent.id };
    },
    destroy(): void {
      client.destroy();
    }
  };
}

export function createNeonDiscordWebhookTransport(
  options: ICreateNeonDiscordWebhookTransportOptions
): INeonDiscordWebhookTransport {
  let client: INeonWebhookClientLike | undefined;
  const createClient = options.createWebhookClient ?? defaultCreateNeonWebhookClient;

  return {
    async send(payload: INeonWebhookPayload): Promise<{ readonly messageId: string }> {
      // Validate before constructing the client / touching the URL.
      const built = buildNeonWebhookPayload(payload);
      if (!built.ok) {
        throw new Error(`Refusing to send invalid webhook payload: ${built.errors.join("; ")}`);
      }

      // Re-build embeds into the API shape (validation already passed above).
      let embeds: readonly APIEmbed[] | undefined;
      if (built.payload.embeds && built.payload.embeds.length > 0) {
        const embedResult = buildNeonDiscordEmbedPayload(built.payload.embeds);
        if (embedResult.ok) {
          embeds = embedResult.embeds;
        }
      }

      if (!client) {
        client = createClient(options.webhookUrl);
      }
      const sent = await client.send({
        ...(built.payload.content.length > 0 ? { content: built.payload.content } : {}),
        ...(built.payload.username !== undefined ? { username: built.payload.username } : {}),
        ...(built.payload.avatarUrl !== undefined ? { avatarURL: built.payload.avatarUrl } : {}),
        ...(built.payload.threadId !== undefined ? { threadId: built.payload.threadId } : {}),
        ...(embeds !== undefined ? { embeds } : {})
      });
      return { messageId: sent.id };
    },

    async close(): Promise<void> {
      if (client) {
        client.destroy();
        client = undefined;
      }
    }
  };
}
