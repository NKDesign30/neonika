import { resolveNeonAgentProfile } from "../agents/registry.js";
import type { TDiscordMentionPolicy } from "./discordIngress.js";
import {
  parseDiscordApplicationIdFromToken,
  resolveDiscordBotIdentityConsistency,
  type TDiscordBotIdentityConsistency
} from "./discordTokenIdentity.js";
import {
  readNeonDiscordRouteProbe,
  type INeonDiscordRouteProbe,
  type TNeonDiscordRouteProbeState
} from "./discordRouteProbe.js";
import { readNeonGatewayStatus, type INeonGatewayRunSummary } from "./runStore.js";

export type TNeonGatewayRouteInspectionState = "ready" | "needs-config" | "unsafe";
export type TNeonGatewayChannelAuthState = "ready" | "needs-config" | "unsafe";

export interface ICreateNeonGatewayRouteInspectionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export interface INeonGatewayAllowlistSection {
  readonly configured: boolean;
  readonly count: number;
  readonly entries: readonly string[];
  readonly omittedCount: number;
}

export interface INeonGatewayRouteAllowlist {
  readonly guilds: INeonGatewayAllowlistSection;
  readonly channels: INeonGatewayAllowlistSection;
}

export interface INeonGatewayRouteDiscordConfig {
  readonly accountId: string;
  readonly agentId: string;
  readonly agentDisplayName?: string;
  readonly botUserIdPresent: boolean;
  readonly applicationId?: string;
  readonly botIdentityConsistency: TDiscordBotIdentityConsistency;
  readonly mentionPolicy: TDiscordMentionPolicy;
  readonly harnessMode: string;
}

export interface INeonGatewayChannelAuthStatus {
  readonly channel: "discord";
  readonly accountId: string;
  readonly state: TNeonGatewayChannelAuthState;
  readonly botIdentity: "present" | "missing";
  readonly guildScope: "configured" | "missing" | "wildcard";
  readonly channelScope: "configured" | "missing" | "wildcard";
  readonly mentionPolicy: TDiscordMentionPolicy;
  readonly harnessMode: string;
  readonly checks: readonly string[];
  readonly recovery: readonly string[];
}

export interface INeonGatewayRouteSummary {
  readonly id: string;
  readonly channel: "discord";
  readonly accountId: string;
  readonly agentId: string;
  readonly agentDisplayName?: string;
  readonly mode: "read-only";
  readonly delivery: "suppressed";
  readonly mentionPolicy: TDiscordMentionPolicy;
  readonly guildScope: "configured" | "missing" | "wildcard";
  readonly channelScope: "configured" | "missing" | "wildcard";
  readonly authState: TNeonGatewayChannelAuthState;
  readonly probeState: TNeonDiscordRouteProbeState;
  readonly lastProbeAt?: string;
  readonly latestRunId?: string;
}

export interface INeonGatewayRouteInspectionSnapshot {
  readonly state: TNeonGatewayRouteInspectionState;
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly allowlist: INeonGatewayRouteAllowlist;
  readonly discord: INeonGatewayRouteDiscordConfig;
  readonly discordProbe: INeonDiscordRouteProbe;
  readonly authStatus: readonly INeonGatewayChannelAuthStatus[];
  readonly routes: readonly INeonGatewayRouteSummary[];
  readonly latestRun?: INeonGatewayRunSummary;
  readonly recovery: readonly string[];
}

const MAX_VISIBLE_ALLOWLIST_ENTRIES = 20;

