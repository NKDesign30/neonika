import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactHarnessEvent, redactText } from "../harness/redaction.js";
import { isNeonHarnessId } from "../harness/types.js";
import type {
  TCodexHarnessEvent,
  THarnessRunMode,
  TMemoryAttachmentState,
  TNeonChannel
} from "../harness/types.js";
import type {
  INeonGatewayDeliveryResult,
  INeonGatewayPersistedFinding,
  INeonGatewayRunRequest,
  INeonGatewayShadowRun,
  TNeonGatewayDeliveryState,
  TNeonGatewayRunMode,
  TNeonGatewayRunStatus
} from "./types.js";
import type {
  TNeonExternalContentPatternId,
  TNeonExternalContentSeverity
} from "../security/externalContent.js";

const DEFAULT_STATE_ROOT = "state";
const GATEWAY_STATE_DIR = "gateway";
const GATEWAY_RUNS_FILE = "runs.jsonl";

export interface INeonGatewayStatePaths {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly gatewayRoot: string;
  readonly runsPath: string;
}

export interface INeonGatewayRunStoreReadOptions {
  readonly maxRuns?: number;
}

export interface INeonGatewayRunSummary {
  readonly runId: string;
  readonly mode: TNeonGatewayRunMode;
  readonly status: TNeonGatewayRunStatus;
  readonly channel: TNeonChannel;
  readonly channelId: string;
  readonly agentId: string;
  readonly memoryState: TMemoryAttachmentState;
  readonly deliveryState: TNeonGatewayDeliveryState;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface INeonGatewayStatus {
  readonly state: "ready";
  readonly projectRoot: string;
  readonly runsPath: string;
  readonly runCount: number;
  readonly shadowRunCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly runningCount: number;
  readonly deliverySuppressedCount: number;
  readonly latestRun?: INeonGatewayRunSummary;
}

export function resolveGatewayStatePaths(projectRoot: string): INeonGatewayStatePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, DEFAULT_STATE_ROOT);
  const gatewayRoot = join(stateRoot, GATEWAY_STATE_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    stateRoot,
    gatewayRoot,
    runsPath: join(gatewayRoot, GATEWAY_RUNS_FILE)
  };
}

export async function writeNeonGatewayRun(
  projectRoot: string,
  run: INeonGatewayShadowRun
): Promise<void> {
  const paths = resolveGatewayStatePaths(projectRoot);
  const safeRun = redactGatewayRun(run);

  await mkdir(dirname(paths.runsPath), { recursive: true });
  await appendFile(paths.runsPath, `${JSON.stringify(safeRun)}\n`, "utf8");
}

export async function writeNeonGatewayRunLatest(
  projectRoot: string,
  run: INeonGatewayShadowRun
): Promise<void> {
  const paths = resolveGatewayStatePaths(projectRoot);
  const safeRun = redactGatewayRun(run);
  const safeLine = JSON.stringify(safeRun);

  await mkdir(dirname(paths.runsPath), { recursive: true });

  let existingLines: readonly string[] = [];
  try {
    const raw = await readFile(paths.runsPath, "utf8");
    existingLines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }

  const keptLines = existingLines.filter((line) => {
    const parsed = parseGatewayRunLine(line);
    return parsed === undefined || parsed.runId !== safeRun.runId;
  });
  await writeFile(paths.runsPath, `${[...keptLines, safeLine].join("\n")}\n`, "utf8");
}

export async function readNeonGatewayRuns(
  projectRoot: string,
  options: INeonGatewayRunStoreReadOptions = {}
): Promise<readonly INeonGatewayShadowRun[]> {
  const paths = resolveGatewayStatePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.runsPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const runs = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseGatewayRunLine)
    .filter((run): run is INeonGatewayShadowRun => run !== undefined);

  return options.maxRuns ? runs.slice(-options.maxRuns) : runs;
}

export async function readNeonGatewayStatus(projectRoot: string): Promise<INeonGatewayStatus> {
  const paths = resolveGatewayStatePaths(projectRoot);
  const runs = await readNeonGatewayRuns(projectRoot);
  const latestRun = runs.at(-1);
  const latestRunSummary = latestRun ? summarizeGatewayRun(latestRun) : undefined;

  return {
    state: "ready",
    projectRoot: paths.projectRoot,
    runsPath: paths.runsPath,
    runCount: runs.length,
    shadowRunCount: runs.filter((run) => run.mode === "shadow").length,
    completedCount: runs.filter((run) => run.status === "completed").length,
    failedCount: runs.filter((run) => run.status === "failed").length,
    runningCount: runs.filter((run) => run.status === "running").length,
    deliverySuppressedCount: runs.filter((run) => run.delivery.state === "suppressed").length,
    ...(latestRunSummary ? { latestRun: latestRunSummary } : {})
  };
}

