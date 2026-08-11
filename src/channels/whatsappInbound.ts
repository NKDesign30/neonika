import { createHash } from "node:crypto";

import { resolveNeonCanonicalPeer } from "./channelIdentity.js";
import { runNeonGatewayShadow } from "../gateway/shadowGateway.js";
import { writeNeonGatewayRun } from "../gateway/runStore.js";
import type { INeonGatewayShadowResult, INeonGatewayShadowRun } from "../gateway/types.js";
import type { ICodexHarness } from "../harness/types.js";
import {
  createNeonMemoryAttachment,
  type INeonMemoryProvider
} from "../memory/neonMemory.js";
import type { INeonSetupConfig } from "../onboarding/neonSetup.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import { isNeonWhatsAppCanaryMessageId } from "./whatsappCanary.js";

export type TNeonWhatsAppDropReason =
  | "history"
  | "invalid-event"
  | "group-disabled"
  | "status-or-broadcast"
  | "owner-not-allowed"
  | "outbound-loop"
  | "direction-not-allowed"
  | "missing-message-id"
  | "missing-timestamp"
  | "empty-content";

export interface INeonWhatsAppInboundMessage {
  readonly messageId: string;
  readonly peerId: string;
  readonly channelId: string;
  readonly content: string;
  readonly createdAt: string;
}

export type TNeonWhatsAppInboundDecision =
  | { readonly state: "accepted"; readonly message: INeonWhatsAppInboundMessage }
  | { readonly state: "dropped"; readonly reason: TNeonWhatsAppDropReason };

