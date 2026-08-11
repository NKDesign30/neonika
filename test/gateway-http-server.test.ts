import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeActionRequestSnapshot,
  createNeonNodeDeviceSessionSnapshot,
  createNeonNodePairingRequest,
  createNeonNodePairingCanaryTokenSnapshot,
  createNeonNodePairingSnapshot,
  createNeonNodePairingTokenGateSnapshot,
  createNeonNodeTransportSnapshot,
  listenNeonGatewayHttpServer,
  enqueueNeonDeliveryDryRunCandidate,
  issueNeonNodePairingCanaryToken,
  openNeonNodeDeviceSession,
  recordNeonOperatorAck,
  recordNeonNodeActionApproval,
  recordNeonNodeActionRequest,
  recordNeonNodePairingApproval,
  referenceRootEnvKey,
  resolveNeonNodeTransportPaths,
  NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV,
  writeNeonGatewayRun,
  type INeonAgentSkillPolicyResult,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot,
  type INeonActivitySnapshot,
  type INeonAgentsSnapshot,
  type INeonAutomationSnapshot,
  type INeonChatSnapshot,
  type INeonCanaryStabilitySnapshot,
  type INeonDeliveryQueueSnapshot,
  type INeonDoctorSnapshot,
  type INeonGatewayRouteInspectionSnapshot,
  type INeonGatewayProtocolSnapshot,
  type INeonGatewayRuntimeEventFrame,
  type INeonGatewayRuntimeSnapshot,
  type INeonGatewayShadowRun,
  type INeonGatewayStatus,
  type INeonGatewayRunControlHttpRequest,
  type INeonGatewayRunControlRuntime,
  type INeonInFlightRunRecord,
  type INeonInFlightRunRegistry,
  type INeonLiveSessionReadinessSnapshot,
  type INeonLiveIndexDaemonSnapshot,
  type INeonLiveIndexMemorySyncResult,
  type INeonMirrorEvidenceSnapshot,
  type INeonOnboardingSnapshot,
  type INeonNodesSnapshot,
  type INeonReplayEventPage,
  type INeonReplaySnapshot,
  type INeonNodeActionRequestSnapshot,
  type INeonNodeTransportSnapshot,
  type INeonNodeRunnerSnapshot,
  type INeonNodeRunnerServiceActionSnapshot,
  type INeonNodeRunnerServiceCanarySnapshot,
  type INeonNodeRunnerServiceSnapshot,
  type INeonNodeDeviceSessionSnapshot,
  type INeonNodePairingCanaryTokenSnapshot,
  type INeonNodePairingSnapshot,
  type INeonNodePairingTokenGateSnapshot,
  type INeonExtensionInventorySnapshot,
  type INeonSkillInventorySnapshot,
  type INeonSessionsSnapshot,
} from "../src/index.js";

