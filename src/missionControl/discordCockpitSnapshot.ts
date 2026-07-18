import type { INeonHarnessRuntimeMetadata } from "../harness/types.js";
import {
  readNeonDeliveryReceipts,
  type INeonDeliveryReceipt,
  type TNeonDeliveryReceiptState
} from "../gateway/deliveryReceiptStore.js";
import {
  createUnknownNeonDiscordRouteProbe,
  readNeonDiscordRouteProbe,
  type INeonDiscordRouteProbe
} from "../gateway/discordRouteProbe.js";
import { resolveNeonCanaryChannelAllowlist } from "../gateway/outboundSender.js";
import { readNeonGatewayRuns } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";

export type TNeonMissionControlDiscordCockpitState = "live" | "stopped" | "unknown";
export type TNeonMissionControlDiscordSourceState = "ready" | "unavailable";
export type TNeonMissionControlDiscordScopeState = "allowed" | "blocked" | "unconfigured";

export interface INeonMissionControlDiscordCockpitSnapshot {
  readonly generatedAt: string;
  readonly accountId: string;
  readonly state: TNeonMissionControlDiscordCockpitState;
  readonly tap: {
    readonly running: boolean;
    readonly startedAt?: string;
    readonly stoppedAt?: string;
    readonly lastProbeAt?: string;
    readonly accepted: number;
    readonly dropped: number;
    readonly errors: number;
    readonly typingStarted: number;
    readonly reactionsSent: number;
  };
  readonly scope: {
    readonly configured: boolean;
    readonly allowedChannelIds: readonly string[];
    readonly violations: number;
  };
  readonly activeRuns: readonly INeonMissionControlDiscordActiveRun[];
  readonly staleRunningRuns: number;
  readonly progress: {
    readonly cardsStarted: number;
    readonly updates: number;
    readonly errors: number;
    readonly lastMessageId?: string;
  };
  readonly controls: {
    readonly accepted: number;
    readonly dropped: number;
    readonly lastState?: "stopped" | "idle" | "blocked" | "partial";
    readonly lastAt?: string;
  };
  readonly recovery: {
    readonly cardsStarted: number;
    readonly errors: number;
    readonly lastMessageId?: string;
  };
  readonly delivery: {
    readonly totals: INeonMissionControlDiscordDeliveryTotals;
    readonly recentReceipts: readonly INeonMissionControlDiscordDeliveryReceipt[];
  };
  readonly sources: {
    readonly tap: TNeonMissionControlDiscordSourceState;
    readonly runs: TNeonMissionControlDiscordSourceState;
    readonly deliveryReceipts: TNeonMissionControlDiscordSourceState;
  };
}

export interface INeonMissionControlDiscordActiveRun {
  readonly runId: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly startedAt: string;
  readonly harnessId: string;
  readonly runtime?: INeonMissionControlDiscordRuntime;
  readonly scope: TNeonMissionControlDiscordScopeState;
}

export interface INeonMissionControlDiscordRuntime {
  readonly provider: INeonHarnessRuntimeMetadata["provider"];
  readonly runtime: string;
  readonly model?: string;
  readonly effort?: string;
}

export interface INeonMissionControlDiscordDeliveryTotals {
  readonly receipts: number;
  readonly attempting: number;
  readonly delivered: number;
  readonly suppressed: number;
  readonly uncertain: number;
}

export interface INeonMissionControlDiscordDeliveryReceipt {
  readonly runId: string;
  readonly kind: "text" | "media" | "poll" | "embed";
  readonly state: TNeonDeliveryReceiptState;
  readonly attempts: number;
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly updatedAt: string;
  readonly scope: TNeonMissionControlDiscordScopeState;
}

export interface ICreateNeonMissionControlDiscordCockpitOptions {
  readonly accountId?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly activeRunMaxAgeMs?: number;
  readonly sourceStates?: Partial<INeonMissionControlDiscordCockpitSnapshot["sources"]>;
}

