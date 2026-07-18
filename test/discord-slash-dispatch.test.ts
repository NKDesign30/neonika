import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  resolveNeonSlashCommandRegistrationPlan,
  runNeonDiscordSlashInteractionShadow,
  type INeonDiscordIngressPolicy,
  type INeonDiscordSlashInteractionEnvelope
} from "../src/index.js";

const guildId = "guild-1";
const channelId = "channel-1";

async function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "neonika-slash-dispatch-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function interaction(
  overrides: Partial<INeonDiscordSlashInteractionEnvelope> = {}
): INeonDiscordSlashInteractionEnvelope {
  return {
    accountId: "default",
    guildId,
    channelId,
    interactionId: "i-1",
    commandName: "skill",
    subcommandName: "run",
    author: { id: "operator", username: "operator", displayName: "Operator" },
    options: [{ name: "query", value: "memory search" }],
    createdAt: "2026-06-02T12:00:00.000Z",
    ...overrides
  };
}

function policy(overrides: Partial<INeonDiscordIngressPolicy> = {}): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: "/tmp/neonika",
    mode: "read-only",
    mentionPolicy: "never",
    allowedGuildIds: [guildId],
    allowedChannelIds: [channelId],
    ...overrides
  };
}

describe("Neonika Discord slash interaction shadow dispatch", () => {
  it("admits a slash interaction as a no-send shadow run", async () => {
    await withProjectRoot(async (root) => {
      const result = await runNeonDiscordSlashInteractionShadow(
        {
          interaction: interaction(),
          policy: policy({ workspaceRoot: root }),
          memory: { state: "skipped", hitCount: 0, note: "slash smoke" }
        },
        { projectRoot: root, harness: createDryRunHarness() }
      );

      assert.equal(result.state, "accepted");
      if (result.state === "accepted") {
        assert.equal(result.result.run.delivery.state, "suppressed");
        assert.equal(result.commandText, '/skill run query="memory search"');
        assert.equal(result.result.run.request.channel, "discord");
      }
    });
  });

  it("drops an interaction that maps to no command as empty-command", async () => {
    await withProjectRoot(async (root) => {
      const result = await runNeonDiscordSlashInteractionShadow(
        {
          interaction: interaction({ commandName: "   " }),
          policy: policy({ workspaceRoot: root }),
          memory: { state: "skipped", hitCount: 0, note: "slash smoke" }
        },
        { projectRoot: root, harness: createDryRunHarness() }
      );

      assert.deepEqual(result, { state: "dropped", reason: "empty-command" });
    });
  });

  it("drops an unauthorized control command when text commands are enabled", async () => {
    await withProjectRoot(async (root) => {
      const result = await runNeonDiscordSlashInteractionShadow(
        {
          interaction: interaction({ author: { id: "stranger", username: "stranger" } }),
          policy: policy({ workspaceRoot: root, allowTextCommands: true }),
          memory: { state: "skipped", hitCount: 0, note: "slash smoke" }
        },
        { projectRoot: root, harness: createDryRunHarness() }
      );

      assert.equal(result.state, "dropped");
      if (result.state === "dropped") {
        assert.equal(result.reason, "command-not-authorized");
      }
    });
  });

  it("does not resolve memory for a dropped (empty) interaction", async () => {
    await withProjectRoot(async (root) => {
      let resolverCalls = 0;
      const result = await runNeonDiscordSlashInteractionShadow(
        {
          interaction: interaction({ commandName: "" }),
          policy: policy({ workspaceRoot: root }),
          resolveMemory: () => {
            resolverCalls += 1;
            return { state: "attached", hitCount: 1, note: "should not run" };
          }
        },
        { projectRoot: root, harness: createDryRunHarness() }
      );

      assert.equal(result.state, "dropped");
      assert.equal(resolverCalls, 0);
    });
  });
});

describe("Neon slash command registration plan", () => {
  it("prefers guild-scoped registration", () => {
    const plan = resolveNeonSlashCommandRegistrationPlan({
      requestedScope: "guild",
      guildIds: [guildId, " "]
    });
    assert.equal(plan.scope, "guild");
    assert.equal(plan.blocked, false);
    assert.deepEqual(plan.guildIds, [guildId]);
  });

  it("blocks global registration even when opt-in is set (no deploy in shadow)", () => {
    const optedIn = resolveNeonSlashCommandRegistrationPlan({
      requestedScope: "global",
      allowGlobal: true
    });
    const notOptedIn = resolveNeonSlashCommandRegistrationPlan({ requestedScope: "global" });
    assert.equal(optedIn.blocked, true);
    assert.equal(notOptedIn.blocked, true);
    assert.equal(notOptedIn.scope, "blocked");
  });

  it("blocks a guild plan with no guild to scope to", () => {
    const plan = resolveNeonSlashCommandRegistrationPlan({ requestedScope: "guild", guildIds: [] });
    assert.equal(plan.blocked, true);
    assert.equal(plan.scope, "blocked");
  });
});
