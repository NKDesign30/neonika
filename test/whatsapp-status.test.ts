import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonWhatsAppStatusSnapshot,
  renderNeonWhatsAppStatusReport,
  resolveNeonSetupPaths,
  runNeonSetup
} from "../src/index.js";

describe("Neonika WhatsApp status", () => {
  it("separates policy configuration, auth evidence, and outbound posture", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-status-${process.pid}-${Date.now()}`);
    const ownerPeer = "+15551234567";
    try {
      await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: ownerPeer }
      });
      const pending = await createNeonWhatsAppStatusSnapshot(configRoot);
      assert.equal(pending.state, "login-required");
      assert.equal(pending.inbound, "disabled");
      assert.equal(pending.outbound, "suppressed");

      const authPath = resolveNeonSetupPaths(configRoot).whatsappAuthPath;
      await writeFile(join(authPath, "creds.json"), '{"registered":false,"me":{"id":"15551234567:9@s.whatsapp.net"}}\n', {
        encoding: "utf8",
        mode: 0o600
      });
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
      const ready = await createNeonWhatsAppStatusSnapshot(configRoot);
      const report = renderNeonWhatsAppStatusReport(ready);

      assert.equal(ready.state, "ready");
      assert.equal(ready.inbound, "ready");
      assert.match(report, /WhatsApp companion: ready/u);
      assert.match(report, /Outbound agent messages: suppressed/u);
      assert.doesNotMatch(report, new RegExp(ownerPeer.replace("+", "\\+")));
      assert.doesNotMatch(report, new RegExp(configRoot));
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });
});
