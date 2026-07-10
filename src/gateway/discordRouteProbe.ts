import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TNeonDiscordDropReason } from "./discordIngress.js";
import { resolveGatewayStatePaths } from "./runStore.js";

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
  readonly lastReactionState?: "queued" | "done" | "error";
  readonly lastReactionOutcome?: "sent" | "failed";
  readonly lastRunId?: string;
  readonly lastReplyState?: "delivered" | "suppressed" | "skipped" | "transport-error";
  readonly lastReplyMessageId?: string;
  readonly lastDropReason?: TNeonDiscordDropReason | "unmapped-message";
  readonly lastErrorMessage?: string;
}

export interface INeonDiscordRouteProbe {
  readonly channel: "discord";
  readonly accountId: string;
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
    ...(value["lastReactionState"] === "queued" ||
    value["lastReactionState"] === "done" ||
    value["lastReactionState"] === "error"
      ? { lastReactionState: value["lastReactionState"] }
      : {}),
    ...(value["lastReactionOutcome"] === "sent" || value["lastReactionOutcome"] === "failed"
      ? { lastReactionOutcome: value["lastReactionOutcome"] }
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
): value is "delivered" | "suppressed" | "skipped" | "transport-error" {
  return (
    value === "delivered" ||
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
