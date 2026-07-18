import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TNeonDiscordDropReason } from "./discordIngress.js";
import {
  neonStatusReactionEmojis,
  type TNeonStatusReactionState
} from "../channels/statusReactions.js";
import { resolveGatewayStatePaths } from "./runStore.js";

function isStatusReactionState(value: unknown): value is TNeonStatusReactionState {
  return typeof value === "string" && value in neonStatusReactionEmojis;
}

export type TNeonDiscordRouteProbeState = "running" | "stopped" | "unknown";

export interface INeonDiscordRouteProbeStats {
  readonly accepted: number;
  readonly dropped: number;
  readonly errors: number;
  readonly repliesDelivered?: number;
  readonly repliesSuppressed?: number;
  readonly replyErrors?: number;
  readonly typingStarted?: number;
  readonly typingErrors?: number;
  readonly lastTypingState?: "started" | "failed";
  readonly reactionsSent?: number;
  readonly reactionErrors?: number;
  readonly controlsAccepted?: number;
  readonly controlsDropped?: number;
  readonly progressCardsStarted?: number;
  readonly progressCardUpdates?: number;
  readonly progressCardErrors?: number;
  readonly runtimePickersOpened?: number;
  readonly runtimePickerErrors?: number;
  readonly capacityPromptsOpened?: number;
  readonly capacityPromptErrors?: number;
  readonly recoveryCardsStarted?: number;
  readonly recoveryCardErrors?: number;
  readonly lastReactionState?: TNeonStatusReactionState;
  readonly lastReactionOutcome?: "sent" | "failed";
  readonly lastControlState?: "stopped" | "idle" | "blocked" | "partial";
  readonly lastControlAt?: string;
  readonly lastProgressCardMessageId?: string;
  readonly lastRuntimePickerMessageId?: string;
  readonly lastCapacityPromptMessageId?: string;
  readonly lastRecoveryCardMessageId?: string;
  readonly lastRunId?: string;
  readonly lastReplyState?: "delivered" | "review-pending" | "suppressed" | "skipped" | "transport-error";
  readonly lastReplyMessageId?: string;
  readonly lastDropReason?: TNeonDiscordDropReason | "unmapped-message";
  readonly lastErrorMessage?: string;
}

export interface INeonDiscordRouteProbe {
  readonly channel: "discord";
  readonly accountId: string;
  readonly allowedChannelIds?: readonly string[];
  readonly state: TNeonDiscordRouteProbeState;
  readonly running: boolean;
  readonly startedAt?: string;
  readonly stoppedAt?: string;
  readonly lastProbeAt?: string;
  readonly stats: INeonDiscordRouteProbeStats;
}

const discordRouteProbeFile = "discord-route-probe.json";
const emptyStats: INeonDiscordRouteProbeStats = {
  accepted: 0,
  dropped: 0,
  errors: 0
};

export function resolveNeonDiscordRouteProbePath(projectRoot: string): string {
  return join(resolveGatewayStatePaths(projectRoot).gatewayRoot, discordRouteProbeFile);
}

export async function writeNeonDiscordRouteProbe(
  projectRoot: string,
  probe: INeonDiscordRouteProbe
): Promise<void> {
  const probePath = resolveNeonDiscordRouteProbePath(projectRoot);

  await mkdir(dirname(probePath), { recursive: true });
  await writeFile(probePath, `${JSON.stringify(probe, null, 2)}\n`, "utf8");
}

export async function readNeonDiscordRouteProbe(
  projectRoot: string,
  accountId: string
): Promise<INeonDiscordRouteProbe> {
  const probePath = resolveNeonDiscordRouteProbePath(projectRoot);
  let raw: string;

  try {
    raw = await readFile(probePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return createUnknownNeonDiscordRouteProbe(accountId);
    }

    throw error;
  }

  try {
    const probe = parseNeonDiscordRouteProbe(JSON.parse(raw));

    if (!probe || probe.accountId !== accountId) {
      return createUnknownNeonDiscordRouteProbe(accountId);
    }

    return probe;
  } catch {
    return createUnknownNeonDiscordRouteProbe(accountId);
  }
}

