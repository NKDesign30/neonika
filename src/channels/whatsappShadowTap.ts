import { redactText } from "../harness/redaction.js";
import type { ICodexHarness } from "../harness/types.js";
import type { INeonMemoryProvider } from "../memory/neonMemory.js";
import { readNeonSetupConfig, resolveNeonSetupPaths } from "../onboarding/neonSetup.js";
import { assertNeonWhatsAppAuthLinked } from "./whatsappAuth.js";
import {
  closeNeonWhatsAppSocket,
  createSilentNeonWhatsAppLogger,
  hardenNeonWhatsAppAuthDirectory,
  loadNeonWhatsAppRuntime,
  type INeonBaileysRuntime,
  type INeonWhatsAppSocket
} from "./whatsappLogin.js";
import {
  createNeonWhatsAppReplayStore,
  type INeonWhatsAppReplayStore
} from "./whatsappReplayStore.js";
import { installNeonWhatsAppLibsignalLogGuard } from "./whatsappLogGuard.js";
import { acquireNeonWhatsAppTapLock } from "./whatsappTapLock.js";
import {
  decideNeonWhatsAppInbound,
  runNeonWhatsAppShadowIngress
} from "./whatsappInbound.js";

export type TNeonWhatsAppTapEvent =
  | { readonly kind: "connection"; readonly state: "open" | "closed" }
  | { readonly kind: "accepted"; readonly runId: string }
  | { readonly kind: "dropped"; readonly reason: string }
  | { readonly kind: "duplicate" }
  | { readonly kind: "error"; readonly message: string };

export interface INeonWhatsAppTapStats {
  accepted: number;
  dropped: number;
  duplicates: number;
  errors: number;
}

export interface INeonWhatsAppTapCloseResult {
  readonly reason: "operator" | "transport-closed";
}

export interface INeonWhatsAppShadowTapHandle {
  readonly ready: Promise<void>;
  readonly closed: Promise<INeonWhatsAppTapCloseResult>;
  readonly stats: INeonWhatsAppTapStats;
  close(): Promise<void>;
}

export interface IStartNeonWhatsAppShadowTapOptions {
  readonly configRoot?: string;
  readonly projectRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly harness: ICodexHarness;
  readonly memoryProvider: INeonMemoryProvider;
  readonly agentId?: string;
  readonly now?: () => Date;
  readonly loadRuntime?: () => Promise<INeonBaileysRuntime>;
  readonly replayStore?: INeonWhatsAppReplayStore;
  readonly readyTimeoutMs?: number;
  readonly onEvent?: (event: TNeonWhatsAppTapEvent) => void;
}

const replayWindowMs = 60_000;

