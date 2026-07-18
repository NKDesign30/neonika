import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeRunnerServiceActionSnapshot,
  listenNeonGatewayHttpServer,
  NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV
} from "../src/index.js";

/**
 * P5.1 — Node Runner Service action routes are HTTP-reachable and ultimately the
 * only path in the codebase that can reach `spawn("/bin/zsh", ...)`. The three
 * mutation routes are wired through `authorizeHttpMutation` in `httpServer.ts`
 * (POST `.../service/actions`, `.../actions/approvals`, `.../actions/executions`).
 *
 * Existing coverage proves the module-level command guard (never spawns on a
 * tampered/forged command, never spawns while the executor is disabled) and the
 * functional request flow over a loopback server WITHOUT a configured token. What
 * was missing is the HTTP mutation-auth posture on these specific spawn-capable
 * routes: with a configured token, non-authorized callers must be denied BEFORE
 * the handler runs, so no request/approval/execution record is ever written.
 *
 * These tests configure `NEON_GATEWAY_HTTP_MUTATION_TOKEN` so loopback no longer
 * auto-authorizes, then assert 401 (missing token) / 403 (wrong token) on all
 * three routes and prove the authorized path records a no-spawn, approval-gated
 * request. No real service mutation, launchctl, or shell spawn is exercised.
 */

const mutationToken = "neonika-runner-service-http-test-token";

const mutationRoutes = [
  {
    label: "request",
    path: "/api/neon-nodes/runner/service/actions",
    body: { action: "install", operatorId: "operator", reason: "http auth audit" }
  },
  {
    label: "approval",
    path: "/api/neon-nodes/runner/service/actions/approvals",
    body: { actionRequestId: "missing-request", decision: "approve", operatorId: "operator" }
  },
  {
    label: "execution",
    path: "/api/neon-nodes/runner/service/actions/executions",
    body: { approvalId: "missing-approval", operatorId: "operator" }
  }
] as const;

describe("Neon Node Runner Service HTTP mutation auth (P5.1)", () => {
  it("denies every spawn-capable service-action route without the configured token (401) and writes nothing", async () => {
    await withConfiguredMutationToken(async () => {
      const projectRoot = await createTempProjectRoot();

      try {
        const handle = await listenNeonGatewayHttpServer(
          { projectRoot },
          { host: "127.0.0.1", port: 0 }
        );

        try {
          for (const route of mutationRoutes) {
            const response = await fetch(`${handle.url}${route.path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(route.body)
            });
            const payload = (await response.json()) as { readonly error: string };

            assert.equal(response.status, 401, `${route.label} route must require auth`);
            assert.equal(payload.error, "neon-http-mutation-auth-required");
          }
        } finally {
          await handle.close();
        }

        // The auth gate short-circuits before the handler, so no side effect lands.
        const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot);
        assert.equal(snapshot.totals.requests, 0);
        assert.equal(snapshot.totals.approvals, 0);
        assert.equal(snapshot.totals.executions, 0);
      } finally {
        await rm(projectRoot, { force: true, recursive: true });
      }
    });
  });

  it("denies every spawn-capable service-action route with a wrong token (403) and writes nothing", async () => {
    await withConfiguredMutationToken(async () => {
      const projectRoot = await createTempProjectRoot();

      try {
        const handle = await listenNeonGatewayHttpServer(
          { projectRoot },
          { host: "127.0.0.1", port: 0 }
        );

        try {
          for (const route of mutationRoutes) {
            const response = await fetch(`${handle.url}${route.path}`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer wrong-token"
              },
              body: JSON.stringify(route.body)
            });
            const payload = (await response.json()) as { readonly error: string };

            assert.equal(response.status, 403, `${route.label} route must reject a wrong token`);
            assert.equal(payload.error, "neon-http-mutation-auth-denied");
          }
        } finally {
          await handle.close();
        }

        const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot);
        assert.equal(snapshot.totals.requests, 0);
        assert.equal(snapshot.totals.approvals, 0);
        assert.equal(snapshot.totals.executions, 0);
      } finally {
        await rm(projectRoot, { force: true, recursive: true });
      }
    });
  });

  it("authorizes the request route with the configured token and records a no-spawn, approval-gated action", async () => {
    await withConfiguredMutationToken(async () => {
      const projectRoot = await createTempProjectRoot();

      try {
        const handle = await listenNeonGatewayHttpServer(
          { projectRoot },
          { host: "127.0.0.1", port: 0 }
        );

        try {
          const authorized = {
            "content-type": "application/json",
            authorization: `Bearer ${mutationToken}`
          };

          const requestResponse = await fetch(`${handle.url}/api/neon-nodes/runner/service/actions`, {
            method: "POST",
            headers: authorized,
            body: JSON.stringify({ action: "install", operatorId: "operator", reason: "http auth audit" })
          });
          const requestBody = (await requestResponse.json()) as {
            readonly request: {
              readonly actionRequestId: string;
              readonly state: string;
              readonly safety: { readonly serviceMutationExecuted: boolean; readonly launchAgentWritten: boolean };
            };
          };

          assert.equal(requestResponse.status, 201);
          assert.ok(
            requestBody.request.state === "approval-required" || requestBody.request.state === "blocked",
            "an authorized request stays approval-gated or blocked, never auto-executed"
          );
          // Crucial: an authorized HTTP request never spawns or mutates the service.
          assert.equal(requestBody.request.safety.serviceMutationExecuted, false);
          assert.equal(requestBody.request.safety.launchAgentWritten, false);

          // Approval/execution routes pass the auth gate (no 401/403) and reach the
          // handler, which 404s on the unknown ids — proving auth allowed them through
          // without performing any mutation.
          const approvalResponse = await fetch(
            `${handle.url}/api/neon-nodes/runner/service/actions/approvals`,
            {
              method: "POST",
              headers: authorized,
              body: JSON.stringify({ actionRequestId: "missing-request", decision: "approve", operatorId: "operator" })
            }
          );
          assert.equal(approvalResponse.status, 404);

          const executionResponse = await fetch(
            `${handle.url}/api/neon-nodes/runner/service/actions/executions`,
            {
              method: "POST",
              headers: authorized,
              body: JSON.stringify({ approvalId: "missing-approval", operatorId: "operator" })
            }
          );
          assert.equal(executionResponse.status, 404);
        } finally {
          await handle.close();
        }

        // Exactly one request landed; no approval/execution side effect occurred.
        const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot);
        assert.equal(snapshot.totals.requests, 1);
        assert.equal(snapshot.totals.approvals, 0);
        assert.equal(snapshot.totals.executions, 0);
      } finally {
        await rm(projectRoot, { force: true, recursive: true });
      }
    });
  });
});

async function withConfiguredMutationToken(run: () => Promise<void>): Promise<void> {
  const previous = process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV];
  process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV] = mutationToken;

  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV];
    } else {
      process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV] = previous;
    }
  }
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-runner-service-http-auth-"));
}