export function createUnknownNeonDiscordRouteProbe(accountId: string): INeonDiscordRouteProbe {
  return {
    channel: "discord",
    accountId,
    state: "unknown",
    running: false,
    stats: emptyStats
  };
}

function parseNeonDiscordRouteProbe(value: unknown): INeonDiscordRouteProbe | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const stats = parseNeonDiscordRouteProbeStats(value["stats"]);
  const state = parseNeonDiscordRouteProbeState(value["state"]);

  if (
    value["channel"] !== "discord" ||
    typeof value["accountId"] !== "string" ||
    !state ||
    typeof value["running"] !== "boolean" ||
    !stats
  ) {
    return undefined;
  }

  return {
    channel: "discord",
    accountId: value["accountId"],
    ...(Array.isArray(value["allowedChannelIds"]) &&
    value["allowedChannelIds"].every((entry): entry is string => typeof entry === "string")
      ? { allowedChannelIds: value["allowedChannelIds"] }
      : {}),
    state,
    running: value["running"],
    ...(typeof value["startedAt"] === "string" ? { startedAt: value["startedAt"] } : {}),
    ...(typeof value["stoppedAt"] === "string" ? { stoppedAt: value["stoppedAt"] } : {}),
    ...(typeof value["lastProbeAt"] === "string" ? { lastProbeAt: value["lastProbeAt"] } : {}),
    stats
  };
}

