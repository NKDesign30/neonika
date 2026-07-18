import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  queryGatewayRuns,
  type INeonGatewayPersistedFinding,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("queryGatewayRuns", () => {
  it("returns every run in input order when no filter is given", () => {
    const runs = [
      buildRun("run-a", { status: "completed" }),
      buildRun("run-b", { status: "failed" }),
      buildRun("run-c", { status: "completed" })
    ];

    const result = queryGatewayRuns(runs);

    assert.deepEqual(
      result.map((run) => run.runId),
      ["run-a", "run-b", "run-c"]
    );
  });

  it("does not mutate the input array", () => {
    const runs = [buildRun("run-a", { status: "completed" }), buildRun("run-b", { status: "failed" })];

    const result = queryGatewayRuns(runs, { status: "completed" });

    assert.equal(runs.length, 2);
    assert.notEqual(result, runs);
    assert.equal(result.length, 1);
  });

  it("filters by status", () => {
    const runs = [
      buildRun("run-a", { status: "completed" }),
      buildRun("run-b", { status: "failed" }),
      buildRun("run-c", { status: "failed" })
    ];

    const failed = queryGatewayRuns(runs, { status: "failed" });
    const completed = queryGatewayRuns(runs, { status: "completed" });

    assert.deepEqual(
      failed.map((run) => run.runId),
      ["run-b", "run-c"]
    );
    assert.deepEqual(
      completed.map((run) => run.runId),
      ["run-a"]
    );
  });

  it("filters by mode", () => {
    const runs = [buildRun("run-a", {}), buildRun("run-b", {})];

    const shadow = queryGatewayRuns(runs, { mode: "shadow" });

    assert.deepEqual(
      shadow.map((run) => run.runId),
      ["run-a", "run-b"]
    );
  });

  it("filters by agentId", () => {
    const runs = [
      buildRun("run-a", { agentId: "chaty" }),
      buildRun("run-b", { agentId: "neo" }),
      buildRun("run-c", { agentId: "chaty" })
    ];

    const chaty = queryGatewayRuns(runs, { agentId: "chaty" });
    const neo = queryGatewayRuns(runs, { agentId: "neo" });
    const missing = queryGatewayRuns(runs, { agentId: "atlas" });

    assert.deepEqual(
      chaty.map((run) => run.runId),
      ["run-a", "run-c"]
    );
    assert.deepEqual(
      neo.map((run) => run.runId),
      ["run-b"]
    );
    assert.deepEqual(missing, []);
  });

  it("filters by presence of suspicious findings", () => {
    const findings: readonly INeonGatewayPersistedFinding[] = [
      { id: "ignore-previous-instructions", severity: "warn", count: 2 }
    ];
    const runs = [
      buildRun("run-flagged", { suspiciousFindings: findings }),
      buildRun("run-clean", {}),
      buildRun("run-empty-array", { suspiciousFindings: [] })
    ];

    const flagged = queryGatewayRuns(runs, { hasSuspiciousFindings: true });
    const clean = queryGatewayRuns(runs, { hasSuspiciousFindings: false });

    assert.deepEqual(
      flagged.map((run) => run.runId),
      ["run-flagged"]
    );
    assert.deepEqual(
      clean.map((run) => run.runId),
      ["run-clean", "run-empty-array"]
    );
  });

  it("combines multiple filter dimensions with AND semantics", () => {
    const findings: readonly INeonGatewayPersistedFinding[] = [
      { id: "tool-call-injection", severity: "warn", count: 1 }
    ];
    const runs = [
      buildRun("run-a", { status: "failed", agentId: "chaty", suspiciousFindings: findings }),
      buildRun("run-b", { status: "completed", agentId: "chaty", suspiciousFindings: findings }),
      buildRun("run-c", { status: "failed", agentId: "neo", suspiciousFindings: findings }),
      buildRun("run-d", { status: "failed", agentId: "chaty" })
    ];

    const result = queryGatewayRuns(runs, {
      mode: "shadow",
      status: "failed",
      agentId: "chaty",
      hasSuspiciousFindings: true
    });

    assert.deepEqual(
      result.map((run) => run.runId),
      ["run-a"]
    );
  });

  it("filters by memoryState", () => {
    const runs = [
      buildRun("run-attached", { memoryState: "attached" }),
      buildRun("run-skipped", { memoryState: "skipped" }),
      buildRun("run-failed", { memoryState: "failed" }),
      buildRun("run-attached-2", { memoryState: "attached" })
    ];

    const attached = queryGatewayRuns(runs, { memoryState: "attached" });
    const skipped = queryGatewayRuns(runs, { memoryState: "skipped" });
    const failed = queryGatewayRuns(runs, { memoryState: "failed" });

    assert.deepEqual(
      attached.map((run) => run.runId),
      ["run-attached", "run-attached-2"]
    );
    assert.deepEqual(
      skipped.map((run) => run.runId),
      ["run-skipped"]
    );
    assert.deepEqual(
      failed.map((run) => run.runId),
      ["run-failed"]
    );
  });

  it("filters by exact deliveryState", () => {
    const runs = [buildRun("run-a", {}), buildRun("run-b", {})];

    const suppressed = queryGatewayRuns(runs, { deliveryState: "suppressed" });

    assert.deepEqual(
      suppressed.map((run) => run.runId),
      ["run-a", "run-b"]
    );
  });

  it("filters by negated deliveryState (deliveryStateNot)", () => {
    const runs = [buildRun("run-a", {}), buildRun("run-b", {})];

    const unsafe = queryGatewayRuns(runs, { deliveryStateNot: "suppressed" });

    assert.deepEqual(unsafe, []);
  });

  it("combines memoryState with other dimensions using AND semantics", () => {
    const runs = [
      buildRun("run-a", { status: "completed", memoryState: "attached" }),
      buildRun("run-b", { status: "failed", memoryState: "attached" }),
      buildRun("run-c", { status: "completed", memoryState: "skipped" })
    ];

    const result = queryGatewayRuns(runs, { status: "completed", memoryState: "attached" });

    assert.deepEqual(
      result.map((run) => run.runId),
      ["run-a"]
    );
  });

  it("returns an empty array for an empty input", () => {
    assert.deepEqual(queryGatewayRuns([], { status: "failed" }), []);
    assert.deepEqual(queryGatewayRuns([], { memoryState: "attached" }), []);
    assert.deepEqual(queryGatewayRuns([], { deliveryStateNot: "suppressed" }), []);
    assert.deepEqual(queryGatewayRuns([]), []);
  });
});

interface IBuildRunOverrides {
  readonly status?: INeonGatewayShadowRun["status"];
  readonly agentId?: string;
  readonly suspiciousFindings?: readonly INeonGatewayPersistedFinding[];
  readonly memoryState?: INeonGatewayShadowRun["memoryState"];
}

function buildRun(runId: string, overrides: IBuildRunOverrides): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: overrides.status ?? "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: "900000000000000005",
      userId: "operator",
      agentId: overrides.agentId ?? "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Bitte Query testen",
      receivedAt: "2026-05-31T14:30:00.000Z",
      ...(overrides.suspiciousFindings ? { suspiciousFindings: overrides.suspiciousFindings } : {})
    },
    harnessId: "codex-app-server",
    harnessSessionKey:
      "neon:codex:chaty:discord:default:900000000000000001:900000000000000005:main:hash:read-only",
    memoryState: overrides.memoryState ?? "skipped",
    events: [{ kind: "final", text: "final" }],
    finalText: "final",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "final"
    },
    startedAt: "2026-05-31T15:00:00.000Z",
    completedAt: "2026-05-31T15:00:01.000Z"
  };
}