export async function createNeonGatewayRouteInspectionSnapshot(
  projectRoot: string,
  options: ICreateNeonGatewayRouteInspectionOptions = {}
): Promise<INeonGatewayRouteInspectionSnapshot> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const allowedGuildIds = readCsvEnv(env, "NEON_DISCORD_ALLOWED_GUILDS");
  const allowedChannelIds = readCsvEnv(env, "NEON_DISCORD_ALLOWED_CHANNELS");
  const agentId = readOptionalEnv(env, "NEON_DISCORD_AGENT_ID") ?? "chaty";
  const accountId = readOptionalEnv(env, "NEON_DISCORD_ACCOUNT_ID") ?? "default";
  const botUserId = readOptionalEnv(env, "NEON_DISCORD_BOT_USER_ID");
  const botUserIdPresent = Boolean(botUserId);
  const applicationId = parseDiscordApplicationIdFromToken(readOptionalEnv(env, "NEON_DISCORD_BOT_TOKEN"));
  const botIdentityConsistency = resolveDiscordBotIdentityConsistency(applicationId, botUserId);
  const mentionPolicy = readMentionPolicy(env);
  const harnessMode = readOptionalEnv(env, "NEON_DISCORD_TAP_HARNESS") ?? "dry";
  const agent = resolveNeonAgentProfile(agentId);
  const [status, discordProbe] = await Promise.all([
    readNeonGatewayStatus(projectRoot),
    readNeonDiscordRouteProbe(projectRoot, accountId)
  ]);
  const recovery = createRecovery({
    agentFound: Boolean(agent),
    botIdentityConsistency,
    botUserIdPresent,
    channelCount: allowedChannelIds.length,
    guildCount: allowedGuildIds.length
  });
  const authStatus = createDiscordAuthStatus({
    accountId,
    allowedChannelIds,
    allowedGuildIds,
    botUserIdPresent,
    harnessMode,
    mentionPolicy,
    recovery
  });
  const state: TNeonGatewayRouteInspectionState = authStatus.state;
  const discordConfig: INeonGatewayRouteDiscordConfig = {
    accountId,
    agentId,
    botUserIdPresent,
    botIdentityConsistency,
    mentionPolicy,
    harnessMode,
    ...(applicationId ? { applicationId } : {}),
    ...(agent ? { agentDisplayName: agent.displayName } : {})
  };
  const routeBase: Omit<INeonGatewayRouteSummary, "agentDisplayName" | "lastProbeAt" | "latestRunId"> = {
    id: `discord:${accountId}:${agentId}`,
    channel: "discord",
    accountId,
    agentId,
    mode: "read-only",
    delivery: "suppressed",
    mentionPolicy,
    guildScope: authStatus.guildScope,
    channelScope: authStatus.channelScope,
    authState: authStatus.state,
    probeState: discordProbe.state
  };
  const routeWithProbe: Omit<INeonGatewayRouteSummary, "agentDisplayName" | "latestRunId"> = discordProbe.lastProbeAt
    ? {
        ...routeBase,
        lastProbeAt: discordProbe.lastProbeAt
      }
    : routeBase;
  const routeWithAgent: Omit<INeonGatewayRouteSummary, "latestRunId"> = agent
    ? {
        ...routeWithProbe,
        agentDisplayName: agent.displayName
      }
    : routeWithProbe;
  const route: INeonGatewayRouteSummary = status.latestRun
    ? {
        ...routeWithAgent,
        latestRunId: status.latestRun.runId
      }
    : routeWithAgent;
  const snapshotBase: Omit<INeonGatewayRouteInspectionSnapshot, "latestRun"> = {
    state,
    generatedAt: now().toISOString(),
    projectRoot,
    allowlist: {
      guilds: createAllowlistSection(allowedGuildIds),
      channels: createAllowlistSection(allowedChannelIds)
    },
    discord: discordConfig,
    discordProbe,
    authStatus: [authStatus],
    routes: [route],
    recovery: authStatus.recovery
  };

  return status.latestRun
    ? {
        ...snapshotBase,
        latestRun: status.latestRun
      }
    : snapshotBase;
}

export function renderNeonGatewayRouteInspectionReport(
  snapshot: INeonGatewayRouteInspectionSnapshot
): string {
  const route = snapshot.routes[0];
  const recovery =
    snapshot.recovery.length > 0
      ? snapshot.recovery.map((step) => `- ${step}`)
      : ["- none"];

  return [
    `Neon Gateway Routes: ${snapshot.state}`,
    `Discord: account=${snapshot.discord.accountId} agent=${snapshot.discord.agentId} botUserId=${snapshot.discord.botUserIdPresent ? "present" : "missing"} mention=${snapshot.discord.mentionPolicy} harness=${snapshot.discord.harnessMode}`,
    `Identity: applicationId=${snapshot.discord.applicationId ?? "unknown"} consistency=${snapshot.discord.botIdentityConsistency}`,
    `Auth: discord=${snapshot.authStatus[0]?.state ?? "needs-config"} bot=${snapshot.authStatus[0]?.botIdentity ?? "missing"} guild=${snapshot.authStatus[0]?.guildScope ?? "missing"} channel=${snapshot.authStatus[0]?.channelScope ?? "missing"}`,
    `Probe: ${snapshot.discordProbe.state} accepted=${snapshot.discordProbe.stats.accepted} dropped=${snapshot.discordProbe.stats.dropped} errors=${snapshot.discordProbe.stats.errors} last=${snapshot.discordProbe.lastProbeAt ?? "none"}`,
    `Allowlist: guilds=${snapshot.allowlist.guilds.count} channels=${snapshot.allowlist.channels.count}`,
    `Route: ${route ? `${route.id} mode=${route.mode} delivery=${route.delivery}` : "none"}`,
    `Latest: ${snapshot.latestRun?.runId ?? "none"}`,
    "Recovery:",
    ...recovery
  ].join("\n");
}

