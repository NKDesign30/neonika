import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  createNeonWhatsAppCanaryMessageId,
  readNeonGatewayRuns,
  runNeonSetup,
  runNeonWhatsAppLogin,
  startNeonWhatsAppCanaryTap,
  writeNeonCutoverPromotion,
  type INeonBaileysRuntime,
  type INeonMemoryProvider,
  type TNeonWhatsAppCanaryTapEvent
} from "../src/index.js";

describe("Neonika WhatsApp canary tap", () => {
  it("fails closed before loading a transport when the independent flag is absent", async () => {
    const configRoot = join(tmpdir(), `neonika-whatsapp-canary-disabled-${process.pid}-${Date.now()}`);
    let runtimeLoads = 0;
    try {
      await runNeonSetup({
        configRoot,
        whatsapp: { enabled: true, ownerPeerId: "+15551234567", mode: "dedicated" }
      });

      await assert.rejects(
        startNeonWhatsAppCanaryTap({
          configRoot,
          projectRoot: join(configRoot, "runtime"),
          env: {},
          harness: createDryRunHarness(),
          memoryProvider: emptyMemoryProvider,
          loadRuntime: () => {
            runtimeLoads += 1;
            return Promise.resolve(createCanaryRuntime([]));
          }
        }),
        /NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED=ready/u
      );
      assert.equal(runtimeLoads, 0);
    } finally {
      await rm(configRoot, { force: true, recursive: true });
    }
  });

  it("fails closed before loading a transport when persisted outbound gates are closed", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-canary-gate-${process.pid}-${Date.now()}`);
    const configRoot = join(root, "config");
    let runtimeLoads = 0;
    try {
      await prepareLinkedConfig(configRoot);

      await assert.rejects(
        startNeonWhatsAppCanaryTap({
          configRoot,
          projectRoot: join(root, "runtime"),
          env: { NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "ready" },
          harness: createDryRunHarness(),
          memoryProvider: emptyMemoryProvider,
          loadRuntime: () => {
            runtimeLoads += 1;
            return Promise.resolve(createCanaryRuntime([]));
          }
        }),
        /canary-not-approved, outbound-disarmed/u
      );
      assert.equal(runtimeLoads, 0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("delivers one prefixed owner command and rejects every wider access path", { timeout: 10_000 }, async () => {
    const root = join(tmpdir(), `neonika-whatsapp-canary-tap-${process.pid}-${Date.now()}`);
    const configRoot = join(root, "config");
    const projectRoot = join(root, "runtime");
    const sent: Array<{ readonly peerJid: string; readonly body: string; readonly messageId: string }> = [];
    const events: TNeonWhatsAppCanaryTapEvent[] = [];
    let resolveDelivered: () => void = () => undefined;
    const delivered = new Promise<void>((resolvePromise) => {
      resolveDelivered = resolvePromise;
    });
    let resolveDuplicate: () => void = () => undefined;
    const duplicate = new Promise<void>((resolvePromise) => {
      resolveDuplicate = resolvePromise;
    });

    try {
      await prepareLinkedConfig(configRoot);
      await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
      });
      const outboundId = createNeonWhatsAppCanaryMessageId("prior-delivery");
      const runtime = createCanaryRuntime(
        [
          {
            event: "connection.update",
            value: { connection: "open" }
          },
          {
            event: "messages.upsert",
            value: upsert([
              message("group-command", "15551234567-1@g.us", false, "/neon group"),
              message("non-owner-command", "15550000000@s.whatsapp.net", false, "/neon nope"),
              message("missing-prefix", "15551234567@s.whatsapp.net", false, "status"),
              message(outboundId, "15551234567@s.whatsapp.net", true, "/neon loop"),
              message("owner-command", "15551234567@s.whatsapp.net", false, "/neon status")
            ])
          },
          {
            event: "messages.upsert",
            value: upsert([
              message("owner-command", "15551234567@s.whatsapp.net", false, "/neon status")
            ])
          }
        ],
        (peerJid, body, messageId) => {
          sent.push({ peerJid, body, messageId });
          return Promise.resolve({ messageId });
        }
      );
      const handle = await startNeonWhatsAppCanaryTap({
        configRoot,
        projectRoot,
        env: { NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "ready" },
        harness: createDryRunHarness(),
        memoryProvider: emptyMemoryProvider,
        loadRuntime: () => Promise.resolve(runtime),
        now: () => new Date("2026-08-11T20:00:00.000Z"),
        onEvent: (event) => {
          events.push(event);
          if (event.kind === "reply" && event.state === "delivered") {
            resolveDelivered();
          }
          if (event.kind === "duplicate") {
            resolveDuplicate();
          }
        }
      });

      await handle.ready;
      await Promise.all([delivered, duplicate]);
      await handle.close();
      const runs = await readNeonGatewayRuns(projectRoot);

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.peerJid, "15551234567@s.whatsapp.net");
      assert.equal(handle.stats.accepted, 1);
      assert.equal(handle.stats.repliesDelivered, 1);
      assert.equal(handle.stats.duplicates, 1);
      assert.equal(handle.stats.loopsPrevented, 1);
      assert.ok(events.some((event) => event.kind === "dropped" && event.reason === "group-disabled"));
      assert.ok(events.some((event) => event.kind === "dropped" && event.reason === "owner-not-allowed"));
      assert.ok(events.some((event) => event.kind === "dropped" && event.reason === "command-prefix-required"));
      assert.ok(events.some((event) => event.kind === "dropped" && event.reason === "outbound-loop"));
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.request.contentPreview, "status");
      assert.equal(runs[0]?.mode, "live");
      assert.equal(runs[0]?.delivery.state, "delivered");
      assert.equal(runs[0]?.delivery.cutoverStage, "canary");
      assert.doesNotMatch(JSON.stringify({ events, runs }), /15551234567/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists credential updates and stops after the bounded reconnect budget", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-canary-reconnect-${process.pid}-${Date.now()}`);
    const configRoot = join(root, "config");
    let credentialSaves = 0;

    try {
      await prepareLinkedConfig(configRoot);
      await writeNeonCutoverPromotion(join(root, "runtime"), {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
      });
      const runtime = createCanaryRuntime(
        [
          { event: "creds.update", value: {} },
          { event: "connection.update", value: { connection: "open" } },
          { event: "connection.update", value: { connection: "close" } }
        ],
        (_peerJid, _body, messageId) => Promise.resolve({ messageId }),
        () => {
          credentialSaves += 1;
        },
        [
          [{ event: "creds.update", value: {} }, { event: "connection.update", value: { connection: "close" } }],
          [{ event: "creds.update", value: {} }, { event: "connection.update", value: { connection: "close" } }]
        ]
      );
      const handle = await startNeonWhatsAppCanaryTap({
        configRoot,
        projectRoot: join(root, "runtime"),
        env: { NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED: "ready" },
        harness: createDryRunHarness(),
        memoryProvider: emptyMemoryProvider,
        loadRuntime: () => Promise.resolve(runtime),
        maxReconnects: 2,
        reconnectDelay: () => Promise.resolve(),
        connectionTimeoutMs: 1_000
      });

      await handle.ready;
      const closed = await handle.closed;

      assert.equal(closed.reason, "reconnect-exhausted");
      assert.equal(handle.stats.reconnects, 2);
      assert.equal(credentialSaves, 3);
      await handle.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

const emptyMemoryProvider: INeonMemoryProvider = {
  search: (query) => Promise.resolve({ query, hits: [], diagnostics: [] })
};

async function prepareLinkedConfig(configRoot: string): Promise<void> {
  await runNeonSetup({
    configRoot,
    whatsapp: { enabled: true, ownerPeerId: "+15551234567", mode: "dedicated" }
  });
  await runNeonWhatsAppLogin({
    configRoot,
    loadRuntime: () =>
      Promise.resolve(
        createCanaryRuntime([
          { event: "creds.update", value: {} },
          { event: "connection.update", value: { connection: "open" } }
        ])
      ),
    showQr: () => undefined,
    timeoutMs: 1_000
  });
}

function createCanaryRuntime(
  initialScript: readonly { readonly event: string; readonly value: unknown }[],
  onSend?: (
    peerJid: string,
    body: string,
    messageId: string
  ) => Promise<{ readonly messageId: string }>,
  onSave: () => void = () => undefined,
  reconnectScripts: readonly (readonly { readonly event: string; readonly value: unknown }[])[] = []
): INeonBaileysRuntime {
  let socketIndex = 0;
  return {
    useMultiFileAuthState: (authPath) =>
      Promise.resolve({
        state: {},
        saveCreds: async () => {
          onSave();
          await writeFile(
            join(authPath, "creds.json"),
            '{"registered":false,"me":{"id":"15551234567:9@s.whatsapp.net"}}\n',
            { encoding: "utf8", mode: 0o600 }
          );
        }
      }),
    fetchProtocolVersion: () => Promise.resolve({ version: [2, 3000, 1], isCurrent: true }),
    createSocket: () => {
      const listeners = new Map<string, (value: unknown) => void>();
      const script = socketIndex === 0 ? initialScript : reconnectScripts[socketIndex - 1] ?? [];
      socketIndex += 1;
      const socket = {
        ev: {
          on: (event: string, listener: (value: unknown) => void) => {
            listeners.set(event, listener);
          }
        },
        end: () => undefined,
        ...(onSend
          ? {
              sendText: (peerJid: string, body: string, messageId: string) =>
                onSend(peerJid, body, messageId)
            }
          : {})
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

function upsert(messages: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>> {
  return { type: "notify", messages };
}

function message(
  id: string,
  remoteJid: string,
  fromMe: boolean,
  content: string
): Readonly<Record<string, unknown>> {
  return {
    key: { id, remoteJid, fromMe },
    message: { conversation: content },
    messageTimestamp: Date.parse("2026-08-11T20:00:00.000Z") / 1_000
  };
}