export async function startNeonWhatsAppShadowTap(
  options: IStartNeonWhatsAppShadowTapOptions
): Promise<INeonWhatsAppShadowTapHandle> {
  const env = options.env ?? process.env;
  const config = await readNeonSetupConfig(options.configRoot, env);
  if (config === undefined || config.channels.whatsapp.enabled !== true) {
    throw new Error("WhatsApp companion is not configured; run neonika onboard first");
  }
  const setupConfig = config;
  const paths = resolveNeonSetupPaths(options.configRoot, env);
  await assertNeonWhatsAppAuthLinked(paths.whatsappAuthPath);
  await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
  const replayStore =
    options.replayStore ??
    (await createNeonWhatsAppReplayStore(paths.whatsappReplayPath, {
      ...(options.now ? { now: options.now } : {})
    }));
  const runtime = await (options.loadRuntime ?? loadNeonWhatsAppRuntime)();
  const auth = await runtime.useMultiFileAuthState(paths.whatsappAuthPath);
  const { version } = await runtime.fetchLatestBaileysVersion();
  const tapLock = await acquireNeonWhatsAppTapLock(paths.whatsappTapLockPath, {
    ...(options.now ? { now: options.now } : {})
  });
  const restoreLogGuard = installNeonWhatsAppLibsignalLogGuard();
  let socket: INeonWhatsAppSocket;
  try {
    socket = runtime.createSocket({
      auth: auth.state,
      version,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ["Neonika", "Chrome", "1.0.0"],
      logger: createSilentNeonWhatsAppLogger()
    });
  } catch (error) {
    restoreLogGuard();
    await tapLock.release().catch(() => undefined);
    throw error;
  }
  const stats: INeonWhatsAppTapStats = { accepted: 0, dropped: 0, duplicates: 0, errors: 0 };
  const startedAtMs = (options.now?.() ?? new Date()).getTime();
  const projectRoot = options.projectRoot ?? paths.configRoot;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  let readySettled = false;
  let closedSettled = false;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let resolveClosed: (result: INeonWhatsAppTapCloseResult) => void = () => undefined;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const closed = new Promise<INeonWhatsAppTapCloseResult>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });
  const readyTimeout = setTimeout(() => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    stopped = true;
    closeNeonWhatsAppSocket(socket);
    rejectReady(new Error("WhatsApp transport did not become ready in time"));
    resolveClosedOnce("transport-closed");
  }, options.readyTimeoutMs ?? 30_000);

  socket.ev.on("creds.update", () => {
    queue = queue.then(async () => {
      await auth.saveCreds();
      await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
    }).catch((error: unknown) => {
      recordError(error);
      stopped = true;
      closeNeonWhatsAppSocket(socket);
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("WhatsApp credentials could not be persisted"));
      }
      resolveClosedOnce("transport-closed");
    });
  });
  socket.ev.on("connection.update", (value) => {
    if (!isRecord(value)) {
      return;
    }
    if (value["connection"] === "open" && !readySettled) {
      readySettled = true;
      clearTimeout(readyTimeout);
      options.onEvent?.({ kind: "connection", state: "open" });
      resolveReady();
    } else if (value["connection"] === "close") {
      clearTimeout(readyTimeout);
      stopped = true;
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("WhatsApp transport closed before becoming ready"));
      }
      options.onEvent?.({ kind: "connection", state: "closed" });
      resolveClosedOnce("transport-closed");
    }
  });
  socket.ev.on("messages.upsert", (value) => {
    queue = queue.then(() => processUpsert(value)).catch((error: unknown) => {
      recordError(error);
    });
  });

  return {
    ready,
    closed,
    stats,
    close: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimeout(readyTimeout);
      await queue;
      closeNeonWhatsAppSocket(socket);
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("WhatsApp tap stopped before becoming ready"));
      }
      resolveClosedOnce("operator");
    }
  };

  async function processUpsert(value: unknown): Promise<void> {
    if (stopped) {
      return;
    }
    const decisions = decideNeonWhatsAppInbound(value, setupConfig, options.now);
    for (const decision of decisions) {
      if (decision.state === "dropped") {
        stats.dropped += 1;
        options.onEvent?.({ kind: "dropped", reason: decision.reason });
        continue;
      }
      const createdAtMs = Date.parse(decision.message.createdAt);
      if (Number.isFinite(createdAtMs) && createdAtMs < startedAtMs - replayWindowMs) {
        stats.dropped += 1;
        options.onEvent?.({ kind: "dropped", reason: "stale-message" });
        continue;
      }
      if (!(await replayStore.claim(decision.message.messageId))) {
        stats.duplicates += 1;
        options.onEvent?.({ kind: "duplicate" });
        continue;
      }
      const result = await runNeonWhatsAppShadowIngress(decision.message, {
        config: setupConfig,
        projectRoot,
        harness: options.harness,
        memoryProvider: options.memoryProvider,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.now ? { now: options.now } : {})
      });
      stats.accepted += 1;
      options.onEvent?.({ kind: "accepted", runId: result.run.runId });
    }
  }

  function recordError(error: unknown): void {
    stats.errors += 1;
    const message = redactText(error instanceof Error ? error.message : "unknown WhatsApp tap error");
    options.onEvent?.({ kind: "error", message });
  }

  function resolveClosedOnce(reason: INeonWhatsAppTapCloseResult["reason"]): void {
    if (closedSettled) {
      return;
    }
    closedSettled = true;
    restoreLogGuard();
    void tapLock
      .release()
      .catch((error: unknown) => {
        recordError(error);
      })
      .finally(() => {
        resolveClosed({ reason });
      });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