export interface IReadNeonMissionControlDiscordCockpitOptions {
  readonly accountId?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly maxReceipts?: number;
}

const maxCockpitReceipts = 8;
const defaultActiveRunMaxAgeMs = 24 * 60 * 60 * 1_000;

export async function readNeonMissionControlDiscordCockpitSnapshot(
  projectRoot: string,
  options: IReadNeonMissionControlDiscordCockpitOptions = {}
): Promise<INeonMissionControlDiscordCockpitSnapshot> {
  const env = options.env ?? process.env;
  const accountId = resolveAccountId(options.accountId, env);
  const [probeResult, runsResult, receiptsResult] = await Promise.allSettled([
    readNeonDiscordRouteProbe(projectRoot, accountId),
    readNeonGatewayRuns(projectRoot),
    readNeonDeliveryReceipts(
      projectRoot,
      options.maxReceipts === undefined ? {} : { maxReceipts: options.maxReceipts }
    )
  ]);
  const tapSourceReady = probeResult.status === "fulfilled" && probeResult.value.state !== "unknown";
  return createNeonMissionControlDiscordCockpitSnapshot(
    probeResult.status === "fulfilled"
      ? probeResult.value
      : createUnknownNeonDiscordRouteProbe(accountId),
    runsResult.status === "fulfilled" ? runsResult.value : [],
    receiptsResult.status === "fulfilled" ? receiptsResult.value : [],
    {
      accountId,
      env,
      ...(options.now ? { now: options.now } : {}),
      sourceStates: {
        tap: tapSourceReady ? "ready" : "unavailable",
        runs: runsResult.status === "fulfilled" ? "ready" : "unavailable",
        deliveryReceipts: receiptsResult.status === "fulfilled" ? "ready" : "unavailable"
      }
    }
  );
}

export function createNeonMissionControlDiscordCockpitSnapshot(
  probe: INeonDiscordRouteProbe,
  runs: readonly INeonGatewayShadowRun[],
  receipts: readonly INeonDeliveryReceipt[],
  options: ICreateNeonMissionControlDiscordCockpitOptions = {}
): INeonMissionControlDiscordCockpitSnapshot {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? new Date();
  const accountId = resolveAccountId(options.accountId ?? probe.accountId, env);
  const envAllowlist = resolveNeonCanaryChannelAllowlist(env);
  const allowedChannelIds = probe.allowedChannelIds
    ? [...new Set(probe.allowedChannelIds)].sort()
    : [...envAllowlist.channels].sort();
  const allowedChannels = new Set(allowedChannelIds);
  const scopeConfigured = probe.allowedChannelIds !== undefined
    ? allowedChannelIds.length > 0
    : envAllowlist.configured;
  const discordRuns = runs.filter(
    (run) => run.request.channel === "discord" && run.request.accountId === accountId
  );
  const activeRunMaxAgeMs = normalizeActiveRunMaxAgeMs(options.activeRunMaxAgeMs);
  const runningRuns = discordRuns.filter((run) => run.status === "running");
  const activeRunCandidates = runningRuns.filter(
    (run) => isPersistedRunActive(run, now.getTime(), activeRunMaxAgeMs)
  );
  const activeRuns = activeRunCandidates
    .map((run) => toActiveRun(run, scopeConfigured, allowedChannels));
  const projectedReceipts = receipts
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map((receipt) => toDeliveryReceipt(receipt, scopeConfigured, allowedChannels));
  const recentReceipts = projectedReceipts.slice(0, maxCockpitReceipts);
  const violations = [
    ...activeRuns.map((run) => run.scope),
    ...projectedReceipts.map((receipt) => receipt.scope)
  ].filter((scope) => scope === "blocked").length;

  return {
    generatedAt: now.toISOString(),
    accountId,
    state: resolveCockpitState(probe),
    tap: {
      running: probe.running,
      ...(probe.startedAt ? { startedAt: probe.startedAt } : {}),
      ...(probe.stoppedAt ? { stoppedAt: probe.stoppedAt } : {}),
      ...(probe.lastProbeAt ? { lastProbeAt: probe.lastProbeAt } : {}),
      accepted: probe.stats.accepted,
      dropped: probe.stats.dropped,
      errors: probe.stats.errors,
      typingStarted: probe.stats.typingStarted ?? 0,
      reactionsSent: probe.stats.reactionsSent ?? 0
    },
    scope: {
      configured: scopeConfigured,
      allowedChannelIds,
      violations
    },
    activeRuns,
    staleRunningRuns: runningRuns.length - activeRunCandidates.length,
    progress: {
      cardsStarted: probe.stats.progressCardsStarted ?? 0,
      updates: probe.stats.progressCardUpdates ?? 0,
      errors: probe.stats.progressCardErrors ?? 0,
      ...(probe.stats.lastProgressCardMessageId
        ? { lastMessageId: probe.stats.lastProgressCardMessageId }
        : {})
    },
    controls: {
      accepted: probe.stats.controlsAccepted ?? 0,
      dropped: probe.stats.controlsDropped ?? 0,
      ...(probe.stats.lastControlState ? { lastState: probe.stats.lastControlState } : {}),
      ...(probe.stats.lastControlAt ? { lastAt: probe.stats.lastControlAt } : {})
    },
    recovery: {
      cardsStarted: probe.stats.recoveryCardsStarted ?? 0,
      errors: probe.stats.recoveryCardErrors ?? 0,
      ...(probe.stats.lastRecoveryCardMessageId
        ? { lastMessageId: probe.stats.lastRecoveryCardMessageId }
        : {})
    },
    delivery: {
      totals: summarizeReceipts(receipts),
      recentReceipts
    },
    sources: {
      tap: options.sourceStates?.tap ?? "ready",
      runs: options.sourceStates?.runs ?? "ready",
      deliveryReceipts: options.sourceStates?.deliveryReceipts ?? "ready"
    }
  };
}

