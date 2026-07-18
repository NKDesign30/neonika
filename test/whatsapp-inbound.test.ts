import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  decideNeonWhatsAppInbound,
  deriveCodexSessionKey,
  resolveGatewayStatePaths,
  resolveNeonCanonicalPeer,
  runNeonSetup,
  runNeonWhatsAppShadowIngress,
  type INeonMemoryProvider
} from "../src/index.js";

describe("Neonika WhatsApp shadow ingress", () => {
  it("accepts only the configured owner direction and rejects groups, history, and unknown peers", async () => {
    const configRoot = join(tmpdir(), `neonika-wa-policy-${process.pid}-${Date.now()}`);
    const ownerPeer = "+15551234567";
    const ownerJid = `${ownerPeer.slice(1)}@s.whatsapp.net`;
    const unknownPeer = "+15557654321";
    const unknownJid = `${unknownPeer.slice(1)}@s.whatsapp.net`;
    const groupJid = `${"9".repeat(18)}@g.us`;
    try {
      const { config } = await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: ownerPeer, mode: "personal" }
      });
      const accepted = decideNeonWhatsAppInbound(
        upsert(ownerJid, true, "wa-message-1", "memory check"),
        config,
        () => new Date("2026-07-18T18:00:00.000Z")
      );
      const wrongDirection = decideNeonWhatsAppInbound(
        upsert(ownerJid, false, "wa-message-2", "ignored"),
        config
      );
      const unknown = decideNeonWhatsAppInbound(
        upsert(unknownJid, true, "wa-message-3", "ignored"),
        config
      );
      const group = decideNeonWhatsAppInbound(
        upsert(groupJid, true, "wa-message-4", "ignored"),
        config
      );
      const disguisedGroup = decideNeonWhatsAppInbound(
        upsert(
          groupJid,
          true,
          "wa-message-4b",
          "ignored",
          ownerJid
        ),
        config
      );
      const missingTimestampFixture = upsert(
        ownerJid,
        true,
        "wa-message-4c",
        "ignored"
      );
      const missingTimestamp = decideNeonWhatsAppInbound(
        {
          ...missingTimestampFixture,
          messages: (missingTimestampFixture["messages"] as readonly Record<string, unknown>[]).map(
            ({ messageTimestamp: _messageTimestamp, ...message }) => message
          )
        },
        config
      );
      const history = decideNeonWhatsAppInbound(
        { ...upsert(ownerJid, true, "x", "x"), type: "append" },
        config
      );

      assert.equal(accepted[0]?.state, "accepted");
      assert.equal(wrongDirection[0]?.state, "dropped");
      assert.equal(wrongDirection[0]?.state === "dropped" ? wrongDirection[0].reason : "", "direction-not-allowed");
      assert.equal(unknown[0]?.state === "dropped" ? unknown[0].reason : "", "owner-not-allowed");
      assert.equal(group[0]?.state === "dropped" ? group[0].reason : "", "group-disabled");
      assert.equal(disguisedGroup[0]?.state === "dropped" ? disguisedGroup[0].reason : "", "group-disabled");
      assert.equal(
        missingTimestamp[0]?.state === "dropped" ? missingTimestamp[0].reason : "",
        "missing-timestamp"
      );
      assert.equal(history[0]?.state === "dropped" ? history[0].reason : "", "history");
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("runs accepted owner input with local memory, shared peer session, and suppressed delivery", async () => {
    const root = join(tmpdir(), `neonika-wa-ingress-${process.pid}-${Date.now()}`);
    const configRoot = join(root, "config");
    const projectRoot = join(root, "runtime");
    const ownerPeer = "+15551234567";
    const ownerJid = `${ownerPeer.slice(1)}@s.whatsapp.net`;
    try {
      const { config } = await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        discord: { enabled: true, ownerPeerId: "900000000000000010" },
        whatsapp: { enabled: true, ownerPeerId: ownerPeer, mode: "dedicated" }
      });
      const decision = decideNeonWhatsAppInbound(
        upsert(ownerJid, false, "wa-message-5", "what do we remember?"),
        config,
        () => new Date("2026-07-18T18:00:00.000Z")
      )[0];
      assert.equal(decision?.state, "accepted");
      if (decision?.state !== "accepted") {
        throw new Error("Expected accepted WhatsApp fixture");
      }
      const memoryProvider: INeonMemoryProvider = {
        search: (query) =>
          Promise.resolve({
            query,
            hits: [{ source: "local/memory", text: "The owner prefers concise updates." }],
            diagnostics: []
          })
      };
      const result = await runNeonWhatsAppShadowIngress(decision.message, {
        config,
        projectRoot,
        harness: createDryRunHarness(),
        memoryProvider,
        now: () => new Date("2026-07-18T18:00:01.000Z")
      });
      const owner = resolveNeonCanonicalPeer(config, {
        channel: "discord",
        accountId: "default",
        peerId: "900000000000000010"
      });
      const expectedSharedSession = deriveCodexSessionKey({
        channel: "discord",
        accountId: "default",
        channelId: "900000000000000005",
        agentId: "chaty",
        workspaceRoot: projectRoot,
        mode: "read-only",
        sessionPeerKey: owner.sessionPeerKey
      });
      const stored = await readFile(resolveGatewayStatePaths(projectRoot).runsPath, "utf8");

      assert.equal(result.run.request.channel, "whatsapp");
      assert.equal(result.run.memoryState, "attached");
      assert.equal(result.run.delivery.state, "suppressed");
      assert.equal(result.run.harnessSessionKey, expectedSharedSession);
      assert.doesNotMatch(stored, /15551234567/u);
      assert.doesNotMatch(stored, /900000000000000010/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function upsert(
  remoteJid: string,
  fromMe: boolean,
  messageId: string,
  content: string,
  remoteJidAlt?: string
): Readonly<Record<string, unknown>> {
  return {
    type: "notify",
    messages: [
      {
        key: { remoteJid, ...(remoteJidAlt ? { remoteJidAlt } : {}), fromMe, id: messageId },
        message: { conversation: content },
        messageTimestamp: 1_752_862_800
      }
    ]
  };
}
