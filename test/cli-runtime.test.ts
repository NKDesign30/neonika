import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

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