describe("Neonika Gateway HTTP server", () => {
  it("serves persisted gateway status over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-1", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-gateway/status`);
        const body = (await response.json()) as INeonGatewayStatus;

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(body.runCount, 1);
        assert.equal(body.latestRun?.runId, "run-http-1");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the same genuine Canary evidence used by the Primary gate", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      for (let index = 1; index <= 5; index += 1) {
        const runId = `run-http-canary-${index}`;
        await writeNeonGatewayRun(projectRoot, createHttpCanaryRun(runId));
        await recordNeonOperatorAck(
          projectRoot,
          { runId, ackedBy: "operator" },
          { now: () => new Date("2026-05-31T15:01:00.000Z") }
        );
      }
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        { host: "127.0.0.1", port: 0 }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-canary-stability`);
        const body = (await response.json()) as INeonCanaryStabilitySnapshot;

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(body.verdict, "stable");
        assert.equal(body.totals.delivered, 5);
        assert.equal(body.totals.acknowledged, 5);
        assert.equal(body.primaryReadiness.ready, true);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves bounded gateway runs over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-1", "completed"));
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-2", "failed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-gateway/runs?limit=1`);
        const body = (await response.json()) as { readonly runs: readonly INeonGatewayShadowRun[] };

        assert.equal(response.status, 200);
        assert.equal(body.runs.length, 1);
        assert.equal(body.runs[0]?.runId, "run-http-2");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Gateway lifecycle snapshot over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-gateway/lifecycle`);
        const body = (await response.json()) as INeonGatewayRuntimeSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.network.url, handle.url);
        assert.equal(body.protocol.eventStreamPath, "/api/neon-gateway/events");
        assert.equal(body.protocol.eventStream, "sse");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Gateway protocol contract over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-gateway/protocol`);
        const body = (await response.json()) as INeonGatewayProtocolSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.protocol.transport, "websocket-json-rpc");
        assert.equal(body.endpoints.webSocketPath, "/api/neon-gateway/ws");
        assert.equal(body.endpoints.snapshotPath, "/api/neon-gateway/lifecycle");
        assert.equal(body.hello.type, "hello-ok");
        assert.equal(body.hello.snapshot.state, "ready");
        assert.ok(body.features.methods.includes("connect"));
        assert.ok(body.features.events.includes("connect.challenge"));
        assert.equal(body.policy.outboundDelivery, "suppressed-until-canary");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves upstream-shaped Gateway event frames over SSE", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const abort = new AbortController();

      try {
        const response = await fetch(`${handle.url}/api/neon-gateway/events`, {
          signal: abort.signal
        });
        const reader = response.body?.getReader();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
        assert.ok(reader);

        const raw = await readFirstSseDataFrame(reader);
        const frame = parseSseDataFrame(raw);
        await reader.cancel();
        abort.abort();

        assert.equal(frame.type, "event");
        assert.equal(frame.event, "neon.gateway.snapshot");
        assert.equal(frame.payload.state, "ready");
        assert.equal(frame.payload.protocol.snapshotPath, "/api/neon-gateway/lifecycle");
        assert.ok(frame.seq >= 1);
      } finally {
        abort.abort();
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Gateway route inspection over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-gateway/routes`);
        const body = (await response.json()) as INeonGatewayRouteInspectionSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.discord.agentId, "chaty");
        assert.equal(body.routes[0]?.channel, "discord");
        assert.equal(body.allowlist.guilds.configured, false);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Chat conversations over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-chat", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-chat/conversations?limit=10`);
        const body = (await response.json()) as INeonChatSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.totals.conversations, 1);
        assert.equal(body.totals.messages, 2);
        assert.equal(body.conversations[0]?.messages[0]?.direction, "inbound");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves filtered Neonika Chat conversations over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-chat-main", "completed"));
      const opsRun = createHttpRun("run-http-chat-ops", "completed");
      await writeNeonGatewayRun(projectRoot, {
        ...opsRun,
        request: {
          ...opsRun.request,
          channelId: "900000000000000004",
          contentPreview: "Ops HTTP smoke"
        },
        harnessSessionKey:
          "neon:codex:chaty:discord:default:900000000000000001:900000000000000004:main:hash:read-only"
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(
          `${handle.url}/api/neon-chat/conversations?channelId=900000000000000004&limit=10`
        );
        const body = (await response.json()) as INeonChatSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.deepEqual(body.filters, {
          channelId: "900000000000000004"
        });
        assert.equal(body.totals.sourceRuns, 2);
        assert.equal(body.totals.filteredRuns, 1);
        assert.equal(body.totals.conversations, 1);
        assert.equal(body.conversations[0]?.channelId, "900000000000000004");
        assert.equal(body.conversations[0]?.messages[0]?.textPreview, "Ops HTTP smoke");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Sessions over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-session", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-sessions?limit=10`);
        const body = (await response.json()) as INeonSessionsSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.totals.sessions, 1);
        assert.equal(body.sessions[0]?.latestRunId, "run-http-session");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Activity over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-activity", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-activity?limit=20`);
        const body = (await response.json()) as INeonActivitySnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.ok(body.entries.some((entry) => entry.kind === "inbound"));
        assert.ok(body.entries.some((entry) => entry.kind === "delivery"));
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves filtered Neonika Replay over HTTP without exposing secrets", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, {
        ...createHttpRun("run-http-replay", "completed"),
        events: [
          {
            kind: "tool-output",
            output: "token sk-http-replay-secret",
            toolName: "codex"
          },
          {
            kind: "final",
            text: "done sk-http-replay-secret"
          }
        ],
        finalText: "done sk-http-replay-secret",
        delivery: {
          ...createHttpRun("run-http-replay", "completed").delivery,
          finalText: "done sk-http-replay-secret"
        }
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-replay?runId=run-http-replay&events=10`);
        const body = (await response.json()) as INeonReplaySnapshot;
        const serialized = JSON.stringify(body);

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.filters.runId, "run-http-replay");
        assert.equal(body.runs[0]?.runId, "run-http-replay");
        assert.ok(body.runs[0]?.events.some((event) => event.kind === "tool-output"));
        assert.doesNotMatch(serialized, /sk-http-replay-secret/u);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves a cursor-paginated replay event page over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-page", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const first = (await (
          await fetch(`${handle.url}/api/neon-replay/page?runId=run-http-page&pageLimit=2`)
        ).json()) as INeonReplayEventPage;

        assert.equal(first.state, "ready");
        assert.equal(first.totalEvents, 5);
        assert.equal(first.returned, 2);
        assert.equal(first.hasMore, true);
        assert.ok(first.nextCursor);
        assert.equal(first.items[0]?.runId, "run-http-page");

        const second = (await (
          await fetch(
            `${handle.url}/api/neon-replay/page?runId=run-http-page&pageLimit=2&after=${encodeURIComponent(
              first.nextCursor ?? ""
            )}`
          )
        ).json()) as INeonReplayEventPage;

        assert.equal(second.returned, 2);
        assert.equal(second.items[0]?.position, 2);
        assert.notEqual(second.items[0]?.messageSeq, first.items[0]?.messageSeq);

        const unsafeLimit = (await (
          await fetch(`${handle.url}/api/neon-replay/page?runId=run-http-page&pageLimit=9007199254740992`)
        ).json()) as INeonReplayEventPage;

        assert.equal(unsafeLimit.limit, 50);
        assert.equal(unsafeLimit.returned, 5);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves queued no-send delivery dry-runs over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const run = createHttpRun("run-http-delivery", "completed");
      await writeNeonGatewayRun(projectRoot, run);
      await enqueueNeonDeliveryDryRunCandidate(projectRoot, run, {
        now: () => new Date("2026-05-31T20:10:00.000Z")
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-delivery/queue`);
        const body = (await response.json()) as INeonDeliveryQueueSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.totals.candidates, 1);
        assert.equal(body.totals.queuedDryRuns, 1);
        assert.equal(body.candidates[0]?.runId, "run-http-delivery");
        assert.equal(body.candidates[0]?.safety.outboundSent, false);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records a no-send delivery approval over HTTP and keeps outbound suppressed", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const run = createHttpRun("run-http-approval", "completed");
      await writeNeonGatewayRun(projectRoot, run);
      const candidate = await enqueueNeonDeliveryDryRunCandidate(projectRoot, run, {
        now: () => new Date("2026-05-31T20:10:00.000Z")
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-delivery/approval`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidateId: candidate.id,
            decision: "approve-canary",
            operatorId: "operator"
          })
        });
        const body = (await response.json()) as {
          readonly state: string;
          readonly approval: {
            readonly decision: string;
            readonly candidateId: string;
            readonly safety: { readonly outboundSent: boolean; readonly cutoverStage: string };
          };
        };

        assert.equal(response.status, 201);
        assert.equal(body.state, "accepted");
        assert.equal(body.approval.candidateId, candidate.id);
        assert.equal(body.approval.decision, "approve-canary");
        assert.equal(body.approval.safety.outboundSent, false);
        assert.equal(body.approval.safety.cutoverStage, "shadow");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("requires the configured HTTP mutation token before recording approvals", async () => {
    const projectRoot = await createTempProjectRoot();
    const previousToken = process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV];
    process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV] = "http-mutation-token";

    try {
      const run = createHttpRun("run-http-approval-auth", "completed");
      await writeNeonGatewayRun(projectRoot, run);
      const candidate = await enqueueNeonDeliveryDryRunCandidate(projectRoot, run, {
        now: () => new Date("2026-05-31T20:11:00.000Z")
      });

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const unauthenticated = await fetch(`${handle.url}/api/neon-delivery/approval`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidateId: candidate.id,
            decision: "approve-canary",
            operatorId: "operator"
          })
        });
        const unauthenticatedBody = (await unauthenticated.json()) as { readonly error: string };

        assert.equal(unauthenticated.status, 401);
        assert.equal(unauthenticatedBody.error, "neon-http-mutation-auth-required");

        const authenticated = await fetch(`${handle.url}/api/neon-delivery/approval`, {
          method: "POST",
          headers: {
            authorization: "Bearer http-mutation-token",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            candidateId: candidate.id,
            decision: "approve-canary",
            operatorId: "operator"
          })
        });
        const authenticatedBody = (await authenticated.json()) as {
          readonly approval: { readonly candidateId: string; readonly safety: { readonly outboundSent: boolean } };
        };

        assert.equal(authenticated.status, 201);
        assert.equal(authenticatedBody.approval.candidateId, candidate.id);
        assert.equal(authenticatedBody.approval.safety.outboundSent, false);
      } finally {
        await handle.close();
      }
    } finally {
      if (previousToken === undefined) {
        delete process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV];
      } else {
        process.env[NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV] = previousToken;
      }
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects a delivery approval for an unknown candidate with 404", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-delivery/approval`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateId: "missing-candidate", decision: "approve-canary" })
        });
        const body = (await response.json()) as { readonly error: string };

        assert.equal(response.status, 404);
        assert.equal(body.error, "delivery-candidate-not-found");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Cutover gates over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-cutover`);
        const body = (await response.json()) as INeonCutoverGateSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.currentStage, "primary");
        assert.equal(body.gates.length, 5);
        assert.ok(body.gates.some((gate) => gate.id === "canary"));
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Mirror evidence over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-mirror/evidence`);
        const body = (await response.json()) as INeonMirrorEvidenceSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "needs-evidence");
        assert.equal(body.totals.records, 0);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Agents registry over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-agents`);
        const body = (await response.json()) as INeonAgentsSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.defaultAgentId, "chaty");
        assert.ok(body.agents.some((agent) => agent.id === "chaty"));
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Automation catalog over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-automation`);
        const body = (await response.json()) as INeonAutomationSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.policy, "shadow-read-only");
        assert.equal(body.totals.enabled, 0);
        assert.ok(body.jobs.some((job) => job.kind === "cron"));
        assert.ok(body.hooks.some((hook) => hook.event === "gateway:startup"));
        assert.equal(body.dreams[0]?.state, "disabled");
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves local Neonika Nodes over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes`);
        const body = (await response.json()) as INeonNodesSnapshot;
        const fileTransfer = body.capabilities.find((capability) => capability.id === "file-transfer");

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.gatewayUrl, handle.url);
        assert.match(body.localNode.nodeId, /^local-[a-f0-9]{12}$/u);
        assert.equal(fileTransfer?.policy, "read-only");
        assert.equal(body.safeRoots[0]?.writeAccess, false);
        assert.equal(body.totals.pairingRequests, 0);
        assert.equal(body.transport.state, "empty");
        assert.equal(body.runner.state, "stopped");
        assert.equal(body.runnerService.state, "blocked");
        assert.equal(body.totals.transportDispatches, 0);
        assert.equal(body.totals.transportResults, 0);
        assert.equal(body.totals.transportPolls, 0);
        assert.equal(body.totals.runnerCycles, 0);
        assert.equal(body.totals.runnerSubmitted, 0);
        assert.equal(body.totals.runnerFailed, 0);
        assert.equal(body.totals.runnerServiceBlockers > 0, true);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Node Pairing over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/pairing`);
        const body = (await response.json()) as INeonNodePairingSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "ready");
        assert.equal(body.totals.requests, 0);
        assert.match(body.source.requestPath, /state\/nodes\/node-pairing-requests\.jsonl$/u);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Node Pairing Token Gate over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const request = await createNeonNodePairingRequest(
        projectRoot,
        {
          requestId: "http-token-gate-request",
          deviceId: "operator-phone",
          publicKey: "raw-public-key"
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );
      await recordNeonNodePairingApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          decidedBy: "chaty"
        },
        {
          now: () => new Date("2026-06-01T00:01:00.000Z")
        }
      );
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/pairing/token-gate`);
        const body = (await response.json()) as INeonNodePairingTokenGateSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "locked");
        assert.equal(body.totals.eligibleApprovals, 1);
        assert.equal(body.eligibleApprovals[0]?.tokenIssued, false);
        // The stage blocker does not fire at the default stage; the gate stays locked
        // on the remaining blockers, which is what this endpoint must keep reporting.
        assert.equal(body.blockers.some((blocker) => blocker.id === "cutover-stage-before-canary"), false);
        assert.equal(body.blockers.some((blocker) => blocker.id === "cutover-gate-not-ready"), true);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves redacted Neonika Node Canary Tokens over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/pairing/canary-tokens`);
        const body = (await response.json()) as INeonNodePairingCanaryTokenSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "locked");
        assert.equal(body.totals.issued, 0);
        assert.equal(body.deliveryPolicy.rawTokenPersistence, "disabled");
        assert.equal(body.deliveryPolicy.rawTokenHttpExposure, "disabled");
        assert.equal(body.deliveryPolicy.rawTokenCliEcho, "disabled");
        assert.deepEqual(body.issues, []);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves redacted Neonika Node Device Sessions over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/device-sessions`);
        const body = (await response.json()) as INeonNodeDeviceSessionSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "locked");
        assert.equal(body.totals.sessions, 0);
        assert.equal(body.policy.rawTokenPersistence, "disabled");
        assert.equal(body.policy.sessionSecretPersistence, "disabled");
        assert.equal(body.policy.rawTokenHttpExposure, "disabled");
        assert.equal(body.policy.sessionSecretHttpExposure, "disabled");
        assert.deepEqual(body.sessions, []);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves redacted Neonika Node Action Requests over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/action-requests`);
        const body = (await response.json()) as INeonNodeActionRequestSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "empty");
        assert.equal(body.totals.requests, 0);
        assert.equal(body.totals.approvalRecords, 0);
        assert.equal(body.totals.pendingApproval, 0);
        assert.equal(body.totals.resultPreviews, 0);
        assert.equal(body.totals.pendingResultPreviews, 0);
        assert.equal(body.policy.execution, "disabled");
        assert.equal(body.policy.fileRead, "approval-required");
        assert.equal(body.policy.browserRead, "approval-required");
        assert.deepEqual(body.requests, []);
        assert.deepEqual(body.approvals, []);
        assert.deepEqual(body.resultPreviews, []);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Node Transport over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/transport`);
        const body = (await response.json()) as INeonNodeTransportSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "empty");
        assert.equal(body.totals.dispatches, 0);
        assert.equal(body.totals.blockers, 0);
        assert.equal(body.totals.results, 0);
        assert.equal(body.totals.polls, 0);
        assert.equal(body.policy.mode, "poll-only");
        assert.equal(body.policy.mutationAllowed, false);
        assert.equal(body.policy.rawTokenExposure, "disabled");
        assert.equal(body.policy.sessionSecretExposure, "disabled");
        assert.deepEqual(body.dispatches, []);
        assert.deepEqual(body.blockers, []);
        assert.deepEqual(body.results, []);
        assert.deepEqual(body.polls, []);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Node Runner over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/runner`);
        const body = (await response.json()) as INeonNodeRunnerSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "stopped");
        assert.equal(body.control.desiredState, "stopped");
        assert.equal(body.totals.cycles, 0);
        assert.equal(body.totals.submitted, 0);
        assert.equal(body.safety.sessionSecretPersisted, false);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Node Runner Service over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/runner/service`);
        const body = (await response.json()) as INeonNodeRunnerServiceSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "blocked");
        assert.equal(body.installState, "not-installed");
        assert.equal(body.credentials.source, "missing");
        assert.equal(body.commands.some((command) => command.id === "restart" && command.requiresApproval), true);
        assert.equal(body.safety.installExecuted, false);
        assert.equal(body.safety.sessionSecretPersisted, false);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Node Runner Service canary readiness over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-nodes/runner/service/canary`);
        const body = (await response.json()) as INeonNodeRunnerServiceCanarySnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.state, "blocked");
        assert.equal(body.executorMode, "disabled");
        assert.equal(body.rollbackConfigured, false);
        assert.equal(body.credentialsSource, "missing");
        assert.equal(body.blockers.some((blocker) => blocker.id === "credentials-missing"), true);
        assert.equal(body.safety.serviceMutationExecuted, false);
        assert.equal(body.safety.rawTokenPersisted, false);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves and records Neonika Node Runner Service actions over HTTP without executing them", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const requestResponse = await fetch(`${handle.url}/api/neon-nodes/runner/service/actions`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            action: "install",
            operatorId: "chaty",
            reason: "http service action audit"
          })
        });
        const requestBody = (await requestResponse.json()) as {
          readonly request: {
            readonly actionRequestId: string;
            readonly state: string;
            readonly safety: {
              readonly serviceMutationExecuted: boolean;
            };
          };
        };
        const snapshotResponse = await fetch(`${handle.url}/api/neon-nodes/runner/service/actions`);
        const snapshot = (await snapshotResponse.json()) as INeonNodeRunnerServiceActionSnapshot;
        const missingExecutionResponse = await fetch(`${handle.url}/api/neon-nodes/runner/service/actions/executions`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            approvalId: "missing-approval",
            operatorId: "chaty"
          })
        });

        assert.equal(requestResponse.status, 201);
        assert.equal(requestBody.request.state, "blocked");
        assert.equal(requestBody.request.safety.serviceMutationExecuted, false);
        assert.equal(snapshotResponse.status, 200);
        assert.equal(snapshot.state, "blocked");
        assert.equal(snapshot.totals.requests, 1);
        assert.equal(snapshot.requests[0]?.actionRequestId, requestBody.request.actionRequestId);
        assert.equal(missingExecutionResponse.status, 404);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves authenticated Neonika Node transport polls over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const setup = await createHttpTransportDispatch(projectRoot);
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const missingAuth = await fetch(`${handle.url}/api/neon-nodes/transport/poll`);
        const wrongSecret = await fetch(`${handle.url}/api/neon-nodes/transport/poll`, {
          headers: {
            "x-neon-node-session-id": setup.sessionId,
            "x-neon-node-session-secret": "wrong-secret"
          }
        });
        const firstPoll = await fetch(`${handle.url}/api/neon-nodes/transport/poll`, {
          headers: {
            "x-neon-node-session-id": setup.sessionId,
            "x-neon-node-session-secret": setup.sessionSecret
          }
        });
        const firstBody = (await firstPoll.json()) as {
          readonly replay: string;
          readonly cursor: string;
          readonly dispatches: readonly { readonly dispatchId: string }[];
        };
        const secondPoll = await fetch(
          `${handle.url}/api/neon-nodes/transport/poll?cursor=${encodeURIComponent(firstBody.cursor)}`,
          {
            headers: {
              "x-neon-node-session-id": setup.sessionId,
              "x-neon-node-session-secret": setup.sessionSecret
            }
          }
        );
        const secondBody = (await secondPoll.json()) as {
          readonly replay: string;
          readonly previousCursor?: string;
          readonly dispatches: readonly { readonly dispatchId: string }[];
        };
        const snapshotResponse = await fetch(`${handle.url}/api/neon-nodes/transport`);
        const snapshot = (await snapshotResponse.json()) as INeonNodeTransportSnapshot;
        const rawState = await readFile(resolveNeonNodeTransportPaths(projectRoot).pollPath, "utf8");

        assert.equal(missingAuth.status, 401);
        assert.deepEqual(await missingAuth.json(), { error: "node-session-auth-required" });
        assert.equal(wrongSecret.status, 403);
        assert.deepEqual(await wrongSecret.json(), { error: "node-session-auth-denied" });
        assert.equal(firstPoll.status, 200);
        assert.equal(firstBody.replay, "replay");
        assert.equal(firstBody.dispatches[0]?.dispatchId, setup.dispatchId);
        assert.equal(secondPoll.status, 200);
        assert.equal(secondBody.replay, "cursor-hit");
        assert.equal(secondBody.previousCursor, firstBody.cursor);
        assert.equal(secondBody.dispatches.length, 0);
        assert.equal(snapshot.totals.polls, 2);
        assert.equal(snapshot.totals.activePollingSessions, 1);
        assert.doesNotMatch(rawState, /neon_node_session_http_secret/u);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("accepts authenticated Neonika Node transport result submissions over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const setup = await createHttpTransportDispatch(projectRoot);
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );
      const payload = {
        dispatchId: setup.dispatchId,
        summary: "HTTP result sk-test-secret-value",
        entries: [
          {
            name: "sample.txt",
            kind: "file",
            relativePath: "transport-fixtures/sample.txt",
            sizeBytes: 10
          }
        ],
        totalEntries: 1,
        truncated: false
      };

      try {
        const missingAuth = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
          method: "POST",
          body: JSON.stringify(payload)
        });
        const wrongSecret = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-neon-node-session-id": setup.sessionId,
            "x-neon-node-session-secret": "wrong-secret"
          },
          body: JSON.stringify(payload)
        });
        const accepted = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-neon-node-session-id": setup.sessionId,
            "x-neon-node-session-secret": setup.sessionSecret
          },
          body: JSON.stringify(payload)
        });
        const acceptedBody = (await accepted.json()) as {
          readonly state: string;
          readonly result: {
            readonly dispatchId: string;
            readonly summary: string;
          };
        };
        const duplicate = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-neon-node-session-id": setup.sessionId,
            "x-neon-node-session-secret": setup.sessionSecret
          },
          body: JSON.stringify(payload)
        });
        assert.equal(missingAuth.status, 401);
        assert.deepEqual(await missingAuth.json(), { error: "node-session-auth-required" });
        assert.equal(wrongSecret.status, 403);
        assert.deepEqual(await wrongSecret.json(), { error: "node-session-auth-denied" });
        assert.equal(accepted.status, 201);
        assert.equal(acceptedBody.state, "accepted");
        assert.equal(acceptedBody.result.dispatchId, setup.dispatchId);
        assert.equal(acceptedBody.result.summary, "HTTP result [REDACTED_SECRET]");
        assert.equal(duplicate.status, 409);
        assert.deepEqual(await duplicate.json(), { error: "node-transport-result-duplicate" });

        const snapshotResponse = await fetch(`${handle.url}/api/neon-nodes/transport`);
        const snapshot = (await snapshotResponse.json()) as INeonNodeTransportSnapshot;
        const rawState = await readFile(resolveNeonNodeTransportPaths(projectRoot).resultPath, "utf8");

        assert.equal(snapshot.totals.dispatches, 0);
        assert.equal(snapshot.totals.results, 1);
        assert.equal(snapshot.totals.ingestedApprovals, 1);
        assert.doesNotMatch(rawState, /neon_node_session_http_secret/u);
        assert.doesNotMatch(rawState, /sk-test-secret-value/u);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Doctor snapshot over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-doctor", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-doctor`);
        const body = (await response.json()) as INeonDoctorSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.currentStage, "primary");
        assert.ok(body.checks.some((check) => check.id === "gateway"));
        assert.ok(body.checks.some((check) => check.id === "secrets"));
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Neonika Onboarding snapshot over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-onboarding`);
        const body = (await response.json()) as INeonOnboardingSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.configPreview.secretsPrinted, false);
        assert.ok(body.steps.some((step) => step.id === "discord"));
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves Neonika Skills and Extensions inventory over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();
    // The reference checkout is a fixture, not a host assumption: this test used
    // to pass only on a machine that happened to have a reference checkout at the
    // hardcoded path, and would have failed on any clean CI runner.
    const referenceRoot = await createTempProjectRoot();
    const previousReferenceRoot = process.env[referenceRootEnvKey];
    process.env[referenceRootEnvKey] = referenceRoot;

    try {
      const extensionDir = join(referenceRoot, "extensions", "discord");
      await mkdir(extensionDir, { recursive: true });
      await writeFile(
        join(extensionDir, "openclaw.plugin.json"),
        `${JSON.stringify({ id: "discord", name: "Discord", version: "1.0.0", channels: ["discord"] }, null, 2)}\n`,
        "utf8"
      );

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const skillsResponse = await fetch(`${handle.url}/api/neon-skills`);
        const skills = (await skillsResponse.json()) as INeonSkillInventorySnapshot;
        const extensionsResponse = await fetch(`${handle.url}/api/neon-extensions`);
        const extensions = (await extensionsResponse.json()) as INeonExtensionInventorySnapshot;

        assert.equal(skillsResponse.status, 200);
        assert.equal(extensionsResponse.status, 200);
        assert.ok(skills.totals.roots >= 1);
        assert.equal(skills.totals.extensionManifests, 1);
        assert.equal(extensions.totals.extensionManifests, skills.totals.extensionManifests);
        assert.ok(extensions.extensions.every((extension) => extension.trust === "reference-only"));
      } finally {
        await handle.close();
      }
    } finally {
      if (previousReferenceRoot === undefined) {
        delete process.env[referenceRootEnvKey];
      } else {
        process.env[referenceRootEnvKey] = previousReferenceRoot;
      }

      await rm(referenceRoot, { force: true, recursive: true });
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("feeds a declarative skill-policy file into the policy endpoint", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, ".agents"), { recursive: true });
      await writeFile(
        join(projectRoot, ".agents", "skill-policy.json"),
        JSON.stringify({ deny: ["github"] }),
        "utf8"
      );

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-skills/policy`);
        const payload = (await response.json()) as {
          readonly policySource: { readonly state: string; readonly relativePath: string };
          readonly policy: INeonAgentSkillPolicyResult;
        };

        assert.equal(response.status, 200);
        assert.equal(payload.policySource.state, "loaded");
        assert.equal(payload.policySource.relativePath, ".agents/skill-policy.json");
        const github = payload.policy.decisions.find(
          (decision) => decision.normalizedName === "github"
        );
        if (github) {
          assert.equal(github.decision, "deny");
          assert.equal(github.reason, "denied-global");
        }
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps default-allow on the policy endpoint when no policy file exists", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-skills/policy`);
        const payload = (await response.json()) as {
          readonly policySource: { readonly state: string };
          readonly policy: INeonAgentSkillPolicyResult;
        };

        assert.equal(response.status, 200);
        assert.equal(payload.policySource.state, "absent");
        assert.equal(payload.policy.denied.length, 0);
        assert.equal(payload.policy.allowed.length, payload.policy.decisions.length);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves injected live-session runtime readiness over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();
    const runControl: INeonGatewayRunControlRuntime = {
      registry: createHttpInFlightRegistry(),
      control: async (request) => ({
        state: "accepted",
        action: request.action,
        runId: request.runId,
        reason: "test-control",
        interruptSent: false,
        localAbortSent: true,
        activeRuns: 1,
        safety: { outboundSent: false, primaryCutover: false }
      })
    };

    try {
      const previous = process.env["NEON_LIVE_RUN_LIFECYCLE_ENABLED"];
      process.env["NEON_LIVE_RUN_LIFECYCLE_ENABLED"] = "ready";
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot, runControl },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-live-session-readiness`);
        const snapshot = (await response.json()) as INeonLiveSessionReadinessSnapshot;

        assert.equal(response.status, 200);
        assert.equal(snapshot.liveRuntimeReady, true);
        assert.equal(snapshot.runtime.activeRuns, 1);
        assert.deepEqual(snapshot.runtime.runningRunIds, ["run-http-live"]);
        assert.equal(snapshot.capabilities.find((cap) => cap.capability === "stop")?.state, "interrupt-ready");
        assert.doesNotMatch(JSON.stringify(snapshot), /thread-http-live|turn-http-live|session-http-live/);
      } finally {
        await handle.close();
        if (previous === undefined) {
          delete process.env["NEON_LIVE_RUN_LIFECYCLE_ENABLED"];
        } else {
          process.env["NEON_LIVE_RUN_LIFECYCLE_ENABLED"] = previous;
        }
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the live-index sync projection over HTTP without default memory writes", async () => {
    const projectRoot = await createTempProjectRoot();
    const transcriptProjectsDir = join(projectRoot, "claude-projects");
    const liveIndexCodexSessionsDir = join(projectRoot, "codex-sessions");

    try {
      await mkdir(transcriptProjectsDir, { recursive: true });
      await mkdir(liveIndexCodexSessionsDir, { recursive: true });
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-live-index", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot, transcriptProjectsDir, liveIndexCodexSessionsDir },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-live-index-sync`);
        const body = (await response.json()) as INeonLiveIndexMemorySyncResult;

        assert.equal(response.status, 200);
        assert.equal(body.state, "planned");
        assert.equal(body.collection.totals.discord, 1);
        assert.equal(body.collection.totals.claude, 0);
        assert.equal(body.collection.totals.codex, 0);
        assert.equal(body.collection.totals.records, 1);
        assert.equal(body.writes.length, 0);
        assert.equal(body.dbPath, undefined);
        assert.equal(body.safety.targetedRealMemoryDb, false);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the live-index daemon state over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();
    const transcriptProjectsDir = join(projectRoot, "claude-projects");
    const liveIndexCodexSessionsDir = join(projectRoot, "codex-sessions");

    try {
      await mkdir(transcriptProjectsDir, { recursive: true });
      await mkdir(liveIndexCodexSessionsDir, { recursive: true });
      await writeNeonGatewayRun(projectRoot, createHttpRun("run-http-live-index-daemon", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot, transcriptProjectsDir, liveIndexCodexSessionsDir },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-live-index-daemon`);
        const body = (await response.json()) as INeonLiveIndexDaemonSnapshot;

        assert.equal(response.status, 200);
        assert.equal(body.running, false);
        assert.equal(body.enabled, false);
        assert.equal(body.collection?.totals.discord, 1);
        assert.equal(body.collection?.totals.records, 1);
        assert.equal(body.state?.scanCount, 1);
        assert.equal(body.state?.sources.discord.changed, 1);
        assert.match(body.statePath, /live-index-daemon-state\.json/u);
        assert.match(body.metricsPath, /live-index-daemon-metrics\.jsonl/u);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("dispatches a run-control mutation through the injected runtime", async () => {
    const projectRoot = await createTempProjectRoot();
    const calls: INeonGatewayRunControlHttpRequest[] = [];
    const runControl: INeonGatewayRunControlRuntime = {
      registry: createHttpInFlightRegistry(),
      control: async (request) => {
        calls.push(request);
        return {
          state: "accepted",
          action: request.action,
          runId: request.runId,
          reason: "test-control",
          interruptSent: true,
          localAbortSent: true,
          activeRuns: 1,
          safety: { outboundSent: false, primaryCutover: false }
        };
      }
    };

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot, runControl },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-runs/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "stop", runId: "run-http-live", operatorId: "chaty" })
        });
        const payload = (await response.json()) as {
          readonly state: string;
          readonly control: { readonly state: string; readonly interruptSent: boolean; readonly localAbortSent: boolean };
        };

        assert.equal(response.status, 202);
        assert.equal(payload.state, "accepted");
        assert.equal(payload.control.interruptSent, true);
        assert.equal(payload.control.localAbortSent, true);
        assert.deepEqual(calls, [{ action: "stop", runId: "run-http-live", operatorId: "chaty" }]);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps run-control fail-closed without an injected runtime", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/api/neon-runs/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "stop", runId: "run-http-live" })
        });

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "runtime-control-unavailable" });
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("returns JSON 404 and 405 errors", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const missing = await fetch(`${handle.url}/missing`);
        const badMethod = await fetch(`${handle.url}/api/neon-gateway/status`, {
          method: "POST"
        });

        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: "not-found" });
        assert.equal(badMethod.status, 405);
        assert.deepEqual(await badMethod.json(), { error: "method-not-allowed" });
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createHttpTransportDispatch(projectRoot: string): Promise<{
  readonly dispatchId: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
}> {
  const base = Date.now();
  await mkdir(join(projectRoot, "transport-fixtures"), { recursive: true });
  await writeFile(join(projectRoot, "transport-fixtures", "sample.txt"), "transport\n", "utf8");

  const pairingRequest = await createNeonNodePairingRequest(
    projectRoot,
    {
      requestId: "pair-http-transport-request",
      deviceId: "operator-node",
      publicKey: "raw-public-key",
      displayName: "Operator Node",
      platform: "macos",
      requestedRole: "operator",
      requestedScopes: ["operator.pairing", "file.read"]
    },
    {
      now: () => new Date(base + 0 * 60_000)
    }
  );
  const pairingApproval = await recordNeonNodePairingApproval(
    projectRoot,
    {
      requestId: pairingRequest.requestId,
      decision: "approve",
      decidedBy: "chaty",
      reason: "HTTP transport result unit"
    },
    {
      now: () => new Date(base + 1 * 60_000)
    }
  );
  const pairingSnapshot = await createNeonNodePairingSnapshot(projectRoot, {
    now: () => new Date(base + 2 * 60_000)
  });
  const tokenGateSnapshot = await createNeonNodePairingTokenGateSnapshot(projectRoot, {
    pairingSnapshot,
    cutoverSnapshot: createHttpCanaryCutoverSnapshot(projectRoot),
    now: () => new Date(base + 3 * 60_000)
  });
  const tokenResult = await issueNeonNodePairingCanaryToken(
    projectRoot,
    {
      requestId: pairingRequest.requestId,
      approvalId: pairingApproval.approvalId,
      issuedBy: "chaty",
      deliveryMethod: "mission-control-once",
      deliveryNote: "HTTP transport result unit",
      ttlMinutes: 15
    },
    {
      tokenGateSnapshot,
      createTokenMaterial: () => "neon_node_canary_http_secret",
      now: () => new Date(base + 4 * 60_000)
    }
  );
  const canaryTokenSnapshot = await createNeonNodePairingCanaryTokenSnapshot(projectRoot, {
    tokenGateSnapshot,
    now: () => new Date(base + 5 * 60_000)
  });
  const sessionResult = await openNeonNodeDeviceSession(
    projectRoot,
    {
      tokenIssueId: tokenResult.record.tokenIssueId,
      token: tokenResult.oneTimeSecret.token,
      acceptedBy: "chaty",
      requestedScopes: ["operator.pairing", "file.read"],
      ttlMinutes: 24 * 60
    },
    {
      canaryTokenSnapshot,
      createSessionSecret: () => "neon_node_session_http_secret",
      now: () => new Date(base + 6 * 60_000)
    }
  );
  const deviceSessionSnapshot = await createNeonNodeDeviceSessionSnapshot(projectRoot, {
    canaryTokenSnapshot,
    now: () => new Date(base + 7 * 60_000)
  });
  const actionRequest = await recordNeonNodeActionRequest(
    projectRoot,
    {
      sessionId: sessionResult.record.sessionId,
      kind: "file.list",
      requestedBy: "chaty",
      targetPath: join(projectRoot, "transport-fixtures"),
      reason: "HTTP transport result unit"
    },
    {
      deviceSessionSnapshot,
      now: () => new Date(base + 8 * 60_000)
    }
  );
  await recordNeonNodeActionApproval(
    projectRoot,
    {
      requestId: actionRequest.requestId,
      decision: "approve",
      operatorId: "chaty",
      reason: "HTTP transport result unit"
    },
    {
      now: () => new Date(base + 9 * 60_000)
    }
  );
  const actionRequestSnapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
    deviceSessionSnapshot,
    now: () => new Date(base + 10 * 60_000)
  });
  const transportSnapshot = await createNeonNodeTransportSnapshot(projectRoot, {
    deviceSessionSnapshot,
    actionRequestSnapshot,
    now: () => new Date(base + 11 * 60_000)
  });
  const dispatch = transportSnapshot.dispatches[0];

  assert.ok(dispatch);

  return {
    dispatchId: dispatch.dispatchId,
    sessionId: sessionResult.record.sessionId,
    sessionSecret: sessionResult.oneTimeSessionSecret.sessionSecret
  };
}

function createHttpCanaryCutoverSnapshot(projectRoot: string): INeonCutoverGateSnapshot {
  const gates: readonly INeonCutoverGate[] = [
    createHttpCutoverGate("shadow", "Shadow", "pass"),
    createHttpCutoverGate("mirror", "Mirror", "pass"),
    createHttpCutoverGate("canary", "Canary", "pass"),
    createHttpCutoverGate("primary", "Primary", "locked"),
    createHttpCutoverGate("retire", "Retire", "locked")
  ];

  return {
    state: "ready",
    generatedAt: "2026-06-01T00:03:00.000Z",
    currentStage: "canary",
    nextStage: "primary",
    gates,
    source: {
      projectRoot,
      doctorState: "pass",
      routeState: "ready",
      mirrorEvidenceState: "ready",
      mirrorAcceptedCount: 2,
      gatewayRuns: 5,
      latestRunId: "run-http-transport-unit",
      rollbackConfigured: true
    }
  };
}

function createHttpCutoverGate(
  id: INeonCutoverGate["id"],
  label: string,
  state: INeonCutoverGate["state"]
): INeonCutoverGate {
  return {
    id,
    label,
    state,
    summary: `${label} ${state}`,
    requiredEvidence: ["HTTP transport result unit"],
    evidence: ["evidence"],
    recovery: state === "pass" ? [] : ["keep previous stage"],
    rollback: "Keep previous route active."
  };
}

function createHttpRun(
  runId: string,
  status: INeonGatewayShadowRun["status"]
): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status,
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "HTTP smoke",
      receivedAt: "2026-05-31T14:30:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:channel:main:hash:read-only",
    memoryState: "skipped",
    events:
      status === "failed"
        ? [
            {
              kind: "failed",
              message: "failed"
            }
          ]
        : [
            {
              kind: "final",
              text: "ok"
            }
          ],
    finalText: status === "failed" ? "failed" : "ok",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: status === "failed" ? "failed" : "ok"
    },
    startedAt: "2026-05-31T15:00:00.000Z",
    completedAt: "2026-05-31T15:00:01.000Z"
  };
}

function createHttpCanaryRun(runId: string): INeonGatewayShadowRun {
  const run = createHttpRun(runId, "completed");

  return {
    ...run,
    mode: "live",
    delivery: {
      ...run.delivery,
      state: "delivered",
      reason: "canary-reply",
      messageId: `message-${runId}`,
      cutoverStage: "canary"
    }
  };
}

function createHttpInFlightRegistry(): INeonInFlightRunRegistry {
  const record: INeonInFlightRunRecord = {
    runId: "run-http-live",
    threadId: "thread-http-live",
    turnId: "turn-http-live",
    sessionKey: "session-http-live",
    agentId: "chaty",
    channel: "discord",
    state: "running" as const,
    startedAt: "2026-06-04T10:00:00.000Z",
    lastActivityAt: "2026-06-04T10:00:01.000Z"
  };

  return {
    gate: { enabled: true, reason: "lifecycle-enabled", envKey: "NEON_LIVE_RUN_LIFECYCLE_ENABLED" },
    onRunStart: () => record,
    recordActivity: () => undefined,
    markInterrupting: () => undefined,
    onRunEnd: () => undefined,
    snapshot: () => ({
      activeRuns: 1,
      busy: true,
      lastRunActivityAt: record.lastActivityAt,
      running: [record]
    })
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-gateway-http-"));
}

async function readFirstSseDataFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for (let index = 0; index < 10; index += 1) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true });

    if (hasCompleteSseDataBlock(buffer)) {
      return buffer;
    }
  }

  throw new Error("SSE stream did not emit a data frame");
}

function hasCompleteSseDataBlock(raw: string): boolean {
  return raw.split("\n\n").some((block) => block.split("\n").some((line) => line.startsWith("data: ")));
}

function parseSseDataFrame(raw: string): INeonGatewayRuntimeEventFrame {
  const dataLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data: "));

  assert.ok(dataLine);

  return JSON.parse(dataLine.slice("data: ".length)) as INeonGatewayRuntimeEventFrame;
}
