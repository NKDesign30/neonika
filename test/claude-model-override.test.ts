import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNeonClaudeCliProcessRunner,
  neonClaudeModelEnvKey,
  resolveClaudeModelArg
} from "../src/index.js";

// The Claude head pins each tier to a concrete model id. Those ids age as new
// models ship, so the pin is overridable per tier. These tests hold two lines:
// an absent or malformed override never moves the spawn off today's default,
// and a stated override actually reaches argv (not merely the resolver).

const SONNET_DEFAULT = "claude-sonnet-4-6";
const HAIKU_DEFAULT = "claude-haiku-4-5";

describe("Claude model override seam", () => {
  it("falls back to the shipped defaults when nothing is stated", () => {
    assert.equal(resolveClaudeModelArg("sonnet", {}), SONNET_DEFAULT);
    assert.equal(resolveClaudeModelArg("haiku", {}), HAIKU_DEFAULT);
  });

  it("uses a stated override per tier, leaving the other tier alone", () => {
    const env = { NEON_CLAUDE_MODEL_SONNET: "claude-sonnet-5" };
    assert.equal(resolveClaudeModelArg("sonnet", env), "claude-sonnet-5");
    assert.equal(resolveClaudeModelArg("haiku", env), HAIKU_DEFAULT);
  });

  it("derives the env key from the tier", () => {
    assert.equal(neonClaudeModelEnvKey("sonnet"), "NEON_CLAUDE_MODEL_SONNET");
    assert.equal(neonClaudeModelEnvKey("haiku"), "NEON_CLAUDE_MODEL_HAIKU");
  });

  it("trims surrounding whitespace rather than passing it through", () => {
    const env = { NEON_CLAUDE_MODEL_HAIKU: "  claude-haiku-5  " };
    assert.equal(resolveClaudeModelArg("haiku", env), "claude-haiku-5");
  });

  // The resolved value is spliced straight into argv. A value that could read as
  // a further flag, or that smuggles a second whitespace-separated argument, is
  // refused in favour of the default — a typo must degrade, never inject.
  it("refuses a malformed override instead of passing it to argv", () => {
    const malformed = [
      "--dangerously-skip-permissions",
      "-p",
      "claude-sonnet-5 --print",
      "",
      "   ",
      "model;rm -rf /"
    ];
    for (const value of malformed) {
      assert.equal(
        resolveClaudeModelArg("sonnet", { NEON_CLAUDE_MODEL_SONNET: value }),
        SONNET_DEFAULT,
        `expected the default for a malformed override: ${JSON.stringify(value)}`
      );
    }
  });

  // Live proof, not a resolver assertion: a stub `claude` on PATH echoes the argv
  // it was spawned with, so this fails if the runner stops threading the override
  // through to the real process boundary.
  it("passes the override through to the spawned process argv", async () => {
    const stubDir = mkdtempSync(join(tmpdir(), "neon-claude-stub-"));
    try {
      const stub = join(stubDir, "claude");
      writeFileSync(stub, '#!/bin/sh\ncat >/dev/null\necho "$@"\n', "utf8");
      chmodSync(stub, 0o755);

      const previousPath = process.env["PATH"];
      process.env["PATH"] = `${stubDir}:${previousPath ?? ""}`;
      try {
        const overridden = createNeonClaudeCliProcessRunner({
          env: { NEON_CLAUDE_MODEL_SONNET: "claude-sonnet-5" }
        });
        const result = await overridden.run({ prompt: "ping", model: "sonnet" });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.trim(), "-p --model claude-sonnet-5");

        const plain = createNeonClaudeCliProcessRunner({ env: {} });
        const fallback = await plain.run({ prompt: "ping", model: "sonnet" });
        assert.equal(fallback.stdout.trim(), `-p --model ${SONNET_DEFAULT}`);
      } finally {
        if (previousPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = previousPath;
        }
      }
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });
});
