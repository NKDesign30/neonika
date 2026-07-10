import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  loadNeonTuiDashboard,
  loadNeonTuiPanel,
  neonTuiPanelOrder,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon Operator Shell — data loader", () => {
  it("aggregates every panel read-only into one dashboard", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createSeedRun());

      const dashboard = await loadNeonTuiDashboard(projectRoot, {
        now: () => new Date("2026-06-02T11:00:00.000Z")
      });
      const serialized = JSON.stringify(dashboard);

      assert.equal(dashboard.generatedAt, "2026-06-02T11:00:00.000Z");
      assert.equal(dashboard.projectRoot, projectRoot);
      assert.deepEqual(
        dashboard.panels.map((panel) => panel.command),
        [...neonTuiPanelOrder]
      );

      for (const panel of dashboard.panels) {
        assert.ok(panel.lines.length > 0, `panel ${panel.command} should have body lines`);
        assert.notEqual(panel.state, "error", `panel ${panel.command} should load cleanly`);
      }

      const gateway = dashboard.panels.find((panel) => panel.command === "gateway");
      assert.ok(gateway?.lines.some((line) => line.includes("Runs: 1")));

      // Redaction proof: the seeded secret never reaches the rendered panels.
      assert.doesNotMatch(serialized, /sk-tui…secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("loads a single panel read-only", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createSeedRun());

      const panel = await loadNeonTuiPanel(projectRoot, "gateway");

      assert.equal(panel.command, "gateway");
      assert.equal(panel.state, "ready");
      assert.ok(panel.lines.some((line) => line.startsWith("Gateway: ready")));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("isolates a failing panel without dropping the others", async () => {
    // Point the loader at a regular file so the underlying file reads raise a
    // non-ENOENT error. The dashboard must still return all panels, with the
    // failing reads surfaced as a redacted `error` state, not a thrown crash.
    const projectRoot = await createTempProjectRoot();
    const filePath = join(projectRoot, "not-a-directory");
    await writeFile(filePath, "x", "utf8");

    try {
      const dashboard = await loadNeonTuiDashboard(filePath);

      assert.equal(dashboard.panels.length, neonTuiPanelOrder.length);

      const gateway = dashboard.panels.find((panel) => panel.command === "gateway");
      assert.equal(gateway?.state, "error");
      assert.ok(gateway?.lines[0]?.startsWith("Failed to load gateway:"));
      assert.doesNotMatch(gateway?.lines[0] ?? "", /\n {4}at /u);

      // Status renders from a pure manifest, so it never fails on a bad path.
      const status = dashboard.panels.find((panel) => panel.command === "status");
      assert.equal(status?.state, "ready");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects an unknown panel id", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await assert.rejects(
        // The id is intentionally invalid to exercise the descriptor guard.
        loadNeonTuiPanel(projectRoot, "nope" as Parameters<typeof loadNeonTuiPanel>[1]),
        /Unknown Neon operator panel: nope/u
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createSeedRun(): INeonGatewayShadowRun {
  return {
    runId: "tui-seed-run",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      threadId: "operator-privat",
      messageId: "tui-seed-message",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neon-core",
      mode: "read-only",
      contentPreview: "Operator shell seed",
      receivedAt: "2026-06-02T10:58:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "tui-seed-session",
    memoryState: "attached",
    events: [
      { kind: "tool-start", toolName: "codex" },
      { kind: "tool-output", output: "result sk-tui…secret", toolName: "codex" },
      { kind: "final", text: "Operator shell ready sk-tui…secret" }
    ],
    finalText: "Operator shell ready sk-tui…secret",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "Operator shell ready sk-tui…secret"
    },
    startedAt: "2026-06-02T10:58:00.000Z",
    completedAt: "2026-06-02T10:58:02.000Z"
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-tui-data-"));
}
