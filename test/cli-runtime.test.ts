import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  bootstrapNeonMemorySchema,
  createNeonMemoryBackup,
  createNeonRetireEvidenceSnapshot,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "src", "cli.js");

async function runCli(
  args: readonly string[],
  cwd = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = {}
): Promise<string> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      HOME: process.env["HOME"] ?? "",
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "test",
      ...env
    }
  });
  return result.stdout;
}

async function runCliFailure(args: readonly string[]): Promise<string> {
  try {
    await runCli(args);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
    ) {
      return error.stderr;
    }
    throw error;
  }
  throw new Error("Expected Neonika CLI command to fail");
}

describe("Neonika CLI runtime entry points", () => {
  it("exposes global help and the package version through the installed bin contract", async () => {
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8")
    ) as { readonly version?: unknown };
    const help = await runCli(["status", "--help"]);
    const version = await runCli(["--version"]);

    assert.match(help, /^Usage: neonika <command> \[options\]/u);
    assert.match(help, /neonika status/u);
    assert.match(help, /whatsapp-canary-tap/u);
    assert.match(help, /Onboard options:/u);
    assert.match(help, /--whatsapp-mode <dedicated\|personal>/u);
    assert.equal(version.trim(), manifest.version);
  });

  it("keeps global help and version available when persisted setup is malformed", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "neonika-cli-broken-setup-"));

    try {
      await mkdir(configRoot, { recursive: true });
      await writeFile(join(configRoot, "config.json"), '{"version":1,"mode":"primary"}\n', "utf8");
      const env = { NEONIKA_CONFIG_ROOT: configRoot };
      const help = await runCli(["--help"], process.cwd(), env);
      const version = await runCli(["--version"], process.cwd(), env);

      assert.match(help, /^Usage: neonika <command> \[options\]/u);
      assert.match(version, /^\d+\.\d+\.\d+\s*$/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("runs headless first-use setup through the installed CLI contract", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "neonika-cli-onboard-"));
    await rm(configRoot, { recursive: true });
    try {
      const stdout = await runCli(["onboard", "--yes", "--config-root", configRoot]);
      const config = await readFile(join(configRoot, "config.json"), "utf8");

      assert.match(stdout, /Neonika setup: created/u);
      assert.match(stdout, /Memory: ready \(local SQLite\)/u);
      assert.match(stdout, /Secrets persisted: no/u);
      assert.equal((await stat(configRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(join(configRoot, "config.json"))).mode & 0o777, 0o600);
      assert.doesNotMatch(config, /"(?:token|secret)"\s*:|op:\/\//u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("rejects unknown or incomplete onboarding options instead of silently ignoring them", async () => {
    const missingValue = await runCliFailure(["onboard", "--yes", "--whatsapp-owner"]);
    const unknownOption = await runCliFailure(["onboard", "--yes", "--whatsap"]);
    const conflictingMode = await runCliFailure(["onboard", "--yes", "--interactive"]);

    assert.match(missingValue, /--whatsapp-owner requires a value/u);
    assert.match(unknownOption, /Unknown onboard option: --whatsap/u);
    assert.match(conflictingMode, /mutually exclusive/u);
  });

  it("treats channel-specific onboarding options as an explicit channel request", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "neonika-cli-channel-flags-"));
    await rm(configRoot, { recursive: true });
    try {
      await runCli([
        "onboard",
        "--config-root",
        configRoot,
        "--discord-guilds",
        "900000000000000001",
        "--whatsapp-mode",
        "personal"
      ]);
      const config = JSON.parse(await readFile(join(configRoot, "config.json"), "utf8")) as {
        readonly channels?: {
          readonly discord?: { readonly enabled?: unknown };
          readonly whatsapp?: { readonly enabled?: unknown; readonly mode?: unknown };
        };
      };

      assert.equal(config.channels?.discord?.enabled, true);
      assert.equal(config.channels?.whatsapp?.enabled, true);
      assert.equal(config.channels?.whatsapp?.mode, "personal");
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("runs mission-control-filter-smoke with flags through the real top-level dispatch", async () => {
    const stdout = await runCli(["mission-control-filter-smoke", "--status", "done"]);

    assert.match(stdout, /Neonika Mission-Control Filter/);
    assert.match(stdout, /Criteria: status=done/);
    assert.match(stdout, /Visible: 5\/5/);
    assert.doesNotMatch(stdout, /ReferenceError/);
  });

  it("runs the portable runtime-service lifecycle through the real top-level dispatch", async () => {
    const stdout = await runCli(["runtime-service-smoke"]);

    assert.match(stdout, /^Neonika Runtime Service Smoke: ok$/mu);
    assert.match(stdout, /Lifecycle: install -> update -> status -> restart -> rollback -> uninstall/u);
    assert.match(stdout, /Secrets persisted: false/u);
    assert.match(stdout, /Shell used: false/u);
    assert.doesNotMatch(stdout, /(?:TOKEN|SECRET)=/u);
  });

  it("records Retire evidence under the explicit runtime config root, independent of cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-cli-retire-root-"));
    const configRoot = join(root, "config");
    const unrelatedCwd = join(root, "unrelated");

    try {
      await mkdir(configRoot, { mode: 0o700, recursive: true });
      await mkdir(unrelatedCwd, { mode: 0o700, recursive: true });
      await writeNeonGatewayRun(configRoot, createCliRetireRun());

      const stdout = await runCli(
        ["cutover-retire-smoke", "--config-root", configRoot],
        unrelatedCwd
      );

      assert.match(stdout, /Neonika Retire Export\/Import: ok/u);
      assert.equal((await createNeonRetireEvidenceSnapshot(configRoot)).state, "ready");
      assert.equal((await createNeonRetireEvidenceSnapshot(unrelatedCwd)).state, "needs-evidence");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the supervised runtime on its configured port instead of falling back", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-cli-runtime-service-port-"));
    const envFilePath = join(root, "runtime.env");
    const server = createServer((_request, response) => response.end("occupied"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("runtime-service port test did not expose a TCP port");
      }
      await writeFile(
        envFilePath,
        `NEONIKA_HOST=127.0.0.1\nNEONIKA_PORT=${address.port}\n`,
        { mode: 0o600 }
      );
      const stderr = await runCliFailure([
        "runtime-service-run",
        "--config-root",
        root,
        "--env-file",
        envFilePath
      ]);

      assert.match(stderr, /EADDRINUSE|address already in use/u);
      assert.doesNotMatch(stderr, /Mission Control server: ready/u);
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      await rm(root, { force: true, recursive: true });
    }
  });

  it("runs context-pack with a channel argument through the real top-level dispatch", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-cli-runtime-"));

    try {
      const stdout = await runCli(["context-pack", "chaty", "discord", "memory"], projectRoot);

      assert.match(stdout, /Neonika Context Pack/);
      assert.match(stdout, /Agent: chaty .* channel: discord/);
      assert.doesNotMatch(stdout, /ReferenceError/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("validates the productive live-index target without echoing private paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-cli-writeback-check-"));
    const dbPath = join(root, "semantic-memory.db");
    const backupDir = join(root, "backups");

    try {
      seedMemoryDb(dbPath, ["seed"]);
      await chmod(dbPath, 0o600);
      const stdout = await runCli(["live-index-production-check"], process.cwd(), {
        NEON_LIVE_INDEX_DAEMON_ENABLED: "ready",
        NEON_MEMORY_WRITE_ENABLED: "ready",
        NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready",
        NEON_MEMORY_DB_PATH: dbPath,
        NEON_LIVE_INDEX_MEMORY_DB_PATH: dbPath,
        NEON_MEMORY_BACKUP_DIR: backupDir
      });

      assert.match(stdout, /Neonika Live Index Production: ready/u);
      assert.match(stdout, /Target: validated \(validated-primary\)/u);
      assert.match(stdout, /Pre-write backup directory: configured/u);
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(root), "u"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses persisted onboarding paths for an upgraded productive install", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "neonika-cli-writeback-upgrade-"));
    await rm(configRoot, { recursive: true, force: true });

    try {
      await runCli(["onboard", "--yes", "--config-root", configRoot]);
      const stdout = await runCli(
        ["live-index-production-check", "--config-root", configRoot],
        configRoot,
        {
          NEON_LIVE_INDEX_DAEMON_ENABLED: "ready",
          NEON_MEMORY_WRITE_ENABLED: "ready",
          NEON_LIVE_INDEX_WRITEBACK_ENABLED: "ready"
        }
      );

      assert.match(stdout, /Neonika Live Index Production: ready/u);
      assert.match(stdout, /Target: validated \(validated-primary\)/u);
      assert.match(stdout, /Pre-write backup directory: configured/u);
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(configRoot), "u"));
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  });

  it("restores a verified memory snapshot through the real CLI command", async () => {
    const root = await mkdtemp(join(tmpdir(), "neonika-cli-writeback-rollback-"));
    const dbPath = join(root, "semantic-memory.db");
    const backupDir = join(root, "backups");

    try {
      seedMemoryDb(dbPath, ["before"]);
      await chmod(dbPath, 0o600);
      const backup = await createNeonMemoryBackup({
        dbPath,
        backupDir,
        stamp: "cli-rollback-source"
      });
      assert.ok(backup.snapshotId);
      insertMemoryRow(dbPath, "after");
      assert.equal(countMemoryRows(dbPath), 2);

      const stdout = await runCli(
        ["memory-writeback-rollback", backup.snapshotId],
        process.cwd(),
        {
          NEON_MEMORY_ROLLBACK_ENABLED: "ready",
          NEON_MEMORY_DB_PATH: dbPath,
          NEON_LIVE_INDEX_MEMORY_DB_PATH: dbPath,
          NEON_MEMORY_BACKUP_DIR: backupDir
        }
      );

      assert.match(stdout, /Neonika Memory Rollback: restored/u);
      assert.match(stdout, /Verification: verified/u);
      assert.match(stdout, /Recovery attempts: 0\/1/u);
      assert.equal(countMemoryRows(dbPath), 1);
      assert.doesNotMatch(stdout, new RegExp(escapeRegExp(root), "u"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs run-lifecycle-harness-smoke through the real top-level dispatch", async () => {
    const stdout = await runCli(["run-lifecycle-harness-smoke"]);

    assert.match(stdout, /Neon run lifecycle harness smoke: ok/);
    assert.match(stdout, /Stop decision: interrupt-ready/);
    assert.match(stdout, /Client interrupts: 1/);
    assert.match(stdout, /Final active runs: 0/);
    assert.doesNotMatch(stdout, /ReferenceError/);
  });

  it("keeps run-lifecycle-codex-live-smoke opt-in by default", async () => {
    const stdout = await runCli(["run-lifecycle-codex-live-smoke"]);

    assert.match(stdout, /Neon run lifecycle codex live smoke: not-run/);
    assert.match(stdout, /NEON_RUN_LIFECYCLE_CODEX_LIVE_SMOKE=ready/);
    assert.doesNotMatch(stdout, /ReferenceError/);
  });

  it("keeps discord-ingress-codex-live-smoke opt-in by default", async () => {
    const stdout = await runCli(["discord-ingress-codex-live-smoke"]);

    assert.match(stdout, /Neonika Discord ingress codex live smoke: not-run/);
    assert.match(stdout, /NEON_DISCORD_INGRESS_CODEX_LIVE_SMOKE=ready/);
    assert.doesNotMatch(stdout, /ReferenceError/);
  });

  it("keeps discord-ingress-control-live-smoke opt-in by default", async () => {
    const stdout = await runCli(["discord-ingress-control-live-smoke"]);

    assert.match(stdout, /Neonika Discord ingress control live smoke: not-run/);
    assert.match(stdout, /NEON_DISCORD_INGRESS_CONTROL_LIVE_SMOKE=ready/);
    assert.doesNotMatch(stdout, /ReferenceError/);
  });

  it("keeps discord-tap-canary-reply-live-smoke opt-in by default", async () => {
    const stdout = await runCli(["discord-tap-canary-reply-live-smoke"]);

    assert.match(stdout, /Neonika Discord tap canary reply live smoke: not-run/);
    assert.match(stdout, /NEON_DISCORD_TAP_CANARY_REPLY_LIVE_SMOKE=ready/);
    assert.doesNotMatch(stdout, /ReferenceError/);
  });

});

function seedMemoryDb(dbPath: string, values: readonly string[]): void {
  const database = new DatabaseSync(dbPath);
  try {
    bootstrapNeonMemorySchema(database);
    const insert = database.prepare(
      "INSERT INTO memory_entries (source_file, content, agent, category, content_hash) VALUES (?, ?, ?, ?, ?)"
    );
    for (const value of values) {
      insert.run(`${value}.md`, `Memory row ${value}`, "neo", "learnings", `hash-${value}`);
    }
  } finally {
    database.close();
  }
}

function createCliRetireRun(): INeonGatewayShadowRun {
  return {
    runId: "cli-retire-proof",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "cli",
      accountId: "default",
      channelId: "local",
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neonika",
      mode: "read-only",
      contentPreview: "Retire proof",
      receivedAt: "2026-08-11T20:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "cli-retire-proof",
    memoryState: "attached",
    events: [{ kind: "final", text: "ok" }],
    finalText: "ok",
    delivery: {
      state: "suppressed",
      targetChannel: "cli",
      targetChannelId: "local",
      reason: "shadow-mode",
      finalText: "ok"
    },
    startedAt: "2026-08-11T20:00:00.000Z",
    completedAt: "2026-08-11T20:00:01.000Z"
  };
}

function insertMemoryRow(dbPath: string, value: string): void {
  const database = new DatabaseSync(dbPath);
  try {
    database
      .prepare(
        "INSERT INTO memory_entries (source_file, content, agent, category, content_hash) VALUES (?, ?, ?, ?, ?)"
      )
      .run(`${value}.md`, `Memory row ${value}`, "neo", "learnings", `hash-${value}`);
  } finally {
    database.close();
  }
}

function countMemoryRows(dbPath: string): number {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
      readonly count: number;
    };
    return row.count;
  } finally {
    database.close();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