export interface INeonGatewayRunQueryFilter {
  readonly mode?: TNeonGatewayRunMode;
  readonly status?: TNeonGatewayRunStatus;
  readonly agentId?: string;
  readonly hasSuspiciousFindings?: boolean;
  readonly memoryState?: TMemoryAttachmentState;
  /**
   * Exact match on the run's outbound delivery state.
   *
   * Use this when selecting runs that are in a specific delivery state (e.g. all
   * shadow-suppressed runs).
   */
  readonly deliveryState?: TNeonGatewayDeliveryState;
  /**
   * Negated match on the run's outbound delivery state: keeps every run whose
   * delivery state differs from the given value.
   *
   * Modelled as an explicit negation field (rather than deriving the count from
   * runs.length minus an exact-match query) because the Doctor's Delivery check
   * needs the actual unsafe run objects to report their run IDs, not just a
   * count. Under shadow/mirror the Doctor uses `deliveryStateNot: "suppressed"`
   * to flag any run that escaped suppression; under canary/primary a `delivered`
   * run is the expected outcome and is matched with `deliveryState: "delivered"`.
   */
  readonly deliveryStateNot?: TNeonGatewayDeliveryState;
}

/**
 * Pure, read-only filter over an already-loaded set of Gateway runs.
 *
 * Performs no I/O, no parsing, and no mutation: callers pass the runs they have
 * read elsewhere (e.g. via readNeonGatewayRuns) and receive a new array holding
 * only the runs that match every provided criterion. Undefined filter fields are
 * ignored, so an empty filter returns a shallow copy in the input order.
 *
 * This is the single source of truth for run-selection predicates used across the
 * Doctor checks and Gateway reporting; keep the predicate semantics here rather
 * than re-deriving them inline.
 */
export function queryGatewayRuns(
  runs: readonly INeonGatewayShadowRun[],
  filter: INeonGatewayRunQueryFilter = {}
): readonly INeonGatewayShadowRun[] {
  return runs.filter((run) => {
    if (filter.mode !== undefined && run.mode !== filter.mode) {
      return false;
    }

    if (filter.status !== undefined && run.status !== filter.status) {
      return false;
    }

    if (filter.agentId !== undefined && run.request.agentId !== filter.agentId) {
      return false;
    }

    if (filter.hasSuspiciousFindings !== undefined) {
      const hasFindings = (run.request.suspiciousFindings?.length ?? 0) > 0;
      if (hasFindings !== filter.hasSuspiciousFindings) {
        return false;
      }
    }

    if (filter.memoryState !== undefined && run.memoryState !== filter.memoryState) {
      return false;
    }

    if (filter.deliveryState !== undefined && run.delivery.state !== filter.deliveryState) {
      return false;
    }

    if (filter.deliveryStateNot !== undefined && run.delivery.state === filter.deliveryStateNot) {
      return false;
    }

    return true;
  });
}

export function summarizeGatewayRun(run: INeonGatewayShadowRun): INeonGatewayRunSummary {
  return {
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
  };
}

function redactGatewayRun(run: INeonGatewayShadowRun): INeonGatewayShadowRun {
  return {
    ...run,
    request: {
      ...run.request,
      ...(run.request.goal ? { goal: redactText(run.request.goal) } : {}),
      contentPreview: redactText(run.request.contentPreview)
    },
    events: run.events.map(redactHarnessEvent),
    finalText: redactText(run.finalText),
    delivery: {
      ...run.delivery,
      finalText: redactText(run.delivery.finalText)
    }
  };
}

