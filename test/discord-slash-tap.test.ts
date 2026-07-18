import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  mapDiscordJsInteractionToSlashEnvelope,
  readNeonGatewayStatus,
  startNeonDiscordShadowTap,
  type IDiscordJsInteractionLike,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type INeonDiscordSlashInteractionEnvelope,
  type INeonDiscordTapAdapter,
  type TNeonDiscordShadowTapEvent
} from "../src/index.js";

const guildId = "900000000000000001";
const channelId = "900000000000000005";

describe("mapDiscordJsInteractionToSlashEnvelope", () => {
  it("lifts a leading subcommand and maps its options", () => {
    const interaction: IDiscordJsInteractionLike = {
      id: "i-1",
      commandName: "skill",
      guildId,
      channelId,
      createdTimestamp: Date.parse("2026-06-02T12:00:00.000Z"),
      user: { id: "operator", username: "operator" },
      member: { displayName: "Operator" },
      options: {
        data: [
          {
            name: "run",
            type: 1, // Subcommand
            options: [
              { name: "query", type: 3, value: "memory search" },
              { name: "limit", type: 4, value: 3 }
            ]
          }
        ]
      }
    };

    const envelope = mapDiscordJsInteractionToSlashEnvelope(interaction, "default");

    assert.equal(envelope.commandName, "skill");
    assert.equal(envelope.subcommandName, "run");
    assert.equal(envelope.guildId, guildId);
    assert.equal(envelope.author.displayName, "Operator");
    assert.deepEqual(envelope.options, [
      { name: "query", value: "memory search" },
      { name: "limit", value: 3 }
    ]);
  });

  it("maps a bare command with top-level options and no subcommand", () => {
    const interaction: IDiscordJsInteractionLike = {
      id: "i-2",
      commandName: "status",
      guildId: null,
      channelId,
      createdTimestamp: Date.parse("2026-06-02T12:00:00.000Z"),
      user: { id: "operator", username: "operator" },
      options: { data: [{ name: "verbose", type: 5, value: true }] }
    };

    const envelope = mapDiscordJsInteractionToSlashEnvelope(interaction, "default");

    assert.equal(envelope.commandName, "status");
    assert.equal(envelope.subcommandName, undefined);
    assert.equal(envelope.guildId, undefined);
    assert.deepEqual(envelope.options, [{ name: "verbose", value: true }]);
  });
});

describe("Neon Discord shadow tap — slash interaction wiring", () => {
  it("dispatches a native interaction through the shadow slash pipeline", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryTapAdapter();
    const events: TNeonDiscordShadowTapEvent[] = [];

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "***",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        mapInteraction: (interaction) => interaction,
        policy: createPolicy(projectRoot),
        memory: { state: "skipped", hitCount: 0, note: "slash tap test" },
        harness: createDryRunHarness(),
        now: () => new Date("2026-06-02T12:00:00.000Z"),
        onEvent: (event) => events.push(event)
      });

      await adapter.emitInteraction(createInteractionEnvelope());

      assert.equal(handle.stats.interactionsAccepted, 1);
      assert.equal(handle.stats.interactionsDropped, 0);
      assert.equal(handle.stats.accepted, 0, "message counter untouched by interactions");
      assert.ok(handle.stats.lastInteractionRunId);
      assert.equal(events[0]?.kind, "interaction-accepted");

      const status = await readNeonGatewayStatus(projectRoot);
      assert.equal(status.runCount, 1);
      assert.equal(status.latestRun?.channel, "discord");

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("counts an unmapped interaction as an interaction drop", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryTapAdapter();
    const events: TNeonDiscordShadowTapEvent[] = [];

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "***",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        mapInteraction: () => undefined,
        policy: createPolicy(projectRoot),
        memory: { state: "skipped", hitCount: 0, note: "slash tap test" },
        harness: createDryRunHarness(),
        now: () => new Date("2026-06-02T12:00:00.000Z"),
        onEvent: (event) => events.push(event)
      });

      await adapter.emitInteraction(createInteractionEnvelope());

      assert.equal(handle.stats.interactionsAccepted, 0);
      assert.equal(handle.stats.interactionsDropped, 1);
      assert.equal(events[0]?.kind, "interaction-dropped");
      if (events[0]?.kind === "interaction-dropped") {
        assert.equal(events[0].reason, "unmapped-interaction");
      }

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("never arms interaction dispatch without a mapInteraction", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryTapAdapter();

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "***",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy(projectRoot),
        memory: { state: "skipped", hitCount: 0, note: "slash tap test" },
        harness: createDryRunHarness(),
        now: () => new Date("2026-06-02T12:00:00.000Z")
      });

      assert.equal(adapter.interactionListenerArmed, false);
      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createPolicy(projectRoot: string): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: projectRoot,
    mode: "read-only",
    mentionPolicy: "never",
    allowedGuildIds: [guildId],
    allowedChannelIds: [channelId]
  };
}

function createInteractionEnvelope(): INeonDiscordSlashInteractionEnvelope {
  return {
    accountId: "default",
    guildId,
    channelId,
    interactionId: "i-1",
    commandName: "skill",
    subcommandName: "run",
    author: { id: "operator", username: "operator", displayName: "Operator" },
    options: [{ name: "query", value: "memory search" }],
    createdAt: "2026-06-02T12:00:00.000Z"
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-slash-tap-"));
}

class MemoryTapAdapter
  implements INeonDiscordTapAdapter<INeonDiscordMessageEnvelope, INeonDiscordSlashInteractionEnvelope>
{
  loginToken: string | undefined;
  interactionListenerArmed = false;
  private onInteraction:
    | ((interaction: INeonDiscordSlashInteractionEnvelope) => void | Promise<void>)
    | undefined;

  listen(
    _onMessage: (message: INeonDiscordMessageEnvelope) => void | Promise<void>,
    _onError: (error: Error) => void
  ): void {
    // Message listening is unused in these interaction-focused tests.
  }

  listenInteractions(
    onInteraction: (interaction: INeonDiscordSlashInteractionEnvelope) => void | Promise<void>
  ): void {
    this.interactionListenerArmed = true;
    this.onInteraction = onInteraction;
  }

  async login(token: string): Promise<void> {
    this.loginToken = token;
  }

  async close(): Promise<void> {
    // no-op
  }

  async emitInteraction(interaction: INeonDiscordSlashInteractionEnvelope): Promise<void> {
    await this.onInteraction?.(interaction);
  }
}
