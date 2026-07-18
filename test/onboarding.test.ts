import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonOnboardingSnapshot,
  renderNeonOnboardingReport
} from "../src/index.js";

describe("Neonika Onboarding", () => {
  it("renders a no-secret config preview that is ready for Discord smoke", async () => {
    const projectRoot = await createTempProjectRoot();
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");
    const env = {
      NEON_DISCORD_BOT_TOKEN: "super-secret-token-value",
      NEON_DISCORD_BOT_USER_ID: "900000000000000010",
      NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
      NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
    };

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env,
        memorySearchCommandPath: memoryCommandPath,
        now: () => new Date("2026-05-31T20:00:00.000Z")
      });
      const report = renderNeonOnboardingReport(snapshot);

      assert.equal(snapshot.state, "ready-for-discord-smoke");
      assert.equal(snapshot.readyForDiscordSmoke, true);
      assert.equal(snapshot.configPreview.secretsPrinted, false);
      assert.ok(
        snapshot.configPreview.env.some(
          (entry) => entry.name === "NEON_DISCORD_BOT_TOKEN" && entry.status === "value"
        )
      );
      assert.ok(snapshot.steps.some((step) => step.id === "discord" && step.state === "pass"));
      assert.match(report, /Ready for Discord smoke: yes/);
      assert.doesNotMatch(report, /super-secret-token-value/);
      assert.doesNotMatch(JSON.stringify(snapshot), /super-secret-token-value/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("shows exact recovery steps when Discord env is missing", async () => {
    const projectRoot = await createTempProjectRoot();
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env: {},
        memorySearchCommandPath: memoryCommandPath
      });
      const discord = snapshot.steps.find((step) => step.id === "discord");

      assert.equal(snapshot.state, "needs-action");
      assert.equal(snapshot.readyForDiscordSmoke, false);
      assert.equal(discord?.state, "action");
      assert.deepEqual(discord?.recovery, [
        "Set NEON_DISCORD_BOT_TOKEN.",
        "Set NEON_DISCORD_BOT_USER_ID.",
        "Set NEON_DISCORD_ALLOWED_GUILDS.",
        "Set NEON_DISCORD_ALLOWED_CHANNELS."
      ]);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("shows op based Discord tokens as refs without leaking the reference", async () => {
    const projectRoot = await createTempProjectRoot();
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");
    const secretRef = "op://Automation/Discord Bot Token/credential";

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env: {
          NEON_DISCORD_BOT_TOKEN: secretRef,
          NEON_DISCORD_BOT_USER_ID: "900000000000000010",
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
        },
        memorySearchCommandPath: memoryCommandPath
      });
      const report = renderNeonOnboardingReport(snapshot);
      const tokenPreview = snapshot.configPreview.env.find((entry) => entry.name === "NEON_DISCORD_BOT_TOKEN");

      assert.equal(snapshot.readyForDiscordSmoke, true);
      assert.equal(tokenPreview?.present, true);
      assert.equal(tokenPreview?.status, "ref");
      // A valid ref whose item name contains spaces still resolves structurally.
      assert.equal(tokenPreview?.reachability, "resolvable");
      assert.match(report, /NEON_DISCORD_BOT_TOKEN: ref/);
      assert.doesNotMatch(report, /op:\/\//);
      assert.doesNotMatch(JSON.stringify(snapshot), /Discord Bot Token/);
      assert.doesNotMatch(JSON.stringify(snapshot), /credential/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("flags a structurally incomplete op:// Discord token without leaking the reference", async () => {
    const projectRoot = await createTempProjectRoot();
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");
    // Missing the field segment — present but cannot resolve.
    const incompleteRef = "op://Automation/Discord Bot Token";

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env: {
          NEON_DISCORD_BOT_TOKEN: incompleteRef,
          NEON_DISCORD_BOT_USER_ID: "900000000000000010",
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
        },
        memorySearchCommandPath: memoryCommandPath
      });
      const tokenPreview = snapshot.configPreview.env.find(
        (entry) => entry.name === "NEON_DISCORD_BOT_TOKEN"
      );
      const discord = snapshot.steps.find((step) => step.id === "discord");

      assert.equal(tokenPreview?.present, true);
      assert.equal(tokenPreview?.status, "ref");
      assert.equal(tokenPreview?.reachability, "incomplete");
      assert.equal(snapshot.readyForDiscordSmoke, false);
      assert.equal(discord?.state, "action");
      assert.match(discord?.summary ?? "", /cannot resolve \(incomplete op:\/\/ shape\)/);
      assert.ok(discord?.recovery.some((line) => line.includes("NEON_DISCORD_BOT_TOKEN")));
      // Leak-safe: the vault/item identifiers never appear in the snapshot.
      assert.doesNotMatch(JSON.stringify(snapshot), /Discord Bot Token/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function writePackage(projectRoot: string): Promise<void> {
  await writeFile(
    join(projectRoot, "package.json"),
    JSON.stringify({
      name: "neonika-test",
      private: true
    }),
    "utf8"
  );
}

async function writeExecutableMarker(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\n", "utf8");
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-onboarding-"));
}
