import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDoctorSnapshot,
  markNeonGatewayRunDelivered,
  readNeonGatewayRuns,
  writeNeonGatewayRunLatest,
  type INeonGatewayShadowRun
} from "../src/index.js";

const DISCORD_CHANNEL_ID = "900000000000000005";
const REAL_MESSAGE_ID = "900000000000000014";

function createShadowRun(runId: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      channelId: DISCORD_CHANNEL_ID,
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/neonika",
      mode: "write",
      contentPreview: "run audit live test",
      receivedAt: "2026-06-05T11:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:audit",
    memoryState: "skipped",
    events: [],
    finalText: "live reply",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: DISCORD_CHANNEL_ID,
      reason: "shadow-mode",
      finalText: "live reply"
    },
    startedAt: "2026-06-05T11:00:00.000Z",
    completedAt: "2026-06-05T11:00:01.000Z"
  };
}

async function withTempRoot<T>(run: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-run-audit-live-"));
  try {
    return await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

describe("Neon run audit live widening", () => {
  it("marks a sent run as live/delivered with the real message id", () => {
    const delivered = markNeonGatewayRunDelivered(createShadowRun("neon-shadow-mark"), {
      messageId: REAL_MESSAGE_ID,
      cutoverStage: "canary"
    });

    assert.equal(delivered.mode, "live");
    assert.equal(delivered.delivery.state, "delivered");
    assert.equal(delivered.delivery.messageId, REAL_MESSAGE_ID);
    assert.equal(delivered.delivery.cutoverStage, "canary");
    assert.equal(delivered.delivery.reason, "canary-reply");
    // The rest of the run is untouched.
    assert.equal(delivered.runId, "neon-shadow-mark");
    assert.equal(delivered.finalText, "live reply");
  });

  it("round-trips a delivered run through the store, preserving the message id", async () => {
    await withTempRoot(async (projectRoot) => {
      const delivered = markNeonGatewayRunDelivered(createShadowRun("neon-shadow-roundtrip"), {
        messageId: REAL_MESSAGE_ID,
        reason: "none",
        cutoverStage: "canary"
      });
      await writeNeonGatewayRunLatest(projectRoot, delivered);

      const runs = await readNeonGatewayRuns(projectRoot);
      assert.equal(runs.length, 1);
      const [run] = runs;
      assert.equal(run?.mode, "live");
      assert.equal(run?.delivery.state, "delivered");
      assert.equal(run?.delivery.messageId, REAL_MESSAGE_ID);
      assert.equal(run?.delivery.cutoverStage, "canary");
      assert.equal(run?.delivery.reason, "none");
    });
  });

  it("upsert-replaces the prior shadow record by runId (no duplicate)", async () => {
    await withTempRoot(async (projectRoot) => {
      const base = createShadowRun("neon-shadow-upsert");
      await writeNeonGatewayRunLatest(projectRoot, base);
      await writeNeonGatewayRunLatest(
        projectRoot,
        markNeonGatewayRunDelivered(base, { messageId: REAL_MESSAGE_ID })
      );

      const runs = await readNeonGatewayRuns(projectRoot);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.delivery.state, "delivered");
    });
  });

  it("doctor delivery check passes for delivered runs under primary", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonGatewayRunLatest(
        projectRoot,
        markNeonGatewayRunDelivered(createShadowRun("neon-shadow-primary"), {
          messageId: REAL_MESSAGE_ID
        })
      );

      const snapshot = await createNeonDoctorSnapshot(projectRoot, {
        currentStage: "primary",
        includeMemoryStatus: false
      });
      const delivery = snapshot.checks.find((check) => check.id === "delivery");

      assert.equal(delivery?.state, "pass");
      assert.match(delivery?.summary ?? "", /Outbound is live at the primary stage/u);
      assert.match(delivery?.summary ?? "", /1 run\(s\) delivered/u);
    });
  });

  it("doctor delivery check still fails for a delivered run under shadow", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonGatewayRunLatest(
        projectRoot,
        markNeonGatewayRunDelivered(createShadowRun("neon-shadow-leak"), {
          messageId: REAL_MESSAGE_ID
        })
      );

      const snapshot = await createNeonDoctorSnapshot(projectRoot, {
        currentStage: "shadow",
        includeMemoryStatus: false
      });
      const delivery = snapshot.checks.find((check) => check.id === "delivery");

      assert.equal(delivery?.state, "fail");
      assert.match(delivery?.summary ?? "", /not shadow-suppressed/u);
    });
  });

  it("keeps a delivered run leak-safe when serialized", () => {
    const delivered = markNeonGatewayRunDelivered(createShadowRun("neon-shadow-leak-safe"), {
      messageId: REAL_MESSAGE_ID
    });
    const serialized = JSON.stringify(delivered);
    assert.doesNotMatch(serialized, /MT[A-Za-z0-9._-]{15,}/u);
    assert.doesNotMatch(serialized, /token/u);
  });
});
