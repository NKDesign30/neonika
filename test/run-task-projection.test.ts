import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonRunTaskProjection,
  mapNeonGatewayRunToTask,
  renderNeonRunTaskProjectionReport
} from "../src/tasks/runTaskProjection.js";
import type { INeonGatewayShadowRun, TNeonGatewayRunStatus } from "../src/gateway/types.js";
import type { TNeonChannel } from "../src/harness/types.js";

interface IMakeRunOptions {
  readonly runId: string;
  readonly status: TNeonGatewayRunStatus;
  readonly agentId?: string;
  readonly channel?: TNeonChannel;
  readonly contentPreview?: string;
  readonly finalText?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

function makeRun(options: IMakeRunOptions): INeonGatewayShadowRun {
  return {
    runId: options.runId,
    mode: "shadow",
    status: options.status,
    request: {
      channel: options.channel ?? "discord",
      accountId: "default",
      channelId: "channel-1",
      userId: "operator",
      agentId: options.agentId ?? "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: options.contentPreview ?? "triage the inbox",
      receivedAt: options.startedAt ?? "2026-06-03T00:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: `neon:${options.agentId ?? "chaty"}:${options.runId}`,
    memoryState: "skipped",
    events: [{ kind: "final", text: options.finalText ?? "done" }],
    finalText: options.finalText ?? "done",
    delivery: {
      state: "suppressed",
      targetChannel: options.channel ?? "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: options.finalText ?? "done"
    },
    startedAt: options.startedAt ?? "2026-06-03T00:00:00.000Z",
    completedAt: options.completedAt ?? "2026-06-03T00:00:01.000Z"
  };
}

describe("mapNeonGatewayRunToTask", () => {
  it("projects a completed run into a done task linked back to the run", () => {
    const task = mapNeonGatewayRunToTask(
      makeRun({ runId: "r1", status: "completed", agentId: "neo", contentPreview: "summarize the thread" })
    );
    assert.ok(task);
    assert.equal(task?.taskId, "run:r1");
    assert.equal(task?.source, "run");
    assert.equal(task?.sourceRef, "r1");
    assert.equal(task?.status, "done");
    assert.equal(task?.priority, "normal");
    assert.equal(task?.ownerAgentId, "neo");
    assert.equal(task?.title, "summarize the thread");
    assert.deepEqual(task?.runIds, ["r1"]);
    assert.deepEqual(task?.links, [{ type: "run", ref: "r1" }]);
    assert.deepEqual(task?.labels, ["run", "completed"]);
  });

  it("projects a failed run into a blocked, high-priority task", () => {
    const task = mapNeonGatewayRunToTask(makeRun({ runId: "r2", status: "failed" }));
    assert.equal(task?.status, "blocked");
    assert.equal(task?.priority, "high");
    assert.deepEqual(task?.labels, ["run", "failed"]);
  });

  it("falls back to a run-id title when there is no content preview or goal", () => {
    const task = mapNeonGatewayRunToTask(makeRun({ runId: "r3", status: "completed", contentPreview: "" }));
    assert.equal(task?.title, "Run r3");
  });

  it("redacts a secret in the projected title and summary", () => {
    const task = mapNeonGatewayRunToTask(
      makeRun({
        runId: "r4",
        status: "completed",
        contentPreview: "deploy with token sk-abcdef0123456789ABCDEF",
        finalText: "shipped using sk-abcdef0123456789ABCDEF"
      })
    );
    const serialized = JSON.stringify(task);
    assert.doesNotMatch(serialized, /sk-abcdef/);
    assert.match(task?.title ?? "", /\[REDACTED_SECRET\]/);
    assert.match(task?.summary ?? "", /\[REDACTED_SECRET\]/);
  });
});

describe("createNeonRunTaskProjection", () => {
  it("reports an empty projection when there are no runs", () => {
    const projection = createNeonRunTaskProjection([]);
    assert.equal(projection.state, "empty");
    assert.equal(projection.taskCount, 0);
    assert.match(renderNeonRunTaskProjectionReport(projection), /no terminal runs/);
  });

  it("counts done vs blocked and sorts newest-updated first, never spawning", () => {
    const projection = createNeonRunTaskProjection([
      makeRun({ runId: "older", status: "completed", completedAt: "2026-06-03T00:00:01.000Z" }),
      makeRun({ runId: "newer", status: "failed", completedAt: "2026-06-03T00:05:00.000Z" })
    ]);
    assert.equal(projection.state, "ready");
    assert.equal(projection.taskCount, 2);
    assert.equal(projection.doneCount, 1);
    assert.equal(projection.blockedCount, 1);
    assert.equal(projection.cancelledCount, 0);
    assert.equal(projection.tasks[0]?.taskId, "run:newer", "newest-updated task sorts first");

    const report = renderNeonRunTaskProjectionReport(projection);
    assert.match(report, /2 task\(s\) from terminal runs \(1 done \/ 1 blocked \/ 0 cancelled\)/);
    assert.match(report, /read-only, no spawn/);
  });
});
