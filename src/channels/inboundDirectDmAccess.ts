/**
 * Direct-message access guard, a rebuild of the DM branch of upstream
 * `src/security/dm-policy-shared.ts` (`resolveDmGroupAccessDecision` /
 * `resolveOpenDmAllowlistAccess`).
 *
 * Neon's Discord ingress had no DM-policy concept: a direct message that passed
 * the bot/ignored/guild/channel gates was accepted. This adds the policy axis —
 * open / allowlist / pairing / disabled — feeding off the effective allow-from
 * (post access-group expansion). It runs only in DM scope (no guild); group
 * scope keeps using the allow-from matcher directly.
 *
 * Parity note (adapt, not 1:1): upstream's "open" still allowlists when an
 * allow-from is configured. Neon keeps that, AND treats an EMPTY allow-from
 * under "open" as truly open — which is what preserves Neon's pre-existing
 * default-open DM behavior when no `dmPolicy` is configured at all (the ingress
 * only consults this guard when `dmPolicy` is explicitly set). Pairing here is a
 * decision signal only; issuing a pairing challenge is a later live slice.
 *
 * Pure decision, no side effect, no state.
 */

import {
  compileNeonAllowFrom,
  isNeonSenderIdAllowed
} from "./inboundAllowFromPolicy.js";

export type TNeonDmPolicy = "open" | "allowlist" | "pairing" | "disabled";

export type TNeonDmAccessDecision = "allow" | "block" | "pairing";

export const NEON_DM_ACCESS_REASON = {
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted"
} as const;

export type TNeonDmAccessReasonCode =
  (typeof NEON_DM_ACCESS_REASON)[keyof typeof NEON_DM_ACCESS_REASON];

export interface INeonDirectDmAccess {
  readonly decision: TNeonDmAccessDecision;
  readonly reasonCode: TNeonDmAccessReasonCode;
  readonly reason: string;
}

function dmAccess(
  decision: TNeonDmAccessDecision,
  reasonCode: TNeonDmAccessReasonCode,
  reason: string
): INeonDirectDmAccess {
  return { decision, reasonCode, reason };
}

/**
 * Resolves DM access for one sender against the effective (already
 * access-group-expanded) allow-from. The matcher is case-sensitive and
 * deny-when-empty, matching the allow-from layer; the empty-open case is handled
 * explicitly for the `open` policy.
 */
export function resolveNeonDirectDmAccess(params: {
  readonly dmPolicy: TNeonDmPolicy;
  readonly allowFrom?: readonly (string | number)[];
  readonly senderId: string;
}): INeonDirectDmAccess {
  const compiled = compileNeonAllowFrom(params.allowFrom);
  const senderAllowed = isNeonSenderIdAllowed(compiled, params.senderId, false);

  switch (params.dmPolicy) {
    case "disabled":
      return dmAccess("block", NEON_DM_ACCESS_REASON.DM_POLICY_DISABLED, "dmPolicy=disabled");
    case "open":
      if (!compiled.hasEntries || compiled.hasWildcard) {
        return dmAccess("allow", NEON_DM_ACCESS_REASON.DM_POLICY_OPEN, "dmPolicy=open");
      }
      return senderAllowed
        ? dmAccess(
            "allow",
            NEON_DM_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
            "dmPolicy=open (allowlisted)"
          )
        : dmAccess(
            "block",
            NEON_DM_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
            "dmPolicy=open (not allowlisted)"
          );
    case "allowlist":
      return senderAllowed
        ? dmAccess(
            "allow",
            NEON_DM_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
            "dmPolicy=allowlist (allowlisted)"
          )
        : dmAccess(
            "block",
            NEON_DM_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
            "dmPolicy=allowlist (not allowlisted)"
          );
    case "pairing":
      return senderAllowed
        ? dmAccess(
            "allow",
            NEON_DM_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
            "dmPolicy=pairing (allowlisted)"
          )
        : dmAccess(
            "pairing",
            NEON_DM_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
            "dmPolicy=pairing (not allowlisted)"
          );
  }
}

export function renderNeonDirectDmAccessReport(access: INeonDirectDmAccess): string {
  return [
    "Neonika Direct DM Access",
    `Decision: ${access.decision}`,
    `Reason: ${access.reasonCode}`
  ].join("\n");
}
