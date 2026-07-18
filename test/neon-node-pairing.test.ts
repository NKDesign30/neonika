import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodePairingRequest,
  createNeonNodePairingSnapshot,
  recordNeonNodePairingApproval,
  renderNeonNodePairingReport,
  resolveNeonNodePairingPaths,
  verifyNeonNodePairingChallenge
} from "../src/index.js";

describe("Neon Node Pairing", () => {
  it("persists pending pairing requests without storing raw public keys or issuing tokens", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const request = await createNeonNodePairingRequest(
        projectRoot,
        {
          requestId: "pair-request-1",
          deviceId: "operator-phone",
          publicKey: "raw-public-key-secret",
          displayName: "Operator Phone",
          platform: "ios",
          requestedScopes: ["operator.pairing", "operator.pairing", "operator.files.read"]
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );

      assert.equal(request.requestId, "pair-request-1");
      assert.equal(request.tokenIssued, false);
      assert.equal(request.state, "pending");
      assert.equal(request.expiresAt, "2026-06-01T00:05:00.000Z");
      assert.deepEqual(request.requestedScopes, ["operator.pairing", "operator.files.read"]);
      assert.notEqual(request.publicKeyFingerprint, "raw-public-key-secret");
      assert.match(request.publicKeyFingerprint, /^[a-f0-9]{64}$/u);

      const raw = await readFile(resolveNeonNodePairingPaths(projectRoot).requestPath, "utf8");
      assert.doesNotMatch(raw, /raw-public-key-secret/);

      const snapshot = await createNeonNodePairingSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:01:00.000Z")
      });

      assert.equal(snapshot.totals.requests, 1);
      assert.equal(snapshot.totals.pending, 1);
      assert.equal(snapshot.requests[0]?.state, "pending");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records operator approvals as audit-only records with token issuance disabled", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const request = await createNeonNodePairingRequest(
        projectRoot,
        {
          requestId: "pair-request-approve",
          deviceId: "operator-ipad",
          publicKey: "raw-public-key"
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );
      const approval = await recordNeonNodePairingApproval(
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

      assert.equal(approval.decision, "approve");
      assert.equal(approval.stateAfterDecision, "approved-shadow");
      assert.equal(approval.tokenIssued, false);

      const snapshot = await createNeonNodePairingSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:02:00.000Z")
      });

      assert.equal(snapshot.totals.pending, 0);
      assert.equal(snapshot.totals.approvedShadow, 1);
      assert.equal(snapshot.totals.approvals, 1);
      assert.equal(snapshot.requests[0]?.approvalId, approval.approvalId);
      assert.equal(snapshot.approvals[0]?.tokenIssued, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects approval for expired pairing requests", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await createNeonNodePairingRequest(
        projectRoot,
        {
          requestId: "pair-request-expired",
          deviceId: "old-device",
          publicKey: "raw-public-key"
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );

      await assert.rejects(
        recordNeonNodePairingApproval(
          projectRoot,
          {
            requestId: "pair-request-expired",
            decision: "approve",
            decidedBy: "chaty"
          },
          {
            now: () => new Date("2026-06-01T00:06:00.000Z")
          }
        ),
        /not pending: expired/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders an operator report for requests and audit decisions", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await createNeonNodePairingRequest(
        projectRoot,
        {
          requestId: "pair-report",
          deviceId: "operator-phone",
          publicKey: "raw-public-key"
        },
        {
          now: () => new Date("2026-06-01T00:00:00.000Z")
        }
      );

      const report = renderNeonNodePairingReport(
        await createNeonNodePairingSnapshot(projectRoot, {
          now: () => new Date("2026-06-01T00:01:00.000Z")
        })
      );

      assert.match(report, /Neon Node Pairing: ready/);
      assert.match(report, /pair-report: pending/);
      assert.match(report, /tokenIssued=false/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

describe("verifyNeonNodePairingChallenge", () => {
  it("issues a per-request challenge and verifies a device signature over it", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

      const request = await createNeonNodePairingRequest(projectRoot, {
        deviceId: "operator-phone",
        publicKey: publicKeyB64
      });

      assert.match(request.challenge, /^[a-f0-9]{64}$/u);

      const signature = sign(null, Buffer.from(request.challenge, "utf8"), privateKey).toString("base64");
      const result = verifyNeonNodePairingChallenge({
        publicKey: publicKeyB64,
        challenge: request.challenge,
        signature
      });

      assert.equal(result.state, "verified");
      assert.equal(result.verified, true);
      assert.equal(request.tokenIssued, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("verifies a PEM-encoded public key as well", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const challenge = "a".repeat(64);
    const signature = sign(null, Buffer.from(challenge, "utf8"), privateKey).toString("base64");

    assert.equal(
      verifyNeonNodePairingChallenge({ publicKey: pem, challenge, signature }).state,
      "verified"
    );
  });

  it("rejects a tampered signature, a wrong key, a bad key and missing input", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const publicKeyB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const otherB64 = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const challenge = "b".repeat(64);
    const signature = sign(null, Buffer.from(challenge, "utf8"), privateKey).toString("base64");

    assert.equal(
      verifyNeonNodePairingChallenge({ publicKey: publicKeyB64, challenge: "c".repeat(64), signature }).state,
      "signature-mismatch"
    );
    assert.equal(
      verifyNeonNodePairingChallenge({ publicKey: otherB64, challenge, signature }).state,
      "signature-mismatch"
    );
    assert.equal(
      verifyNeonNodePairingChallenge({ publicKey: "not-a-key", challenge, signature }).state,
      "invalid-public-key"
    );
    assert.equal(
      verifyNeonNodePairingChallenge({ publicKey: publicKeyB64, challenge, signature: "" }).state,
      "missing-input"
    );
  });
});

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-node-pairing-"));
}
