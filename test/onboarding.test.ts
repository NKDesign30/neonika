import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonOnboardingSnapshot,
  renderNeonOnboardingReport,
  runNeonSetup
} from "../src/index.js";

describe("Neonika Onboarding", () => {
  it("renders a no-secret config preview that is ready for Discord smoke", async () => {
    const projectRoot = await createTempProjectRoot();
    const configRoot = join(projectRoot, "user-config");
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
      await configureDiscordSetup(configRoot);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env,
        memorySearchCommandPath: memoryCommandPath,
        configRoot,
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
      assert.doesNotMatch(report, new RegExp(projectRoot));
      assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(projectRoot));
      assert.doesNotMatch(report, /super-secret-token-value/);
      assert.doesNotMatch(JSON.stringify(snapshot), /super-secret-token-value/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("shows exact recovery steps when Discord env is missing", async () => {
    const projectRoot = await createTempProjectRoot();
    const configRoot = join(projectRoot, "user-config");
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);
      await configureDiscordSetup(configRoot);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env: {},
        memorySearchCommandPath: memoryCommandPath,
        configRoot
      });
      const discord = snapshot.steps.find((step) => step.id === "discord");

      assert.equal(snapshot.state, "needs-action");
      assert.equal(snapshot.readyForDiscordSmoke, false);
      assert.equal(discord?.state, "action");
      assert.deepEqual(discord?.recovery, [
        "Set NEON_DISCORD_BOT_TOKEN.",
        "Set NEON_DISCORD_BOT_USER_ID."
      ]);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("shows op based Discord tokens as refs without leaking the reference", async () => {
    const projectRoot = await createTempProjectRoot();
    const configRoot = join(projectRoot, "user-config");
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");
    const secretRef = "op://Automation/Discord Bot Token/credential";

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);
      await configureDiscordSetup(configRoot);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env: {
          NEON_DISCORD_BOT_TOKEN: secretRef,
          NEON_DISCORD_BOT_USER_ID: "900000000000000010",
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
        },
        memorySearchCommandPath: memoryCommandPath,
        configRoot
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
    const configRoot = join(projectRoot, "user-config");
    const memoryCommandPath = join(projectRoot, "bin", "memory-search");
    // Missing the field segment — present but cannot resolve.
    const incompleteRef = "op://Automation/Discord Bot Token";

    try {
      await writePackage(projectRoot);
      await writeExecutableMarker(memoryCommandPath);
      await configureDiscordSetup(configRoot);

      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        env: {
          NEON_DISCORD_BOT_TOKEN: incompleteRef,
          NEON_DISCORD_BOT_USER_ID: "900000000000000010",
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
        },
        memorySearchCommandPath: memoryCommandPath,
        configRoot
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

  it("does not call Discord ready until the explicit owner link exists", async () => {
    const projectRoot = await createTempProjectRoot();
    const configRoot = join(projectRoot, "user-config");
    try {
      await writePackage(projectRoot);
      await runNeonSetup({
        configRoot,
        discord: {
          enabled: true,
          allowedGuilds: ["900000000000000001"],
          allowedChannels: ["900000000000000005"]
        }
      });
      const snapshot = await createNeonOnboardingSnapshot(projectRoot, {
        configRoot,
        env: {
          NEON_DISCORD_BOT_TOKEN: "placeholder-token",
          NEON_DISCORD_BOT_USER_ID: "900000000000000010",
          NEON_MEMORY_DB_PATH: join(configRoot, "memory", "semantic-memory.db")
        }
      });
      const discord = snapshot.steps.find((step) => step.id === "discord");

      assert.equal(snapshot.readyForDiscordSmoke, false);
      assert.equal(discord?.state, "action");
      assert.match(discord?.summary ?? "", /no explicit owner identity link/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("separates WhatsApp policy readiness from a verified linked-device session", async () => {
    const projectRoot = await createTempProjectRoot();
    const configRoot = join(projectRoot, "user-config");
    try {
      await writePackage(projectRoot);
      await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        whatsapp: {
          enabled: true,
          ownerPeerId: "+15551234567",
          mode: "personal"
        }
      });
      const pending = await createNeonOnboardingSnapshot(projectRoot, {
        configRoot,
        env: { NEON_MEMORY_DB_PATH: join(configRoot, "memory", "semantic-memory.db") }
      });
      const pendingStep = pending.steps.find((step) => step.id === "whatsapp");

      assert.equal(pending.readyForWhatsAppLogin, true);
      assert.equal(pending.whatsappSessionLinked, false);
      assert.equal(pendingStep?.state, "action");
      assert.match(pendingStep?.summary ?? "", /login is pending/u);

      const authPath = join(configRoot, "credentials", "whatsapp", "default");
      await chmod(authPath, 0o755);
      const unsafe = await createNeonOnboardingSnapshot(projectRoot, {
        configRoot,
        env: { NEON_MEMORY_DB_PATH: join(configRoot, "memory", "semantic-memory.db") }
      });
      const unsafeStep = unsafe.steps.find((step) => step.id === "whatsapp");
      assert.equal(unsafeStep?.state, "action");
      assert.match(unsafeStep?.summary ?? "", /unsafe or invalid/u);
      await chmod(authPath, 0o700);

      await writeFile(
        join(authPath, "session.json"),
        `${JSON.stringify({
          version: 1,
          state: "linked",
          accountId: "default",
          verifiedAt: "2026-07-18T18:00:00.000Z"
        })}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      const markerOnly = await createNeonOnboardingSnapshot(projectRoot, {
        configRoot,
        env: { NEON_MEMORY_DB_PATH: join(configRoot, "memory", "semantic-memory.db") }
      });
      assert.equal(markerOnly.whatsappSessionLinked, false);

      await writeFile(
        join(authPath, "creds.json"),
        '{"registered":false,"me":{"id":"15551234567:9@s.whatsapp.net"}}\n',
        { encoding: "utf8", mode: 0o600 }
      );
      const linked = await createNeonOnboardingSnapshot(projectRoot, {
        configRoot,
        env: { NEON_MEMORY_DB_PATH: join(configRoot, "memory", "semantic-memory.db") }
      });
      const linkedStep = linked.steps.find((step) => step.id === "whatsapp");

      assert.equal(linked.readyForWhatsAppLogin, true);
      assert.equal(linked.whatsappSessionLinked, true);
      assert.equal(linkedStep?.state, "pass");
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

async function configureDiscordSetup(configRoot: string): Promise<void> {
  await runNeonSetup({
    configRoot,
    ownerId: "owner-primary",
    discord: {
      enabled: true,
      ownerPeerId: "900000000000000010",
      allowedGuilds: ["900000000000000001"],
      allowedChannels: ["900000000000000005"]
    }
  });
}
