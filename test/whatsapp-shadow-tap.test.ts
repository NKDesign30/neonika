import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  resolveGatewayStatePaths,
  runNeonSetup,
  runNeonWhatsAppLogin,
  startNeonWhatsAppShadowTap,
  type INeonBaileysRuntime,
  type INeonMemoryProvider,
  type INeonWhatsAppSocket,
  type TNeonWhatsAppTapEvent
} from "../src/index.js";

describe("Neonika WhatsApp live shadow tap", () => {
  it("opens the linked session, deduplicates owner input, attaches memory, and never sends", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-tap-${process.pid}-${Date.now()}`);
    const configRoot = join(root, "config");
    const projectRoot = join(root, "runtime");
    let socketEnded = false;
    try {
      await runNeonSetup({
        configRoot,
        ownerId: "owner-primary",
        whatsapp: { enabled: true, ownerPeerId: "+15551234567", mode: "dedicated" }
      });
      await runNeonWhatsAppLogin({
        configRoot,
        loadRuntime: () =>
          Promise.resolve(
            createScriptedRuntime([
              { event: "creds.update", value: {} },
              { event: "connection.update", value: { connection: "open" } }
            ])
          ),
        showQr: () => undefined,
        now: () => new Date("2026-07-18T18:00:00.000Z"),
        timeoutMs: 1_000
      });
      const eventScript = [
        { event: "connection.update", value: { connection: "open" } },
        { event: "messages.upsert", value: ownerUpsert("tap-message-1") },
        { event: "messages.upsert", value: ownerUpsert("tap-message-1") }
      ] as const;
      const events: TNeonWhatsAppTapEvent[] = [];
      let resolveDuplicate: () => void = () => undefined;
      const duplicateObserved = new Promise<void>((resolvePromise) => {
        resolveDuplicate = resolvePromise;
      });
      const memoryProvider: INeonMemoryProvider = {
        search: (query) =>
          Promise.resolve({
            query,
            hits: [{ source: "local/memory", text: "One shared owner memory." }],
            diagnostics: []
          })
      };
      const runtime = createScriptedRuntime(eventScript, () => {
        socketEnded = true;
      });
      const handle = await startNeonWhatsAppShadowTap({
        configRoot,
        projectRoot,
        harness: createDryRunHarness(),
        memoryProvider,
        loadRuntime: () => Promise.resolve(runtime),
        now: () => new Date("2026-07-18T18:00:01.000Z"),
        onEvent: (event) => {
          events.push(event);
          if (event.kind === "duplicate") {
            resolveDuplicate();
          }
        }
      });

      await handle.ready;
      await duplicateObserved;
      await handle.close();
      const closed = await handle.closed;
      const stored = await readFile(resolveGatewayStatePaths(projectRoot).runsPath, "utf8");

      assert.equal(closed.reason, "operator");
      assert.equal(socketEnded, true);
      assert.equal(handle.stats.accepted, 1);
      assert.equal(handle.stats.duplicates, 1);
      assert.equal(handle.stats.errors, 0);
      assert.ok(events.some((event) => event.kind === "connection" && event.state === "open"));
      assert.ok(events.some((event) => event.kind === "accepted"));
      assert.match(stored, /"channel":"whatsapp"/u);
      assert.match(stored, /"state":"suppressed"/u);
      assert.doesNotMatch(stored, /15551234567/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("surfaces a post-ready transport close instead of pretending the tap is alive", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-tap-close-${process.pid}-${Date.now()}`);
    try {
      await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: "+15551234567" }
      });
      await runNeonWhatsAppLogin({
        configRoot,
        loadRuntime: () =>
          Promise.resolve(
            createScriptedRuntime([
              { event: "creds.update", value: {} },
              { event: "connection.update", value: { connection: "open" } }
            ])
          ),
        showQr: () => undefined,
        timeoutMs: 1_000
      });
      const handle = await startNeonWhatsAppShadowTap({
        configRoot,
        harness: createDryRunHarness(),
        memoryProvider: emptyMemoryProvider,
        loadRuntime: () =>
          Promise.resolve(
            createScriptedRuntime([
              { event: "connection.update", value: { connection: "open" } },
              { event: "connection.update", value: { connection: "close" } }
            ])
          )
      });

      await handle.ready;
      assert.equal((await handle.closed).reason, "transport-closed");
      await handle.close();
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });
});

const emptyMemoryProvider: INeonMemoryProvider = {
  search: (query) => Promise.resolve({ query, hits: [], diagnostics: [] })
};

function ownerUpsert(messageId: string): Readonly<Record<string, unknown>> {
  const ownerPeer = "+15551234567";
  return {
    type: "notify",
    messages: [
      {
        key: {
          remoteJid: `${ownerPeer.slice(1)}@s.whatsapp.net`,
          fromMe: false,
          id: messageId
        },
        message: { conversation: "what do we remember?" },
        messageTimestamp: Date.parse("2026-07-18T18:00:01.000Z") / 1_000
      }
    ]
  };
}

function createScriptedRuntime(
  script: readonly { readonly event: string; readonly value: unknown }[],
  onEnd: () => void = () => undefined
): INeonBaileysRuntime {
  return {
    useMultiFileAuthState: (authPath) =>
      Promise.resolve({
        state: {},
        saveCreds: () =>
          writeFile(join(authPath, "creds.json"), '{"registered":true}\n', {
            encoding: "utf8",
            mode: 0o600
          })
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
        for (const entry of script) {
          listeners.get(entry.event)?.(entry.value);
        }
      });
      return socket;
    }
  };
}
