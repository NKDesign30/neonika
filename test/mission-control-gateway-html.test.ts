import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonLiveSessionReadinessSnapshot,
  createNeonMissionControlGatewaySnapshot,
  listenNeonGatewayHttpServer,
  renderNeonMissionControlGatewayHtml,
  writeNeonGatewayRun,
  type INeonGatewayRunControlRuntime,
  type INeonGatewayShadowRun,
  type INeonGatewayStatus,
  type INeonInFlightRunRecord
} from "../src/index.js";

describe("Neonika Mission Control Gateway HTML", () => {
  it("renders a Mission Control HTML surface from a real snapshot", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-1", "completed")],
      {
        now: () => new Date("2026-05-31T16:20:00.000Z")
      }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.match(html, /<!doctype html>/);
    assert.match(html, /Neonika Mission Control/);
    assert.match(html, /NEONIKA/);
    assert.match(html, /data-view="chat"/);
    assert.match(html, /data-view="overview"/);
    assert.match(html, /data-view="activity"/);
    assert.match(html, /data-view="workboard"/);
    assert.match(html, /data-view="instances"/);
    assert.match(html, /data-view="sessions"/);
    assert.match(html, /data-view="usage"/);
    assert.match(html, /data-view="cron"/);
    assert.match(html, /data-view="skills"/);
    assert.match(html, /data-view="nodes"/);
    assert.match(html, /data-view="dreams"/);
    assert.match(html, /data-view="config"/);
    assert.match(html, /id="view-overview" data-view="overview" hidden/);
    assert.match(html, /id="view-activity" data-view="activity" hidden/);
    assert.match(html, /New session/);
    assert.match(html, /Chaty Lab/);
    assert.match(html, /Gateway Zugang/);
    assert.match(html, /Neonika Chat/);
    assert.match(html, /WebSocket URL/);
    assert.match(html, /Gateway Snapshot/);
    assert.match(html, /Neonika Aktivität/);
    assert.match(html, /Neonika Instanzen/);
    assert.match(html, /Neonika Nutzung/);
    assert.match(html, /Neonika Agents/);
    assert.match(html, /Cron-Aufgaben/);
    assert.match(html, /Neonika Skills/);
    assert.match(html, /Neonika Geräte/);
    assert.match(html, /Neonika Träume/);
    assert.match(html, /Neonika Einstellungen/);
    // Blocked-row readiness panel is wired into the server-rendered dashboard.
    assert.match(html, /Blocked-Row Readiness/);
    assert.match(html, /\/api\/neon-blocked-readiness/);
    assert.match(html, /OPERATOR-FREIGABE/);
    // Live-session readiness panel is wired into the server-rendered dashboard.
    assert.match(html, /Live-Session Readiness/);
    assert.match(html, /\/api\/neon-live-session-readiness/);
    assert.match(html, /LIVE-RUNTIME NOT READY/);
    assert.match(html, /initialSnapshot/);
    assert.match(html, /run-html-1/);
    assert.match(html, /\/api\/neon-mission-control\/gateway/);
    assert.match(html, /\/api\/neon-gateway\/lifecycle/);
    assert.match(html, /\/api\/neon-gateway\/events/);
    assert.match(html, /\/api\/neon-chat\/conversations/);
    assert.match(html, /\/api\/neon-delivery\/queue/);
    assert.match(html, /\/api\/neon-sessions/);
    assert.match(html, /\/api\/neon-activity/);
    assert.match(html, /\/api\/neon-replay/);
    assert.match(html, /id="activityRows"/);
    assert.match(html, /id="activitySearchInput"/);
    assert.match(html, /id="activityStatusFilter"/);
    assert.match(html, /id="activityAgentFilter"/);
    assert.match(html, /id="activityClearFilters"/);
    assert.match(html, /id="activityVisibleCount"/);
    assert.match(html, /probe " \+ route\.probeState/);
    assert.match(html, /route\.lastProbeAt \|\| "none"/);
    assert.match(html, /readActivityFiltersFromLocation/);
    assert.match(html, /writeActivityFiltersToLocation/);
    assert.match(html, /updateActivityFilters/);
    assert.match(html, /id="replayRows"/);
    assert.match(html, /id="replayDetail"/);
    assert.match(html, /id="replaySummary"/);
    assert.match(html, /loadReplay/);
    assert.match(html, /replayUrl/);
    assert.match(html, /activeReplayFilters/);
    assert.match(html, /readReplayFiltersFromLocation/);
    assert.match(html, /writeReplayFiltersToLocation/);
    assert.match(html, /data-replay-run-id/);
    assert.match(html, /data-replay-session-key/);
    assert.match(html, /data-replay-conversation-id/);
    assert.match(html, /id="deliveryQueueRows"/);
    assert.match(html, /id="deliveryApprovalRows"/);
    assert.match(html, /id="deliveryApprovalSummary"/);
    assert.match(html, /id="metricDeliveryQueue"/);
    assert.match(html, /id="sessionRows"/);
    assert.match(html, /id="sessionSearchInput"/);
    assert.match(html, /id="sessionStatusFilter"/);
    assert.match(html, /id="sessionAgentFilter"/);
    assert.match(html, /id="sessionClearFilters"/);
    assert.match(html, /id="sessionVisibleCount"/);
    assert.match(html, /readSessionFiltersFromLocation/);
    assert.match(html, /writeSessionFiltersToLocation/);
    assert.match(html, /updateSessionFilters/);
    assert.match(html, /\/api\/neon-gateway\/routes/);
    assert.match(html, /\/api\/neon-mirror\/evidence/);
    assert.match(html, /\/api\/neon-cutover/);
    assert.match(html, /\/api\/neon-gates/);
    assert.match(html, /\/api\/neon-agents/);
    assert.match(html, /\/api\/neon-skills/);
    assert.match(html, /\/api\/neon-extensions/);
    assert.match(html, /\/api\/neon-nodes/);
    assert.match(html, /\/api\/neon-doctor/);
    assert.match(html, /id="skillRootRows"/);
    assert.match(html, /id="extensionRows"/);
    assert.match(html, /id="nodesHeartbeat"/);
    assert.match(html, /id="nodesPairing"/);
    assert.match(html, /id="nodesPairingPending"/);
    assert.match(html, /id="nodesPairingApprovals"/);
    assert.match(html, /id="nodesTokenGate"/);
    assert.match(html, /id="nodesTokenGateBlockers"/);
    assert.match(html, /id="nodesCanaryTokens"/);
    assert.match(html, /id="nodesSecretDelivery"/);
    assert.match(html, /id="nodesDeviceSessions"/);
    assert.match(html, /id="nodesDeviceSessionScopes"/);
    assert.match(html, /id="nodesActionRequests"/);
    assert.match(html, /id="nodesActionApprovals"/);
    assert.match(html, /id="nodesActionResultPreviews"/);
    assert.match(html, /id="nodesTransport"/);
    assert.match(html, /id="nodesTransportResults"/);
    assert.match(html, /id="nodesTransportPolls"/);
    assert.match(html, /id="nodesRunner"/);
    assert.match(html, /id="nodesRunnerLoop"/);
    assert.match(html, /id="nodesRunnerService"/);
    assert.match(html, /id="nodesRunnerServiceInstall"/);
    assert.match(html, /id="nodesRunnerServiceCredentials"/);
    assert.match(html, /id="nodesRunnerServiceCanary"/);
    assert.match(html, /id="nodesRunnerServiceExecutor"/);
    assert.match(html, /id="nodesRunnerServiceRollback"/);
    assert.match(html, /id="nodesRunnerServiceCutover"/);
    assert.match(html, /id="nodesRunnerServiceActions"/);
    assert.match(html, /id="nodesRunnerServiceApprovals"/);
    assert.match(html, /id="nodesRunnerServiceExecutions"/);
    assert.match(html, /id="nodesActionPolicy"/);
    assert.match(html, /id="pairingRows"/);
    assert.match(html, /id="eventStreamUrl"/);
    assert.match(html, /id="lifecycleState"/);
    assert.match(html, /EventSource/);
    assert.match(html, /\/api\/neon-onboarding/);
    assert.match(html, /\/api\/neon-automation/);
    assert.match(html, /id="cronRows"/);
    assert.match(html, /id="hookRows"/);
    assert.match(html, /id="dreamRows"/);
    assert.match(html, /Recent Events/);
    assert.match(html, /id="recentEventsPanel"/);
    assert.match(html, /id="recentEventsCount"/);
    assert.doesNotMatch(html, /undefined/);
  });

  it("server-renders the Recent Events panel from the live snapshot projection", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-events", "completed"), createHtmlRun("run-html-fail", "failed")],
      { now: () => new Date("2026-05-31T16:20:00.000Z") }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    // The live projection produced events for both runs (final + failed).
    assert.ok(snapshot.recentEvents.length >= 2);
    assert.match(html, /<h2 class="panel-title">Recent Events<\/h2>/);
    assert.match(html, /run-html-events \/ final/);
    assert.match(html, /<strong>final<\/strong>/);
    assert.match(html, /<strong>failed<\/strong>/);
    // Leak-safe: only the bounded label/kind/runId surface — never the raw final
    // text ("ok") that the run carried.
    assert.doesNotMatch(html, /<strong>ok<\/strong>/);
  });

  it("server-renders an empty Recent Events panel when no runs exist", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [], {
      now: () => new Date("2026-05-31T16:20:00.000Z")
    });
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.equal(snapshot.recentEvents.length, 0);
    assert.match(html, /id="recentEventsEmpty"/);
    assert.match(html, /no recent events/);
    assert.match(html, /id="recentEventsCount">0 live</);
    // No events -> no fabricated filter facets are rendered.
    assert.doesNotMatch(html, /id="recentEventsFilter"/);
  });

  it("server-renders the Channels panel from the static manifest catalog", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [], {
      now: () => new Date("2026-06-02T09:00:00.000Z")
    });
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.match(html, /id="channelsPanel"/);
    assert.match(html, /id="channelsCount">2 live \/ 4 gated</);

    const panelBody = html.match(/id="channelsPanelBody">([\s\S]*?)<\/div>\s*<\/article>/)?.[1] ?? "";
    assert.ok(panelBody.length > 0, "channels panel body rendered");

    // Every catalog platform has a row; Discord and WhatsApp are live inbound.
    for (const id of ["discord", "matrix", "msteams", "slack", "telegram", "whatsapp"]) {
      assert.match(panelBody, new RegExp(`data-channel="${id}"`));
    }
    assert.equal((panelBody.match(/>live<\/span>/g) ?? []).length, 2);
    assert.equal((panelBody.match(/>gated<\/span>/g) ?? []).length, 4);
    // No channel implies a live send path: outbound is suppressed for all six.
    assert.equal((panelBody.match(/>suppressed<\/span>/g) ?? []).length, 6);
    assert.match(panelBody, /no-new-login/);
  });

  it("server-renders a Recent Events filter control from the live projection", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-events", "completed"), createHtmlRun("run-html-fail", "failed")],
      { now: () => new Date("2026-05-31T16:20:00.000Z") }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    // The projection produced one `final` and one `failed` event across the runs.
    const finalCount = snapshot.recentEvents.filter((event) => event.kind === "final").length;
    const failedCount = snapshot.recentEvents.filter((event) => event.kind === "failed").length;
    assert.equal(finalCount, 1);
    assert.equal(failedCount, 1);

    // The filter control is server-rendered with a real visible-count summary.
    assert.match(html, /id="recentEventsFilter"/);
    assert.match(
      html,
      new RegExp(
        `id="recentEventsVisibleCount">${snapshot.recentEvents.length} / ${snapshot.recentEvents.length} sichtbar<`
      )
    );

    // Each facet chip carries the real per-kind count from the snapshot, not a
    // placeholder. The "alle" reset chip reflects the total event count.
    assert.match(html, /data-event-kind=""[^>]*>alle 2</);
    assert.match(html, /data-event-kind="final" data-event-count="1"[^>]*>final 1</);
    assert.match(html, /data-event-kind="failed" data-event-count="1"[^>]*>failed 1</);

    // The rows below are tagged by kind, so the control is a genuine filterable
    // DOM surface and not a decorative widget.
    assert.match(html, /<div class="route-step" data-event-kind="final">/);
    assert.match(html, /<div class="route-step" data-event-kind="failed">/);

    // Leak-safe: only the bounded kind tokens reach the filter, never the raw
    // final text ("ok") the run carried.
    assert.doesNotMatch(html, /data-event-kind="ok"/);
    assert.doesNotMatch(html, /<strong>ok<\/strong>/);
  });

  it("server-renders the Recent Runs panel with operator deep-links", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-runs", "completed")],
      { now: () => new Date("2026-05-31T16:20:00.000Z") }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.match(html, /<h2 class="panel-title">Recent Runs<\/h2>/);
    assert.match(html, /<strong>run-html-runs<\/strong>/);
    // Deep-links pivot the operator into the filtered read-only views.
    assert.match(html, /href="\/api\/neon-replay\?runId=run-html-runs"/);
    assert.match(html, /href="\/api\/neon-chat\?runId=run-html-runs"/);
    assert.match(html, /href="\/api\/neon-replay\?channelId=900000000000000005"/);
    // Leak-safe: the run's raw final text ("ok") never reaches the panel.
    assert.doesNotMatch(html, /<strong>ok<\/strong>/);
  });

  it("server-renders an empty Recent Runs panel when no runs exist", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [], {
      now: () => new Date("2026-05-31T16:20:00.000Z")
    });
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.match(html, /id="recentRunsEmpty"/);
    assert.match(html, /no recent runs/);
    assert.match(html, /id="recentRunsCount">0 runs</);
  });

  it("url-encodes deep-link params so a crafted channel id cannot break out of the href", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [
        {
          ...createHtmlRun("run-html-encode", "completed"),
          request: {
            ...createHtmlRun("run-html-encode", "completed").request,
            channelId: 'evil" onclick="x'
          }
        }
      ],
      { now: () => new Date("2026-05-31T16:20:00.000Z") }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    // The crafted channel id is percent-encoded inside the href, never a raw
    // attribute-breaking quote.
    assert.match(html, /channelId=evil%22%20onclick%3D%22x/);
    assert.doesNotMatch(html, /channelId=evil" onclick/);
  });

  it("escapes embedded snapshot values before placing them in a script tag", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      {
        ...createStatus(),
        runsPath: "</script><script>alert('neon')</script>"
      },
      [createHtmlRun("run-html-escape", "completed")]
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.match(html, /\\u003c\/script>/);
    assert.doesNotMatch(html, /<script>alert\('neon'\)<\/script>/);
  });

  it("serves the Mission Control HTML surface over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createHtmlRun("run-html-1", "completed"));

      const handle = await listenNeonGatewayHttpServer(
        { projectRoot },
        {
          host: "127.0.0.1",
          port: 0
        }
      );

      try {
        const response = await fetch(`${handle.url}/mission-control/gateway`);
        const html = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.match(html, /Neonika Mission Control/);
        assert.match(html, /Gateway Zugang/);
        assert.match(html, /run-html-1/);
        // Served-path proof: the live Recent Events panel reaches the browser.
        assert.match(html, /<h2 class="panel-title">Recent Events<\/h2>/);
        assert.match(html, /<strong>final<\/strong>/);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves the Mission Control HTML alias route", async () => {
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
        const response = await fetch(`${handle.url}/mission-control`);
        const html = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.match(html, /Neonika Mission Control/);
        assert.match(html, /initialSnapshot/);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serves direct Mission Control tab routes", async () => {
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
        const response = await fetch(`${handle.url}/mission-control/usage`);
        const html = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        assert.match(html, /id="view-usage" data-view="usage"/);
        assert.doesNotMatch(html, /id="view-usage" data-view="usage" hidden/);
        assert.match(html, /\/mission-control\/sessions/);
        assert.match(html, /\/mission-control\/config/);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("server-renders the Canary Outbound panel as suppressed by default", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-canary", "completed")],
      { now: () => new Date("2026-06-02T11:00:00.000Z"), env: {} }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.equal(snapshot.canaryPosture.ready, false);
    assert.match(html, /<h2 class="panel-title">Canary Outbound<\/h2>/);
    assert.match(html, /id="canaryReady">SUPPRESSED \(default\)/);
    assert.match(html, /id="canaryChannel">none</);
  });

  it("server-renders the Canary Outbound panel as live-ready without leaking the token", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-canary", "completed")],
      {
        now: () => new Date("2026-06-02T11:00:00.000Z"),
        env: {
          NEON_DISCORD_BOT_TOKEN: "bot-token-secret-should-not-render",
          NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005",
          NEON_CUTOVER_STAGE: "canary",
          NEON_CUTOVER_CANARY_APPROVED: "1",
          NEON_CUTOVER_OUTBOUND_ENABLED: "1"
        }
      }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.equal(snapshot.canaryPosture.ready, true);
    assert.match(html, /id="canaryReady">LIVE-READY/);
    assert.match(html, /id="canaryChannel">900000000000000005</);
    assert.match(html, /id="gatePosturePanel"/);
    assert.match(html, /id="gatePostureState">FULLY SHADOWED/);
    assert.match(html, /id="gatePostureTotals">16 · armed 0 · shadowed 16/);
    assert.doesNotMatch(html, /bot-token-secret-should-not-render/);
  });

  it("server-renders live-run Stop/Abort controls from the injected runtime snapshot", () => {
    const record = createLiveControlRecord("neon-shadow-livecontrol01");
    const liveSessionReadiness = createNeonLiveSessionReadinessSnapshot({
      env: { NEON_LIVE_RUN_LIFECYCLE_ENABLED: "ready" },
      runtimeSnapshot: {
        activeRuns: 1,
        busy: true,
        lastRunActivityAt: record.lastActivityAt,
        running: [record]
      }
    });
    const snapshot = createNeonMissionControlGatewaySnapshot(
      createStatus(),
      [createHtmlRun("run-html-1", "completed")],
      { now: () => new Date("2026-06-04T10:00:05.000Z") }
    );
    const html = renderNeonMissionControlGatewayHtml(snapshot, { liveSessionReadiness });

    // Verdict flips to READY and the runtime line reflects the live run.
    assert.match(html, /id="liveSessionReadyState">LIVE-RUNTIME READY/);
    assert.match(html, /active-runs 1 · busy yes · live-runtime-ready true/);
    // A control row with Stop/Abort buttons wired to the existing endpoint.
    assert.match(html, /data-run-control-row="neon-shadow-livecontrol01"/);
    assert.match(html, /data-run-control-action="stop" data-run-control-run-id="neon-shadow-livecontrol01"/);
    assert.match(html, /data-run-control-action="abort" data-run-control-run-id="neon-shadow-livecontrol01"/);
    // Client handler posts fail-closed to the existing control endpoint.
    assert.match(html, /fetch\("\/api\/neon-runs\/control"/);
    assert.match(html, /dispatchRunControl/);
    // No empty-state line while a run is active.
    assert.doesNotMatch(html, /id="runControlEmpty"/);
    // Leak-safe: thread/turn/session keys never reach the panel.
    assert.doesNotMatch(html, /thread-livecontrol|turn-livecontrol|session-livecontrol/);
  });

  it("renders the empty live-run control state when no run is active", () => {
    const snapshot = createNeonMissionControlGatewaySnapshot(createStatus(), [], {
      now: () => new Date("2026-06-04T10:00:05.000Z")
    });
    const html = renderNeonMissionControlGatewayHtml(snapshot);

    assert.match(html, /id="liveSessionReadyState">LIVE-RUNTIME NOT READY/);
    assert.match(html, /active-runs 0 · busy no · live-runtime-ready false/);
    assert.match(html, /id="runControlEmpty"/);
    assert.doesNotMatch(html, /data-run-control-action="stop"/);
  });

  it("wires live-run controls into the served Mission Control HTML over HTTP", async () => {
    const projectRoot = await createTempProjectRoot();
    const record = createLiveControlRecord("neon-shadow-httpcontrol");
    const runControl: INeonGatewayRunControlRuntime = {
      registry: {
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
      },
      control: async (request) => ({
        state: "accepted",
        action: request.action,
        runId: request.runId,
        reason: "smoke",
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
        { host: "127.0.0.1", port: 0 }
      );

      try {
        const response = await fetch(`${handle.url}/mission-control/gateway`);
        const html = await response.text();

        assert.equal(response.status, 200);
        assert.match(html, /id="liveSessionReadyState">LIVE-RUNTIME READY/);
        assert.match(html, /data-run-control-row="neon-shadow-httpcontrol"/);
        assert.match(html, /data-run-control-action="stop" data-run-control-run-id="neon-shadow-httpcontrol"/);
        // Leak-safe: the record's thread/turn/session keys never reach the panel.
        assert.doesNotMatch(html, /thread-livecontrol|turn-livecontrol|session-livecontrol/);
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
});

function createLiveControlRecord(runId: string): INeonInFlightRunRecord {
  return {
    runId,
    threadId: "thread-livecontrol",
    turnId: "turn-livecontrol",
    sessionKey: "session-livecontrol",
    agentId: "chaty",
    channel: "discord",
    state: "running",
    startedAt: "2026-06-04T10:00:00.000Z",
    lastActivityAt: "2026-06-04T10:00:01.000Z"
  };
}

function createStatus(): INeonGatewayStatus {
  return {
    state: "ready",
    projectRoot: "/Users/operator/neon-projects/neonika",
    runsPath: "/Users/operator/neon-projects/neonika/state/gateway/runs.jsonl",
    runCount: 1,
    shadowRunCount: 1,
    completedCount: 1,
    failedCount: 0,
    runningCount: 0,
    cancelledCount: 0,
    deliverySuppressedCount: 1,
    latestRun: {
      runId: "run-html-1",
      mode: "shadow",
      status: "completed",
      channel: "discord",
      channelId: "900000000000000005",
      agentId: "chaty",
      memoryState: "skipped",
      deliveryState: "suppressed",
      startedAt: "2026-05-31T15:00:00.000Z",
      completedAt: "2026-05-31T15:00:01.000Z"
    }
  };
}

function createHtmlRun(
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
      contentPreview: "Mission Control HTML",
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

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-mission-control-html-"));
}