export function parseGatewayRunLine(line: string): INeonGatewayShadowRun | undefined {
  try {
    return parseGatewayRun(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export interface INeonRunStoreIntegrity {
  readonly totalLines: number;
  readonly parsedRuns: number;
  readonly corruptLines: number;
}

/**
 * Read-only integrity scan of the raw `runs.jsonl` contents (Z281). The hot
 * read path (`readNeonGatewayRuns`) silently drops non-empty lines that fail to
 * parse; this surfaces that count so the Doctor can warn instead of hiding a
 * truncated/corrupt store. Uses the SAME line normalization + `parseGatewayRunLine`
 * as the read path so the corrupt count matches exactly what is dropped.
 */
export function scanNeonRunStoreIntegrity(rawRuns: string | undefined): INeonRunStoreIntegrity {
  if (!rawRuns) {
    return { totalLines: 0, parsedRuns: 0, corruptLines: 0 };
  }
  const lines = rawRuns
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let parsedRuns = 0;
  for (const line of lines) {
    if (parseGatewayRunLine(line) !== undefined) {
      parsedRuns += 1;
    }
  }
  return { totalLines: lines.length, parsedRuns, corruptLines: lines.length - parsedRuns };
}

function parseGatewayRun(value: unknown): INeonGatewayShadowRun | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const request = parseGatewayRunRequest(value["request"]);
  const delivery = parseGatewayDelivery(value["delivery"]);
  const events = parseHarnessEvents(value["events"]);

  if (
    typeof value["runId"] !== "string" ||
    !isGatewayRunMode(value["mode"]) ||
    !isGatewayRunStatus(value["status"]) ||
    !request ||
    !isNeonHarnessId(value["harnessId"]) ||
    typeof value["harnessSessionKey"] !== "string" ||
    !isMemoryState(value["memoryState"]) ||
    !events ||
    typeof value["finalText"] !== "string" ||
    !delivery ||
    typeof value["startedAt"] !== "string" ||
    typeof value["completedAt"] !== "string"
  ) {
    return undefined;
  }

  return redactGatewayRun({
    runId: value["runId"],
    mode: value["mode"],
    status: value["status"],
    request,
    harnessId: value["harnessId"],
    harnessSessionKey: value["harnessSessionKey"],
    memoryState: value["memoryState"],
    events,
    finalText: value["finalText"],
    delivery,
    startedAt: value["startedAt"],
    completedAt: value["completedAt"]
  });
}

function parseGatewayRunRequest(value: unknown): INeonGatewayRunRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    !isNeonChannel(value["channel"]) ||
    typeof value["accountId"] !== "string" ||
    typeof value["channelId"] !== "string" ||
    typeof value["userId"] !== "string" ||
    typeof value["agentId"] !== "string" ||
    typeof value["workspaceRoot"] !== "string" ||
    !isHarnessRunMode(value["mode"]) ||
    typeof value["contentPreview"] !== "string" ||
    typeof value["receivedAt"] !== "string"
  ) {
    return undefined;
  }

  const suspiciousFindings = parsePersistedFindings(value["suspiciousFindings"]);

  return {
    channel: value["channel"],
    accountId: value["accountId"],
    channelId: value["channelId"],
    userId: value["userId"],
    agentId: value["agentId"],
    workspaceRoot: value["workspaceRoot"],
    mode: value["mode"],
    ...(typeof value["goal"] === "string" ? { goal: redactText(value["goal"]) } : {}),
    contentPreview: value["contentPreview"],
    receivedAt: value["receivedAt"],
    ...(typeof value["guildId"] === "string" ? { guildId: value["guildId"] } : {}),
    ...(typeof value["threadId"] === "string" ? { threadId: value["threadId"] } : {}),
    ...(typeof value["messageId"] === "string" ? { messageId: value["messageId"] } : {}),
    ...(typeof value["userDisplayName"] === "string" ? { userDisplayName: value["userDisplayName"] } : {}),
    ...(suspiciousFindings.length > 0 ? { suspiciousFindings } : {})
  };
}

function parsePersistedFindings(value: unknown): readonly INeonGatewayPersistedFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const findings: INeonGatewayPersistedFinding[] = [];
  for (const candidate of value) {
    const finding = parsePersistedFinding(candidate);
    if (finding) {
      findings.push(finding);
    }
  }

  return findings;
}

function parsePersistedFinding(value: unknown): INeonGatewayPersistedFinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    !isExternalContentPatternId(value["id"]) ||
    !isExternalContentSeverity(value["severity"]) ||
    typeof value["count"] !== "number" ||
    !Number.isFinite(value["count"])
  ) {
    return undefined;
  }

  return {
    id: value["id"],
    severity: value["severity"],
    count: value["count"]
  };
}

