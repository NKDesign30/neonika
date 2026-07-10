import type { INeonHeartbeatAgentState } from "./heartbeatTimerRuntime.js";

export const NEON_HEARTBEAT_DEFAULT_AGENT_ID = "chaty";
export const NEON_HEARTBEAT_DEFAULT_AGENT_INTERVAL_MS = 900_000;

export interface IResolveNeonHeartbeatAgentsOptions {
  readonly fallbackAgentId?: string;
  readonly fallbackIntervalMs?: number;
}

export function resolveNeonHeartbeatAgentsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: IResolveNeonHeartbeatAgentsOptions = {}
): readonly INeonHeartbeatAgentState[] {
  const fallbackIntervalMs = options.fallbackIntervalMs ?? NEON_HEARTBEAT_DEFAULT_AGENT_INTERVAL_MS;
  const agentEntries = splitCsv(env["NEON_HEARTBEAT_AGENTS"]);

  if (agentEntries.length > 0) {
    return agentEntries.map((entry) => parseNeonHeartbeatAgentEntry(entry, fallbackIntervalMs));
  }

  const fallbackAgentId =
    firstNonEmpty(env["NEON_HEARTBEAT_AGENT_ID"], env["NEON_DISCORD_AGENT_ID"], options.fallbackAgentId) ??
    NEON_HEARTBEAT_DEFAULT_AGENT_ID;
  const intervalMs = parseNeonHeartbeatDurationMs(
    firstNonEmpty(env["NEON_HEARTBEAT_AGENT_INTERVAL"], env["NEON_HEARTBEAT_AGENT_INTERVAL_MS"]),
    fallbackIntervalMs
  );

  return [{ agentId: fallbackAgentId, intervalMs }];
}

export function parseNeonHeartbeatDurationMs(raw: string | undefined, fallbackMs: number): number {
  const trimmed = raw?.trim();

  if (!trimmed) {
    return fallbackMs;
  }

  const match = /^(\d+)(ms|s|m|h)?$/iu.exec(trimmed);

  if (!match) {
    return fallbackMs;
  }

  const value = Number.parseInt(match[1] ?? "", 10);

  if (!Number.isFinite(value) || value <= 0) {
    return fallbackMs;
  }

  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;

  return value * multiplier;
}

function parseNeonHeartbeatAgentEntry(entry: string, fallbackIntervalMs: number): INeonHeartbeatAgentState {
  const [rawAgentId, rawInterval, extra] = entry.split(":");
  const agentId = (rawAgentId ?? "").trim();

  if (!agentId || extra !== undefined) {
    return { agentId: NEON_HEARTBEAT_DEFAULT_AGENT_ID, intervalMs: fallbackIntervalMs };
  }

  return {
    agentId,
    intervalMs: parseNeonHeartbeatDurationMs(rawInterval, fallbackIntervalMs)
  };
}

function splitCsv(raw: string | undefined): readonly string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim();
}