function parseNeonDiscordRouteProbeStats(value: unknown): INeonDiscordRouteProbeStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value["accepted"] !== "number" ||
    typeof value["dropped"] !== "number" ||
    typeof value["errors"] !== "number"
  ) {
    return undefined;
  }

  return {
    accepted: Math.max(0, Math.trunc(value["accepted"])),
    dropped: Math.max(0, Math.trunc(value["dropped"])),
    errors: Math.max(0, Math.trunc(value["errors"])),
    ...(typeof value["repliesDelivered"] === "number"
      ? { repliesDelivered: Math.max(0, Math.trunc(value["repliesDelivered"])) }
      : {}),
    ...(typeof value["repliesSuppressed"] === "number"
      ? { repliesSuppressed: Math.max(0, Math.trunc(value["repliesSuppressed"])) }
      : {}),
    ...(typeof value["replyErrors"] === "number"
      ? { replyErrors: Math.max(0, Math.trunc(value["replyErrors"])) }
      : {}),
    ...(typeof value["typingStarted"] === "number"
      ? { typingStarted: Math.max(0, Math.trunc(value["typingStarted"])) }
      : {}),
    ...(typeof value["typingErrors"] === "number"
      ? { typingErrors: Math.max(0, Math.trunc(value["typingErrors"])) }
      : {}),
    ...(value["lastTypingState"] === "started" || value["lastTypingState"] === "failed"
      ? { lastTypingState: value["lastTypingState"] }
      : {}),
    ...(typeof value["reactionsSent"] === "number"
      ? { reactionsSent: Math.max(0, Math.trunc(value["reactionsSent"])) }
      : {}),
    ...(typeof value["reactionErrors"] === "number"
      ? { reactionErrors: Math.max(0, Math.trunc(value["reactionErrors"])) }
      : {}),
    ...(typeof value["controlsAccepted"] === "number"
      ? { controlsAccepted: Math.max(0, Math.trunc(value["controlsAccepted"])) }
      : {}),
    ...(typeof value["controlsDropped"] === "number"
      ? { controlsDropped: Math.max(0, Math.trunc(value["controlsDropped"])) }
      : {}),
    ...(typeof value["progressCardsStarted"] === "number"
      ? { progressCardsStarted: Math.max(0, Math.trunc(value["progressCardsStarted"])) }
      : {}),
    ...(typeof value["progressCardUpdates"] === "number"
      ? { progressCardUpdates: Math.max(0, Math.trunc(value["progressCardUpdates"])) }
      : {}),
    ...(typeof value["progressCardErrors"] === "number"
      ? { progressCardErrors: Math.max(0, Math.trunc(value["progressCardErrors"])) }
      : {}),
    ...(typeof value["runtimePickersOpened"] === "number"
      ? { runtimePickersOpened: Math.max(0, Math.trunc(value["runtimePickersOpened"])) }
      : {}),
    ...(typeof value["runtimePickerErrors"] === "number"
      ? { runtimePickerErrors: Math.max(0, Math.trunc(value["runtimePickerErrors"])) }
      : {}),
    ...(typeof value["capacityPromptsOpened"] === "number"
      ? { capacityPromptsOpened: Math.max(0, Math.trunc(value["capacityPromptsOpened"])) }
      : {}),
    ...(typeof value["capacityPromptErrors"] === "number"
      ? { capacityPromptErrors: Math.max(0, Math.trunc(value["capacityPromptErrors"])) }
      : {}),
    ...(typeof value["recoveryCardsStarted"] === "number"
      ? { recoveryCardsStarted: Math.max(0, Math.trunc(value["recoveryCardsStarted"])) }
      : {}),
    ...(typeof value["recoveryCardErrors"] === "number"
      ? { recoveryCardErrors: Math.max(0, Math.trunc(value["recoveryCardErrors"])) }
      : {}),
    ...(isStatusReactionState(value["lastReactionState"])
      ? { lastReactionState: value["lastReactionState"] }
      : {}),
    ...(value["lastReactionOutcome"] === "sent" || value["lastReactionOutcome"] === "failed"
      ? { lastReactionOutcome: value["lastReactionOutcome"] }
      : {}),
    ...(isControlState(value["lastControlState"])
      ? { lastControlState: value["lastControlState"] }
      : {}),
    ...(typeof value["lastControlAt"] === "string" ? { lastControlAt: value["lastControlAt"] } : {}),
    ...(typeof value["lastProgressCardMessageId"] === "string"
      ? { lastProgressCardMessageId: value["lastProgressCardMessageId"] }
      : {}),
    ...(typeof value["lastRuntimePickerMessageId"] === "string"
      ? { lastRuntimePickerMessageId: value["lastRuntimePickerMessageId"] }
      : {}),
    ...(typeof value["lastCapacityPromptMessageId"] === "string"
      ? { lastCapacityPromptMessageId: value["lastCapacityPromptMessageId"] }
      : {}),
    ...(typeof value["lastRecoveryCardMessageId"] === "string"
      ? { lastRecoveryCardMessageId: value["lastRecoveryCardMessageId"] }
      : {}),
    ...(typeof value["lastRunId"] === "string" ? { lastRunId: value["lastRunId"] } : {}),
    ...(isReplyState(value["lastReplyState"]) ? { lastReplyState: value["lastReplyState"] } : {}),
    ...(typeof value["lastReplyMessageId"] === "string"
      ? { lastReplyMessageId: value["lastReplyMessageId"] }
      : {}),
    ...(isDropReason(value["lastDropReason"]) ? { lastDropReason: value["lastDropReason"] } : {}),
    ...(typeof value["lastErrorMessage"] === "string" ? { lastErrorMessage: value["lastErrorMessage"] } : {})
  };
}

function isControlState(value: unknown): value is "stopped" | "idle" | "blocked" | "partial" {
  return value === "stopped" || value === "idle" || value === "blocked" || value === "partial";
}

function parseNeonDiscordRouteProbeState(value: unknown): TNeonDiscordRouteProbeState | undefined {
  return value === "running" || value === "stopped" || value === "unknown" ? value : undefined;
}

function isDropReason(value: unknown): value is TNeonDiscordDropReason | "unmapped-message" {
  return (
    value === "bot-author" ||
    value === "ignored-user" ||
    value === "ignored-mentioned-user" ||
    value === "guild-not-allowed" ||
    value === "channel-not-allowed" ||
    value === "mention-required" ||
    value === "empty-content" ||
    value === "unmapped-message"
  );
}

function isReplyState(
  value: unknown
): value is "delivered" | "review-pending" | "suppressed" | "skipped" | "transport-error" {
  return (
    value === "delivered" ||
    value === "review-pending" ||
    value === "suppressed" ||
    value === "skipped" ||
    value === "transport-error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
