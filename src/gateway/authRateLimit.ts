import { isLoopbackRemoteAddress } from "./httpMutationAuth.js";

/**
 * In-memory sliding-window auth-failure rate limiter for the Neonika Gateway
 * connect handshake (Z305).
 *
 * Caps failed connect-auth attempts per client IP ACROSS connections. The
 * per-connection flood guard (Z307) closes one socket that spams rejections;
 * this limiter stops a brute-force attacker who probes credentials across many
 * short-lived sockets from the same IP. After `maxAttempts` failures inside
 * `windowMs` the IP is locked for `lockoutMs`, and `check` reports the
 * remaining `retryAfterMs`.
 *
 * Design (mirrors upstream `src/gateway/auth-rate-limit.ts`, leaner):
 * - Timer-free: stale attempts are pruned lazily on each record (no
 *   setInterval — a background timer would keep the node:test process alive,
 *   see the WS keepalive lesson).
 * - Loopback IPs (and unknown addresses) are exempt, so local CLI / Mission
 *   Control sessions and the Shadow loopback transport never lock out. This
 *   makes the limiter backward-compatible by construction.
 * - The clock is injected (`now` arg) so the policy is deterministic in tests.
 * - Pure in-memory Map, no send / mutation / exec — always-on defensive
 *   hygiene, not a cutover gate.
 */
export const NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS = 10;
export const NEON_GATEWAY_DEFAULT_AUTH_WINDOW_MS = 60_000;
export const NEON_GATEWAY_DEFAULT_AUTH_LOCKOUT_MS = 300_000;

export interface INeonAuthRateLimitConfig {
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
}

export interface INeonAuthRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export interface INeonAuthRateLimiter {
  check(remoteAddress: string | undefined, now: number): INeonAuthRateLimitDecision;
  recordFailure(remoteAddress: string | undefined, now: number): void;
  reset(remoteAddress: string | undefined): void;
  size(): number;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveNeonAuthRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env
): INeonAuthRateLimitConfig {
  return {
    maxAttempts: readPositiveInt(env["NEON_GATEWAY_AUTH_MAX_ATTEMPTS"], NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS),
    windowMs: readPositiveInt(env["NEON_GATEWAY_AUTH_WINDOW_MS"], NEON_GATEWAY_DEFAULT_AUTH_WINDOW_MS),
    lockoutMs: readPositiveInt(env["NEON_GATEWAY_AUTH_LOCKOUT_MS"], NEON_GATEWAY_DEFAULT_AUTH_LOCKOUT_MS)
  };
}

interface INeonAuthRateEntry {
  attempts: number[];
  lockedUntil: number;
}

export function createNeonAuthRateLimiter(
  config: INeonAuthRateLimitConfig = resolveNeonAuthRateLimitConfig()
): INeonAuthRateLimiter {
  const maxAttempts = config.maxAttempts > 0 ? config.maxAttempts : NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS;
  const windowMs = config.windowMs > 0 ? config.windowMs : NEON_GATEWAY_DEFAULT_AUTH_WINDOW_MS;
  const lockoutMs = config.lockoutMs > 0 ? config.lockoutMs : NEON_GATEWAY_DEFAULT_AUTH_LOCKOUT_MS;
  const entries = new Map<string, INeonAuthRateEntry>();

  const isExempt = (remoteAddress: string | undefined): remoteAddress is undefined =>
    !remoteAddress || isLoopbackRemoteAddress(remoteAddress);

  return {
    check(remoteAddress, now): INeonAuthRateLimitDecision {
      if (isExempt(remoteAddress)) {
        return { allowed: true, retryAfterMs: 0 };
      }
      const entry = entries.get(remoteAddress);
      if (entry && entry.lockedUntil > now) {
        return { allowed: false, retryAfterMs: entry.lockedUntil - now };
      }
      return { allowed: true, retryAfterMs: 0 };
    },
    recordFailure(remoteAddress, now): void {
      if (isExempt(remoteAddress)) {
        return;
      }
      const entry = entries.get(remoteAddress) ?? { attempts: [], lockedUntil: 0 };
      // Lazy prune: drop attempts that fell out of the sliding window.
      entry.attempts = entry.attempts.filter((ts) => now - ts < windowMs);
      entry.attempts.push(now);
      if (entry.attempts.length >= maxAttempts) {
        entry.lockedUntil = now + lockoutMs;
        entry.attempts = [];
      }
      entries.set(remoteAddress, entry);
    },
    reset(remoteAddress): void {
      if (remoteAddress) {
        entries.delete(remoteAddress);
      }
    },
    size(): number {
      return entries.size;
    }
  };
}