export function createUnknownNeonMissionControlDiscordCockpitSnapshot(
  accountId = "default",
  generatedAt = new Date().toISOString()
): INeonMissionControlDiscordCockpitSnapshot {
  const normalizedGeneratedAt = Number.isFinite(Date.parse(generatedAt))
    ? new Date(Date.parse(generatedAt)).toISOString()
    : new Date(0).toISOString();
  return createNeonMissionControlDiscordCockpitSnapshot(
    createUnknownNeonDiscordRouteProbe(accountId),
    [],
    [],
    {
      accountId,
      now: () => new Date(normalizedGeneratedAt),
      env: {},
      sourceStates: {
        tap: "unavailable",
        runs: "unavailable",
        deliveryReceipts: "unavailable"
      }
    }
  );
}

export function parseNeonMissionControlDiscordCockpitSnapshot(
  value: unknown
): INeonMissionControlDiscordCockpitSnapshot | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const state = parseCockpitState(value["state"]);
  const tap = parseTap(value["tap"]);
  const scope = parseScope(value["scope"]);
  const activeRuns = parseActiveRuns(value["activeRuns"]);
  const staleRunningRuns = readCount(value["staleRunningRuns"]);
  const progress = parseProgress(value["progress"]);
  const controls = parseControls(value["controls"]);
  const recovery = parseRecovery(value["recovery"]);
  const delivery = parseDelivery(value["delivery"]);
  const sources = parseSources(value["sources"]);
  if (
    typeof value["generatedAt"] !== "string" ||
    typeof value["accountId"] !== "string" ||
    !state ||
    !tap ||
    !scope ||
    !activeRuns ||
    staleRunningRuns === undefined ||
    !progress ||
    !controls ||
    !recovery ||
    !delivery ||
    !sources
  ) {
    return undefined;
  }
  return {
    generatedAt: value["generatedAt"],
    accountId: value["accountId"],
    state,
    tap,
    scope,
    activeRuns,
    staleRunningRuns,
    progress,
    controls,
    recovery,
    delivery,
    sources
  };
}

