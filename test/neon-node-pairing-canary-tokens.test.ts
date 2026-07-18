import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodePairingCanaryTokenSnapshot,
  createNeonNodePairingRequest,
  createNeonNodePairingSnapshot,
  createNeonNodePairingTokenGateSnapshot,
  issueNeonNodePairingCanaryToken,
  recordNeonNodePairingApproval,
  renderNeonNodePairingCanaryTokenReport,
  resolveNeonNodePairingCanaryTokenPaths,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot,
  type INeonNodePairingApprovalRecord,
  type INeonNodePairingTokenGateSnapshot
} from "../src/index.js";

describe("Neonika Node Pairing Canary Tokens", () => {
  it("issues a one-time canary token only when the token gate is ready and keeps raw material out of state", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const approval = await createApprovedPairing(projectRoot);
      const tokenGateSnapshot = await createReadyTokenGateSnapshot(projectRoot);
      const result = await issueNeonNodePairingCanaryToken(
        projectRoot,
        {
          requestId: approval.requestId,
          approvalId: approval.approvalId,
          issuedBy: "chaty",
          deliveryMethod: "mission-control-once",
          deliveryNote: "operator handoff",
          ttlMinutes: 15
        },
        {
          tokenGateSnapshot,
          createTokenMaterial: () => "neon_node_canary_unit_secret",
          now: () => new Date("2026-06-01T00:04:00.000Z")
        }
      );

      assert.equal(result.state, "issued-canary");
      assert.equal(result.oneTimeSecret.token, "neon_node_canary_unit_secret");
      assert.equal(result.oneTimeSecret.persisted, false);
      assert.equal(result.record.secretPersisted, false);
      assert.equal(result.record.tokenMaterialPersisted, false);
      assert.equal(result.record.expiresAt, "2026-06-01T00:19:00.000Z");
      assert.notEqual(result.record.tokenFingerprint, result.oneTimeSecret.token);

      const rawState = await readFile(resolveNeonNodePairingCanaryTokenPaths(projectRoot).tokenIssuePath, "utf8");

      assert.doesNotMatch(rawState, /neon_node_canary_unit_secret/u);
      assert.match(rawState, new RegExp(result.record.tokenFingerprint, "u"));

      const snapshot = await createNeonNodePairingCanaryTokenSnapshot(projectRoot, {
        tokenGateSnapshot,
        now: () => new Date("2026-06-01T00:05:00.000Z")
      });

      assert.equal(snapshot.state, "issued");
      assert.equal(snapshot.totals.issued, 1);
      assert.equal(snapshot.totals.active, 1);
      assert.equal(snapshot.deliveryPolicy.rawTokenPersistence, "disabled");
      assert.equal(snapshot.deliveryPolicy.rawTokenHttpExposure, "disabled");
      assert.equal(snapshot.deliveryPolicy.rawTokenCliEcho, "disabled");
      assert.equal(snapshot.issues[0]?.tokenMaterialPersisted, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("refuses canary token issue while the token gate is locked", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const approval = await createApprovedPairing(projectRoot);

      await assert.rejects(
        issueNeonNodePairingCanaryToken(
          projectRoot,
          {
            requestId: approval.requestId,
            approvalId: approval.approvalId,
            issuedBy: "chaty",
            deliveryMethod: "mission-control-once"
          },
          {
            now: () => new Date("2026-06-01T00:04:00.000Z")
          }
        ),
        /gate is not ready/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks duplicate canary token issue for the same pairing approval", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const approval = await createApprovedPairing(projectRoot);
      const tokenGateSnapshot = await createReadyTokenGateSnapshot(projectRoot);
      const input = {
        requestId: approval.requestId,
        approvalId: approval.approvalId,
        issuedBy: "chaty",
        deliveryMethod: "mission-control-once"
      } as const;

      await issueNeonNodePairingCanaryToken(projectRoot, input, {
        tokenGateSnapshot,
        createTokenMaterial: () => "neon_node_canary_first_secret",
        now: () => new Date("2026-06-01T00:04:00.000Z")
      });

      await assert.rejects(
        issueNeonNodePairingCanaryToken(projectRoot, input, {
          tokenGateSnapshot,
          createTokenMaterial: () => "neon_node_canary_second_secret",
          now: () => new Date("2026-06-01T00:05:00.000Z")
        }),
        /already issued/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a redacted operator report", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const approval = await createApprovedPairing(projectRoot);
      const tokenGateSnapshot = await createReadyTokenGateSnapshot(projectRoot);
      await issueNeonNodePairingCanaryToken(
        projectRoot,
        {
          requestId: approval.requestId,
          approvalId: approval.approvalId,
          issuedBy: "chaty",
          deliveryMethod: "operator-out-of-band"
        },
        {
          tokenGateSnapshot,
          createTokenMaterial: () => "neon_node_canary_report_secret",
          now: () => new Date("2026-06-01T00:04:00.000Z")
        }
      );

      const report = renderNeonNodePairingCanaryTokenReport(
        await createNeonNodePairingCanaryTokenSnapshot(projectRoot, {
          tokenGateSnapshot,
          now: () => new Date("2026-06-01T00:05:00.000Z")
        })
      );

      assert.match(report, /Neonika Node Canary Tokens: issued/u);
      assert.match(report, /secretPersisted=false/u);
      assert.match(report, /rawPersistence=disabled/u);
      assert.doesNotMatch(report, /neon_node_canary_report_secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createApprovedPairing(projectRoot: string): Promise<INeonNodePairingApprovalRecord> {
  const request = await createNeonNodePairingRequest(
    projectRoot,
    {
      requestId: "pair-canary-token-request",
      deviceId: "operator-phone",
      publicKey: "raw-public-key",
      displayName: "Operator Phone",
      platform: "ios",
      requestedRole: "operator",
      requestedScopes: ["operator.pairing"]
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
      latestRunId: "run-canary-token",
      rollbackConfigured: true
    }
  };
}

function createGate(id: INeonCutoverGate["id"], label: string, state: INeonCutoverGate["state"]): INeonCutoverGate {
  return {
    id,
    label,
    state,
    summary: `${label} gate ${state}`,
    requiredEvidence: ["operator evidence"],
    evidence: ["evidence present"],
    recovery: state === "pass" ? [] : ["keep previous stage active"],
    rollback: "Keep current route unchanged."
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-node-canary-token-"));
}
