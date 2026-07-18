import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeActionRequestSnapshot,
  createNeonNodeActionResultPreview,
  readNeonNodeActionApprovalRecords,
  readNeonNodeActionResultPreviewRecords,
  recordNeonNodeActionApproval,
  recordNeonNodeActionRequest,
  renderNeonNodeActionRequestReport,
  resolveNeonNodeActionRequestPaths,
  type INeonNodeDeviceSessionSnapshot
} from "../src/index.js";

describe("Neonika Node Action Requests", () => {
  it("records heartbeat, file, and browser requests without executing side effects", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot);

      const heartbeat = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "heartbeat",
          requestedBy: "chaty"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      const fileList = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.list",
          requestedBy: "chaty",
          targetPath: projectRoot
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      const dirList = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "dir.list",
          requestedBy: "chaty",
          targetPath: projectRoot
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:11:30.000Z")
        }
      );
      const browserSnapshot = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "browser.snapshot",
          requestedBy: "chaty",
          targetUrl: "http://127.0.0.1:8797/mission-control/nodes"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const fileWrite = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.write",
          requestedBy: "chaty",
          targetPath: `${projectRoot}/blocked.txt`
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );

      assert.equal(heartbeat.state, "recorded");
      assert.equal(heartbeat.approvalPolicy, "not-required");
      assert.equal(fileList.state, "approval-required");
      assert.equal(fileList.requiredScope, "file.read");
      assert.equal(dirList.state, "approval-required");
      assert.equal(dirList.requiredScope, "file.read");
      assert.equal(browserSnapshot.state, "approval-required");
      assert.equal(browserSnapshot.requiredScope, "browser.read");
      assert.equal(fileWrite.state, "blocked");
      assert.equal(fileWrite.blockReason, "high-risk-action-disabled");
      assert.equal(fileWrite.sideEffectExecuted, false);

      const snapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:14:00.000Z")
      });

      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.totals.requests, 5);
      assert.equal(snapshot.totals.recorded, 1);
      assert.equal(snapshot.totals.approvalRequired, 3);
      assert.equal(snapshot.totals.blocked, 1);
      assert.equal(snapshot.totals.approvalRecords, 0);
      assert.equal(snapshot.totals.pendingApproval, 3);
      assert.equal(snapshot.totals.resultPreviews, 0);
      assert.equal(snapshot.totals.pendingResultPreviews, 0);
      assert.equal(snapshot.policy.execution, "disabled");
      assert.equal(snapshot.requests.every((request) => request.executionState === "not-executed"), true);
      assert.equal(snapshot.requests.every((request) => request.sideEffectExecuted === false), true);

      const rawState = await readFile(resolveNeonNodeActionRequestPaths(projectRoot).requestPath, "utf8");

      assert.doesNotMatch(rawState, /node-session-secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects requests without an active device session", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await assert.rejects(
        recordNeonNodeActionRequest(
          projectRoot,
          {
            sessionId: "missing-session",
            kind: "heartbeat",
            requestedBy: "chaty"
          },
          {
            deviceSessionSnapshot: createActiveDeviceSessionSnapshot(projectRoot),
            now: () => new Date("2026-06-01T00:10:00.000Z")
          }
        ),
        /Active device session not found/
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records approval audit only for approval-required action requests", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot);
      const fileList = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.list",
          requestedBy: "chaty",
          targetPath: projectRoot,
          reason: "read approved sk-test-secret-value"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      const heartbeat = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "heartbeat",
          requestedBy: "chaty"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const approval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: fileList.requestId,
          decision: "approve",
          operatorId: "operator",
          reason: "ok sk-test-secret-value"
        },
        {
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );

      assert.match(approval.approvalId, /^node-action-approval-/u);
      assert.equal(approval.requestId, fileList.requestId);
      assert.equal(approval.decision, "approve");
      assert.equal(approval.safety.executionEnabled, false);
      assert.equal(approval.safety.sideEffectExecuted, false);
      assert.equal(approval.safety.requiresCanaryGate, true);
      assert.match(approval.reason ?? "", /\[REDACTED_SECRET\]/u);

      await assert.rejects(
        recordNeonNodeActionApproval(projectRoot, {
          requestId: heartbeat.requestId,
          decision: "approve",
          operatorId: "operator"
        }),
        /not queued/
      );
      await assert.rejects(
        recordNeonNodeActionApproval(projectRoot, {
          requestId: fileList.requestId,
          decision: "approve",
          operatorId: "operator"
        }),
        /already has/
      );

      const approvals = await readNeonNodeActionApprovalRecords(projectRoot);
      const snapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:14:00.000Z")
      });

      assert.equal(approvals.length, 1);
      assert.equal(snapshot.state, "needs-preview");
      assert.equal(snapshot.totals.approvalRecords, 1);
      assert.equal(snapshot.totals.approved, 1);
      assert.equal(snapshot.totals.rejected, 0);
      assert.equal(snapshot.totals.pendingApproval, 0);
      assert.equal(snapshot.totals.resultPreviews, 0);
      assert.equal(snapshot.totals.pendingResultPreviews, 1);
      assert.equal(snapshot.approvals[0]?.safety.executionEnabled, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("materializes approved read-only file and browser result previews", async () => {
    const projectRoot = await createTempProjectRoot();
    const server = await listenFixtureServer(
      "<!doctype html><title>Preview sk-test-secret-value</title><main>Browser sk-test-secret-value</main>"
    );

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot);
      const fixtureDir = join(projectRoot, "fixtures");
      const fixtureFile = join(fixtureDir, "secret.txt");

      await mkdir(fixtureDir, { recursive: true });
      await writeFile(fixtureFile, "File preview sk-test-secret-value\n", "utf8");

      const fileList = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.list",
          requestedBy: "chaty",
          targetPath: fixtureDir
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      const fileFetch = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.fetch",
          requestedBy: "chaty",
          targetPath: fixtureFile
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const browserSnapshot = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "browser.snapshot",
          requestedBy: "chaty",
          targetUrl: server.url
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );
      const fileListApproval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: fileList.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:14:00.000Z")
        }
      );
      const fileFetchApproval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: fileFetch.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:15:00.000Z")
        }
      );
      const browserApproval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: browserSnapshot.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:16:00.000Z")
        }
      );

      const fileListPreview = await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: fileListApproval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:17:00.000Z")
        }
      );
      const fileFetchPreview = await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: fileFetchApproval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:18:00.000Z")
        }
      );
      const browserPreview = await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: browserApproval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:19:00.000Z")
        }
      );

      assert.equal(fileListPreview.state, "ready");
      assert.equal(fileListPreview.resultKind, "file-list");
      assert.equal(fileListPreview.fileList?.entries[0]?.name, "secret.txt");
      assert.equal(fileFetchPreview.state, "ready");
      assert.equal(fileFetchPreview.resultKind, "file-fetch");
      assert.match(fileFetchPreview.fileFetch?.previewText ?? "", /\[REDACTED_SECRET\]/u);
      assert.equal(browserPreview.state, "ready");
      assert.equal(browserPreview.resultKind, "browser-snapshot");
      assert.match(browserPreview.browserSnapshot?.textPreview ?? "", /\[REDACTED_SECRET\]/u);
      assert.equal(browserPreview.safety.mutationExecuted, false);
      assert.equal(browserPreview.safety.rawOutputPersisted, false);

      await assert.rejects(
        createNeonNodeActionResultPreview(projectRoot, {
          approvalId: fileListApproval.approvalId
        }),
        /already has/
      );

      const previews = await readNeonNodeActionResultPreviewRecords(projectRoot);
      const snapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:20:00.000Z")
      });
      const rawState = await readFile(resolveNeonNodeActionRequestPaths(projectRoot).resultPreviewPath, "utf8");

      assert.equal(previews.length, 3);
      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.resultPreviews, 3);
      assert.equal(snapshot.totals.readyResultPreviews, 3);
      assert.equal(snapshot.totals.pendingResultPreviews, 0);
      assert.doesNotMatch(rawState, /sk-test-secret-value/u);
    } finally {
      await server.close();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("materializes dir.list as a bounded read-only directory preview", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot);
      const fixtureDir = join(projectRoot, "dir-fixtures");

      await mkdir(fixtureDir, { recursive: true });
      await writeFile(join(fixtureDir, "entry.txt"), "dir-list\n", "utf8");

      const dirList = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "dir.list",
          requestedBy: "chaty",
          targetPath: fixtureDir
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const approval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: dirList.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );
      const preview = await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: approval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:14:00.000Z")
        }
      );

      assert.equal(dirList.kind, "dir.list");
      assert.equal(dirList.requiredScope, "file.read");
      assert.equal(preview.state, "ready");
      assert.equal(preview.kind, "dir.list");
      assert.equal(preview.resultKind, "file-list");
      assert.equal(preview.fileList?.entries[0]?.name, "entry.txt");
      assert.equal(preview.safety.mutationExecuted, false);
      assert.equal(preview.safety.rawOutputPersisted, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks result previews for unsafe targets and rejected approvals", async () => {
    const projectRoot = await createTempProjectRoot();
    const outsideRoot = await mkdtemp(join(tmpdir(), "neonika-node-actions-outside-"));

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot);
      const outsideFile = join(outsideRoot, "outside.txt");
      const symlinkPath = join(projectRoot, "outside-link.txt");

      await writeFile(outsideFile, "outside root\n", "utf8");
      await symlink(outsideFile, symlinkPath);

      const unsafeFile = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.fetch",
          requestedBy: "chaty",
          targetPath: symlinkPath
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const unsafeApproval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: unsafeFile.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );
      const unsafePreview = await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: unsafeApproval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:14:00.000Z")
        }
      );
      const browserSnapshot = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "browser.snapshot",
          requestedBy: "chaty",
          targetUrl: "https://example.com"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:15:00.000Z")
        }
      );
      const rejectedApproval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: browserSnapshot.requestId,
          decision: "reject",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:16:00.000Z")
        }
      );
      const rejectedPreview = await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: rejectedApproval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:17:00.000Z")
        }
      );

      assert.equal(unsafePreview.state, "blocked");
      assert.equal(unsafePreview.blockReason, "unsafe-target");
      assert.equal(rejectedPreview.state, "blocked");
      assert.equal(rejectedPreview.blockReason, "approval-not-approved");
    } finally {
      await rm(outsideRoot, { force: true, recursive: true });
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks file and browser requests when the session lacks the required scope", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot, {
        grantedScopes: ["node.heartbeat", "node.status", "operator.pairing"]
      });
      const fileList = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.list",
          requestedBy: "chaty",
          targetPath: projectRoot
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );

      assert.equal(fileList.state, "blocked");
      assert.equal(fileList.blockReason, "missing-scope");
      assert.equal(fileList.requiredScope, "file.read");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("renders a compact no-execution report", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = createActiveDeviceSessionSnapshot(projectRoot);
      await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "browser.snapshot",
          requestedBy: "chaty",
          targetUrl: "http://127.0.0.1:8797/mission-control/nodes"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );

      const report = renderNeonNodeActionRequestReport(
        await createNeonNodeActionRequestSnapshot(projectRoot, {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:14:00.000Z")
        })
      );

      assert.match(report, /Neonika Node Action Requests: needs-approval/u);
      assert.match(report, /execution=not-executed/u);
      assert.match(report, /sideEffect=false/u);
      assert.match(report, /Approval records: 0/u);
      assert.doesNotMatch(report, /node-session-secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createActiveDeviceSessionSnapshot(
  projectRoot: string,
  options: {
    readonly grantedScopes?: readonly ["node.heartbeat", "node.status", "operator.pairing", "file.read", "browser.read"][number][];
  } = {}
): INeonNodeDeviceSessionSnapshot {
  const grantedScopes = options.grantedScopes ?? [
    "node.heartbeat",
    "node.status",
    "operator.pairing",
    "file.read",
    "browser.read"
  ];

  return {
    state: "active",
    generatedAt: "2026-06-01T00:09:00.000Z",
    canaryTokens: {
      state: "issued",
      generatedAt: "2026-06-01T00:08:00.000Z",
      tokenGate: {
        state: "ready-for-canary",
        generatedAt: "2026-06-01T00:07:00.000Z",
        cutoverStage: "canary",
        cutoverState: "ready",
        currentGateState: "pass",
        eligibleApprovals: [],
        blockers: [],
        invariants: [],
        totals: {
          approvals: 1,
          approvedShadow: 1,
          eligibleApprovals: 1,
          blockers: 0
        },
        source: {
          projectRoot,
          pairingRequestPath: `${projectRoot}/state/nodes/node-pairing-requests.jsonl`,
          pairingApprovalPath: `${projectRoot}/state/nodes/node-pairing-approvals.jsonl`,
          cutoverStage: "canary",
          cutoverState: "ready",
          currentGateState: "pass"
        }
      },
      deliveryPolicy: {
        rawTokenPersistence: "disabled",
        rawTokenHttpExposure: "disabled",
        rawTokenCliEcho: "disabled",
        requiredHandoff: "in-process-one-time"
      },
      issues: [],
      totals: {
        issued: 1,
        active: 1,
        expired: 0,
        eligibleApprovals: 1,
        gateBlockers: 0
      },
      source: {
        tokenIssuePath: `${projectRoot}/state/nodes/node-pairing-canary-tokens.jsonl`
      }
    },
    policy: {
      rawTokenPersistence: "disabled",
      rawTokenHttpExposure: "disabled",
      rawTokenCliEcho: "disabled",
      sessionSecretPersistence: "disabled",
      sessionSecretHttpExposure: "disabled",
      sessionSecretCliEcho: "disabled",
      requiredHandoff: "in-process-one-time",
      actionPolicy: {
        fileTransfer: "approval-required",
        browser: "approval-required",
        phoneControl: "disabled",
        commandExecution: "disabled"
      }
    },
    sessions: [
      {
        sessionId: "device-session-unit",
        tokenIssueId: "canary-token-unit",
        requestId: "pair-unit",
        approvalId: "pair-approval-unit",
        deviceId: "operator-phone",
        displayName: "Operator Phone",
        requestedRole: "operator",
        grantedScopes,
        blockedScopes: [],
        sessionFingerprint: "session-fingerprint-unit",
        tokenFingerprint: "token-fingerprint-unit",
        acceptedAt: "2026-06-01T00:06:00.000Z",
        expiresAt: "2026-06-01T00:36:00.000Z",
        acceptedBy: "chaty",
        state: "active",
        actionPolicy: {
          fileTransfer: "approval-required",
          browser: "approval-required",
          phoneControl: "disabled",
          commandExecution: "disabled"
        },
        rawTokenPersisted: false,
        tokenMaterialPersisted: false,
        sessionSecretPersisted: false
      }
    ],
    totals: {
      sessions: 1,
      active: 1,
      expired: 0,
      activeCanaryTokens: 1,
      blockedScopes: 0
    },
    source: {
      sessionPath: `${projectRoot}/state/nodes/node-device-sessions.jsonl`
    }
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-node-actions-"));
}

async function listenFixtureServer(body: string): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(body);
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    throw new Error("Fixture server did not expose a TCP address");
  }

  const tcpAddress: AddressInfo = address;

  return {
    url: `http://127.0.0.1:${tcpAddress.port}/snapshot`,
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }

          resolveClose();
        });
      });
    }
  };
}