function toActiveRun(
  run: INeonGatewayShadowRun,
  scopeConfigured: boolean,
  allowedChannels: ReadonlySet<string>
): INeonMissionControlDiscordActiveRun {
  return {
    runId: run.runId,
    channelId: run.request.channelId,
    ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
    startedAt: run.startedAt,
    harnessId: run.harnessId,
    ...(run.runtime ? { runtime: toRuntime(run.runtime) } : {}),
    scope: resolveScope(run.request.channelId, scopeConfigured, allowedChannels)
  };
}

function toRuntime(runtime: INeonHarnessRuntimeMetadata): INeonMissionControlDiscordRuntime {
  return {
    provider: runtime.provider,
    runtime: runtime.runtime,
    ...(runtime.model ? { model: runtime.model } : {}),
    ...(runtime.effort ? { effort: runtime.effort } : {})
  };
}

function toDeliveryReceipt(
  receipt: INeonDeliveryReceipt,
  scopeConfigured: boolean,
  allowedChannels: ReadonlySet<string>
): INeonMissionControlDiscordDeliveryReceipt {
  return {
    runId: receipt.runId,
    kind: receipt.kind,
    state: receipt.state,
    attempts: receipt.attempts,
    channelId: receipt.channelId,
    ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
    ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
    updatedAt: receipt.updatedAt,
    scope: resolveScope(receipt.channelId, scopeConfigured, allowedChannels)
  };
}

function summarizeReceipts(receipts: readonly INeonDeliveryReceipt[]): INeonMissionControlDiscordDeliveryTotals {
  return {
    receipts: receipts.length,
    attempting: receipts.filter((receipt) => receipt.state === "attempting").length,
    delivered: receipts.filter((receipt) => receipt.state === "delivered").length,
    suppressed: receipts.filter((receipt) => receipt.state === "suppressed").length,
    uncertain: receipts.filter((receipt) => receipt.state === "uncertain").length
  };
}

function resolveScope(
  channelId: string,
  configured: boolean,
  allowedChannels: ReadonlySet<string>
): TNeonMissionControlDiscordScopeState {
  if (!configured) {
    return "unconfigured";
  }
  return allowedChannels.has(channelId) ? "allowed" : "blocked";
}

function resolveCockpitState(probe: INeonDiscordRouteProbe): TNeonMissionControlDiscordCockpitState {
  if (probe.state === "running" && probe.running) {
    return "live";
  }
  return probe.state === "stopped" ? "stopped" : "unknown";
}

function isPersistedRunActive(
  run: INeonGatewayShadowRun,
  nowMs: number,
  maxAgeMs: number
): boolean {
  const startedAtMs = Date.parse(run.startedAt);
  return Number.isFinite(startedAtMs) && startedAtMs <= nowMs && nowMs - startedAtMs <= maxAgeMs;
}

function normalizeActiveRunMaxAgeMs(value: number | undefined): number {
  const maxAgeMs = value ?? defaultActiveRunMaxAgeMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 60_000 || maxAgeMs > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error("Discord cockpit activeRunMaxAgeMs must be between 1 minute and 7 days");
  }
  return maxAgeMs;
}

function resolveAccountId(
  explicit: string | undefined,
  env: Readonly<Record<string, string | undefined>>
): string {
  return explicit?.trim() || env["NEON_DISCORD_ACCOUNT_ID"]?.trim() || "default";
}

function parseCockpitState(value: unknown): TNeonMissionControlDiscordCockpitState | undefined {
  return value === "live" || value === "stopped" || value === "unknown" ? value : undefined;
}

