/**
 * Per-connection unauthorized-frame flood guard for the Neon Gateway WebSocket.
 *
 * A client can send any number of rejected frames before (or after) connect —
 * bad JSON, wrong nonce, RPC-before-connect, or missing scope. Each rejection
 * returns an error frame but, without this guard, never closes the socket, so a
 * misbehaving or hostile peer can hold an open connection and spam rejections
 * indefinitely (the Z307 gap).
 *
 * This guard counts rejected frames on a single connection and tells the caller
 * to close (1008) once the count reaches the limit. It is pure, in-memory, and
 * holds no socket reference. Like the pre-auth connection budget it is
 * always-on defensive hygiene, not a cutover gate: it performs no send,
 * mutation, or exec, and the default limit is high enough that a correct client
 * (one connect, then authorized RPCs) never trips it.
 */
export const NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES = 32;

export interface INeonUnauthorizedFloodGuard {
  /**
   * Record one rejected frame. Returns true once the per-connection limit is
   * reached, signalling the caller to close the socket with 1008.
   */
  register(): boolean;
  readonly count: number;
}

/**
 * Resolve the per-connection rejection limit from the environment. Junk, zero,
 * negatives, and absent values fall back to the default so a misconfigured env
 * never weakens or disables the guard.
 */
export function resolveNeonGatewayMaxUnauthorizedFrames(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env["NEON_GATEWAY_MAX_UNAUTHORIZED_FRAMES"];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES;
}

export function createNeonUnauthorizedFloodGuard(
  maxUnauthorizedFrames: number = NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES
): INeonUnauthorizedFloodGuard {
  const limit =
    Number.isInteger(maxUnauthorizedFrames) && maxUnauthorizedFrames > 0
      ? maxUnauthorizedFrames
      : NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES;
  let count = 0;
  return {
    register(): boolean {
      count += 1;
      return count >= limit;
    },
    get count(): number {
      return count;
    }
  };
}
