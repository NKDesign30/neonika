import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodePairingRequest,
  createNeonNodePairingSnapshot,
  neonOperatorScopesAllow,
  recordNeonNodePairingApproval,
  renderNeonNodePairingReport,
  resolveNeonNodePairingForbiddenApprovalScope,
  resolveNeonNodePairingRequiredApprovalScopes
} from "../src/index.js";

describe("neon node pairing approval scopes (Z390) — pure decision logic", () => {
  it("derives required operator approval scopes from device capabilities", () => {
    assert.deepEqual(resolveNeonNodePairingRequiredApprovalScopes(["operator.pairing"]), ["operator.pairing"]);
    assert.deepEqual(resolveNeonNodePairingRequiredApprovalScopes([]), ["operator.pairing"]);
    assert.deepEqual(
      resolveNeonNodePairingRequiredApprovalScopes(["operator.pairing", "file.write", "browser.control"]),
      ["operator.pairing", "operator.write"]
    );
    assert.deepEqual(
      resolveNeonNodePairingRequiredApprovalScopes(["operator.pairing", "operator.admin"]),
      ["operator.pairing", "operator.admin"]
    );
    assert.deepEqual(resolveNeonNodePairingRequiredApprovalScopes(["node.admin"]), [
      "operator.pairing",
      "operator.admin"
    ]);
  });

  it("applies operator-scope semantics: admin covers all, write covers read+write", () => {
    assert.equal(
      neonOperatorScopesAllow({ requiredScopes: ["operator.write"], approverScopes: ["operator.admin"] }),
      true
    );
    assert.equal(
      neonOperatorScopesAllow({ requiredScopes: ["operator.read"], approverScopes: ["operator.write"] }),
      true
    );
    assert.equal(
      neonOperatorScopesAllow({ requiredScopes: ["operator.write"], approverScopes: ["operator.read"] }),
      false
    );
    assert.equal(
      neonOperatorScopesAllow({ requiredScopes: ["operator.pairing"], approverScopes: ["operator.pairing"] }),
      true
    );
    assert.equal(neonOperatorScopesAllow({ requiredScopes: [], approverScopes: [] }), true);
  });

  it("resolves the first required approval scope the approver lacks", () => {
    assert.equal(
      resolveNeonNodePairingForbiddenApprovalScope({
        requestedScopes: ["operator.pairing", "file.write"],
        approverScopes: ["operator.pairing", "operator.read"]
      }),
      "operator.write"
    );
    // The approver needs the pairing right AND the write capability.
    assert.equal(
      resolveNeonNodePairingForbiddenApprovalScope({
        requestedScopes: ["operator.pairing", "file.write"],
        approverScopes: ["operator.pairing", "operator.write"]
      }),
      null
    );
    // write capability without the pairing right is refused on the pairing scope.
    assert.equal(
      resolveNeonNodePairingForbiddenApprovalScope({
        requestedScopes: ["operator.pairing", "file.write"],
        approverScopes: ["operator.write"]
      }),
      "operator.pairing"
    );
    // admin covers both the pairing right and any capability.
    assert.equal(
      resolveNeonNodePairingForbiddenApprovalScope({
        requestedScopes: ["operator.pairing", "node.admin"],
        approverScopes: ["operator.admin"]
      }),
      null
    );
    // a write-only approver cannot grant an admin-level capability.
    assert.equal(
      resolveNeonNodePairingForbiddenApprovalScope({
        requestedScopes: ["operator.pairing", "node.admin"],
        approverScopes: ["operator.pairing", "operator.write"]
      }),
      "operator.admin"
    );
  });
});

describe("recordNeonNodePairingApproval (Z390) — audit + enforcement", () => {
  it("records required approval scopes as an audit field and surfaces them in the report", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const request = await createNeonNodePairingRequest(projectRoot, {
        deviceId: "operator-phone",
        publicKey: "***",
        requestedScopes: ["operator.pairing", "file.write", "browser.control"]
      });
      const approval = await recordNeonNodePairingApproval(projectRoot, {
        requestId: request.requestId,
        decision: "approve",
        decidedBy: "chaty"
      });

      assert.deepEqual(approval.requiredApprovalScopes, ["operator.pairing", "operator.write"]);
      assert.equal(approval.tokenIssued, false);

      const snapshot = await createNeonNodePairingSnapshot(projectRoot);
      assert.deepEqual(snapshot.approvals[0]?.requiredApprovalScopes, ["operator.pairing", "operator.write"]);

      const report = renderNeonNodePairingReport(snapshot);
      assert.match(report, /requires=operator\.pairing\+operator\.write/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("refuses an approval when the approver lacks a required operator scope", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const request = await createNeonNodePairingRequest(projectRoot, {
        deviceId: "operator-ipad",
        publicKey: "***",
        requestedScopes: ["operator.pairing", "file.write"]
      });

      await assert.rejects(
        recordNeonNodePairingApproval(projectRoot, {
          requestId: request.requestId,
          decision: "approve",
          decidedBy: "limited-operator",
          approverScopes: ["operator.pairing", "operator.read"]
        }),
        /missing operator scope "operator\.write"/
      );

      // The refused approval wrote no record: the request is still pending.
      const snapshot = await createNeonNodePairingSnapshot(projectRoot);
      assert.equal(snapshot.totals.pending, 1);
      assert.equal(snapshot.totals.approvals, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("allows an admin approver, and never enforces without approver scopes (backward-compatible)", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const adminReq = await createNeonNodePairingRequest(projectRoot, {
        requestId: "pair-admin-req",
        deviceId: "operator-phone",
        publicKey: "***",
        requestedScopes: ["operator.pairing", "node.admin"]
      });
      const approved = await recordNeonNodePairingApproval(projectRoot, {
        requestId: adminReq.requestId,
        decision: "approve",
        decidedBy: "root-operator",
        approverScopes: ["operator.admin"]
      });
      assert.equal(approved.stateAfterDecision, "approved-shadow");
      assert.deepEqual(approved.requiredApprovalScopes, ["operator.pairing", "operator.admin"]);

      // No approverScopes -> local operator is trusted: an admin-level request
      // approves without enforcement (default matches the existing call sites).
      const trustedReq = await createNeonNodePairingRequest(projectRoot, {
        requestId: "pair-trusted-req",
        deviceId: "operator-laptop",
        publicKey: "***",
        requestedScopes: ["operator.pairing", "node.admin"]
      });
      const trusted = await recordNeonNodePairingApproval(projectRoot, {
        requestId: trustedReq.requestId,
        decision: "approve",
        decidedBy: "chaty"
      });
      assert.equal(trusted.stateAfterDecision, "approved-shadow");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-node-pairing-scopes-"));
}