function parseTap(value: unknown): INeonMissionControlDiscordCockpitSnapshot["tap"] | undefined {
  if (!isRecord(value) || typeof value["running"] !== "boolean") {
    return undefined;
  }
  const accepted = readCount(value["accepted"]);
  const dropped = readCount(value["dropped"]);
  const errors = readCount(value["errors"]);
  const typingStarted = readCount(value["typingStarted"]);
  const reactionsSent = readCount(value["reactionsSent"]);
  if (accepted === undefined || dropped === undefined || errors === undefined || typingStarted === undefined || reactionsSent === undefined) {
    return undefined;
  }
  return {
    running: value["running"],
    ...(typeof value["startedAt"] === "string" ? { startedAt: value["startedAt"] } : {}),
    ...(typeof value["stoppedAt"] === "string" ? { stoppedAt: value["stoppedAt"] } : {}),
    ...(typeof value["lastProbeAt"] === "string" ? { lastProbeAt: value["lastProbeAt"] } : {}),
    accepted,
    dropped,
    errors,
    typingStarted,
    reactionsSent
  };
}

function parseScope(value: unknown): INeonMissionControlDiscordCockpitSnapshot["scope"] | undefined {
  if (!isRecord(value) || typeof value["configured"] !== "boolean" || !Array.isArray(value["allowedChannelIds"])) {
    return undefined;
  }
  const ids = value["allowedChannelIds"];
  const violations = readCount(value["violations"]);
  return ids.every((id): id is string => typeof id === "string") && violations !== undefined
    ? { configured: value["configured"], allowedChannelIds: ids, violations }
    : undefined;
}

function parseActiveRuns(value: unknown): readonly INeonMissionControlDiscordActiveRun[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const runs = value.map(parseActiveRun);
  return runs.every((run): run is INeonMissionControlDiscordActiveRun => run !== undefined) ? runs : undefined;
}

function parseActiveRun(value: unknown): INeonMissionControlDiscordActiveRun | undefined {
  if (!isRecord(value) || typeof value["runId"] !== "string" || typeof value["channelId"] !== "string" || typeof value["startedAt"] !== "string" || typeof value["harnessId"] !== "string") {
    return undefined;
  }
  const scope = parseScopeState(value["scope"]);
  const runtime = value["runtime"] === undefined ? undefined : parseRuntime(value["runtime"]);
  if (!scope || (value["runtime"] !== undefined && !runtime)) {
    return undefined;
  }
  return {
    runId: value["runId"],
    channelId: value["channelId"],
    ...(typeof value["threadId"] === "string" ? { threadId: value["threadId"] } : {}),
    startedAt: value["startedAt"],
    harnessId: value["harnessId"],
    ...(runtime ? { runtime } : {}),
    scope
  };
}

function parseRuntime(value: unknown): INeonMissionControlDiscordRuntime | undefined {
  if (!isRecord(value) || (value["provider"] !== "openai" && value["provider"] !== "anthropic") || typeof value["runtime"] !== "string") {
    return undefined;
  }
  return {
    provider: value["provider"],
    runtime: value["runtime"],
    ...(typeof value["model"] === "string" ? { model: value["model"] } : {}),
    ...(typeof value["effort"] === "string" ? { effort: value["effort"] } : {})
  };
}

function parseProgress(value: unknown): INeonMissionControlDiscordCockpitSnapshot["progress"] | undefined {
  return parseCounterGroup(value, ["cardsStarted", "updates", "errors"], "lastMessageId");
}

function parseRecovery(value: unknown): INeonMissionControlDiscordCockpitSnapshot["recovery"] | undefined {
  return parseCounterGroup(value, ["cardsStarted", "errors"], "lastMessageId");
}

function parseControls(value: unknown): INeonMissionControlDiscordCockpitSnapshot["controls"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const accepted = readCount(value["accepted"]);
  const dropped = readCount(value["dropped"]);
  const lastState = value["lastState"];
  if (
    accepted === undefined ||
    dropped === undefined ||
    (lastState !== undefined && lastState !== "stopped" && lastState !== "idle" && lastState !== "blocked" && lastState !== "partial")
  ) {
    return undefined;
  }
  return {
    accepted,
    dropped,
    ...(lastState ? { lastState } : {}),
    ...(typeof value["lastAt"] === "string" ? { lastAt: value["lastAt"] } : {})
  };
}

