import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { bootstrapNeonMemorySchema } from "../memory/neonMemoryDbWriter.js";

export const neonSetupConfigRootEnvKey = "NEONIKA_CONFIG_ROOT" as const;
export const neonSetupConfigFile = "config.json" as const;
export const neonSetupDiscordTokenEnvKey = "NEON_DISCORD_BOT_TOKEN" as const;

export type TNeonSetupChannel = "discord" | "whatsapp";
export type TNeonSetupState = "created" | "existing" | "updated";
export type TNeonWhatsAppMode = "dedicated" | "personal";

export interface INeonSetupIdentityLink {
  readonly channel: TNeonSetupChannel;
  readonly accountId: string;
  readonly peerId: string;
}

export interface INeonSetupConfig {
  readonly version: 1;
  readonly product: "neonika";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mode: "shadow";
  readonly identity: {
    readonly ownerId: string;
    readonly displayName: string;
    readonly links: readonly INeonSetupIdentityLink[];
  };
  readonly paths: {
    readonly state: "state";
    readonly memoryDb: "memory/semantic-memory.db";
    readonly whatsappAuth: "credentials/whatsapp/default";
  };
  readonly memory: {
    readonly backend: "sqlite";
  };
  readonly session: {
    readonly dmScope: "per-channel-peer";
  };
  readonly channels: {
    readonly discord: {
      readonly enabled: boolean;
      readonly role: "hub";
      readonly tokenEnv: typeof neonSetupDiscordTokenEnvKey;
      readonly ownerPeerId?: string;
      readonly allowedGuilds: readonly string[];
      readonly allowedChannels: readonly string[];
    };
    readonly whatsapp: {
      readonly enabled: boolean;
      readonly role: "companion";
      readonly accountId: "default";
      readonly mode: TNeonWhatsAppMode;
      readonly ownerPeerId?: string;
      readonly dmPolicy: "allowlist";
      readonly allowFrom: readonly string[];
      readonly groupPolicy: "disabled";
      readonly groupAllowFrom: readonly string[];
      readonly selfChatMode: boolean;
    };
  };
  readonly security: {
    readonly outbound: "suppressed";
    readonly pluginMessageHooks: false;
  };
}

export interface INeonSetupChannelInput {
  readonly enabled?: boolean;
  readonly ownerPeerId?: string;
}

export interface INeonSetupDiscordInput extends INeonSetupChannelInput {
  readonly allowedGuilds?: readonly string[];
  readonly allowedChannels?: readonly string[];
}

export interface INeonSetupWhatsAppInput extends INeonSetupChannelInput {
  readonly mode?: TNeonWhatsAppMode;
}

