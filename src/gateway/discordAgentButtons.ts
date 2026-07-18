import { redactText } from "../harness/redaction.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type {
  INeonDiscordComponentActionContext,
  INeonDiscordComponentActionOutcome,
  INeonDiscordComponentActionRegistry
} from "./discordComponentActionRegistry.js";
import { NEON_DISCORD_COMPONENT_LIMITS } from "./discordComponentPayload.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import type { INeonGatewayShadowRun } from "./types.js";

/**
 * Agent-authored quick-reply buttons, pattern-following the poll/card markers.
 * An agent appends the marker to its final answer; the reply loop strips it
 * and reports the labels, and the tap presents them as a button row whose
 * click feeds the label back into the session as the user's next message.
 *
 * Marker shape (single line):
 *   <NEON_BUTTONS>Label A|Label B|Label C</NEON_BUTTONS>
 *
 * The parser is pure (no client, no send). The runtime half wires the gated
 * component-action registry: labels ride in the persisted action record as
 * base64url so the registry's opaque resourceRef contract holds, and only the
 * original requester may click (ownerUserId binding enforced by the registry).
 */

export interface INeonDiscordButtonsMarkerParseResult {
  /** Reply text with every buttons marker removed. */
  readonly text: string;
  /** Labels of the first valid marker, if any. */
  readonly buttons?: readonly string[];
}

const BUTTONS_MARKER_PATTERN = /<NEON_BUTTONS>([^<>\r\n]{1,600})<\/NEON_BUTTONS>/gu;
const AGENT_BUTTONS_ACTION = "agent-buttons:pick";
const AGENT_BUTTONS_RESOURCE_PREFIX = "label:";
const DEFAULT_AGENT_BUTTONS_TTL_MS = 15 * 60 * 1_000;

/**
 * Extract the first valid `<NEON_BUTTONS>…</NEON_BUTTONS>` marker from an
 * agent reply and strip every marker occurrence from the text.
 */
export function parseNeonDiscordButtonsMarker(text: string): INeonDiscordButtonsMarkerParseResult {
  let buttons: readonly string[] | undefined;

  const cleaned = text.replace(BUTTONS_MARKER_PATTERN, (_match, labels: string) => {
    buttons = buttons ?? buildButtonsFromMarker(labels);
    return "";
  });

  return {
    text: cleaned.replace(/\n{3,}/gu, "\n\n").trim(),
    ...(buttons ? { buttons } : {})
  };
}

function buildButtonsFromMarker(labels: string): readonly string[] | undefined {
  const parsed = labels
    .split("|")
    .map((label) => redactText(label.trim()))
    .filter((label) => label.length > 0);
  if (parsed.length < 1 || parsed.length > NEON_DISCORD_COMPONENT_LIMITS.buttonsPerRow) {
    return undefined;
  }
  if (parsed.some((label) => label.length > NEON_DISCORD_COMPONENT_LIMITS.buttonLabel)) {
    return undefined;
  }
  return parsed;
}

export function isNeonDiscordAgentButtonsActionType(actionType: string): boolean {
  return actionType === AGENT_BUTTONS_ACTION;
}

export interface INeonDiscordAgentButtonsTransport {
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }>;
}

export interface INeonDiscordAgentButtonsExecuteInput {
  /** Redacted button label the user clicked; becomes the follow-up prompt. */
  readonly label: string;
  readonly context: INeonDiscordComponentActionContext;
}

export interface ICreateNeonDiscordAgentButtonsRuntimeOptions {
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly transport: INeonDiscordAgentButtonsTransport;
  /** Runs the clicked label as the user's next message and returns the outcome text. */
  readonly execute: (input: INeonDiscordAgentButtonsExecuteInput) => Promise<string>;
  readonly ttlMs?: number;
  readonly now?: () => Date;
}

export interface INeonDiscordAgentButtonsRuntime {
  /** Post the quick-reply row for a delivered run. Fail-soft: returns undefined on transport errors. */
  present(
    run: INeonGatewayShadowRun,
    target: INeonDeliveryQueueTarget,
    labels: readonly string[]
  ): Promise<{ readonly messageId: string } | undefined>;
  handleAction(context: INeonDiscordComponentActionContext): Promise<INeonDiscordComponentActionOutcome>;
}

export function createNeonDiscordAgentButtonsRuntime(
  options: ICreateNeonDiscordAgentButtonsRuntimeOptions
): INeonDiscordAgentButtonsRuntime {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_AGENT_BUTTONS_TTL_MS;

  const handleAction = async (
    context: INeonDiscordComponentActionContext
  ): Promise<INeonDiscordComponentActionOutcome> => {
    const label = decodeAgentButtonLabel(context.resourceRef);
    if (!label) {
      throw new Error("Discord agent button is missing its label reference");
    }
    const message = await options.execute({ label, context });
    return { message };
  };

  return {
    present: async (run, target, labels) => {
      const valid = buildButtonsFromMarker(labels.join("|"));
      if (!valid) {
        return undefined;
      }
      try {
        const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
        const buttons = valid.map((label) => {
          const action = options.registry.register({
            ownerUserId: run.request.userId,
            ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
            channelId: run.request.channelId,
            sessionKey: run.harnessSessionKey,
            actionType: AGENT_BUTTONS_ACTION,
            interactionKind: "button",
            resourceRef: encodeAgentButtonLabel(label),
            expiresAt,
            handler: handleAction
          });
          return { label, style: "secondary" as const, customId: action.customId };
        });
        return await options.transport.postComponents(target, "Schnellantworten:", [{ buttons }]);
      } catch {
        return undefined;
      }
    },
    handleAction
  };
}

function encodeAgentButtonLabel(label: string): string {
  return `${AGENT_BUTTONS_RESOURCE_PREFIX}${Buffer.from(label, "utf8").toString("base64url")}`;
}

function decodeAgentButtonLabel(resourceRef: string | undefined): string | undefined {
  if (!resourceRef?.startsWith(AGENT_BUTTONS_RESOURCE_PREFIX)) {
    return undefined;
  }
  const encoded = resourceRef.slice(AGENT_BUTTONS_RESOURCE_PREFIX.length);
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}
