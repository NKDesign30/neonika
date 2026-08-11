import { isHarnessEventHiddenFromChannelProgress, type TCodexHarnessEvent } from "../harness/types.js";
import { loadNeonCutoverEnv } from "../core/cutoverPromotion.js";
import type {
  INeonGatewayRunSummary,
  INeonGatewayStatus
} from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import {
  evaluateNeonCanaryLivePreconditions,
  type INeonCanaryLivePreconditions
} from "../gateway/outboundSender.js";
import {
  createUnknownNeonMissionControlDiscordCockpitSnapshot,
  parseNeonMissionControlDiscordCockpitSnapshot,
  type INeonMissionControlDiscordCockpitSnapshot
} from "./discordCockpitSnapshot.js";

export interface INeonMissionControlGatewaySnapshot {
  readonly generatedAt: string;
  readonly title: "Neonika Gateway";
  readonly state: INeonGatewayStatus["state"];
  readonly totals: INeonMissionControlGatewayTotals;
  readonly latestRun?: INeonGatewayRunSummary;
  readonly recentRuns: readonly INeonGatewayRunSummary[];
  /** Leak-safe overview of the most recent harness events across the returned runs. */
  readonly recentEvents: readonly INeonMissionControlGatewayEvent[];
  /** Leak-safe canary outbound readiness (booleans + channel id, never the token). */
  readonly canaryPosture: INeonCanaryLivePreconditions;
  /** Persisted Discord entry-point truth: tap, active runs, controls, progress and receipts. */
  readonly discordCockpit: INeonMissionControlDiscordCockpitSnapshot;
  readonly source: INeonMissionControlGatewaySource;
}

export interface INeonMissionControlGatewayTotals {
  readonly runs: number;
  readonly shadowRuns: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly running: number;
  readonly deliverySuppressed: number;
}

/**
 * A single overview event entry. Carries only the run id, the event kind, and a
 * bounded, non-sensitive `label` (tool name, exit code, or kind) — never raw
 * tool output, command text, file paths, final text, or failure messages. This
 * keeps the dashboard event log leak-safe by construction.
 */
export interface INeonMissionControlGatewayEvent {
  readonly runId: string;
  readonly kind: TCodexHarnessEvent["kind"];
  readonly label: string;
}

const maxRecentMissionControlEvents = 20;

export interface INeonMissionControlGatewaySource {
  readonly gatewayStatusPath: "/api/neon-gateway/status";
  readonly gatewayRunsPath: "/api/neon-gateway/runs";
  readonly runsPath: string;
}

