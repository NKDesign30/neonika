import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  parseNeonCronCommand,
  processNeonCronCommand,
  readNeonCronStoreEvents,
  type INeonGatewayInboundMessage
} from "../src/index.js";

function createCronMessage(content: string): INeonGatewayInboundMessage {
  return {
    channel: "discord",
    accountId: "default",
    channelId: "900000000000000005",
    messageId: "cron-command-smoke",
    userId: "operator",
    userDisplayName: "Operator",
    agentId: "chaty",
    workspaceRoot: "/tmp/neon-cron-command",
    mode: "read-only",
    content,
    createdAt: "2026-06-05T16:00:00.000Z",
    guildId: "900000000000000001"
  };
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-cron-command-"));
}

test("parseNeonCronCommand accepts explicit add/list/state commands only", () => {
  assert.equal(parseNeonCronCommand("please add cron"), undefined);
  assert.deepEqual(parseNeonCronCommand("/cron list"), { mutation: "list" });
  assert.deepEqual(parseNeonCronCommand("/cron add deploy-check every-15m Check deploy"), {
    mutation: "add",
    id: "deploy-check",
    schedule: "every-15m",
    label: "Check deploy"
  });
  assert.deepEqual(parseNeonCronCommand("/cron add label-check every-15m invalid"), {
    mutation: "add",
    id: "label-check",
    schedule: "every-15m",
    label: "invalid"
  });
  assert.deepEqual(parseNeonCronCommand("/cron disable deploy-check"), {
    mutation: "disable",
    id: "deploy-check"
  });
  assert.deepEqual(parseNeonCronCommand("/cron rm deploy-check"), {
    mutation: "remove",
    id: "deploy-check"
  });
  assert.deepEqual(parseNeonCronCommand("/cron nope deploy-check"), {
    mutation: "list",
    error: "Usage: /cron add <id> <schedule> <label...>"
  });
});

test("processNeonCronCommand is gated and writes routed jobs when armed", async () => {
  const root = await tempRoot();
  try {
    const blocked = await processNeonCronCommand(
      root,
      createCronMessage("/cron add deploy-check every-15m Check deploy sk-live-SHOULD-REDACT"),
      { env: {}, now: () => new Date("2026-06-05T16:00:00.000Z") }
    );
    assert.equal(blocked.state, "blocked");
    assert.match(blocked.report, /NEON_CRON_STORE_ENABLED/u);

    const added = await processNeonCronCommand(
      root,
      createCronMessage("/cron add deploy-check every-15m Check deploy sk-live-SHOULD-REDACT"),
      {
        env: { NEON_CRON_STORE_ENABLED: "ready" },
        now: () => new Date("2026-06-05T16:01:00.000Z")
      }
    );
    assert.equal(added.state, "mutated");
    assert.equal(added.jobs.length, 1);
    assert.equal(added.jobs[0]?.id, "deploy-check");
    assert.equal(added.jobs[0]?.deliveryTarget?.channel, "discord");
    assert.equal(added.jobs[0]?.deliveryTarget?.to, "900000000000000005");
    assert.doesNotMatch(JSON.stringify(added), /sk-live-SHOULD-REDACT/u);

    const disabled = await processNeonCronCommand(root, createCronMessage("/cron disable deploy-check"), {
      env: { NEON_CRON_STORE_ENABLED: "ready" },
      now: () => new Date("2026-06-05T16:02:00.000Z")
    });
    assert.equal(disabled.state, "mutated");
    assert.equal(disabled.jobs[0]?.enabled, false);

    const events = await readNeonCronStoreEvents(root);
    assert.equal(events.length, 2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("processNeonCronCommand rejects invalid schedules before writing", async () => {
  const root = await tempRoot();
  try {
    const result = await processNeonCronCommand(root, createCronMessage("/cron add bad nope Bad schedule"), {
      env: { NEON_CRON_STORE_ENABLED: "ready" }
    });
    assert.equal(result.state, "rejected");
    assert.match(result.report, /expected manual-only/u);
    assert.equal((await readNeonCronStoreEvents(root)).length, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