function createAllowlistSection(values: readonly string[]): INeonGatewayAllowlistSection {
  return {
    configured: values.length > 0,
    count: values.length,
    entries: values.slice(0, MAX_VISIBLE_ALLOWLIST_ENTRIES),
    omittedCount: Math.max(0, values.length - MAX_VISIBLE_ALLOWLIST_ENTRIES)
  };
}

function createDiscordAuthStatus(input: {
  readonly accountId: string;
  readonly allowedChannelIds: readonly string[];
  readonly allowedGuildIds: readonly string[];
  readonly botUserIdPresent: boolean;
  readonly harnessMode: string;
  readonly mentionPolicy: TDiscordMentionPolicy;
  readonly recovery: readonly string[];
}): INeonGatewayChannelAuthStatus {
  const guildScope = resolveScope(input.allowedGuildIds);
  const channelScope = resolveScope(input.allowedChannelIds);
  const unsafeRecovery =
    guildScope === "wildcard" || channelScope === "wildcard"
      ? ["Remove wildcard entries from Discord guild/channel allowlists before canary."]
      : [];
  const recovery = [...input.recovery, ...unsafeRecovery];
  const state: TNeonGatewayChannelAuthState =
    unsafeRecovery.length > 0 ? "unsafe" : recovery.length === 0 ? "ready" : "needs-config";

  return {
    channel: "discord",
    accountId: input.accountId,
    state,
    botIdentity: input.botUserIdPresent ? "present" : "missing",
    guildScope,
    channelScope,
    mentionPolicy: input.mentionPolicy,
    harnessMode: input.harnessMode,
    checks: [
      `botUserId=${input.botUserIdPresent ? "present" : "missing"}`,
      `guildAllowlist=${guildScope}:${input.allowedGuildIds.length}`,
      `channelAllowlist=${channelScope}:${input.allowedChannelIds.length}`,
      `mentionPolicy=${input.mentionPolicy}`,
      `harness=${input.harnessMode}`
    ],
    recovery
  };
}

function resolveScope(values: readonly string[]): "configured" | "missing" | "wildcard" {
  if (values.length === 0) {
    return "missing";
  }

  return values.includes("*") ? "wildcard" : "configured";
}

function createRecovery(input: {
  readonly agentFound: boolean;
  readonly botIdentityConsistency: TDiscordBotIdentityConsistency;
  readonly botUserIdPresent: boolean;
  readonly channelCount: number;
  readonly guildCount: number;
}): readonly string[] {
  const recovery: string[] = [];

  if (!input.botUserIdPresent) {
    recovery.push("Set NEON_DISCORD_BOT_USER_ID before Discord can identify mentions.");
  }

  if (input.botIdentityConsistency === "mismatch") {
    recovery.push(
      "NEON_DISCORD_BOT_USER_ID does not match the application id derived from NEON_DISCORD_BOT_TOKEN — verify the token and bot user id belong to the same application."
    );
  }

  if (input.guildCount === 0) {
    recovery.push("Set NEON_DISCORD_ALLOWED_GUILDS to keep Discord ingress scoped.");
  }

  if (input.channelCount === 0) {
    recovery.push("Set NEON_DISCORD_ALLOWED_CHANNELS to keep Discord ingress scoped.");
  }

  if (!input.agentFound) {
    recovery.push("Set NEON_DISCORD_AGENT_ID to a known Neon Agent.");
  }

  return recovery;
}

function readCsvEnv(env: Readonly<Record<string, string | undefined>>, key: string): readonly string[] {
  const raw = readOptionalEnv(env, key);

  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readMentionPolicy(env: Readonly<Record<string, string | undefined>>): TDiscordMentionPolicy {
  const raw = readOptionalEnv(env, "NEON_DISCORD_MENTION_POLICY") ?? readOptionalEnv(env, "NEON_DISCORD_REQUIRE_MENTION");

  if (!raw) {
    return "guild";
  }

  const normalized = raw.toLowerCase();

  if (normalized === "always" || normalized === "guild" || normalized === "never") {
    return normalized;
  }

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return "always";
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return "never";
  }

  return "guild";
}

function readOptionalEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}