function parseCounterGroup<TKeys extends string>(
  value: unknown,
  keys: readonly TKeys[],
  optionalStringKey: string
): (Record<TKeys, number> & { readonly lastMessageId?: string }) | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = keys.map((key) => [key, readCount(value[key])] as const);
  if (entries.some((entry) => entry[1] === undefined)) {
    return undefined;
  }
  return {
    ...Object.fromEntries(entries.map(([key, count]) => [key, count ?? 0])) as Record<TKeys, number>,
    ...(typeof value[optionalStringKey] === "string"
      ? { lastMessageId: value[optionalStringKey] }
      : {})
  };
}

function parseDelivery(value: unknown): INeonMissionControlDiscordCockpitSnapshot["delivery"] | undefined {
  if (!isRecord(value) || !isRecord(value["totals"]) || !Array.isArray(value["recentReceipts"])) {
    return undefined;
  }
  const totals = value["totals"];
  const parsedTotals = {
    receipts: readCount(totals["receipts"]),
    attempting: readCount(totals["attempting"]),
    delivered: readCount(totals["delivered"]),
    suppressed: readCount(totals["suppressed"]),
    uncertain: readCount(totals["uncertain"])
  };
  if (Object.values(parsedTotals).some((count) => count === undefined)) {
    return undefined;
  }
  const receipts = value["recentReceipts"].map(parseDeliveryReceipt);
  if (!receipts.every((receipt): receipt is INeonMissionControlDiscordDeliveryReceipt => receipt !== undefined)) {
    return undefined;
  }
  return {
    totals: {
      receipts: parsedTotals.receipts ?? 0,
      attempting: parsedTotals.attempting ?? 0,
      delivered: parsedTotals.delivered ?? 0,
      suppressed: parsedTotals.suppressed ?? 0,
      uncertain: parsedTotals.uncertain ?? 0
    },
    recentReceipts: receipts
  };
}

function parseDeliveryReceipt(value: unknown): INeonMissionControlDiscordDeliveryReceipt | undefined {
  if (!isRecord(value) || typeof value["runId"] !== "string" || (value["kind"] !== "text" && value["kind"] !== "media") || typeof value["channelId"] !== "string" || typeof value["updatedAt"] !== "string") {
    return undefined;
  }
  const state = parseReceiptState(value["state"]);
  const attempts = readCount(value["attempts"]);
  const scope = parseScopeState(value["scope"]);
  if (!state || attempts === undefined || !scope) {
    return undefined;
  }
  return {
    runId: value["runId"],
    kind: value["kind"],
    state,
    attempts,
    channelId: value["channelId"],
    ...(typeof value["threadId"] === "string" ? { threadId: value["threadId"] } : {}),
    ...(typeof value["messageId"] === "string" ? { messageId: value["messageId"] } : {}),
    updatedAt: value["updatedAt"],
    scope
  };
}

function parseSources(value: unknown): INeonMissionControlDiscordCockpitSnapshot["sources"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tap = parseSourceState(value["tap"]);
  const runs = parseSourceState(value["runs"]);
  const deliveryReceipts = parseSourceState(value["deliveryReceipts"]);
  return tap && runs && deliveryReceipts ? { tap, runs, deliveryReceipts } : undefined;
}

function parseSourceState(value: unknown): TNeonMissionControlDiscordSourceState | undefined {
  return value === "ready" || value === "unavailable" ? value : undefined;
}

function parseScopeState(value: unknown): TNeonMissionControlDiscordScopeState | undefined {
  return value === "allowed" || value === "blocked" || value === "unconfigured" ? value : undefined;
}

function parseReceiptState(value: unknown): TNeonDeliveryReceiptState | undefined {
  return value === "attempting" || value === "delivered" || value === "suppressed" || value === "uncertain"
    ? value
    : undefined;
}

function readCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