function parseGatewayDelivery(value: unknown): INeonGatewayDeliveryResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    !isGatewayDeliveryState(value["state"]) ||
    !isNeonChannel(value["targetChannel"]) ||
    typeof value["targetChannelId"] !== "string" ||
    typeof value["reason"] !== "string" ||
    typeof value["finalText"] !== "string"
  ) {
    return undefined;
  }

  const messageId = typeof value["messageId"] === "string" ? value["messageId"] : undefined;

  return {
    state: value["state"],
    targetChannel: value["targetChannel"],
    targetChannelId: value["targetChannelId"],
    reason: value["reason"],
    finalText: value["finalText"],
    ...(messageId ? { messageId } : {})
  };
}

function parseHarnessEvents(value: unknown): readonly TCodexHarnessEvent[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const events = value.map(parseHarnessEvent);

  return events.every((event): event is TCodexHarnessEvent => event !== undefined) ? events : undefined;
}

function parseHarnessEvent(value: unknown): TCodexHarnessEvent | undefined {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    return undefined;
  }

  switch (value["kind"]) {
    case "assistant-delta":
      return typeof value["text"] === "string"
        ? {
            kind: "assistant-delta",
            text: value["text"]
          }
        : undefined;
    case "tool-start":
      if (typeof value["toolName"] !== "string") {
        return undefined;
      }

      {
        const toolCallId = parsePersistedToolCallId(value["toolCallId"]);

        return {
          kind: "tool-start",
          toolName: value["toolName"],
          ...(toolCallId ? { toolCallId } : {}),
          ...readHiddenChannelProgressFlag(value)
        };
      }
    case "tool-output":
      if (typeof value["toolName"] !== "string" || typeof value["output"] !== "string") {
        return undefined;
      }

      {
        const toolCallId = parsePersistedToolCallId(value["toolCallId"]);

        return {
          kind: "tool-output",
          toolName: value["toolName"],
          ...(toolCallId ? { toolCallId } : {}),
          output: value["output"],
          ...readHiddenChannelProgressFlag(value)
        };
      }
    case "file-write":
      return typeof value["path"] === "string"
        ? {
            kind: "file-write",
            path: value["path"]
          }
        : undefined;
    case "command-exit":
      return typeof value["command"] === "string" && typeof value["exitCode"] === "number"
        ? {
            kind: "command-exit",
            command: value["command"],
            exitCode: value["exitCode"]
          }
        : undefined;
    case "token-usage": {
      const inputTokens = parseNonNegativeInteger(value["inputTokens"]);
      const outputTokens = parseNonNegativeInteger(value["outputTokens"]);
      const totalTokens = parseNonNegativeInteger(value["totalTokens"]);

      return inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined
        ? {
            kind: "token-usage",
            inputTokens,
            outputTokens,
            totalTokens
          }
        : undefined;
    }
    case "final":
      return typeof value["text"] === "string"
        ? {
            kind: "final",
            text: value["text"]
          }
        : undefined;
    case "failed":
      return typeof value["message"] === "string"
        ? {
            kind: "failed",
            message: value["message"]
          }
        : undefined;
    default:
      return undefined;
  }
}

function readHiddenChannelProgressFlag(value: Record<string, unknown>): { readonly hideFromChannelProgress?: true } {
  return value["hideFromChannelProgress"] === true ? { hideFromChannelProgress: true } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsePersistedToolCallId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isGatewayRunMode(value: unknown): value is TNeonGatewayRunMode {
  return value === "shadow" || value === "live";
}

function isGatewayDeliveryState(value: unknown): value is TNeonGatewayDeliveryState {
  return value === "suppressed" || value === "delivered";
}

function isGatewayRunStatus(value: unknown): value is TNeonGatewayRunStatus {
  return value === "running" || value === "completed" || value === "failed";
}

function isNeonChannel(value: unknown): value is TNeonChannel {
  return (
    value === "discord" ||
    value === "telegram" ||
    value === "whatsapp" ||
    value === "webchat" ||
    value === "cli" ||
    value === "device"
  );
}

function isHarnessRunMode(value: unknown): value is THarnessRunMode {
  return value === "read-only" || value === "write";
}

function isMemoryState(value: unknown): value is TMemoryAttachmentState {
  return value === "attached" || value === "skipped" || value === "failed";
}

function isExternalContentPatternId(value: unknown): value is TNeonExternalContentPatternId {
  return (
    value === "ignore-previous-instructions" ||
    value === "system-role-boundary" ||
    value === "tool-call-injection"
  );
}

function isExternalContentSeverity(value: unknown): value is TNeonExternalContentSeverity {
  return value === "warn";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
