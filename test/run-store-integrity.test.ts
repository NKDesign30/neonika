import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  resolveGatewayStatePaths,
  scanNeonRunStoreIntegrity,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("scanNeonRunStoreIntegrity (Z281)", () => {
  it("reports zero for undefined / empty / whitespace-only input", () => {
    assert.deepEqual(scanNeonRunStoreIntegrity(undefined), { totalLines: 0, parsedRuns: 0, corruptLines: 0 });
    assert.deepEqual(scanNeonRunStoreIntegrity(""), { totalLines: 0, parsedRuns: 0, corruptLines: 0 });
    assert.deepEqual(scanNeonRunStoreIntegrity("\n   \n\n"), { totalLines: 0, parsedRuns: 0, corruptLines: 0 });
  });

  it("counts non-empty unparsable lines as corrupt (mirrors the silent read-path drop)", () => {
    // {"foo":1} is valid JSON but not a run shape -> dropped on read, so corrupt here too.
    const raw = ['{"truncated', '{"foo":1}', "   ", "not json"].join("\n");
    const result = scanNeonRunStoreIntegrity(raw);
    assert.equal(result.totalLines, 3); // the whitespace-only line is excluded
    assert.equal(result.parsedRuns, 0);
    assert.equal(result.corruptLines, 3);
  });

  it("counts real persisted runs as parsed and flags appended corrupt lines", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-run-integrity-"));
    try {
      await writeNeonGatewayRun(projectRoot, createStoredRun("run-1", "completed"));
      await writeNeonGatewayRun(projectRoot, createStoredRun("run-2", "failed"));
      const runsPath = resolveGatewayStatePaths(projectRoot).runsPath;
      const clean = await readFile(runsPath, "utf8");

      const cleanScan = scanNeonRunStoreIntegrity(clean);
      assert.equal(cleanScan.totalLines, 2);
      assert.equal(cleanScan.parsedRuns, 2);
      assert.equal(cleanScan.corruptLines, 0);

      const withCorrupt = `${clean}{"runId":"run-3","truncated\n`;
      const corruptScan = scanNeonRunStoreIntegrity(withCorrupt);
      assert.equal(corruptScan.parsedRuns, 2);
      assert.equal(corruptScan.corruptLines, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createStoredRun(
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
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      threadId: "900000000000000011",
      messageId: "900000000000000012",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neon-core",
      mode: "read-only",
      contentPreview: "Bitte Store testen",
      receivedAt: "2026-05-31T14:30:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:c…only",
    memoryState: "skipped",
    events: [{ kind: "final", text: "final result" }],
    finalText: "final result",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "final result"
    },
    startedAt: "2026-05-31T15:00:00.000Z",
    completedAt: "2026-05-31T15:00:01.000Z"
  };
}
