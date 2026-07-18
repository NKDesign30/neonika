import assert from "node:assert/strict";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  acquireNeonWhatsAppTapLock,
  renderNeonWhatsAppLoginReport,
  resolveNeonSetupPaths,
  runNeonSetup,
  runNeonWhatsAppLogin,
  type INeonBaileysRuntime,
  type INeonWhatsAppSocket
} from "../src/index.js";

describe("Neonika WhatsApp linked-device login", () => {
  it("persists auth and writes a verified marker only after the socket opens", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-login-${process.pid}-${Date.now()}`);
    const qrValue = "ephemeral-qr-challenge-must-not-persist";
    const shown: string[] = [];
    let saveCount = 0;
    let ended = false;
    try {
      await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      const authPath = resolveNeonSetupPaths(configRoot).whatsappAuthPath;
      const runtime = createFakeRuntime(
        authPath,
        [{ qr: qrValue }, { credentials: true }, { connection: "open" }],
        () => {
          saveCount += 1;
        },
        () => {
          ended = true;
        }
      );
      const result = await runNeonWhatsAppLogin({
        configRoot,
        loadRuntime: () => Promise.resolve(runtime),
        showQr: (qr) => {
          shown.push(qr);
        },
        now: () => new Date("2026-07-18T18:00:00.000Z"),
        timeoutMs: 1_000
      });
      const paths = resolveNeonSetupPaths(configRoot);
      const markerText = await readFile(join(paths.whatsappAuthPath, "session.json"), "utf8");
      const report = renderNeonWhatsAppLoginReport(result);

      assert.equal(result.state, "linked");
      assert.equal(result.qrShown, true);
      assert.deepEqual(shown, [qrValue]);
      assert.equal(saveCount, 1);
      assert.equal(result.transportRestarts, 0);
      assert.equal(ended, true);
      assert.equal((await stat(paths.whatsappAuthPath)).mode & 0o777, 0o700);
      assert.equal((await stat(join(paths.whatsappAuthPath, "session.json"))).mode & 0o777, 0o600);
      assert.match(markerText, /"state": "linked"/u);
      assert.doesNotMatch(markerText, /ephemeral-qr-challenge/u);
      assert.doesNotMatch(markerText, /15551234567/u);
      assert.doesNotMatch(report, /ephemeral-qr-challenge/u);
      assert.doesNotMatch(report, /15551234567/u);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("does not write a linked marker when the transport closes first", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-closed-${process.pid}-${Date.now()}`);
    let ended = false;
    try {
      await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      const runtime = createFakeRuntime(
        resolveNeonSetupPaths(configRoot).whatsappAuthPath,
        [{ connection: "close" }],
        () => undefined,
        () => {
          ended = true;
        }
      );

      await assert.rejects(
        () =>
          runNeonWhatsAppLogin({
            configRoot,
            loadRuntime: () => Promise.resolve(runtime),
            showQr: () => undefined,
            timeoutMs: 1_000
          }),
        /closed before login completed/u
      );
      assert.equal(ended, true);
      await assert.rejects(
        () => readFile(join(resolveNeonSetupPaths(configRoot).whatsappAuthPath, "session.json"), "utf8"),
        /ENOENT/u
      );
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("performs one controlled socket restart after linked-device pairing", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-restart-${process.pid}-${Date.now()}`);
    try {
      await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      const authPath = resolveNeonSetupPaths(configRoot).whatsappAuthPath;
      const runtime = createRestartingRuntime(authPath);
      const result = await runNeonWhatsAppLogin({
        configRoot,
        loadRuntime: () => Promise.resolve(runtime),
        showQr: () => undefined,
        timeoutMs: 1_000
      });

      assert.equal(result.state, "linked");
      assert.equal(result.qrShown, true);
      assert.equal(result.transportRestarts, 1);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("refuses login before loading a transport when WhatsApp is not configured", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-unconfigured-${process.pid}-${Date.now()}`);
    let runtimeLoaded = false;
    try {
      await runNeonSetup({ configRoot });
      await assert.rejects(
        () =>
          runNeonWhatsAppLogin({
            configRoot,
            loadRuntime: () => {
              runtimeLoaded = true;
              return Promise.resolve(
                createFakeRuntime(
                  resolveNeonSetupPaths(configRoot).whatsappAuthPath,
                  [],
                  () => undefined,
                  () => undefined
                )
              );
            }
          }),
        /not configured/u
      );
      assert.equal(runtimeLoaded, false);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("refuses a second mutable WhatsApp session while the shadow tap lock is held", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-login-lock-${process.pid}-${Date.now()}`);
    let lock: Awaited<ReturnType<typeof acquireNeonWhatsAppTapLock>> | undefined;
    let runtimeLoaded = false;
    try {
      await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      const paths = resolveNeonSetupPaths(configRoot);
      lock = await acquireNeonWhatsAppTapLock(paths.whatsappTapLockPath);

      await assert.rejects(
        () =>
          runNeonWhatsAppLogin({
            configRoot,
            loadRuntime: () => {
              runtimeLoaded = true;
              return Promise.resolve(
                createFakeRuntime(paths.whatsappAuthPath, [], () => undefined, () => undefined)
              );
            }
          }),
        /login or shadow tap is already running/u
      );
      assert.equal(runtimeLoaded, false);
    } finally {
      await lock?.release();
      await rm(configRoot, { force: true, recursive: true });
    }
  });
});

function createFakeRuntime(
  authPath: string,
  updates: readonly Readonly<Record<string, unknown>>[],
  onSave: () => void,
  onEnd: () => void
): INeonBaileysRuntime {
  return {
    useMultiFileAuthState: () =>
      Promise.resolve({
        state: { private: true },
        saveCreds: async () => {
          await writeFile(join(authPath, "creds.json"), '{"registered":true}\n', {
            encoding: "utf8",
            mode: 0o600
          });
          onSave();
        }
      }),
    fetchLatestBaileysVersion: () => Promise.resolve({ version: [2, 3000, 1] }),
    createSocket: () => {
      const listeners = new Map<string, (value: unknown) => void>();
      const socket: INeonWhatsAppSocket = {
        ev: {
          on: (event, listener) => {
            listeners.set(event, listener);
          }
        },
        end: () => {
          onEnd();
        }
      };
      queueMicrotask(() => {
        for (const update of updates) {
          if (update["credentials"] === true) {
            listeners.get("creds.update")?.({});
          } else {
            listeners.get("connection.update")?.(update);
          }
        }
      });
      return socket;
    }
  };
}

function createRestartingRuntime(authPath: string): INeonBaileysRuntime {
  let socketCount = 0;
  return {
    useMultiFileAuthState: () =>
      Promise.resolve({
        state: { private: true },
        saveCreds: () =>
          writeFile(join(authPath, "creds.json"), '{"registered":true}\n', {
            encoding: "utf8",
            mode: 0o600
          })
      }),
    fetchLatestBaileysVersion: () => Promise.resolve({ version: [2, 3000, 1] }),
    createSocket: () => {
      socketCount += 1;
      const currentSocket = socketCount;
      const listeners = new Map<string, (value: unknown) => void>();
      const socket: INeonWhatsAppSocket = {
        ev: {
          on: (event, listener) => {
            listeners.set(event, listener);
          }
        },
        end: () => undefined
      };
      queueMicrotask(() => {
        if (currentSocket === 1) {
          listeners.get("connection.update")?.({ qr: "one-time-qr" });
          listeners.get("creds.update")?.({});
          listeners.get("connection.update")?.({
            connection: "close",
            lastDisconnect: { error: { output: { statusCode: 515 } } }
          });
        } else {
          listeners.get("connection.update")?.({ connection: "open" });
        }
      });
      return socket;
    }
  };
}