export interface IRunNeonWhatsAppShadowIngressOptions {
  readonly config: INeonSetupConfig;
  readonly projectRoot: string;
  readonly harness: ICodexHarness;
  readonly memoryProvider: INeonMemoryProvider;
  readonly agentId?: string;
  readonly now?: () => Date;
  readonly writeRun?: (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;
}

export function decideNeonWhatsAppInbound(
  value: unknown,
  config: INeonSetupConfig,
  now: () => Date = () => new Date()
): readonly TNeonWhatsAppInboundDecision[] {
  if (!isRecord(value) || value["type"] !== "notify" || !Array.isArray(value["messages"])) {
    return [{ state: "dropped", reason: isRecord(value) && value["type"] !== "notify" ? "history" : "invalid-event" }];
  }
  return value["messages"].map((message) => decideMessage(message, config, now));
}

export async function runNeonWhatsAppShadowIngress(
  message: INeonWhatsAppInboundMessage,
  options: IRunNeonWhatsAppShadowIngressOptions
): Promise<INeonGatewayShadowResult> {
  const identity = resolveNeonCanonicalPeer(options.config, {
    channel: "whatsapp",
    accountId: "default",
    peerId: message.peerId
  });
  if (!identity.linkedToOwner) {
    throw new Error("WhatsApp inbound peer is not linked to the owner");
  }
  const memory = await createNeonMemoryAttachment(
    options.memoryProvider,
    `${options.agentId ?? "chaty"} owner whatsapp ${message.content}`,
    { maxHits: 12 }
  );
  const result = await runNeonGatewayShadow(
    {
      message: {
        channel: "whatsapp",
        accountId: "default",
        channelId: message.channelId,
        messageId: message.messageId,
        userId: identity.sessionPeerKey,
        userDisplayName: "Owner",
        agentId: options.agentId ?? "chaty",
        workspaceRoot: options.projectRoot,
        mode: "read-only",
        sessionPeerKey: identity.sessionPeerKey,
        content: message.content,
        createdAt: message.createdAt
      },
      memory
    },
    {
      harness: options.harness,
      ...(options.now ? { now: options.now } : {})
    }
  );
  await (options.writeRun ?? writeNeonGatewayRun)(options.projectRoot, result.run);
  return result;
}

function decideMessage(
  value: unknown,
  config: INeonSetupConfig,
  now: () => Date
): TNeonWhatsAppInboundDecision {
  if (!isRecord(value) || !isRecord(value["key"])) {
    return { state: "dropped", reason: "invalid-event" };
  }
  const key = value["key"];
  const remoteJids = uniqueStrings(key["remoteJid"], key["remoteJidAlt"]);
  const primaryJid = remoteJids[0];
  if (!primaryJid) {
    return { state: "dropped", reason: "invalid-event" };
  }
  if (remoteJids.some((jid) => jid.endsWith("@g.us"))) {
    return { state: "dropped", reason: "group-disabled" };
  }
  if (
    remoteJids.some(
      (jid) => jid.endsWith("@broadcast") || jid.endsWith("@newsletter")
    )
  ) {
    return { state: "dropped", reason: "status-or-broadcast" };
  }
  const configuredOwner = config.channels.whatsapp.ownerPeerId;
  const ownerJid = configuredOwner
    ? remoteJids.find((jid) => jidToE164(jid) === configuredOwner)
    : undefined;
  if (!configuredOwner || !ownerJid) {
    return { state: "dropped", reason: "owner-not-allowed" };
  }
  const fromMe = key["fromMe"] === true;
  const messageId = typeof key["id"] === "string" ? key["id"].trim() : "";
  if (fromMe && isNeonWhatsAppCanaryMessageId(messageId)) {
    return { state: "dropped", reason: "outbound-loop" };
  }
  const mode = config.channels.whatsapp.mode;
  if ((mode === "personal" && !fromMe) || (mode === "dedicated" && fromMe)) {
    return { state: "dropped", reason: "direction-not-allowed" };
  }
  if (messageId === "") {
    return { state: "dropped", reason: "missing-message-id" };
  }
  const content = extractMessageText(value["message"]);
  if (content === "") {
    return { state: "dropped", reason: "empty-content" };
  }
  const timestampSeconds = readTimestampSeconds(value["messageTimestamp"]);
  const createdAt = timestampSeconds === undefined
    ? undefined
    : toCanonicalTimestamp(timestampSeconds);
  const receivedAtMs = now().getTime();
  if (
    !createdAt ||
    !Number.isFinite(receivedAtMs) ||
    Date.parse(createdAt) > receivedAtMs + 5 * 60 * 1_000
  ) {
    return { state: "dropped", reason: "missing-timestamp" };
  }
  return {
    state: "accepted",
    message: {
      messageId: `wa:${fingerprint(messageId)}`,
      peerId: configuredOwner,
      channelId: `wa:${fingerprint(primaryJid)}`,
      content: truncateUtf16Safe(content, 8_000),
      createdAt
    }
  };
}

function extractMessageText(value: unknown, depth = 0): string {
  if (!isRecord(value) || depth > 8) {
    return "";
  }
  const direct = firstString(
    value["conversation"],
    readNestedString(value["extendedTextMessage"], "text"),
    readNestedString(value["imageMessage"], "caption"),
    readNestedString(value["videoMessage"], "caption"),
    readNestedString(value["documentMessage"], "caption")
  );
  if (direct) {
    return normalizeText(direct);
  }
  for (const wrapperName of [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage"
  ]) {
    const wrapper = value[wrapperName];
    if (isRecord(wrapper)) {
      const nested = extractMessageText(wrapper["message"], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

function readNestedString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function uniqueStrings(...values: readonly unknown[]): readonly string[] {
  return [...new Set(values.map((value) => firstString(value)).filter(isString))];
}

function jidToE164(jid: string): string | undefined {
  const user = jid.split("@", 1)[0]?.split(":", 1)[0]?.replace(/\D/gu, "") ?? "";
  return /^[1-9]\d{7,14}$/u.test(user) ? `+${user}` : undefined;
}

function readTimestampSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (isRecord(value) && typeof value["toNumber"] === "function") {
    try {
      const result = Reflect.apply(value["toNumber"], value, []) as unknown;
      return typeof result === "number" && Number.isFinite(result) && result > 0 ? result : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function toCanonicalTimestamp(timestampSeconds: number): string | undefined {
  const timestamp = new Date(timestampSeconds * 1_000);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