export interface ICreateGatewaySnapshotOptions {
  readonly now?: () => Date;
  /**
   * Env source for the leak-safe canary outbound posture. Defaults to
   * `process.env`. Only booleans + the channel id are projected, never the token.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly discordCockpit?: INeonMissionControlDiscordCockpitSnapshot;
}

export interface IFetchGatewaySnapshotOptions {
  readonly recentRunsLimit?: number;
}

export function createNeonMissionControlGatewaySnapshot(
  status: INeonGatewayStatus,
  runs: readonly INeonGatewayShadowRun[],
  options: ICreateGatewaySnapshotOptions = {}
): INeonMissionControlGatewaySnapshot {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const env = options.env ?? process.env;
  const recentRuns = runs.map((run) => ({
    runId: run.runId,
    mode: run.mode,
    status: run.status,
    channel: run.request.channel,
    channelId: run.request.channelId,
    agentId: run.request.agentId,
    memoryState: run.memoryState,
    deliveryState: run.delivery.state,
    startedAt: run.startedAt,
    completedAt: run.completedAt
  }));

  return {
    generatedAt,
    title: "Neonika Gateway",
    state: status.state,
    totals: {
      runs: status.runCount,
      shadowRuns: status.shadowRunCount,
      completed: status.completedCount,
      failed: status.failedCount,
      cancelled: status.cancelledCount,
      running: status.runningCount,
      deliverySuppressed: status.deliverySuppressedCount
    },
    recentRuns,
    recentEvents: deriveRecentMissionControlEvents(runs),
    canaryPosture: evaluateNeonCanaryLivePreconditions(env),
    discordCockpit: options.discordCockpit ?? createUnknownNeonMissionControlDiscordCockpitSnapshot(
      env["NEON_DISCORD_ACCOUNT_ID"]?.trim() || "default",
      generatedAt
    ),
    source: {
      gatewayStatusPath: "/api/neon-gateway/status",
      gatewayRunsPath: "/api/neon-gateway/runs",
      runsPath: status.runsPath
    },
    ...(status.latestRun ? { latestRun: status.latestRun } : {})
  };
}

/**
 * Builds a live boundary snapshot from the latest persisted outbound state.
 * Call this for HTTP, SSR and WebSocket responses; keep the synchronous builder
 * above for already-resolved data and pure projections.
 */
export async function createLiveNeonMissionControlGatewaySnapshot(
  projectRoot: string,
  status: INeonGatewayStatus,
  runs: readonly INeonGatewayShadowRun[],
  options: ICreateGatewaySnapshotOptions = {}
): Promise<INeonMissionControlGatewaySnapshot> {
  const env = await loadNeonCutoverEnv(projectRoot, options.env ?? process.env);
  return createNeonMissionControlGatewaySnapshot(status, runs, { ...options, env });
}

export async function fetchNeonMissionControlGatewaySnapshot(
  baseUrl: string,
  options: IFetchGatewaySnapshotOptions = {}
): Promise<INeonMissionControlGatewaySnapshot> {
  const url = new URL("/api/neon-mission-control/gateway", baseUrl);

  if (options.recentRunsLimit !== undefined) {
    url.searchParams.set("limit", String(options.recentRunsLimit));
  }

  const response = await fetch(url);
  const payload: unknown = JSON.parse(await response.text());

  if (!response.ok) {
    throw new Error(`Mission Control gateway snapshot failed with HTTP ${response.status}`);
  }

  const snapshot = parseNeonMissionControlGatewaySnapshot(payload);

  if (!snapshot) {
    throw new Error("Mission Control gateway snapshot response was malformed");
  }

  return snapshot;
}

export function parseNeonMissionControlGatewaySnapshot(
  value: unknown
): INeonMissionControlGatewaySnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const totals = parseTotals(value["totals"]);
  const source = parseSource(value["source"]);
  const recentRuns = parseRunSummaries(value["recentRuns"]);
  const recentEvents = parseRecentMissionControlEvents(value["recentEvents"]);
  const latestRun = parseRunSummary(value["latestRun"]);
  const discordCockpit = value["discordCockpit"] === undefined
    ? createUnknownNeonMissionControlDiscordCockpitSnapshot(
        "default",
        typeof value["generatedAt"] === "string" ? value["generatedAt"] : new Date(0).toISOString()
      )
    : parseNeonMissionControlDiscordCockpitSnapshot(value["discordCockpit"]);

  if (
    typeof value["generatedAt"] !== "string" ||
    value["title"] !== "Neonika Gateway" ||
    value["state"] !== "ready" ||
    !totals ||
    !source ||
    !recentRuns ||
    !discordCockpit
  ) {
    return undefined;
  }

  return {
    generatedAt: value["generatedAt"],
    title: "Neonika Gateway",
    state: "ready",
    totals,
    recentRuns,
    recentEvents,
    canaryPosture: parseCanaryPosture(value["canaryPosture"]),
    discordCockpit,
    source,
    ...(latestRun ? { latestRun } : {})
  };
}

const suppressedCanaryPosture: INeonCanaryLivePreconditions = {
  tokenPresent: false,
  channelConfigured: false,
  singleChannel: false,
  stageIsCanary: false,
  stageAllowsOutbound: false,
  canaryApproved: false,
  outboundEnabled: false,
  ready: false
};

/**
 * Parses a serialized canary posture leniently. Missing or malformed posture
 * (older snapshots) defaults to fully suppressed — never to a ready/open state.
 */
function parseCanaryPosture(value: unknown): INeonCanaryLivePreconditions {
  if (!isRecord(value)) {
    return suppressedCanaryPosture;
  }

  const channelId = value["channelId"];

  return {
    tokenPresent: value["tokenPresent"] === true,
    channelConfigured: value["channelConfigured"] === true,
    singleChannel: value["singleChannel"] === true,
    stageIsCanary: value["stageIsCanary"] === true,
    stageAllowsOutbound: value["stageAllowsOutbound"] === true,
    canaryApproved: value["canaryApproved"] === true,
    outboundEnabled: value["outboundEnabled"] === true,
    ready: value["ready"] === true,
    ...(typeof channelId === "string" ? { channelId } : {})
  };
}

function parseTotals(value: unknown): INeonMissionControlGatewayTotals | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value["runs"] !== "number" ||
    typeof value["shadowRuns"] !== "number" ||
    typeof value["completed"] !== "number" ||
    typeof value["failed"] !== "number" ||
    typeof value["deliverySuppressed"] !== "number"
  ) {
    return undefined;
  }

  return {
    runs: value["runs"],
    shadowRuns: value["shadowRuns"],
    completed: value["completed"],
    failed: value["failed"],
    cancelled: typeof value["cancelled"] === "number" ? value["cancelled"] : 0,
    running: typeof value["running"] === "number" ? value["running"] : 0,
    deliverySuppressed: value["deliverySuppressed"]
  };
}

