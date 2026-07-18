import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeDeviceSessionSnapshot,
  createNeonNodePairingCanaryTokenSnapshot,
  createNeonNodePairingRequest,
  createNeonNodePairingSnapshot,
  createNeonNodePairingTokenGateSnapshot,
  issueNeonNodePairingCanaryToken,
  openNeonNodeDeviceSession,
  recordNeonNodePairingApproval,
  renderNeonNodeDeviceSessionReport,
  resolveNeonNodeDeviceSessionPaths,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot,
  type INeonNodePairingApprovalRecord,
  type INeonNodePairingCanaryTokenIssueResult,
  type INeonNodePairingCanaryTokenSnapshot,
  type INeonNodePairingTokenGateSnapshot
} from "../src/index.js";

describe("Neonika Node Device Sessions", () => {
  it("opens a scoped session from an active canary token without persisting raw secrets", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const { tokenResult, canaryTokenSnapshot } = await createIssuedCanaryToken(projectRoot);
      const result = await openNeonNodeDeviceSession(
        projectRoot,
        {
          tokenIssueId: tokenResult.record.tokenIssueId,
          token: tokenResult.oneTimeSecret.token,
          acceptedBy: "chaty",
          deviceNonce: "device-nonce-secret",
          requestedScopes: ["operator.pairing", "node.status", "file.write", "phone.control"],
          ttlMinutes: 30
        },
        {
          canaryTokenSnapshot,
          createSessionSecret: () => "neon_node_session_unit_secret",
          now: () => new Date("2026-06-01T00:06:00.000Z")
        }
      );

      assert.equal(result.state, "accepted-canary");
      assert.equal(result.oneTimeSessionSecret.sessionSecret, "neon_node_session_unit_secret");
      assert.equal(result.oneTimeSessionSecret.persisted, false);
      assert.equal(result.record.rawTokenPersisted, false);
      assert.equal(result.record.tokenMaterialPersisted, false);
      assert.equal(result.record.sessionSecretPersisted, false);
      assert.equal(result.record.actionPolicy.fileTransfer, "approval-required");
      assert.equal(result.record.actionPolicy.browser, "approval-required");
      assert.equal(result.record.actionPolicy.commandExecution, "disabled");
      assert.deepEqual(result.record.grantedScopes, ["node.heartbeat", "node.status", "operator.pairing"]);
      assert.deepEqual(result.record.blockedScopes, [
        {
          scope: "file.write",
          reason: "approval-required"
        },
        {
          scope: "phone.control",
          reason: "approval-required"
        }
      ]);

      const rawState = await readFile(resolveNeonNodeDeviceSessionPaths(projectRoot).sessionPath, "utf8");

      assert.doesNotMatch(rawState, /neon_node_canary_session_unit_secret/u);
      assert.doesNotMatch(rawState, /neon_node_session_unit_secret/u);
      assert.doesNotMatch(rawState, /device-nonce-secret/u);
      assert.match(rawState, new RegExp(result.record.sessionFingerprint, "u"));

      const snapshot = await createNeonNodeDeviceSessionSnapshot(projectRoot, {
        canaryTokenSnapshot,
        now: () => new Date("2026-06-01T00:07:00.000Z")
      });

      assert.equal(snapshot.state, "active");
      assert.equal(snapshot.totals.sessions, 1);
      assert.equal(snapshot.totals.active, 1);
      assert.equal(snapshot.totals.blockedScopes, 2);
      assert.equal(snapshot.policy.rawTokenPersistence, "disabled");
      assert.equal(snapshot.policy.sessionSecretPersistence, "disabled");
      assert.equal(snapshot.policy.rawTokenHttpExposure, "disabled");
      assert.equal(snapshot.policy.sessionSecretHttpExposure, "disabled");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects a token that does not match the canary fingerprint", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const { tokenResult, canaryTokenSnapshot } = await createIssuedCanaryToken(projectRoot);

      await assert.rejects(
        openNeonNodeDeviceSession(
          projectRoot,
          {
            tokenIssueId: tokenResult.record.tokenIssueId,
            token: "wrong-token",
            acceptedBy: "chaty"
          },
          {
            canaryTokenSnapshot,
            now: () => new Date("2026-06-01T00:06:00.000Z")
          }
        ),
        /fingerprint mismatch/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects expired canary token issues", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const { tokenResult, canaryTokenSnapshot } = await createIssuedCanaryToken(projectRoot);

      await assert.rejects(
        openNeonNodeDeviceSession(
          projectRoot,
          {
            tokenIssueId: tokenResult.record.tokenIssueId,
            token: tokenResult.oneTimeSecret.token,
            acceptedBy: "chaty"
          },
          {
            canaryTokenSnapshot,
            now: () => new Date("2026-06-01T00:25:00.000Z")
          }
        ),
        /Active canary token issue not found/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a redacted device session report", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const { tokenResult, canaryTokenSnapshot } = await createIssuedCanaryToken(projectRoot);
      await openNeonNodeDeviceSession(
        projectRoot,
        {
          tokenIssueId: tokenResult.record.tokenIssueId,
          token: tokenResult.oneTimeSecret.token,
          acceptedBy: "chaty",
          requestedScopes: ["operator.pairing", "browser.control"]
        },
        {
          canaryTokenSnapshot,
          createSessionSecret: () => "neon_node_session_report_secret",
          now: () => new Date("2026-06-01T00:06:00.000Z")
        }
      );

      const report = renderNeonNodeDeviceSessionReport(
        await createNeonNodeDeviceSessionSnapshot(projectRoot, {
          canaryTokenSnapshot,
          now: () => new Date("2026-06-01T00:07:00.000Z")
        })
      );

      assert.match(report, /Neonika Node Device Sessions: active/u);
      assert.match(report, /secretPersisted=false/u);
      assert.match(report, /browser.control \/ approval-required/u);
      assert.doesNotMatch(report, /neon_node_canary_session_unit_secret/u);
      assert.doesNotMatch(report, /neon_node_session_report_secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createIssuedCanaryToken(projectRoot: string): Promise<{
  readonly approval: INeonNodePairingApprovalRecord;
  readonly tokenGateSnapshot: INeonNodePairingTokenGateSnapshot;
  readonly tokenResult: INeonNodePairingCanaryTokenIssueResult;
  readonly canaryTokenSnapshot: INeonNodePairingCanaryTokenSnapshot;
}> {
  const approval = await createApprovedPairing(projectRoot);
  const tokenGateSnapshot = await createReadyTokenGateSnapshot(projectRoot);
  const tokenResult = await issueNeonNodePairingCanaryToken(
    projectRoot,
    {
      requestId: approval.requestId,
      approvalId: approval.approvalId,
      issuedBy: "chaty",
      deliveryMethod: "mission-control-once",
      deliveryNote: "device session unit",
      ttlMinutes: 15
    },
    {
      tokenGateSnapshot,
      createTokenMaterial: () => "neon_node_canary_session_unit_secret",
      now: () => new Date("2026-06-01T00:04:00.000Z")
    }
  );
  const canaryTokenSnapshot = await createNeonNodePairingCanaryTokenSnapshot(projectRoot, {
    tokenGateSnapshot,
    now: () => new Date("2026-06-01T00:05:00.000Z")
  });

  return {
    approval,
    tokenGateSnapshot,
    tokenResult,
    canaryTokenSnapshot
  };
}

async function createApprovedPairing(projectRoot: string): Promise<INeonNodePairingApprovalRecord> {
  const request = await createNeonNodePairingRequest(
    projectRoot,
    {
      requestId: "pair-device-session-request",
      deviceId: "operator-phone",
      publicKey: "raw-public-key",
      displayName: "Operator Phone",
      platform: "ios",
      requestedRole: "operator",
      requestedScopes: ["operator.pairing", "file.write", "browser.control"]
    },
    {
      now: () => new Date("2026-06-01T00:00:00.000Z")
    }
  );

  return await recordNeonNodePairingApproval(
    projectRoot,
    {
      requestId: request.requestId,
      decision: "approve",
      decidedBy: "chaty",
      reason: "operator reviewed"
    },
    {
      now: () => new Date("2026-06-01T00:01:00.000Z")
    }
  );
}

async function createReadyTokenGateSnapshot(projectRoot: string): Promise<INeonNodePairingTokenGateSnapshot> {
  const pairingSnapshot = await createNeonNodePairingSnapshot(projectRoot, {
    now: () => new Date("2026-06-01T00:02:00.000Z")
  });

  return await createNeonNodePairingTokenGateSnapshot(projectRoot, {
    pairingSnapshot,
    cutoverSnapshot: createCanaryCutoverSnapshot(projectRoot),
    now: () => new Date("2026-06-01T00:03:00.000Z")
  });
}

function createCanaryCutoverSnapshot(projectRoot: string): INeonCutoverGateSnapshot {
  const gates: readonly INeonCutoverGate[] = [
    createGate("shadow", "Shadow", "pass"),
    createGate("mirror", "Mirror", "pass"),
    createGate("canary", "Canary", "pass"),
    createGate("primary", "Primary", "locked"),
    createGate("retire", "Retire", "locked")
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
      latestRunId: "run-device-session-unit",
      rollbackConfigured: true
    }
  };
}

function createGate(id: INeonCutoverGate["id"], label: string, state: INeonCutoverGate["state"]): INeonCutoverGate {
  return {
    id,
    label,
    state,
    summary: `${label} ${state}`,
    requiredEvidence: ["unit evidence"],
    evidence: ["evidence"],
    recovery: state === "pass" ? [] : ["keep previous stage"],
    rollback: "Keep previous route active."
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-node-device-session-"));
}
