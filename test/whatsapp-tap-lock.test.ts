import assert from "node:assert/strict";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireNeonWhatsAppTapLock } from "../src/index.js";

describe("Neonika WhatsApp single-tap lock", () => {
  it("blocks a second live tap and releases ownership cleanly", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-tap-lock-${process.pid}-${Date.now()}`);
    const path = join(root, "whatsapp-tap.lock");
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const first = await acquireNeonWhatsAppTapLock(path, {
        pid: 31001,
        now: () => new Date("2026-07-18T18:00:00.000Z"),
        isProcessAlive: () => true
      });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      await assert.rejects(
        () =>
          acquireNeonWhatsAppTapLock(path, {
            pid: 31002,
            isProcessAlive: () => true
          }),
        /already running/u
      );

      await first.release();
      await assert.rejects(() => stat(path), /ENOENT/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("replaces a well-formed stale lock but rejects malformed state", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-stale-lock-${process.pid}-${Date.now()}`);
    const path = join(root, "whatsapp-tap.lock");
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(
        path,
        '{"version":1,"pid":31003,"createdAt":"2026-07-18T18:00:00.000Z"}\n',
        { encoding: "utf8", mode: 0o600 }
      );
      const replacement = await acquireNeonWhatsAppTapLock(path, {
        pid: 31004,
        isProcessAlive: () => false
      });
      await replacement.release();

      await writeFile(path, "not-json\n", { encoding: "utf8", mode: 0o600 });
      await assert.rejects(
        () =>
          acquireNeonWhatsAppTapLock(path, {
            pid: 31005,
            isProcessAlive: () => false
          }),
        /malformed/u
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