export interface IRunNeonSetupOptions {
  readonly configRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly ownerId?: string;
  readonly displayName?: string;
  readonly discord?: INeonSetupDiscordInput;
  readonly whatsapp?: INeonSetupWhatsAppInput;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface INeonSetupPaths {
  readonly configRoot: string;
  readonly configPath: string;
  readonly stateRoot: string;
  readonly memoryDbPath: string;
  readonly whatsappAuthPath: string;
  readonly whatsappReplayPath: string;
  readonly whatsappTapLockPath: string;
}

export interface INeonSetupResult {
  readonly state: TNeonSetupState;
  readonly config: INeonSetupConfig;
  readonly paths: INeonSetupPaths;
  readonly memoryReady: true;
  readonly secretsPersisted: false;
}

export interface INeonSetupEnvironmentResult {
  readonly applied: readonly string[];
}

export function resolveNeonSetupPaths(
  configRoot?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonSetupPaths {
  const configuredRoot = configRoot?.trim() || env[neonSetupConfigRootEnvKey]?.trim();
  const root = resolve(configuredRoot || join(homedir(), ".neonika"));

  return {
    configRoot: root,
    configPath: join(root, neonSetupConfigFile),
    stateRoot: join(root, "state"),
    memoryDbPath: join(root, "memory", "semantic-memory.db"),
    whatsappAuthPath: join(root, "credentials", "whatsapp", "default"),
    whatsappReplayPath: join(root, "state", "whatsapp-replay.json"),
    whatsappTapLockPath: join(root, "state", "whatsapp-tap.lock")
  };
}

export async function readNeonSetupConfig(
  configRoot?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<INeonSetupConfig | undefined> {
  const { configPath, configRoot: resolvedRoot } = resolveNeonSetupPaths(configRoot, env);
  try {
    const rootStats = await lstat(resolvedRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("Neonika setup root must be a real directory");
    }
    if ((rootStats.mode & 0o777) !== 0o700) {
      throw new Error("Neonika setup root permissions must be 0700");
    }
    const stats = await lstat(configPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Neonika setup config must be a regular file");
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error("Neonika setup config permissions must be 0600");
    }
    const value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    return parseNeonSetupConfig(value);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function runNeonSetup(
  options: IRunNeonSetupOptions = {}
): Promise<INeonSetupResult> {
  const env = options.env ?? process.env;
  const paths = resolveNeonSetupPaths(options.configRoot, env);
  const existing = await readNeonSetupConfig(paths.configRoot, env);
  const now = (options.now?.() ?? new Date()).toISOString();
  const config = buildNeonSetupConfig(existing, options, now);
  const unchanged = existing !== undefined && JSON.stringify(existing) === JSON.stringify(config);

  await createPrivateDirectories(paths);
  await bootstrapMemory(paths.memoryDbPath);

  if (!unchanged) {
    await writeConfigAtomically(paths.configPath, config);
  } else {
    await chmod(paths.configPath, 0o600);
  }

  return {
    state: existing === undefined ? "created" : unchanged ? "existing" : "updated",
    config,
    paths,
    memoryReady: true,
    secretsPersisted: false
  };
}

export function applyNeonSetupEnvironment(
  config: INeonSetupConfig,
  paths: INeonSetupPaths,
  env: Record<string, string | undefined> = process.env
): INeonSetupEnvironmentResult {
  const applied: string[] = [];
  applyEnvDefault(env, applied, "NEON_MEMORY_DB_PATH", paths.memoryDbPath);
  applyEnvDefault(env, applied, "NEON_LIVE_INDEX_MEMORY_DB_PATH", paths.memoryDbPath);
  applyEnvDefault(
    env,
    applied,
    "NEON_MEMORY_BACKUP_DIR",
    join(paths.configRoot, "memory", "backups")
  );
  applyEnvDefault(env, applied, "NEON_OWNER_ID", config.identity.ownerId);
  applyEnvDefault(
    env,
    applied,
    "NEON_WHATSAPP_ENABLED",
    config.channels.whatsapp.enabled ? "ready" : "off"
  );
  applyEnvDefault(env, applied, "NEON_DISCORD_ALLOWED_GUILDS", config.channels.discord.allowedGuilds.join(","));
  applyEnvDefault(
    env,
    applied,
    "NEON_DISCORD_ALLOWED_CHANNELS",
    config.channels.discord.allowedChannels.join(",")
  );
  if (config.channels.whatsapp.enabled) {
    applyEnvDefault(env, applied, "NEON_WHATSAPP_AUTH_DIR", paths.whatsappAuthPath);
  }
  if (config.channels.whatsapp.ownerPeerId) {
    applyEnvDefault(env, applied, "NEON_WHATSAPP_OWNER_PEER", config.channels.whatsapp.ownerPeerId);
  }
  return { applied };
}

export function renderNeonSetupReport(result: INeonSetupResult): string {
  const linkCount = result.config.identity.links.length;
  return [
    `Neonika setup: ${result.state}`,
    `Mode: ${result.config.mode} (outbound ${result.config.security.outbound})`,
    `Identity: configured, channel links=${linkCount}`,
    `Memory: ${result.memoryReady ? "ready" : "unavailable"} (local SQLite)`,
    `Discord hub: ${result.config.channels.discord.enabled ? "configured" : "skipped"}`,
    `WhatsApp companion: ${result.config.channels.whatsapp.enabled ? "configured; login pending" : "skipped"}`,
    `Secrets persisted: ${result.secretsPersisted ? "yes" : "no"}`,
    "Next: neonika onboarding-smoke"
  ].join("\n");
}

function buildNeonSetupConfig(
  existing: INeonSetupConfig | undefined,
  options: IRunNeonSetupOptions,
  now: string
): INeonSetupConfig {
  const ownerId = normalizeOwnerId(
    options.ownerId ?? existing?.identity.ownerId ?? options.createId?.() ?? randomUUID()
  );
  const displayName = normalizeDisplayName(
    options.displayName ?? existing?.identity.displayName ?? "Operator"
  );
  const discord = mergeDiscord(existing?.channels.discord, options.discord);
  const whatsapp = mergeWhatsApp(existing?.channels.whatsapp, options.whatsapp);
  const links = buildIdentityLinks(discord.ownerPeerId, whatsapp.ownerPeerId);
  const candidate: INeonSetupConfig = {
    version: 1,
    product: "neonika",
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
    mode: "shadow",
    identity: { ownerId, displayName, links },
    paths: {
      state: "state",
      memoryDb: "memory/semantic-memory.db",
      whatsappAuth: "credentials/whatsapp/default"
    },
    memory: { backend: "sqlite" },
    session: { dmScope: "per-channel-peer" },
    channels: { discord, whatsapp },
    security: { outbound: "suppressed", pluginMessageHooks: false }
  };

  if (existing !== undefined && JSON.stringify(candidate) !== JSON.stringify(existing)) {
    return { ...candidate, updatedAt: now };
  }
  return candidate;
}

function mergeDiscord(
  existing: INeonSetupConfig["channels"]["discord"] | undefined,
  input: INeonSetupDiscordInput | undefined
): INeonSetupConfig["channels"]["discord"] {
  const ownerPeerId = normalizeOptionalDiscordPeer(input?.ownerPeerId ?? existing?.ownerPeerId);
  return {
    enabled: input?.enabled ?? existing?.enabled ?? false,
    role: "hub",
    tokenEnv: neonSetupDiscordTokenEnvKey,
    ...(ownerPeerId ? { ownerPeerId } : {}),
    allowedGuilds: normalizeDiscordList(input?.allowedGuilds ?? existing?.allowedGuilds ?? []),
    allowedChannels: normalizeDiscordList(input?.allowedChannels ?? existing?.allowedChannels ?? [])
  };
}

function mergeWhatsApp(
  existing: INeonSetupConfig["channels"]["whatsapp"] | undefined,
  input: INeonSetupWhatsAppInput | undefined
): INeonSetupConfig["channels"]["whatsapp"] {
  const ownerPeerId = normalizeOptionalWhatsAppPeer(input?.ownerPeerId ?? existing?.ownerPeerId);
  const mode = input?.mode ?? existing?.mode ?? "dedicated";
  return {
    enabled: input?.enabled ?? existing?.enabled ?? false,
    role: "companion",
    accountId: "default",
    mode,
    ...(ownerPeerId ? { ownerPeerId } : {}),
    dmPolicy: "allowlist",
    allowFrom: ownerPeerId ? [ownerPeerId] : [],
    groupPolicy: "disabled",
    groupAllowFrom: [],
    selfChatMode: mode === "personal"
  };
}

function buildIdentityLinks(
  discordPeerId: string | undefined,
  whatsappPeerId: string | undefined
): readonly INeonSetupIdentityLink[] {
  return [
    ...(discordPeerId ? [{ channel: "discord" as const, accountId: "default", peerId: discordPeerId }] : []),
    ...(whatsappPeerId ? [{ channel: "whatsapp" as const, accountId: "default", peerId: whatsappPeerId }] : [])
  ];
}

async function createPrivateDirectories(paths: INeonSetupPaths): Promise<void> {
  const directories = [
    paths.configRoot,
    paths.stateRoot,
    join(paths.configRoot, "memory"),
    join(paths.configRoot, "credentials"),
    join(paths.configRoot, "credentials", "whatsapp"),
    paths.whatsappAuthPath
  ];
  for (const directory of directories) {
    await ensurePrivateDirectory(directory);
  }
}

async function bootstrapMemory(memoryDbPath: string): Promise<void> {
  try {
    const stats = await lstat(memoryDbPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Neonika memory database must be a regular file");
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
  const database = new DatabaseSync(memoryDbPath);
  try {
    bootstrapNeonMemorySchema(database);
  } finally {
    database.close();
  }
  await chmod(memoryDbPath, 0o600);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Neonika setup path must be a real directory");
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const created = await lstat(path);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error("Neonika setup path must be a real directory");
    }
  }
  await chmod(path, 0o700);
}

async function writeConfigAtomically(configPath: string, config: INeonSetupConfig): Promise<void> {
  const tempPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function parseNeonSetupConfig(value: unknown): INeonSetupConfig {
  if (!isRecord(value) || value["version"] !== 1 || value["product"] !== "neonika") {
    throw new Error("Neonika setup config has an unsupported format");
  }
  assertOnlyKeys(value, [
    "version",
    "product",
    "createdAt",
    "updatedAt",
    "mode",
    "identity",
    "paths",
    "memory",
    "session",
    "channels",
    "security"
  ]);
  const identity = value["identity"];
  const channels = value["channels"];
  const security = value["security"];
  const paths = value["paths"];
  const memory = value["memory"];
  const session = value["session"];
  if (
    !isRecord(identity) ||
    !isRecord(channels) ||
    !isRecord(security) ||
    !isRecord(paths) ||
    !isRecord(memory) ||
    !isRecord(session)
  ) {
    throw new Error("Neonika setup config is incomplete");
  }
  assertOnlyKeys(identity, ["ownerId", "displayName", "links"]);
  assertOnlyKeys(channels, ["discord", "whatsapp"]);
  assertOnlyKeys(security, ["outbound", "pluginMessageHooks"]);
  assertOnlyKeys(paths, ["state", "memoryDb", "whatsappAuth"]);
  assertOnlyKeys(memory, ["backend"]);
  assertOnlyKeys(session, ["dmScope"]);
  const discord = channels["discord"];
  const whatsapp = channels["whatsapp"];
  if (
    !isRecord(discord) ||
    !isRecord(whatsapp) ||
    !Array.isArray(identity["links"]) ||
    !Array.isArray(discord["allowedGuilds"]) ||
    !Array.isArray(discord["allowedChannels"]) ||
    !Array.isArray(whatsapp["allowFrom"]) ||
    !Array.isArray(whatsapp["groupAllowFrom"])
  ) {
    throw new Error("Neonika setup channel config is incomplete");
  }
  assertOnlyKeys(discord, [
    "enabled",
    "role",
    "tokenEnv",
    "ownerPeerId",
    "allowedGuilds",
    "allowedChannels"
  ]);
  assertOnlyKeys(whatsapp, [
    "enabled",
    "role",
    "accountId",
    "mode",
    "ownerPeerId",
    "dmPolicy",
    "allowFrom",
    "groupPolicy",
    "groupAllowFrom",
    "selfChatMode"
  ]);

  const createdAt = readCanonicalIsoTimestamp(value["createdAt"], "createdAt");
  const updatedAt = readCanonicalIsoTimestamp(value["updatedAt"], "updatedAt");
  const ownerId = normalizeOwnerId(readString(identity["ownerId"], "owner id"));
  const displayName = normalizeDisplayName(readString(identity["displayName"], "display name"));
  const discordOwner = normalizeOptionalDiscordPeer(readOptionalString(discord["ownerPeerId"], "Discord owner id"));
  const whatsappOwner = normalizeOptionalWhatsAppPeer(readOptionalString(whatsapp["ownerPeerId"], "WhatsApp owner id"));
  const allowedGuilds = normalizeDiscordList(readStringArray(discord["allowedGuilds"], "Discord guild ids"));
  const allowedChannels = normalizeDiscordList(readStringArray(discord["allowedChannels"], "Discord channel ids"));
  const mode = whatsapp["mode"];
  if (mode !== "dedicated" && mode !== "personal") {
    throw new Error("Neonika setup config has an invalid WhatsApp mode");
  }
  const links = parseIdentityLinks(identity["links"]);
  const expectedLinks = buildIdentityLinks(discordOwner, whatsappOwner);
  const whatsappAllowFrom = readStringArray(whatsapp["allowFrom"], "WhatsApp allowlist");
  const whatsappGroupAllowFrom = readStringArray(
    whatsapp["groupAllowFrom"],
    "WhatsApp group allowlist"
  );
  if (
    value["mode"] !== "shadow" ||
    typeof discord["enabled"] !== "boolean" ||
    discord["role"] !== "hub" ||
    security["outbound"] !== "suppressed" ||
    security["pluginMessageHooks"] !== false ||
    memory["backend"] !== "sqlite" ||
    session["dmScope"] !== "per-channel-peer" ||
    paths["state"] !== "state" ||
    paths["memoryDb"] !== "memory/semantic-memory.db" ||
    paths["whatsappAuth"] !== "credentials/whatsapp/default" ||
    discord["tokenEnv"] !== neonSetupDiscordTokenEnvKey ||
    typeof whatsapp["enabled"] !== "boolean" ||
    whatsapp["role"] !== "companion" ||
    whatsapp["accountId"] !== "default" ||
    whatsapp["dmPolicy"] !== "allowlist" ||
    whatsapp["groupPolicy"] !== "disabled" ||
    whatsapp["selfChatMode"] !== (mode === "personal") ||
    JSON.stringify(whatsappAllowFrom) !== JSON.stringify(whatsappOwner ? [whatsappOwner] : []) ||
    whatsappGroupAllowFrom.length !== 0 ||
    JSON.stringify(links) !== JSON.stringify(expectedLinks)
  ) {
    throw new Error("Neonika setup config violates the safe onboarding contract");
  }
  return {
    version: 1,
    product: "neonika",
    createdAt,
    updatedAt,
    mode: "shadow",
    identity: { ownerId, displayName, links },
    paths: {
      state: "state",
      memoryDb: "memory/semantic-memory.db",
      whatsappAuth: "credentials/whatsapp/default"
    },
    memory: { backend: "sqlite" },
    session: { dmScope: "per-channel-peer" },
    channels: {
      discord: {
        enabled: discord["enabled"],
        role: "hub",
        tokenEnv: neonSetupDiscordTokenEnvKey,
        ...(discordOwner ? { ownerPeerId: discordOwner } : {}),
        allowedGuilds,
        allowedChannels
      },
      whatsapp: {
        enabled: whatsapp["enabled"],
        role: "companion",
        accountId: "default",
        mode,
        ...(whatsappOwner ? { ownerPeerId: whatsappOwner } : {}),
        dmPolicy: "allowlist",
        allowFrom: whatsappOwner ? [whatsappOwner] : [],
        groupPolicy: "disabled",
        groupAllowFrom: [],
        selfChatMode: mode === "personal"
      }
    },
    security: { outbound: "suppressed", pluginMessageHooks: false }
  };
}

function parseIdentityLinks(value: unknown): readonly INeonSetupIdentityLink[] {
  if (!Array.isArray(value)) {
    throw new Error("Neonika setup identity links must be an array");
  }
  return value.map((entry) => {
    if (!isRecord(entry) || (entry["channel"] !== "discord" && entry["channel"] !== "whatsapp")) {
      throw new Error("Neonika setup identity link is invalid");
    }
    assertOnlyKeys(entry, ["channel", "accountId", "peerId"]);
    const accountId = readString(entry["accountId"], "identity account id").trim();
    if (!/^[A-Za-z0-9._-]{1,80}$/u.test(accountId)) {
      throw new Error("Identity account id must use safe characters");
    }
    const peerId = readString(entry["peerId"], "identity peer id");
    const normalizedPeer =
      entry["channel"] === "discord"
        ? normalizeOptionalDiscordPeer(peerId)
        : normalizeOptionalWhatsAppPeer(peerId);
    if (!normalizedPeer) {
      throw new Error("Neonika setup identity peer is empty");
    }
    return { channel: entry["channel"], accountId, peerId: normalizedPeer };
  });
}

function readCanonicalIsoTimestamp(value: unknown, label: string): string {
  const timestamp = readString(value, label);
  const milliseconds = Date.parse(timestamp);
  if (Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new Error(`Neonika setup ${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Neonika setup ${label} must be a string`);
  }
  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, label);
}

function readStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`Neonika setup ${label} must be a string array`);
  }
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("Neonika setup config contains unsupported fields");
  }
}

function applyEnvDefault(
  env: Record<string, string | undefined>,
  applied: string[],
  name: string,
  value: string
): void {
  if ((env[name]?.trim() ?? "") !== "" || value === "") {
    return;
  }
  env[name] = value;
  applied.push(name);
}

function normalizeOwnerId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(normalized)) {
    throw new Error("Owner id must use 1-80 letters, digits, dots, underscores, or hyphens");
  }
  return normalized;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80 || /[\r\n\0]/u.test(normalized)) {
    throw new Error("Display name must be 1-80 characters on one line");
  }
  return normalized;
}

function normalizeOptionalDiscordPeer(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const normalized = value.trim();
  if (!/^\d{17,20}$/u.test(normalized)) {
    throw new Error("Discord owner id must be a 17-20 digit snowflake");
  }
  return normalized;
}

function normalizeDiscordList(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => normalizeOptionalDiscordPeer(value)).filter(isString))];
}

function normalizeOptionalWhatsAppPeer(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const normalized = value.replace(/[\s()-]/gu, "");
  if (!/^\+[1-9]\d{7,14}$/u.test(normalized)) {
    throw new Error("WhatsApp owner id must be an E.164 number such as +15551234567");
  }
  return normalized;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
