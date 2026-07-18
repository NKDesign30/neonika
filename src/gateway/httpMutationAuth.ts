import type { IncomingHttpHeaders } from "node:http";

export const NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV = "NEON_GATEWAY_HTTP_MUTATION_TOKEN";

export type TNeonHttpMutationAuthState = "authorized" | "auth-required" | "auth-denied";
export type TNeonHttpMutationAuthMode = "configured-token" | "loopback-compat";

export interface INeonHttpMutationAuthDecision {
  readonly state: TNeonHttpMutationAuthState;
  readonly mode?: TNeonHttpMutationAuthMode;
  readonly statusCode?: 401 | 403;
  readonly error?: "neon-http-mutation-auth-required" | "neon-http-mutation-auth-denied";
}

export interface INeonHttpMutationAuthInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly headers: IncomingHttpHeaders;
  readonly remoteAddress?: string;
}

export function authorizeNeonHttpMutation(input: INeonHttpMutationAuthInput): INeonHttpMutationAuthDecision {
  const configuredToken = readConfiguredMutationToken(input.env ?? process.env);

  if (!configuredToken) {
    if (isLoopbackRemoteAddress(input.remoteAddress)) {
      return {
        state: "authorized",
        mode: "loopback-compat"
      };
    }

    return {
      state: "auth-required",
      statusCode: 401,
      error: "neon-http-mutation-auth-required"
    };
  }

  const presentedToken = readPresentedMutationToken(input.headers);

  if (!presentedToken) {
    return {
      state: "auth-required",
      statusCode: 401,
      error: "neon-http-mutation-auth-required"
    };
  }

  if (presentedToken !== configuredToken) {
    return {
      state: "auth-denied",
      statusCode: 403,
      error: "neon-http-mutation-auth-denied"
    };
  }

  return {
    state: "authorized",
    mode: "configured-token"
  };
}

export function readConfiguredMutationToken(env: NodeJS.ProcessEnv): string | undefined {
  return env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV]?.trim() || undefined;
}

function readPresentedMutationToken(headers: IncomingHttpHeaders): string | undefined {
  const bearer = readBearerToken(headers["authorization"]);
  if (bearer) {
    return bearer;
  }

  return readHeaderValue(headers["x-neon-gateway-token"])?.trim() || undefined;
}

function readBearerToken(value: string | string[] | undefined): string | undefined {
  const header = readHeaderValue(value);
  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function readHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }

  if (remoteAddress === "::1" || remoteAddress === "127.0.0.1") {
    return true;
  }

  return remoteAddress.startsWith("::ffff:127.");
}
