import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeActionResultPreview,
  createNeonNodeDeviceSessionSnapshot,
  createNeonNodeTransportSnapshot,
  readNeonNodeTransportPollRecords,
  readNeonNodeTransportResultRecords,
  recordNeonNodeActionApproval,
  recordNeonNodeActionRequest,
  recordNeonNodeTransportPoll,
  recordNeonNodeTransportResult,
  renderNeonNodeTransportReport,
  resolveNeonNodeTransportPaths,
  type INeonNodeDeviceSessionSnapshot,
  type TNeonNodeDeviceSessionScope,
  type TNeonNodeDeviceSessionState
} from "../src/index.js";

describe("Neon Node Transport", () => {
  it("creates poll-only dispatch envelopes for approved read-only actions", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "transport-fixtures"), { recursive: true });
      await writeFile(join(projectRoot, "transport-fixtures", "sample.txt"), "transport\n", "utf8");

      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const request = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.list",
          requestedBy: "chaty",
          targetPath: join(projectRoot, "transport-fixtures"),
          reason: "transport unit"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      const approval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          operatorId: "operator",
          reason: "approved for transport"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:12:00.000Z")
      });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.approvedActions, 1);
      assert.equal(snapshot.totals.dispatches, 1);
      assert.equal(snapshot.totals.blockers, 0);
      assert.equal(snapshot.policy.mode, "poll-only");
      assert.equal(snapshot.policy.mutationAllowed, false);
      assert.equal(snapshot.policy.rawTokenExposure, "disabled");
      assert.equal(snapshot.policy.sessionSecretExposure, "disabled");
      assert.equal(snapshot.dispatches[0]?.approvalId, approval.approvalId);
      assert.equal(snapshot.dispatches[0]?.requestId, request.requestId);
      assert.equal(snapshot.dispatches[0]?.kind, "file.list");
      assert.equal(snapshot.dispatches[0]?.target.path, "transport-fixtures");
      assert.equal(snapshot.dispatches[0]?.safety.sideEffectExecuted, false);
      assert.equal(snapshot.dispatches[0]?.safety.rawOutputPersisted, false);
      assert.equal(snapshot.dispatches[0]?.safety.rawTokenExposed, false);
      assert.equal(snapshot.dispatches[0]?.safety.sessionSecretExposed, false);
      assert.doesNotMatch(JSON.stringify(snapshot), /session-secret-unit/u);
      assert.match(renderNeonNodeTransportReport(snapshot), /Neon Node Transport: ready/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("creates poll-only dispatch envelopes for dir.list actions", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "dir-transport"), { recursive: true });
      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const request = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "dir.list",
          requestedBy: "chaty",
          targetPath: join(projectRoot, "dir-transport"),
          reason: "directory transport unit"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      const approval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:12:00.000Z")
      });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.dispatches, 1);
      assert.equal(snapshot.dispatches[0]?.approvalId, approval.approvalId);
      assert.equal(snapshot.dispatches[0]?.kind, "dir.list");
      assert.equal(snapshot.dispatches[0]?.target.path, "dir-transport");
      assert.equal(snapshot.dispatches[0]?.safety.sideEffectExecuted, false);
      assert.equal(snapshot.dispatches[0]?.safety.rawOutputPersisted, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("ingests bounded remote results and removes the dispatch from pending transport", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const transport = await createApprovedTransportDispatch(projectRoot, deviceSessionSnapshot);
      const result = await recordNeonNodeTransportResult(
        projectRoot,
        {
          dispatchId: transport.dispatch.dispatchId,
          summary: "remote result sk-test-secret-value",
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
        },
        {
          transportSnapshot: transport.snapshot,
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );
      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:14:00.000Z")
      });
      const records = await readNeonNodeTransportResultRecords(projectRoot);
      const rawState = await readFile(resolveNeonNodeTransportPaths(projectRoot).resultPath, "utf8");

      assert.equal(result.dispatchId, transport.dispatch.dispatchId);
      assert.equal(result.state, "received");
      assert.equal(result.resultKind, "file-list");
      assert.equal(result.fileList?.entries[0]?.relativePath, "transport-fixtures/sample.txt");
      assert.equal(result.safety.rawOutputPersisted, false);
      assert.equal(result.safety.rawTokenPersisted, false);
      assert.equal(result.safety.sessionSecretPersisted, false);
      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.dispatches, 0);
      assert.equal(snapshot.totals.results, 1);
      assert.equal(snapshot.totals.receivedResults, 1);
      assert.equal(snapshot.totals.ingestedApprovals, 1);
      assert.equal(records.length, 1);
      assert.doesNotMatch(rawState, /sk-test-secret-value/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("ingests bounded read-only dir.fetch directory bundles with a roundtrip parse", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "dir-bundle"), { recursive: true });
      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const request = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "dir.fetch",
          requestedBy: "chaty",
          targetPath: join(projectRoot, "dir-bundle"),
          reason: "directory bundle unit"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      const transport = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:12:00.000Z")
      });
      const dispatch = transport.dispatches[0];

      assert.ok(dispatch);
      assert.equal(dispatch.kind, "dir.fetch");

      const result = await recordNeonNodeTransportResult(
        projectRoot,
        {
          dispatchId: dispatch.dispatchId,
          summary: "directory bundle ingested",
          entries: [
            {
              relativePath: "dir-bundle/readme.md",
              binary: false,
              sizeBytes: 11,
              textPreview: "x".repeat(5000),
              truncated: false
            },
            {
              relativePath: "dir-bundle/logo.png",
              binary: true,
              sizeBytes: 2048,
              truncated: true
            }
          ],
          totalEntries: 2,
          truncated: false
        },
        {
          transportSnapshot: transport,
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );

      assert.equal(result.resultKind, "dir-fetch");
      assert.equal(result.dirFetch?.totalEntries, 2);
      assert.equal(result.dirFetch?.entries.length, 2);
      assert.equal(result.dirFetch?.entries[0]?.relativePath, "dir-bundle/readme.md");
      assert.equal(result.dirFetch?.entries[0]?.binary, false);
      // textPreview bounded to the transport preview cap (input was 5000 chars)
      assert.ok((result.dirFetch?.entries[0]?.textPreview?.length ?? 0) <= 4096);
      assert.equal(result.dirFetch?.entries[1]?.binary, true);
      assert.equal(result.dirFetch?.entries[1]?.truncated, true);
      assert.equal(result.dirFetch?.entries[1]?.textPreview, undefined);
      assert.equal(result.safety.rawOutputPersisted, false);
      assert.equal(result.safety.sideEffectExecuted, false);
      assert.equal(result.safety.mutationExecuted, false);

      // roundtrip via the persisted parse path
      const records = await readNeonNodeTransportResultRecords(projectRoot);

      assert.equal(records.length, 1);
      assert.equal(records[0]?.resultKind, "dir-fetch");
      assert.equal(records[0]?.dirFetch?.entries.length, 2);
      assert.equal(records[0]?.dirFetch?.entries[0]?.relativePath, "dir-bundle/readme.md");
      assert.equal(records[0]?.dirFetch?.entries[1]?.binary, true);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects duplicate transport results for the same dispatch", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const transport = await createApprovedTransportDispatch(projectRoot, deviceSessionSnapshot);
      const input = {
        dispatchId: transport.dispatch.dispatchId,
        summary: "first result"
      };

      await recordNeonNodeTransportResult(projectRoot, input, {
        transportSnapshot: transport.snapshot,
        now: () => new Date("2026-06-01T00:13:00.000Z")
      });

      await assert.rejects(
        recordNeonNodeTransportResult(projectRoot, input, {
          transportSnapshot: transport.snapshot,
          now: () => new Date("2026-06-01T00:14:00.000Z")
        }),
        /already has an ingested result/u
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records authenticated poll heartbeats and suppresses duplicate cursor replay", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const transport = await createApprovedTransportDispatch(projectRoot, deviceSessionSnapshot);
      const firstPoll = await recordNeonNodeTransportPoll(
        projectRoot,
        {
          sessionId: "device-session-unit"
        },
        {
          deviceSessionSnapshot,
          transportSnapshot: transport.snapshot,
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );
      const secondPoll = await recordNeonNodeTransportPoll(
        projectRoot,
        {
          sessionId: "device-session-unit",
          cursor: firstPoll.cursor
        },
        {
          deviceSessionSnapshot,
          transportSnapshot: transport.snapshot,
          now: () => new Date("2026-06-01T00:14:00.000Z")
        }
      );
      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:15:00.000Z")
      });
      const records = await readNeonNodeTransportPollRecords(projectRoot);
      const rawState = await readFile(resolveNeonNodeTransportPaths(projectRoot).pollPath, "utf8");

      assert.equal(firstPoll.state, "accepted");
      assert.equal(firstPoll.replay, "replay");
      assert.equal(firstPoll.dispatches.length, 1);
      assert.equal(firstPoll.dispatches[0]?.dispatchId, transport.dispatch.dispatchId);
      assert.equal(firstPoll.poll.dispatches, 1);
      assert.equal(secondPoll.replay, "cursor-hit");
      assert.equal(secondPoll.dispatches.length, 0);
      assert.equal(secondPoll.previousCursor, firstPoll.cursor);
      assert.equal(snapshot.totals.polls, 2);
      assert.equal(snapshot.totals.activePollingSessions, 1);
      assert.equal(snapshot.polls[0]?.safety.rawTokenPersisted, false);
      assert.equal(snapshot.polls[0]?.safety.sessionSecretPersisted, false);
      assert.equal(records.length, 2);
      assert.doesNotMatch(rawState, /session-secret-unit/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("does not dispatch an approval after a result preview exists", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await mkdir(join(projectRoot, "preview-fixtures"), { recursive: true });
      await writeFile(join(projectRoot, "preview-fixtures", "sample.txt"), "preview\n", "utf8");

      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const request = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.list",
          requestedBy: "chaty",
          targetPath: join(projectRoot, "preview-fixtures"),
          reason: "preview transport unit"
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      const approval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );
      await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: approval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );

      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:13:00.000Z")
      });

      assert.equal(snapshot.state, "empty");
      assert.equal(snapshot.totals.approvedActions, 1);
      assert.equal(snapshot.totals.previewedApprovals, 1);
      assert.deepEqual(snapshot.dispatches, []);
      assert.deepEqual(snapshot.blockers, []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks approved actions without a matching active session", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const activeSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const expiredSessionSnapshot = await createDeviceSessionSnapshot(projectRoot, {
        sessionState: "expired"
      });
      const request = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "browser.snapshot",
          requestedBy: "chaty",
          targetUrl: "http://127.0.0.1:8797/mission-control/nodes"
        },
        {
          deviceSessionSnapshot: activeSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );

      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot: expiredSessionSnapshot,
        now: () => new Date("2026-06-01T00:12:00.000Z")
      });

      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.totals.dispatches, 0);
      assert.equal(snapshot.totals.blockers, 1);
      assert.equal(snapshot.blockers[0]?.id, "approved-action-without-active-session");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks workspace-escaping file targets before transport dispatch", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const deviceSessionSnapshot = await createDeviceSessionSnapshot(projectRoot);
      const request = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: "device-session-unit",
          kind: "file.fetch",
          requestedBy: "chaty",
          targetPath: join(projectRoot, "..", "outside-neonika.txt")
        },
        {
          deviceSessionSnapshot,
          now: () => new Date("2026-06-01T00:10:00.000Z")
        }
      );
      await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: request.requestId,
          decision: "approve",
          operatorId: "operator"
        },
        {
          now: () => new Date("2026-06-01T00:11:00.000Z")
        }
      );

      const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
        deviceSessionSnapshot,
        now: () => new Date("2026-06-01T00:12:00.000Z")
      });

      assert.equal(snapshot.state, "blocked");
      assert.equal(snapshot.totals.dispatches, 0);
      assert.equal(snapshot.totals.unsafeTargets, 1);
      assert.equal(snapshot.blockers[0]?.id, "unsafe-target");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-node-transport-test-"));
}

