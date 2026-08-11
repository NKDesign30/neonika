import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { neonDefaultCutoverStage } from "./cutover.js";
import { resolveGatewayStatePaths } from "../gateway/runStore.js";

/**
 * Persistent cutover promotion state.
 *
 * The cutover stage and its approval flags were previously read only from
 * `process.env`. That made the cutover the truth of whichever process happened
 * to carry the flags (the live runtime), while every other reader (the Mission
 * Control server, an ad-hoc `cutover-gate` CLI call) defaulted back to
 * `shadow`. This persists the promotion as a small JSON file so the snapshot
 * builders agree on the same stage without each process needing the flags in
 * its own environment.
 *
 * Only non-secret cutover/route flags are stored. The Discord bot token is
 * never written here — it stays resolved at runtime from the upstream config.
 * Live values override persisted configuration except for the global outbound
 * arm. That flag is persisted by `arm-outbound`/`disarm-outbound` and is the
 * authoritative safety state; a stale process environment must not reopen it.
 */
const CUTOVER_STATE_DIR = "cutover";
const PROMOTION_FILE = "promotion.json";
const OUTBOUND_ENABLED_KEY = "NEON_CUTOVER_OUTBOUND_ENABLED";

/** Env keys the promotion file is allowed to carry. Never includes secrets. */
const ALLOWED_PROMOTION_KEYS: readonly string[] = [
  "NEON_CUTOVER_STAGE",
  "NEON_CUTOVER_CANARY_APPROVED",
  OUTBOUND_ENABLED_KEY,
  "NEON_CUTOVER_PRIMARY_APPROVED",
  "NEON_CUTOVER_RETIRE_EVIDENCE",
  "NEON_CUTOVER_ROLLBACK_COMMAND",
  "NEON_CUTOVER_CANARY_CHANNELS",
  "NEON_LIVE_RUN_LIFECYCLE_ENABLED",
  "NEON_DISCORD_ALLOWED_GUILDS",
  "NEON_DISCORD_ALLOWED_CHANNELS",
  "NEON_DISCORD_BOT_USER_ID",
  "NEON_DISCORD_AGENT_ID"
];

/** Keys that must never be persisted, even if passed in. */
const FORBIDDEN_PROMOTION_KEYS: readonly string[] = [
  "NEON_DISCORD_BOT_TOKEN",
  "DISCORD_BOT_TOKEN"
];

export interface INeonCutoverPromotion {
  readonly promotedAt: string;
  readonly env: Readonly<Record<string, string>>;
}

export function resolveNeonCutoverPromotionPath(projectRoot: string): string {
  const gatewayPaths = resolveGatewayStatePaths(projectRoot);
  return join(gatewayPaths.stateRoot, CUTOVER_STATE_DIR, PROMOTION_FILE);
}

/** Keeps only allowed, non-secret, non-empty keys from a candidate env record. */
export function sanitizeNeonCutoverPromotionEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ALLOWED_PROMOTION_KEYS) {
    if (FORBIDDEN_PROMOTION_KEYS.includes(key)) {
      continue;
    }
    const value = env[key]?.trim();
    if (value && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

export async function writeNeonCutoverPromotion(
  projectRoot: string,
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly now?: () => Date } = {}
): Promise<INeonCutoverPromotion> {
  const path = resolveNeonCutoverPromotionPath(projectRoot);
  const promotion: INeonCutoverPromotion = {
    promotedAt: (options.now?.() ?? new Date()).toISOString(),
    env: sanitizeNeonCutoverPromotionEnv(env)
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(promotion, null, 2)}\n`, "utf8");

  return promotion;
}

export async function readNeonCutoverPromotion(
  projectRoot: string
): Promise<INeonCutoverPromotion | undefined> {
  const path = resolveNeonCutoverPromotionPath(projectRoot);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  return parseNeonCutoverPromotion(raw);
}

/**
 * Loads the persisted promotion env merged under the given live env. Live
 * values win for ordinary cutover configuration. The persisted global outbound
 * arm is the exception: it wins when present and fails closed when absent, so
 * `disarm-outbound` takes effect without restarting a stale process.
 */
export async function loadNeonCutoverEnv(
  projectRoot: string,
  liveEnv: Readonly<Record<string, string | undefined>> = process.env
): Promise<Readonly<Record<string, string | undefined>>> {
  const promotion = await readNeonCutoverPromotion(projectRoot);
  const { [OUTBOUND_ENABLED_KEY]: _staleLiveArm, ...liveWithoutArm } = liveEnv;
  const persistedArm = promotion?.env[OUTBOUND_ENABLED_KEY];

  return {
    ...promotion?.env,
    ...liveWithoutArm,
    ...(persistedArm ? { [OUTBOUND_ENABLED_KEY]: persistedArm } : {})
  };
}

export function renderNeonCutoverPromotionReport(promotion: INeonCutoverPromotion): string {
  const keys = Object.keys(promotion.env).sort();
  return [
    `Cutover promotion written: ${promotion.env["NEON_CUTOVER_STAGE"] ?? `none (falls back to ${neonDefaultCutoverStage})`}`,
    `Promoted at: ${promotion.promotedAt}`,
    `Persisted keys (no secrets): ${keys.join(", ")}`
  ].join("\n");
}

function parseNeonCutoverPromotion(raw: string): INeonCutoverPromotion | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const promotedAt = typeof record["promotedAt"] === "string" ? record["promotedAt"] : undefined;
  const envValue = record["env"];

  if (!promotedAt || typeof envValue !== "object" || envValue === null) {
    return undefined;
  }

  const env = sanitizeNeonCutoverPromotionEnv(envValue as Record<string, string | undefined>);
  return { promotedAt, env };
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
