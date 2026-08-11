import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  applyNeonSetupEnvironment,
  readNeonSetupConfig,
  renderNeonSetupReport,
  resolveNeonSetupPaths,
  runNeonSetup
} from "../src/index.js";

describe("Neonika fresh-install setup", () => {
  it("creates private config, local memory, and one explicit cross-channel owner", async () => {
    const configRoot = join(tmpdir(), `neonika-setup-${process.pid}-${Date.now()}`);
    const fakeSecret = "setup-secret-must-never-persist";
    const now = "2026-07-18T16:00:00.000Z";

    try {
      const result = await runNeonSetup({
        configRoot,
        env: { NEON_DISCORD_BOT_TOKEN: fakeSecret },
        ownerId: "owner-primary",
        displayName: "Neon Operator",
        discord: {
          enabled: true,
          ownerPeerId: "900000000000000010",
          allowedGuilds: ["900000000000000001"],
          allowedChannels: ["900000000000000005"]
        },
        whatsapp: {
          enabled: true,
          ownerPeerId: "+15551234567",
          mode: "personal"
        },
        now: () => new Date(now),
        createId: () => "unused-id"
      });
      const configText = await readFile(result.paths.configPath, "utf8");
      const report = renderNeonSetupReport(result);
      const runtimeEnv: Record<string, string | undefined> = {
        NEON_DISCORD_BOT_TOKEN: fakeSecret
      };
      const environment = applyNeonSetupEnvironment(result.config, result.paths, runtimeEnv);
      const database = new DatabaseSync(result.paths.memoryDbPath, { readOnly: true });
      const tableNames = database
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
        .all()
        .map((row) => (row as { readonly name: string }).name);
      database.close();

      assert.equal(result.state, "created");
      assert.equal(result.secretsPersisted, false);
      assert.equal(result.config.mode, "shadow");
      assert.equal(result.config.security.outbound, "suppressed");
      assert.equal(result.config.channels.discord.role, "hub");
      assert.equal(result.config.channels.whatsapp.role, "companion");
      assert.equal(result.config.channels.whatsapp.groupPolicy, "disabled");
      assert.equal(result.config.channels.whatsapp.selfChatMode, true);
      assert.ok(environment.applied.includes("NEON_MEMORY_DB_PATH"));
      assert.equal(runtimeEnv["NEON_MEMORY_DB_PATH"], result.paths.memoryDbPath);
      assert.ok(environment.applied.includes("NEON_LIVE_INDEX_MEMORY_DB_PATH"));
      assert.equal(runtimeEnv["NEON_LIVE_INDEX_MEMORY_DB_PATH"], result.paths.memoryDbPath);
      assert.ok(environment.applied.includes("NEON_MEMORY_BACKUP_DIR"));
      assert.equal(
        runtimeEnv["NEON_MEMORY_BACKUP_DIR"],
        join(result.paths.configRoot, "memory", "backups")
      );
      assert.equal(runtimeEnv["NEON_DISCORD_BOT_TOKEN"], fakeSecret);
      assert.deepEqual(
        result.config.identity.links.map((link) => link.channel),
        ["discord", "whatsapp"]
      );
      assert.equal(new Set(result.config.identity.links.map(() => result.config.identity.ownerId)).size, 1);
      assert.ok(tableNames.includes("memory_entries"));
      assert.ok(tableNames.includes("memory_fts"));
      assert.equal((await stat(configRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(result.paths.configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(result.paths.memoryDbPath)).mode & 0o777, 0o600);
      assert.doesNotMatch(configText, /setup-secret-must-never-persist/u);
      assert.doesNotMatch(configText, /op:\/\//u);
      assert.doesNotMatch(report, /900000000000000010/u);
      assert.doesNotMatch(report, /15551234567/u);
      assert.doesNotMatch(report, /setup-secret-must-never-persist/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("reuses an unchanged setup and preserves its identity and timestamps", async () => {
    const configRoot = join(tmpdir(), `neonika-setup-idempotent-${process.pid}-${Date.now()}`);
    try {
      const first = await runNeonSetup({
        configRoot,
        displayName: "Operator",
        now: () => new Date("2026-07-18T16:00:00.000Z"),
        createId: () => "stable-owner"
      });
      const second = await runNeonSetup({
        configRoot,
        now: () => new Date("2026-07-18T17:00:00.000Z"),
        createId: () => "must-not-replace"
      });

      assert.equal(first.state, "created");
      assert.equal(second.state, "existing");
      assert.equal(second.config.identity.ownerId, "stable-owner");
      assert.equal(second.config.createdAt, first.config.createdAt);
      assert.equal(second.config.updatedAt, first.config.updatedAt);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("updates one channel without losing the existing owner", async () => {
    const configRoot = join(tmpdir(), `neonika-setup-update-${process.pid}-${Date.now()}`);
    try {
      await runNeonSetup({
        configRoot,
        ownerId: "stable-owner",
        displayName: "Operator",
        now: () => new Date("2026-07-18T16:00:00.000Z")
      });
      const updated = await runNeonSetup({
        configRoot,
        discord: {
          enabled: true,
          ownerPeerId: "900000000000000010",
          allowedGuilds: ["900000000000000001"],
          allowedChannels: ["900000000000000005"]
        },
        now: () => new Date("2026-07-18T17:00:00.000Z")
      });
      const persisted = await readNeonSetupConfig(configRoot);

      assert.equal(updated.state, "updated");
      assert.equal(updated.config.identity.ownerId, "stable-owner");
      assert.equal(updated.config.channels.discord.enabled, true);
      assert.equal(updated.config.identity.links.length, 1);
      assert.equal(persisted?.updatedAt, "2026-07-18T17:00:00.000Z");
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("fails closed on an unsafe or malformed persisted config", async () => {
    const configRoot = join(tmpdir(), `neonika-setup-invalid-${process.pid}-${Date.now()}`);
    const paths = resolveNeonSetupPaths(configRoot);
    try {
      await runNeonSetup({ configRoot, createId: () => "owner" });
      const parsed = JSON.parse(await readFile(paths.configPath, "utf8")) as Record<string, unknown>;
      parsed["mode"] = "primary";
      await writeFile(paths.configPath, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600 });

      await assert.rejects(() => readNeonSetupConfig(configRoot), /safe onboarding contract/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("rejects unsupported persisted fields instead of accepting secret material", async () => {
    const configRoot = join(tmpdir(), `neonika-setup-extra-field-${process.pid}-${Date.now()}`);
    try {
      const result = await runNeonSetup({ configRoot, createId: () => "owner" });
      const parsed = JSON.parse(await readFile(result.paths.configPath, "utf8")) as Record<string, unknown>;
      parsed["token"] = "must-not-be-accepted";
      await writeFile(result.paths.configPath, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600 });

      await assert.rejects(() => readNeonSetupConfig(configRoot), /unsupported fields/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("fails closed when private setup permissions drift", async () => {
    const configRoot = join(tmpdir(), `neonika-setup-permissions-${process.pid}-${Date.now()}`);
    try {
      const result = await runNeonSetup({ configRoot, createId: () => "owner" });
      await chmod(result.paths.configPath, 0o644);
      await assert.rejects(() => readNeonSetupConfig(configRoot), /permissions must be 0600/u);

      await chmod(result.paths.configPath, 0o600);
      await chmod(configRoot, 0o755);
      await assert.rejects(() => readNeonSetupConfig(configRoot), /permissions must be 0700/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked setup root before creating config or memory", async () => {
    const parent = join(tmpdir(), `neonika-setup-symlink-${process.pid}-${Date.now()}`);
    const target = join(parent, "target");
    const configRoot = join(parent, "linked-root");
    try {
      await mkdir(target, { recursive: true });
      await symlink(target, configRoot, "dir");

      await assert.rejects(() => runNeonSetup({ configRoot }), /real directory/u);
      await assert.rejects(() => readNeonSetupConfig(configRoot), /real directory/u);
      await assert.rejects(() => stat(join(target, "config.json")), /ENOENT/u);
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
