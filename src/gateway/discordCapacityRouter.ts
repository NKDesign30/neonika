import { createHash } from "node:crypto";

import type { INeonHarnessRuntimeMetadata } from "../harness/types.js";
import type {
  INeonDiscordComponentActionContext,
  INeonDiscordComponentActionOutcome,
  INeonDiscordComponentActionRegistry
} from "./discordComponentActionRegistry.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type { INeonDiscordEmbed } from "./discordRichPayload.js";
import {
  formatNeonDiscordExpiryCountdown,
  neonDiscordSeverityColors
} from "./discordUiColors.js";

export type TNeonDiscordCapacityTier = "luna" | "terra" | "sol";

export interface INeonDiscordCapacityAttachment {
  readonly id?: string;
  readonly name: string;
  readonly kind?: string;
}

export interface INeonDiscordCapacityMessage {
  readonly content: string;
  readonly attachments?: readonly INeonDiscordCapacityAttachment[];
}

export interface INeonDiscordCapacityRuntime extends INeonHarnessRuntimeMetadata {
  readonly provider: "openai";
  readonly runtime: "codex";
  readonly lane: "codex-app-server";
  readonly model: `gpt-5.6-${TNeonDiscordCapacityTier}`;
  readonly effort: "medium" | "high" | "xhigh";
}

export interface INeonDiscordCapacityDecision {
  readonly tier: TNeonDiscordCapacityTier;
  readonly model: INeonDiscordCapacityRuntime["model"];
  readonly effort: INeonDiscordCapacityRuntime["effort"];
  readonly requiresConfirmation: boolean;
  readonly reasons: readonly string[];
}

export interface INeonDiscordCapacityUpgradeRequest {
  readonly tier: "terra" | "sol";
  readonly reason: string;
}

export interface INeonDiscordCapacityGateTransport {
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[],
    embeds?: readonly INeonDiscordEmbed[]
  ): Promise<{ readonly messageId: string }>;
}

export interface INeonDiscordCapacityExecutionInput {
  readonly runtime: INeonDiscordCapacityRuntime;
  readonly messageId: string;
  readonly fingerprint: string;
  readonly context: INeonDiscordComponentActionContext;
}

export interface INeonDiscordCapacityExecutionResult {
  readonly runId: string;
  readonly status: "completed" | "failed" | "cancelled";
}

