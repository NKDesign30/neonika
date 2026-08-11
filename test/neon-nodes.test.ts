import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodesSnapshot,
  renderNeonNodesReport
} from "../src/index.js";

describe("Neonika Nodes", () => {
  it("summarizes the local Neonika node with read-only file-transfer policy", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonNodesSnapshot(projectRoot, {
        arch: "arm64",
        gatewayUrl: "http://127.0.0.1:8797",
        homeDir: join(projectRoot, "home"),
        hostName: "operator-mac",
        now: () => new Date("2026-06-01T00:00:00.000Z"),
        pid: 4242,
        platform: "darwin"
      });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.localNode.displayName, "operator-mac Neonika");
      assert.equal(snapshot.localNode.heartbeatAt, "2026-06-01T00:00:00.000Z");
      assert.equal(snapshot.localNode.platform, "darwin");
      assert.equal(snapshot.localNode.arch, "arm64");
      assert.equal(snapshot.localNode.processId, 4242);
      assert.match(snapshot.localNode.nodeId, /^local-[a-f0-9]{12}$/u);
      assert.equal(snapshot.gatewayUrl, "http://127.0.0.1:8797");
      assert.equal(snapshot.pairing.state, "locked");
      assert.equal(snapshot.pairing.approval, "operator-required");
      assert.equal(snapshot.pairing.requestTtlMinutes, 5);
      assert.equal(snapshot.pairingTokenGate.state, "locked");
      assert.equal(snapshot.pairingTokenGate.totals.eligibleApprovals, 0);
      assert.equal(snapshot.pairingTokenGate.blockers.some((blocker) => blocker.id === "no-approved-shadow-approval"), true);
      assert.equal(snapshot.pairingCanaryTokens.state, "locked");
      assert.equal(snapshot.pairingCanaryTokens.totals.issued, 0);
      assert.equal(snapshot.pairingCanaryTokens.deliveryPolicy.rawTokenPersistence, "disabled");
      assert.equal(snapshot.deviceSessions.state, "locked");
      assert.equal(snapshot.deviceSessions.totals.sessions, 0);
      assert.equal(snapshot.deviceSessions.policy.sessionSecretPersistence, "disabled");
      assert.equal(snapshot.actionRequests.state, "empty");
      assert.equal(snapshot.actionRequests.totals.requests, 0);
      assert.equal(snapshot.actionRequests.policy.execution, "disabled");
      assert.equal(snapshot.transport.state, "empty");
      assert.equal(snapshot.transport.totals.dispatches, 0);
      assert.equal(snapshot.transport.totals.results, 0);
      assert.equal(snapshot.transport.totals.polls, 0);
      assert.equal(snapshot.transport.policy.mode, "poll-only");
      assert.equal(snapshot.runner.state, "stopped");
      assert.equal(snapshot.runner.control.desiredState, "stopped");
      assert.equal(snapshot.runner.totals.cycles, 0);
      assert.equal(snapshot.runner.safety.sessionSecretPersisted, false);
      assert.equal(snapshot.runnerService.state, "blocked");
      assert.equal(snapshot.runnerService.installState, "not-installed");
      assert.equal(snapshot.runnerService.credentials.source, "missing");
      assert.equal(snapshot.runnerService.safety.sessionSecretPersisted, false);
      assert.equal(snapshot.runnerServiceActions.state, "empty");
      assert.equal(snapshot.runnerServiceActions.totals.requests, 0);
      assert.equal(snapshot.runnerServiceActions.totals.executions, 0);
      assert.equal(snapshot.runnerServiceCanary.state, "blocked");
      assert.equal(snapshot.runnerServiceCanary.executorMode, "disabled");
      assert.equal(snapshot.runnerServiceCanary.rollbackConfigured, false);
      assert.equal(snapshot.runnerServiceCanary.safety.serviceMutationExecuted, false);
      assert.equal(snapshot.safeRoots[0]?.readable, true);
      assert.equal(snapshot.safeRoots[0]?.writeAccess, false);

      const fileTransfer = snapshot.capabilities.find((capability) => capability.id === "file-transfer");
      const devicePair = snapshot.capabilities.find((capability) => capability.id === "device-pair");

      assert.equal(fileTransfer?.policy, "read-only");
      assert.equal(fileTransfer?.state, "available");
      assert.equal(devicePair?.policy, "approval-required");
      assert.equal(devicePair?.state, "locked");
      assert.equal(snapshot.totals.onlineNodes, 1);
      assert.equal(snapshot.totals.readOnlyCapabilities, 1);
      assert.equal(snapshot.totals.pairingRequests, 0);
      assert.equal(snapshot.totals.pendingPairingRequests, 0);
      assert.equal(snapshot.totals.pairingApprovals, 0);
      assert.equal(snapshot.totals.pairingCanaryTokens, 0);
      assert.equal(snapshot.totals.deviceSessions, 0);
      assert.equal(snapshot.totals.actionRequests, 0);
      assert.equal(snapshot.totals.transportDispatches, 0);
      assert.equal(snapshot.totals.transportResults, 0);
      assert.equal(snapshot.totals.transportPolls, 0);
      assert.equal(snapshot.totals.runnerCycles, 0);
      assert.equal(snapshot.totals.runnerSubmitted, 0);
      assert.equal(snapshot.totals.runnerFailed, 0);
      assert.equal(snapshot.totals.runnerServiceBlockers, 3);
      // Six, not seven: the "stage is before canary" blocker no longer fires at the
      // default stage. The remaining six still hold the canary shut.
      assert.equal(snapshot.totals.runnerServiceCanaryBlockers, 6);
      assert.equal(snapshot.totals.runnerServiceActions, 0);
      assert.equal(snapshot.totals.runnerServicePendingApprovals, 0);
      assert.equal(snapshot.totals.runnerServiceExecutions, 0);
      assert.deepEqual(snapshot.pairingRequests, []);
      assert.deepEqual(snapshot.pairingApprovals, []);
      assert.deepEqual(snapshot.recovery, []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a compact operator report without enabling writes", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const report = renderNeonNodesReport(
        await createNeonNodesSnapshot(projectRoot, {
          hostName: "operator-mac",
          now: () => new Date("2026-06-01T00:00:00.000Z")
        })
      );

      assert.match(report, /Neonika Nodes: ready/);
      assert.match(report, /Pairing: locked \/ operator-required/);
      assert.match(report, /Token Gate: locked/);
      assert.match(report, /Canary Tokens: locked/);
      assert.match(report, /Device Sessions: locked/);
      assert.match(report, /Action Requests: empty/);
      assert.match(report, /Transport: empty/);
      assert.match(report, /Runner: stopped/);
      assert.match(report, /Runner Service: blocked/);
      assert.match(report, /Runner Service Actions: empty/);
      assert.match(report, /Runner Service Canary: blocked/);
      assert.match(report, /file-transfer: available \/ read-only/);
      assert.doesNotMatch(report, /write=yes/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-nodes-"));
}
