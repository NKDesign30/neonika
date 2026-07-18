import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "src", "cli.js");

async function runCli(args: readonly string[], cwd = process.cwd()): Promise<string> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env: {
      HOME: process.env["HOME"] ?? "",
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "test"
    }
  });
  return result.stdout;
}

describe("Neonika CLI runtime entry points", () => {
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
