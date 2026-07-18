import assert from "node:assert/strict";
import { chmod, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  inspectNeonWhatsAppAuthState,
  resolveNeonSetupPaths,
  runNeonSetup
} from "../src/index.js";

describe("Neonika WhatsApp auth evidence", () => {
  it("requires private credentials beside the verified session marker", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-auth-${process.pid}-${Date.now()}`);
    try {
      await runNeonSetup({ configRoot });
      const authPath = resolveNeonSetupPaths(configRoot).whatsappAuthPath;
      await writeMarker(authPath);

      const markerOnly = await inspectNeonWhatsAppAuthState(authPath);
      assert.equal(markerOnly.state, "missing");
      assert.equal(markerOnly.reason, "credentials-missing");

      const credentialsPath = join(authPath, "creds.json");
      await writeFile(credentialsPath, '{"registered":true}\n', {
        encoding: "utf8",
        mode: 0o644
      });
      const publicCredentials = await inspectNeonWhatsAppAuthState(authPath);
      assert.equal(publicCredentials.state, "invalid");
      assert.equal(publicCredentials.reason, "unsafe-permissions");

      await chmod(credentialsPath, 0o600);
      await writeFile(credentialsPath, '{"registered":false}\n', "utf8");
      const unregistered = await inspectNeonWhatsAppAuthState(authPath);
      assert.equal(unregistered.state, "invalid");
      assert.equal(unregistered.reason, "invalid-credentials");

      await writeFile(credentialsPath, '{"registered":true}\n', "utf8");
      const linked = await inspectNeonWhatsAppAuthState(authPath);
      assert.equal(linked.state, "linked");
      assert.equal(linked.reason, "verified");
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("rejects symlinked credential state", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-auth-link-${process.pid}-${Date.now()}`);
    const configRoot = join(root, "config");
    try {
      await runNeonSetup({ configRoot });
      const authPath = resolveNeonSetupPaths(configRoot).whatsappAuthPath;
      const outsidePath = join(root, "outside-creds.json");
      await writeMarker(authPath);
      await writeFile(outsidePath, '{"registered":true}\n', { encoding: "utf8", mode: 0o600 });
      await symlink(outsidePath, join(authPath, "creds.json"));

      const evidence = await inspectNeonWhatsAppAuthState(authPath);
      assert.equal(evidence.state, "invalid");
      assert.equal(evidence.reason, "unsafe-filesystem-state");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function writeMarker(authPath: string): Promise<void> {
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
}
