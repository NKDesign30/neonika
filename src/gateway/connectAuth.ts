import {
  isLoopbackRemoteAddress,
  readConfiguredMutationToken
} from "./httpMutationAuth.js";

/**
 * WS connect-credential auth for the Neonika Gateway (Z303).
 *
 * The HTTP mutation routes already gate writes behind
 * `NEON_GATEWAY_HTTP_MUTATION_TOKEN` (`httpMutationAuth.ts`). Until this slice
 * the WS `connect` frame accepted any client and adopted its claimed
 * role/scopes after only echoing the challenge nonce. This module brings the
 * connect handshake under the SAME shared-token contract, reusing the HTTP
 * token + loopback helpers so the two surfaces never drift.
 *
 * Backward-compatible by construction:
 * - No `NEON_GATEWAY_HTTP_MUTATION_TOKEN` configured + loopback remote ->
 *   `authorized` (loopback-compat). This is the current Shadow/loopback
 *   behaviour, so existing local clients keep connecting unchanged.
 * - Token configured -> the connect frame must present the matching token,
 *   otherwise `auth-denied`.
 * - No token configured + non-loopback remote -> `auth-required` (a remote
 *   peer may not connect un-authenticated once the gateway is exposed).
 *
 * Pure + leak-safe: compares tokens, returns only a decision tag, never logs
 * or echoes the token. Device-token *issuance* and Ed25519 device-signature
 * auth stay separate slices; this is the shared-secret tier.
 */
export type TNeonGatewayConnectAuthState = "authorized" | "auth-required" | "auth-denied";
export type TNeonGatewayConnectAuthMode = "configured-token" | "loopback-compat";

export interface INeonGatewayConnectAuthDecision {
  readonly state: TNeonGatewayConnectAuthState;
  readonly mode?: TNeonGatewayConnectAuthMode;
}

export interface INeonGatewayConnectAuthInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly presentedToken?: string | undefined;
  readonly remoteAddress?: string | undefined;
}

export function resolveNeonGatewayConnectAuth(
  input: INeonGatewayConnectAuthInput
): INeonGatewayConnectAuthDecision {
  const configuredToken = readConfiguredMutationToken(input.env ?? process.env);

  if (!configuredToken) {
    if (isLoopbackRemoteAddress(input.remoteAddress)) {
      return { state: "authorized", mode: "loopback-compat" };
    }
    return { state: "auth-required" };
  }

  const presentedToken = input.presentedToken?.trim() || undefined;
  if (!presentedToken) {
    return { state: "auth-required" };
  }

  if (presentedToken !== configuredToken) {
    return { state: "auth-denied" };
  }

  return { state: "authorized", mode: "configured-token" };
}
