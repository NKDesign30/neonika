import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readNeonGatewayRuns,
  readNeonGatewayStatus,
  rescueNeonGatewayRunStore,
  resolveNeonRunStoreRescueEnabled,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon Gateway run-store rescue", () => {
  it("is a dry-run by default and never mutates the store", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createRun("keep-1", "completed"));
      await writeNeonGatewayRun(projectRoot, createRun("fail-1", "failed"));

      const result = await rescueNeonGatewayRunStore(projectRoot, { enabled: false });

      assert.equal(result.applied, false);
      assert.equal(result.rescuedRuns, 1);
      assert.equal(result.keptRuns, 1);
      assert.deepEqual([...result.rescuedRunIds], ["fail-1"]);
      assert.equal(result.archivePath, null);

      const status = await readNeonGatewayStatus(projectRoot);
      assert.equal(status.failedCount, 1, "dry-run must not change the store");
      assert.equal(status.runCount, 2);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("archives failed runs and rewrites the store without them when enabled", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createRun("keep-1", "completed"));
      await writeNeonGatewayRun(projectRoot, createRun("fail-1", "failed"));
      await writeNeonGatewayRun(projectRoot, createRun("keep-2", "completed"));
      await writeNeonGatewayRun(projectRoot, createRun("run-1", "running"));

      const result = await rescueNeonGatewayRunStore(projectRoot, {
        enabled: true,
        now: () => new Date("2026-06-05T11:30:00.000Z")
      });

      assert.equal(result.applied, true);
      assert.equal(result.rescuedRuns, 1);
      assert.equal(result.keptRuns, 3);
      assert.ok(result.archivePath, "archive path must be set when applied");

      const status = await readNeonGatewayStatus(projectRoot);
      assert.equal(status.failedCount, 0, "failed runs must be gone from the active store");
      assert.equal(status.completedCount, 2, "completed runs stay as evidence");
      assert.equal(status.runningCount, 1, "non-failed runs are untouched");
      assert.equal(status.runCount, 3);

      // No data loss: the archived line still holds the original failed run.
      const archiveRaw = await readFile(result.archivePath ?? "", "utf8");
      assert.match(archiveRaw, /"runId":"fail-1"/);
      assert.match(archiveRaw, /"reason":"shadow-exit-rescue"/);

      const remaining = await readNeonGatewayRuns(projectRoot);
      assert.deepEqual(
        remaining.map((run) => run.runId).sort(),
        ["keep-1", "keep-2", "run-1"]
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("does nothing and writes no archive when there are no failed runs", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createRun("keep-1", "completed"));

      const result = await rescueNeonGatewayRunStore(projectRoot, { enabled: true });

      assert.equal(result.applied, false);
      assert.equal(result.rescuedRuns, 0);
      assert.equal(result.archivePath, null);

      const status = await readNeonGatewayStatus(projectRoot);
      assert.equal(status.runCount, 1);
      assert.equal(status.completedCount, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reads the rescue gate from a ready-like env flag", () => {
    assert.equal(resolveNeonRunStoreRescueEnabled({ NEON_RUN_STORE_RESCUE_ENABLED: "ready" }), true);
    assert.equal(resolveNeonRunStoreRescueEnabled({ NEON_RUN_STORE_RESCUE_ENABLED: "1" }), true);
    assert.equal(resolveNeonRunStoreRescueEnabled({ NEON_RUN_STORE_RESCUE_ENABLED: "no" }), false);
    assert.equal(resolveNeonRunStoreRescueEnabled({}), false);
  });
});

function createRun(
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
      workspaceRoot: "/tmp/neonika",
      mode: "read-only",
      contentPreview: "rescue test",
      receivedAt: "2026-06-05T11:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:rescue",
    memoryState: "skipped",
    events: [],
    finalText: "",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: ""
    },
    startedAt: "2026-06-05T11:00:00.000Z",
    completedAt: "2026-06-05T11:00:01.000Z"
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-run-store-rescue-"));
}