function parseSource(value: unknown): INeonMissionControlGatewaySource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value["gatewayStatusPath"] !== "/api/neon-gateway/status" ||
    value["gatewayRunsPath"] !== "/api/neon-gateway/runs" ||
    typeof value["runsPath"] !== "string"
  ) {
    return undefined;
  }

  return {
    gatewayStatusPath: "/api/neon-gateway/status",
    gatewayRunsPath: "/api/neon-gateway/runs",
    runsPath: value["runsPath"]
  };
}

function parseRunSummaries(value: unknown): readonly INeonGatewayRunSummary[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const summaries = value.map(parseRunSummary);

  return summaries.every((summary): summary is INeonGatewayRunSummary => summary !== undefined)
    ? summaries
    : undefined;
}

function parseRunSummary(value: unknown): INeonGatewayRunSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const mode = value["mode"];
  const deliveryState = value["deliveryState"];

  if (
    typeof value["runId"] !== "string" ||
    (mode !== "shadow" && mode !== "live") ||
    (value["status"] !== "running" &&
      value["status"] !== "completed" &&
      value["status"] !== "failed" &&
      value["status"] !== "cancelled") ||
    !isNeonChannel(value["channel"]) ||
    typeof value["channelId"] !== "string" ||
    typeof value["agentId"] !== "string" ||
    !isMemoryState(value["memoryState"]) ||
    (deliveryState !== "suppressed" && deliveryState !== "delivered") ||
    typeof value["startedAt"] !== "string" ||
    typeof value["completedAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    runId: value["runId"],
    mode,
    status: value["status"],
    channel: value["channel"],
    channelId: value["channelId"],
    agentId: value["agentId"],
    memoryState: value["memoryState"],
    deliveryState,
    startedAt: value["startedAt"],
    completedAt: value["completedAt"]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNeonChannel(value: unknown): value is INeonGatewayRunSummary["channel"] {
  return (
    value === "discord" ||
    value === "telegram" ||
    value === "whatsapp" ||
    value === "webchat" ||
    value === "cli" ||
    value === "device"
  );
}

function isMemoryState(value: unknown): value is INeonGatewayRunSummary["memoryState"] {
  return value === "attached" || value === "skipped" || value === "failed";
}

function deriveRecentMissionControlEvents(
  runs: readonly INeonGatewayShadowRun[]
): readonly INeonMissionControlGatewayEvent[] {
  const events: INeonMissionControlGatewayEvent[] = [];
  for (const run of runs) {
    for (const event of run.events) {
      if (events.length >= maxRecentMissionControlEvents) {
        return events;
      }
      if (isHarnessEventHiddenFromChannelProgress(event)) {
        continue;
      }
      events.push({ runId: run.runId, kind: event.kind, label: safeEventLabel(event) });
    }
  }
  return events;
}

/**
 * Map a harness event to a bounded, non-sensitive label. Only stable
 * identifiers (tool name, exit code) or the kind itself are surfaced — never
 * raw output, command text, file paths, final text, or failure messages.
 */
function safeEventLabel(event: TCodexHarnessEvent): string {
  switch (event.kind) {
    case "assistant-delta":
      return "assistant";
    case "tool-start":
    case "tool-output":
      return `tool:${event.toolName}`;
    case "file-write":
      return "file-write";
    case "command-exit":
      return `exit:${event.exitCode}`;
    case "token-usage":
      return "token-usage";
    case "final":
      return "final";
    case "failed":
      return "failed";
  }
}

function parseRecentMissionControlEvents(
  value: unknown
): readonly INeonMissionControlGatewayEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const events: INeonMissionControlGatewayEvent[] = [];
  for (const entry of value) {
    if (
      isRecord(entry) &&
      typeof entry["runId"] === "string" &&
      isHarnessEventKind(entry["kind"]) &&
      typeof entry["label"] === "string"
    ) {
      events.push({ runId: entry["runId"], kind: entry["kind"], label: entry["label"] });
    }
  }

  return events;
}

function isHarnessEventKind(value: unknown): value is TCodexHarnessEvent["kind"] {
  return (
    value === "assistant-delta" ||
    value === "tool-start" ||
    value === "tool-output" ||
    value === "file-write" ||
    value === "command-exit" ||
    value === "token-usage" ||
    value === "final" ||
    value === "failed"
  );
}
