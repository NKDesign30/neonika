import type { IncomingMessage } from "node:http";

/**
 * Pre-auth connection budget (DoS hardening).
 *
 * neonika's WS server did not cap how many simultaneous un-connected upgrades
 * a single IP can hold open, so a peer could flood the handshake path. Upstream
 * caps this per remote address (src/gateway/server/preauth-connection-budget.ts,
 * DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP = 32). This is the native parity slice:
 * a pure per-IP counter the upgrade path consults before accepting a socket.
 *
 * Always on (not gated): it is pure defensive hygiene — never an outbound, send,
 * or mutation — and the high default never trips legitimate local clients.
 * Acquire on upgrade, release on connection close.
 */

const maxPreauthPerIpEnvKey = "NEON_GATEWAY_MAX_PREAUTH_CONNECTIONS_PER_IP" as const;
export const NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP = 32;

export interface INeonPreauthConnectionBudget {
  /** Reserve a slot for `ip`. Returns false when the per-IP cap is already reached. */
  acquire(ip: string): boolean;
  /** Release a previously acquired slot for `ip`. No-op when none is held. */
  release(ip: string): void;
  /** Current reserved slot count for `ip` (0 when none). */
  activeCount(ip: string): number;
}

export function resolveNeonPreauthMaxConnectionsPerIp(
  env: Readonly<Record<string, string | undefined>> = process.env
): number {
  const raw = env[maxPreauthPerIpEnvKey];
  if (raw === undefined) {
    return NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP;
}

export function createNeonPreauthConnectionBudget(
  maxPerIp: number = NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP
): INeonPreauthConnectionBudget {
  const counts = new Map<string, number>();
  return {
    acquire(ip: string): boolean {
      const current = counts.get(ip) ?? 0;
      if (current >= maxPerIp) {
        return false;
      }
      counts.set(ip, current + 1);
      return true;
    },
    release(ip: string): void {
      const current = counts.get(ip);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        counts.delete(ip);
      } else {
        counts.set(ip, current - 1);
      }
    },
    activeCount(ip: string): number {
      return counts.get(ip) ?? 0;
    }
  };
}

/** Remote address used as the budget key; falls back to a stable sentinel. */
export function readNeonPreauthRemoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}