export interface ICreateNeonDiscordCapacityGateOptions {
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly transport: INeonDiscordCapacityGateTransport;
  readonly execute: (
    input: INeonDiscordCapacityExecutionInput
  ) => Promise<INeonDiscordCapacityExecutionResult>;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export interface INeonDiscordCapacityGateRequest {
  readonly target: INeonDeliveryQueueTarget;
  readonly ownerUserId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly messageId: string;
  readonly fingerprint: string;
  readonly decision: INeonDiscordCapacityDecision;
}

export interface INeonDiscordCapacityGate {
  request(input: INeonDiscordCapacityGateRequest): Promise<{ readonly messageId: string }>;
  handleAction(context: INeonDiscordComponentActionContext): Promise<INeonDiscordComponentActionOutcome>;
}

const CAPACITY_ACTION_PREFIX = "discord-capacity:";
const CAPACITY_RESOURCE_PREFIX = "capacity";
const DEFAULT_CAPACITY_TTL_MS = 10 * 60 * 1_000;

export const neonDiscordCapacityRuntimes = {
  luna: {
    provider: "openai",
    runtime: "codex",
    lane: "codex-app-server",
    model: "gpt-5.6-luna",
    effort: "medium"
  },
  terra: {
    provider: "openai",
    runtime: "codex",
    lane: "codex-app-server",
    model: "gpt-5.6-terra",
    effort: "high"
  },
  sol: {
    provider: "openai",
    runtime: "codex",
    lane: "codex-app-server",
    model: "gpt-5.6-sol",
    effort: "xhigh"
  }
} as const satisfies Record<TNeonDiscordCapacityTier, INeonDiscordCapacityRuntime>;

export function resolveNeonDiscordCapacityDecision(
  message: INeonDiscordCapacityMessage
): INeonDiscordCapacityDecision {
  const content = normalizeCapacityText(message.content);
  const reasons: string[] = [];
  const highStakes =
    /\b(?:bank|bankprüfung|kredit|investor|gründungszuschuss|businessplan|geschäftsplan|finanzplan(?:ung)?|liquiditätsplan(?:ung)?|rentabilität|break[ -]?even|kapitalbedarf|umsatzplanung|due diligence|security|sicherheitsreview|compliance|architektur)\b/iu.test(
      content
    );
  if (highStakes) {
    reasons.push("Finanzen oder Bankprüfung");
  }
  if (
    /\b(?:bis (?:du )?zufrieden|vollständig (?:prüfen|überarbeiten)|recherch(?:iere|ieren).*(?:bauen|erstellen|überarbeiten)|analys(?:iere|ieren).*(?:verbessern|überarbeiten)|3\s*(?:bis|–|-)\s*5\s*jahre)\b/iu.test(
      content
    )
  ) {
    reasons.push("mehrstufige Qualitätsprüfung");
  }
  if (content.length >= 700) {
    reasons.push("umfangreicher Auftrag");
  }
  if (/\b(?:sol|xhigh)\b/iu.test(content)) {
    reasons.push("Sol ausdrücklich angefordert");
  }

  if (highStakes || reasons.length >= 2) {
    return createDecision("sol", true, reasons);
  }

  const attachments = message.attachments ?? [];
  if (
    attachments.length === 0 &&
    content.length <= 180 &&
    /^(?:super(?:,? danke)?|danke|ok(?:ay)?|alles klar|gern(?:e)?|hallo|hi|hey|moin|guten (?:morgen|tag|abend)|was ist neu|was steht an|wie geht(?:'s| es dir)?)[.!?\s]*$/iu.test(
      content
    )
  ) {
    return createDecision("luna", false, ["kurze Unterhaltung"]);
  }

  const terraReason =
    attachments.length > 0
      ? "Datei- oder Medienarbeit"
      : /\b(?:änder(?:e|n)|aktualisier(?:e|en)|erstell(?:e|en)|übersetz(?:e|en)|prüf(?:e|en)|recherchier(?:e|en)|schick(?:e|en)|send(?:e|en)|bearbeit(?:e|en)|formatier(?:e|en)|trag(?:e|en)|such(?:e|en)|mach(?:e|en))\b/iu.test(
            content
          )
        ? "operativer Arbeitsauftrag"
        : "normaler Arbeitsauftrag";
  return createDecision("terra", false, [terraReason]);
}

export function createNeonDiscordCapacityFingerprint(
  message: INeonDiscordCapacityMessage
): string {
  const attachmentIdentity = (message.attachments ?? [])
    .map((attachment) => `${attachment.id ?? ""}:${attachment.kind ?? "file"}:${attachment.name.trim()}`)
    .sort()
    .join("\n");
  return createHash("sha256")
    .update(`${normalizeCapacityText(message.content)}\n${attachmentIdentity}`)
    .digest("hex")
    .slice(0, 20);
}

export function createNeonDiscordCapacityUpgradeDecision(
  request: INeonDiscordCapacityUpgradeRequest
): INeonDiscordCapacityDecision {
  return createDecision(request.tier, true, [request.reason]);
}

export function parseNeonDiscordCapacityUpgradeRequest(
  value: string
): INeonDiscordCapacityUpgradeRequest | undefined {
  const match = /^<NEON_CAPACITY_UPGRADE tier="(terra|sol)">([^<>\r\n]{1,200})<\/NEON_CAPACITY_UPGRADE>$/u.exec(
    value.trim()
  );
  const tier = match?.[1];
  const reason = match?.[2]?.trim();
  return (tier === "terra" || tier === "sol") && reason ? { tier, reason } : undefined;
}

export function isNeonDiscordCapacityActionType(actionType: string): boolean {
  return actionType === capacityActionType("sol") ||
    actionType === capacityActionType("terra") ||
    actionType === capacityActionType("luna") ||
    actionType === capacityActionType("cancel");
}

export function createNeonDiscordCapacityGate(
  options: ICreateNeonDiscordCapacityGateOptions
): INeonDiscordCapacityGate {
  const now = options.now ?? (() => new Date());
  const ttlMs = normalizeTtl(options.ttlMs);

  const handleAction = async (
    context: INeonDiscordComponentActionContext
  ): Promise<INeonDiscordComponentActionOutcome> => {
    const resource = parseCapacityResourceRef(context.resourceRef);
    if (!resource) {
      throw new Error("Discord capacity action is missing its pending task reference");
    }
    const choice = parseCapacityChoice(context.actionType);
    if (!choice) {
      throw new Error("Discord capacity action is unsupported");
    }
    if (choice === "cancel") {
      return { message: "Auftrag abgebrochen." };
    }
    const runtime = neonDiscordCapacityRuntimes[choice];
    const result = await options.execute({
      runtime,
      messageId: resource.messageId,
      fingerprint: resource.fingerprint,
      context
    });
    return {
      message: `${formatTier(choice)} ${runtime.effort} abgeschlossen (${result.status}).`
    };
  };

  return {
    request: async (input) => {
      if (!input.decision.requiresConfirmation || input.decision.tier === "luna") {
        throw new Error("Discord capacity gate only opens for Terra or Sol confirmation decisions");
      }
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
      const resourceRef = createCapacityResourceRef(input.messageId, input.fingerprint);
      const consumptionKey = `${CAPACITY_RESOURCE_PREFIX}:${input.messageId}:${input.fingerprint}`;
      const register = (choice: TNeonDiscordCapacityTier | "cancel") =>
        options.registry.register({
          ownerUserId: input.ownerUserId,
          ...(input.guildId ? { guildId: input.guildId } : {}),
          channelId: input.channelId,
          sessionKey: input.sessionKey,
          actionType: capacityActionType(choice),
          interactionKind: "button",
          consumptionKey,
          resourceRef,
          expiresAt,
          handler: handleAction
        });
      const preferredTier = input.decision.tier;
      const fallbackTier = preferredTier === "sol" ? "terra" : "luna";
      const preferred = register(preferredTier);
      const fallback = register(fallbackTier);
      const cancel = register("cancel");
      const rows: readonly TNeonDiscordActionRow[] = [
        {
          buttons: [
            {
              label: `${formatTier(preferredTier)} ${neonDiscordCapacityRuntimes[preferredTier].effort} verwenden`,
              style: "primary",
              customId: preferred.customId,
              emoji: preferredTier === "sol" ? "☀️" : "🌍"
            },
            {
              label: `Mit ${formatTier(fallbackTier)} fortfahren`,
              style: "secondary",
              customId: fallback.customId,
              emoji: fallbackTier === "terra" ? "🌍" : "🌙"
            },
            { label: "Abbrechen", style: "danger", customId: cancel.customId }
          ]
        }
      ];
      const reason = input.decision.reasons.slice(0, 2).join(" · ");
      return await options.transport.postComponents(
        input.target,
        `Mehr Kapazität empfohlen: ${reason}. Soll ich diesen Auftrag mit ${formatTier(preferredTier)} ${neonDiscordCapacityRuntimes[preferredTier].effort} ausführen?`,
        rows,
        [
          {
            description: `Läuft ab ${formatNeonDiscordExpiryCountdown(expiresAt)}`,
            color: neonDiscordSeverityColors.info
          }
        ]
      );
    },
    handleAction
  };
}

function createDecision(
  tier: TNeonDiscordCapacityTier,
  requiresConfirmation: boolean,
  reasons: readonly string[]
): INeonDiscordCapacityDecision {
  const runtime = neonDiscordCapacityRuntimes[tier];
  return {
    tier,
    model: runtime.model,
    effort: runtime.effort,
    requiresConfirmation,
    reasons
  };
}

function normalizeCapacityText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function capacityActionType(choice: TNeonDiscordCapacityTier | "cancel"): string {
  return `${CAPACITY_ACTION_PREFIX}${choice}`;
}

function parseCapacityChoice(actionType: string): TNeonDiscordCapacityTier | "cancel" | undefined {
  if (!actionType.startsWith(CAPACITY_ACTION_PREFIX)) {
    return undefined;
  }
  const choice = actionType.slice(CAPACITY_ACTION_PREFIX.length);
  return choice === "sol" || choice === "terra" || choice === "luna" || choice === "cancel"
    ? choice
    : undefined;
}

function createCapacityResourceRef(messageId: string, fingerprint: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(messageId) || !/^[a-f0-9]{20}$/u.test(fingerprint)) {
    throw new Error("Discord capacity pending task reference is invalid");
  }
  return `${CAPACITY_RESOURCE_PREFIX}:${messageId}:${fingerprint}`;
}

function parseCapacityResourceRef(
  value: string | undefined
): { readonly messageId: string; readonly fingerprint: string } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^capacity:([A-Za-z0-9._-]{1,200}):([a-f0-9]{20})$/u.exec(value);
  return match?.[1] && match[2] ? { messageId: match[1], fingerprint: match[2] } : undefined;
}

function formatTier(tier: TNeonDiscordCapacityTier): "Luna" | "Terra" | "Sol" {
  if (tier === "sol") {
    return "Sol";
  }
  return tier === "terra" ? "Terra" : "Luna";
}

function normalizeTtl(value: number | undefined): number {
  const resolved = value ?? DEFAULT_CAPACITY_TTL_MS;
  if (!Number.isFinite(resolved) || resolved < 1_000 || resolved > 30 * 60 * 1_000) {
    throw new Error("Discord capacity gate ttlMs must be between 1000 and 1800000");
  }
  return Math.trunc(resolved);
}
