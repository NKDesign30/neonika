import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  deriveCodexSessionKey,
  hashWorkspace,
  redactText,
  type ICodexSessionBinding
} from "../src/index.js";

const baseBinding: ICodexSessionBinding = {
  channel: "discord",
  accountId: "default",
  guildId: "900000000000000001",
  channelId: "900000000000000005",
  threadId: "main",
  agentId: "chaty",
  workspaceRoot: "/Users/operator/neon-projects/neonika",
  mode: "read-only"
};

describe("Neon Codex Harness foundation", () => {
  it("derives stable session keys without leaking the workspace path", () => {
    const key = deriveCodexSessionKey(baseBinding);

    assert.equal(key, deriveCodexSessionKey(baseBinding));
    assert.match(key, /^neon:codex:chaty:discord:default:/);
    assert.doesNotMatch(key, /Users/);
    assert.match(key, new RegExp(hashWorkspace(baseBinding.workspaceRoot)));
  });

  it("separates write sessions from read-only sessions", () => {
    const readOnlyKey = deriveCodexSessionKey(baseBinding);
    const writeKey = deriveCodexSessionKey({
      ...baseBinding,
      mode: "write"
    });

    assert.notEqual(readOnlyKey, writeKey);
    assert.match(writeKey, /:write$/);
  });

  it("redacts known secret shapes", () => {
    const bearerToken = "abcDEF0123456789._-+=AA=";
    const awsAccessKeyId = "AKIA1234567890ABCDEF";
    const redacted = redactText(
      `OPENAI_API_KEY=sk-testsecretsecretsecret DISCORD_TOKEN=MTFakeDiscordTokenValueFake.fake.fakeTokenValue Authorization: Bearer ${bearerToken} AWS_ACCESS_KEY_ID=${awsAccessKeyId} op://Automation/Secret/credential Item \`nmsqt7xclpl5pxd7sjjd2modqq\``
    );
    const vaultRedacted = redactText("Vault `Automation`");

    assert.doesNotMatch(redacted, /sk-testsecret/);
    assert.doesNotMatch(redacted, /MTFakeDiscord/);
    assert.doesNotMatch(redacted, new RegExp(bearerToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(redacted, new RegExp(awsAccessKeyId));
    assert.doesNotMatch(redacted, /op:\/\/Automation/);
    assert.doesNotMatch(redacted, /nmsqt7xclpl5pxd7sjjd2modqq/);
    assert.doesNotMatch(vaultRedacted, /Automation/);
    assert.match(redacted, /\[REDACTED\]/);
  });

  it("runs a dry harness turn with session and memory metadata", async () => {
    const harness = createDryRunHarness();
    const result = await harness.run({
      prompt: "Build a smoke result",
      binding: baseBinding,
      memory: {
        state: "attached",
        hitCount: 2,
        note: "targeted memory hits"
      }
    });

    assert.equal(harness.id, "codex-app-server");
    assert.equal(result.memoryState, "attached");
    assert.match(result.sessionKey, /^neon:codex:/);
    assert.equal(result.events.length, 4);
    assert.match(result.finalText, /Harness ready/);
  });
});
