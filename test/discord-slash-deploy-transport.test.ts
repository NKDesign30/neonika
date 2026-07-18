import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import {
  buildNeonSlashCommandPayload,
  createNeonDiscordOperatorSlashCommands,
  createNeonDiscordSlashDeployTransport,
  NEON_DISCORD_SLASH_LIMITS,
  type INeonSlashCommand
} from "../src/index.js";

describe("buildNeonSlashCommandPayload (Z476)", () => {
  it("builds a valid command set", () => {
    const result = buildNeonSlashCommandPayload([
      { name: "ping", description: "liveness check" },
      { name: "neon-status", description: "show status" }
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.commands.length, 2);
      assert.equal(result.commands[0]?.name, "ping");
    }
  });

  it("builds the Discord operator command set with Workboard task options", () => {
    const result = buildNeonSlashCommandPayload(createNeonDiscordOperatorSlashCommands());

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.commands.map((command) => command.name),
        ["workboard", "task", "todo", "neon-canary-ping"]
      );
      const workboard = result.commands.find((command) => command.name === "workboard");
      assert.equal(workboard?.options?.[0]?.name, "task");
      assert.equal(workboard?.options?.[0]?.type, 3);
      assert.equal(workboard?.options?.[0]?.required, true);
    }
  });

  it("rejects an empty set, bad names, bad descriptions, and duplicates", () => {
    assert.equal(buildNeonSlashCommandPayload([]).ok, false);
    // Uppercase name.
    assert.equal(buildNeonSlashCommandPayload([{ name: "Ping", description: "x" }]).ok, false);
    // Illegal character.
    assert.equal(buildNeonSlashCommandPayload([{ name: "pi ng", description: "x" }]).ok, false);
    // Over-long name.
    const longName = "x".repeat(NEON_DISCORD_SLASH_LIMITS.commandName + 1);
    assert.equal(buildNeonSlashCommandPayload([{ name: longName, description: "x" }]).ok, false);
    // Empty description.
    assert.equal(buildNeonSlashCommandPayload([{ name: "ping", description: "   " }]).ok, false);
    // Over-long description.
    const longDesc = "x".repeat(NEON_DISCORD_SLASH_LIMITS.commandDescription + 1);
    assert.equal(buildNeonSlashCommandPayload([{ name: "ping", description: longDesc }]).ok, false);
    // Duplicate names.
    assert.equal(
      buildNeonSlashCommandPayload([
        { name: "ping", description: "a" },
        { name: "ping", description: "b" }
      ]).ok,
      false
    );
    assert.equal(
      buildNeonSlashCommandPayload([
        { name: "ping", description: "a", options: [{ name: "Bad", description: "x", type: "string" }] }
      ]).ok,
      false
    );
  });

  it("rejects more than the per-guild command cap", () => {
    const tooMany: INeonSlashCommand[] = Array.from(
      { length: NEON_DISCORD_SLASH_LIMITS.maxCommands + 1 },
      (_unused, index) => ({ name: `cmd${index}`, description: "x" })
    );
    assert.equal(buildNeonSlashCommandPayload(tooMany).ok, false);
  });
});

interface IFakeDeployState {
  loginCount: number;
  deploys: { readonly guildId?: string; readonly count: number }[];
  destroyCount: number;
}

function createFakeDeployClient(): { readonly client: Client; readonly state: IFakeDeployState } {
  const state: IFakeDeployState = { loginCount: 0, deploys: [], destroyCount: 0 };
  const fake = {
    login: async (token: string) => {
      state.loginCount += 1;
      return token;
    },
    isReady: () => true,
    application: {
      commands: {
        set: async (commands: readonly unknown[], guildId?: string) => {
          state.deploys.push({
            ...(guildId !== undefined ? { guildId } : {}),
            count: commands.length
          });
          return {};
        }
      }
    },
    destroy: async () => {
      state.destroyCount += 1;
    }
  };
  return { client: fake as unknown as Client, state };
}

describe("createNeonDiscordSlashDeployTransport (Z476, gated)", () => {
  it("logs in and bulk-overwrites guild commands, returning the deployed count", async () => {
    const { client, state } = createFakeDeployClient();
    const transport = createNeonDiscordSlashDeployTransport({ token: "tok", createClient: () => client });
    const result = await transport.deployGuildCommands("guild-1", [
      { name: "ping", description: "liveness" }
    ]);
    assert.equal(result.deployedCount, 1);
    assert.equal(state.loginCount, 1);
    assert.equal(state.deploys.length, 1);
    assert.equal(state.deploys[0]?.guildId, "guild-1");
    assert.equal(state.deploys[0]?.count, 1);
    await transport.close();
    assert.equal(state.destroyCount, 1);
  });

  it("refuses an empty guild id (no global deploy) BEFORE login", async () => {
    const { client, state } = createFakeDeployClient();
    const transport = createNeonDiscordSlashDeployTransport({ token: "tok", createClient: () => client });
    await assert.rejects(
      () => transport.deployGuildCommands("   ", [{ name: "ping", description: "x" }]),
      /without a guild id/i
    );
    assert.equal(state.loginCount, 0);
    assert.equal(state.deploys.length, 0);
    await transport.close();
  });

  it("rejects an invalid command set BEFORE login, so nothing deploys", async () => {
    const { client, state } = createFakeDeployClient();
    const transport = createNeonDiscordSlashDeployTransport({ token: "tok", createClient: () => client });
    await assert.rejects(
      () => transport.deployGuildCommands("guild-1", [{ name: "BAD NAME", description: "x" }]),
      /invalid slash command/i
    );
    assert.equal(state.loginCount, 0);
    assert.equal(state.deploys.length, 0);
    await transport.close();
  });
});