async function createApprovedTransportDispatch(
  projectRoot: string,
  deviceSessionSnapshot: INeonNodeDeviceSessionSnapshot
) {
  await mkdir(join(projectRoot, "transport-fixtures"), { recursive: true });
  await writeFile(join(projectRoot, "transport-fixtures", "sample.txt"), "transport\n", "utf8");

  const request = await recordNeonNodeActionRequest(
    projectRoot,
    {
      sessionId: "device-session-unit",
      kind: "file.list",
      requestedBy: "chaty",
      targetPath: join(projectRoot, "transport-fixtures"),
      reason: "transport unit"
    },
    {
      deviceSessionSnapshot,
      now: () => new Date("2026-06-01T00:10:00.000Z")
    }
  );
  await recordNeonNodeActionApproval(
    projectRoot,
    {
      requestId: request.requestId,
      decision: "approve",
      operatorId: "operator",
      reason: "approved for transport"
    },
    {
      now: () => new Date("2026-06-01T00:11:00.000Z")
    }
  );

  const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
    deviceSessionSnapshot,
    now: () => new Date("2026-06-01T00:12:00.000Z")
  });
  const dispatch = snapshot.dispatches[0];

  assert.ok(dispatch);

  return {
    dispatch,
    snapshot
  };
}

async function createDeviceSessionSnapshot(
  projectRoot: string,
  options: {
    readonly grantedScopes?: readonly TNeonNodeDeviceSessionScope[];
    readonly sessionState?: TNeonNodeDeviceSessionState;
  } = {}
): Promise<INeonNodeDeviceSessionSnapshot> {
  const base = await createNeonNodeDeviceSessionSnapshot(projectRoot, {
    now: () => new Date("2026-06-01T00:09:00.000Z")
  });
  const grantedScopes = options.grantedScopes ?? [
    "node.heartbeat",
    "node.status",
    "operator.pairing",
    "file.read",
    "browser.read"
  ];
  const sessionState = options.sessionState ?? "active";
  const activeSessions = sessionState === "active" ? 1 : 0;

  return {
    ...base,
    state: sessionState === "active" ? "active" : "locked",
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
        expiresAt:
          sessionState === "active" ? "2026-06-01T00:36:00.000Z" : "2026-06-01T00:08:00.000Z",
        acceptedBy: "chaty",
        state: sessionState,
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
      ...base.totals,
      sessions: 1,
      active: activeSessions,
      expired: sessionState === "active" ? 0 : 1,
      activeCanaryTokens: activeSessions
    }
  };
}
