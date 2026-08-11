import { loadNeonCutoverEnv } from "../core/cutoverPromotion.js";
import { markNeonGatewayRunDelivered } from "../gateway/shadowGateway.js";
import { writeNeonGatewayRunLatest } from "../gateway/runStore.js";
import { redactText } from "../harness/redaction.js";
import type { ICodexHarness } from "../harness/types.js";
import type { INeonMemoryProvider } from "../memory/neonMemory.js";
import { readNeonSetupConfig, resolveNeonSetupPaths } from "../onboarding/neonSetup.js";
import { assertNeonWhatsAppAuthLinked } from "./whatsappAuth.js";
import {
  deliverNeonWhatsAppCanaryReply,
  neonWhatsAppCanaryOutboundEnabledEnvKey,
  parseNeonWhatsAppCanaryCommand,
  resolveNeonWhatsAppCanaryGate,
  type INeonWhatsAppCanaryDeliveryResult
} from "./whatsappCanary.js";
import {
  closeNeonWhatsAppSocket,
  createSilentNeonWhatsAppLogger,
  hardenNeonWhatsAppAuthDirectory,
  loadNeonWhatsAppRuntime,
  type INeonBaileysRuntime,
  type INeonWhatsAppSocket
} from "./whatsappLogin.js";
import {
  decideNeonWhatsAppInbound,
  runNeonWhatsAppShadowIngress
} from "./whatsappInbound.js";
import { installNeonWhatsAppLibsignalLogGuard } from "./whatsappLogGuard.js";
import {
  createNeonWhatsAppReplayStore,
  type INeonWhatsAppReplayStore
} from "./whatsappReplayStore.js";
import { acquireNeonWhatsAppTapLock } from "./whatsappTapLock.js";

export type TNeonWhatsAppCanaryTapEvent =
  | { readonly kind: "connection"; readonly state: "open" | "closed" }
  | { readonly kind: "accepted"; readonly runId: string }
  | {
      readonly kind: "reply";
      readonly runId: string;
      readonly state: INeonWhatsAppCanaryDeliveryResult["state"];
    }
  | { readonly kind: "dropped"; readonly reason: string }
  | { readonly kind: "duplicate" }
  | { readonly kind: "reconnect"; readonly attempt: number; readonly maximum: number }
  | { readonly kind: "error"; readonly message: string };

export interface INeonWhatsAppCanaryTapStats {
  accepted: number;
  dropped: number;
  duplicates: number;
  loopsPrevented: number;
  errors: number;
  reconnects: number;
  repliesDelivered: number;
  repliesSuppressed: number;
  receiptReplays: number;
}

export interface INeonWhatsAppCanaryTapCloseResult {
  readonly reason: "operator" | "reconnect-exhausted" | "transport-error";
}

export interface INeonWhatsAppCanaryTapHandle {
  readonly ready: Promise<void>;
  readonly closed: Promise<INeonWhatsAppCanaryTapCloseResult>;
  readonly stats: INeonWhatsAppCanaryTapStats;
  close(): Promise<void>;
}

export interface IStartNeonWhatsAppCanaryTapOptions {
  readonly configRoot?: string;
  readonly projectRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly harness: ICodexHarness;
  readonly memoryProvider: INeonMemoryProvider;
  readonly agentId?: string;
  readonly now?: () => Date;
  readonly loadRuntime?: () => Promise<INeonBaileysRuntime>;
  readonly replayStore?: INeonWhatsAppReplayStore;
  readonly connectionTimeoutMs?: number;
  readonly maxReconnects?: number;
  readonly reconnectDelay?: (delayMs: number) => Promise<void>;
  readonly onEvent?: (event: TNeonWhatsAppCanaryTapEvent) => void;
}

const replayWindowMs = 60_000;
const defaultConnectionTimeoutMs = 30_000;
const defaultMaxReconnects = 3;
const maximumReconnects = 10;

export async function startNeonWhatsAppCanaryTap(
  options: IStartNeonWhatsAppCanaryTapOptions
): Promise<INeonWhatsAppCanaryTapHandle> {
  const env = options.env ?? process.env;
  const config = await readNeonSetupConfig(options.configRoot, env);
  if (config === undefined || config.channels.whatsapp.enabled !== true) {
    throw new Error("WhatsApp companion is not configured; run neonika onboard first");
  }
  const ownerPeerId = config.channels.whatsapp.ownerPeerId;
  if (!ownerPeerId) {
    throw new Error("WhatsApp canary requires an explicit owner link");
  }
  if (env[neonWhatsAppCanaryOutboundEnabledEnvKey]?.trim() !== "ready") {
    throw new Error(`WhatsApp canary requires ${neonWhatsAppCanaryOutboundEnabledEnvKey}=ready`);
  }
  const setupConfig = config;
  const configuredOwnerPeerId = ownerPeerId;

  const maxReconnects = resolveMaxReconnects(options.maxReconnects);
  const connectionTimeoutMs = resolveConnectionTimeoutMs(options.connectionTimeoutMs);
  const paths = resolveNeonSetupPaths(options.configRoot, env);
  const projectRoot = options.projectRoot ?? paths.configRoot;
  const gate = resolveNeonWhatsAppCanaryGate(await loadNeonCutoverEnv(projectRoot, env));
  if (!gate.ready) {
    throw new Error(`WhatsApp canary gate closed: ${gate.blockers.join(", ")}`);
  }
  await assertNeonWhatsAppAuthLinked(paths.whatsappAuthPath);
  await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
  const replayStore =
    options.replayStore ??
    (await createNeonWhatsAppReplayStore(paths.whatsappReplayPath, {
      ...(options.now ? { now: options.now } : {})
    }));
  const runtime = await (options.loadRuntime ?? loadNeonWhatsAppRuntime)();
  const tapLock = await acquireNeonWhatsAppTapLock(paths.whatsappTapLockPath, {
    ...(options.now ? { now: options.now } : {})
  });
  const restoreLogGuard = installNeonWhatsAppLibsignalLogGuard();
  let auth: Awaited<ReturnType<INeonBaileysRuntime["useMultiFileAuthState"]>>;
  let version: readonly number[];
  try {
    auth = await runtime.useMultiFileAuthState(paths.whatsappAuthPath);
    version = (await runtime.fetchProtocolVersion()).version;
  } catch (error) {
    restoreLogGuard();
    await tapLock.release().catch(() => undefined);
    throw error;
  }

  const stats: INeonWhatsAppCanaryTapStats = {
    accepted: 0,
    dropped: 0,
    duplicates: 0,
    loopsPrevented: 0,
    errors: 0,
    reconnects: 0,
    repliesDelivered: 0,
    repliesSuppressed: 0,
    receiptReplays: 0
  };
  const startedAtMs = (options.now?.() ?? new Date()).getTime();
  let stopped = false;
  let readySettled = false;
  let closedSettled = false;
  let currentSocket: INeonWhatsAppSocket | undefined;
  let currentConnectionTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelReconnectDelay: (() => void) | undefined;
  let credentialQueue: Promise<void> = Promise.resolve();
  let messageQueue: Promise<void> = Promise.resolve();
  let finalizePromise: Promise<void> | undefined;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let resolveClosed: (result: INeonWhatsAppCanaryTapCloseResult) => void = () => undefined;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const closed = new Promise<INeonWhatsAppCanaryTapCloseResult>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  try {
    openSocket();
  } catch (error) {
    restoreLogGuard();
    await tapLock.release().catch(() => undefined);
    throw error;
  }

  return {
    ready,
    closed,
    stats,
    close: async () => {
      await finalize("operator");
    }
  };

  function openSocket(): void {
    const socket = runtime.createSocket({
      auth: auth.state,
      version,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      browser: ["Neonika", "Chrome", "1.0.0"],
      logger: createSilentNeonWhatsAppLogger()
    });
    if (!socket.sendText) {
      closeNeonWhatsAppSocket(socket);
      throw new Error("WhatsApp runtime does not support canary text outbound");
    }
    currentSocket = socket;
    currentConnectionTimer = setTimeout(() => {
      void disconnectAndReconnect(socket);
    }, connectionTimeoutMs);

    socket.ev.on("creds.update", () => {
      if (socket !== currentSocket || stopped) {
        return;
      }
      credentialQueue = credentialQueue
        .then(async () => {
          await auth.saveCreds();
          await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
        })
        .catch((error: unknown) => {
          recordError(error);
          void finalize("transport-error");
        });
    });
    socket.ev.on("connection.update", (value) => {
      if (socket !== currentSocket || stopped || !isRecord(value)) {
        return;
      }
      if (value["connection"] === "open") {
        clearCurrentConnectionTimer();
        options.onEvent?.({ kind: "connection", state: "open" });
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
      } else if (value["connection"] === "close") {
        void disconnectAndReconnect(socket);
      }
    });
    socket.ev.on("messages.upsert", (value) => {
      if (socket !== currentSocket || stopped) {
        return;
      }
      messageQueue = messageQueue
        .then(() => processUpsert(value))
        .catch((error: unknown) => {
          recordError(error);
        });
    });
  }

  async function disconnectAndReconnect(socket: INeonWhatsAppSocket): Promise<void> {
    if (stopped || socket !== currentSocket) {
      return;
    }
    clearCurrentConnectionTimer();
    currentSocket = undefined;
    closeNeonWhatsAppSocket(socket);
    options.onEvent?.({ kind: "connection", state: "closed" });
    await scheduleReconnect();
  }

  async function scheduleReconnect(): Promise<void> {
    if (stopped) {
      return;
    }
    if (stats.reconnects >= maxReconnects) {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("WhatsApp canary reconnect budget exhausted before ready"));
      }
      await finalize("reconnect-exhausted");
      return;
    }
    stats.reconnects += 1;
    options.onEvent?.({
      kind: "reconnect",
      attempt: stats.reconnects,
      maximum: maxReconnects
    });
    await waitForReconnect(resolveReconnectDelayMs(stats.reconnects));
    if (stopped) {
      return;
    }
    try {
      openSocket();
    } catch (error) {
      recordError(error);
      await scheduleReconnect();
    }
  }

  async function waitForReconnect(delayMs: number): Promise<void> {
    if (options.reconnectDelay) {
      await options.reconnectDelay(delayMs);
      return;
    }
    await new Promise<void>((resolveDelay) => {
      const timer = setTimeout(() => {
        cancelReconnectDelay = undefined;
        resolveDelay();
      }, delayMs);
      cancelReconnectDelay = () => {
        clearTimeout(timer);
        cancelReconnectDelay = undefined;
        resolveDelay();
      };
    });
  }

  async function processUpsert(value: unknown): Promise<void> {
    if (stopped) {
      return;
    }
    const decisions = decideNeonWhatsAppInbound(value, setupConfig, options.now);
    for (const decision of decisions) {
      if (decision.state === "dropped") {
        recordDrop(decision.reason);
        continue;
      }
      const createdAtMs = Date.parse(decision.message.createdAt);
      if (Number.isFinite(createdAtMs) && createdAtMs < startedAtMs - replayWindowMs) {
        recordDrop("stale-message");
        continue;
      }
      const command = parseNeonWhatsAppCanaryCommand(decision.message.content);
      if (command.state === "dropped") {
        recordDrop(command.reason);
        continue;
      }
      if (!(await replayStore.claim(decision.message.messageId))) {
        stats.duplicates += 1;
        options.onEvent?.({ kind: "duplicate" });
        continue;
      }
      const result = await runNeonWhatsAppShadowIngress(
        { ...decision.message, content: command.content },
        {
          config: setupConfig,
          projectRoot,
          harness: options.harness,
          memoryProvider: options.memoryProvider,
          ...(options.agentId ? { agentId: options.agentId } : {}),
          ...(options.now ? { now: options.now } : {})
        }
      );
      stats.accepted += 1;
      options.onEvent?.({ kind: "accepted", runId: result.run.runId });
      const delivery = await deliverNeonWhatsAppCanaryReply({
        projectRoot,
        run: result.run,
        ownerPeerId: configuredOwnerPeerId,
        liveEnv: env,
        sendText: async (peerJid, body, messageId) => {
          const sendText = currentSocket?.sendText;
          if (!sendText) {
            throw new Error("WhatsApp canary transport is unavailable");
          }
          return await sendText(peerJid, body, messageId);
        },
        ...(options.now ? { now: options.now } : {})
      });
      await persistDelivery(result.run, delivery);
      recordReply(delivery);
    }
  }

  async function persistDelivery(
    run: Awaited<ReturnType<typeof runNeonWhatsAppShadowIngress>>["run"],
    delivery: INeonWhatsAppCanaryDeliveryResult
  ): Promise<void> {
    if (
      (delivery.state === "delivered" || delivery.state === "already-delivered") &&
      delivery.messageId &&
      delivery.cutoverStage
    ) {
      await writeNeonGatewayRunLatest(
        projectRoot,
        markNeonGatewayRunDelivered(run, {
          messageId: delivery.messageId,
          cutoverStage: delivery.cutoverStage,
          reason: "whatsapp-canary-reply"
        })
      );
    }
  }

  function recordDrop(reason: string): void {
    stats.dropped += 1;
    if (reason === "outbound-loop") {
      stats.loopsPrevented += 1;
    }
    options.onEvent?.({ kind: "dropped", reason });
  }

  function recordReply(delivery: INeonWhatsAppCanaryDeliveryResult): void {
    if (delivery.state === "delivered" && delivery.outboundSent) {
      stats.repliesDelivered += 1;
    } else if (delivery.state === "already-delivered") {
      stats.receiptReplays += 1;
    } else {
      stats.repliesSuppressed += 1;
    }
    options.onEvent?.({
      kind: "reply",
      runId: delivery.runId,
      state: delivery.state
    });
  }

  function recordError(error: unknown): void {
    stats.errors += 1;
    const message = redactText(
      error instanceof Error ? error.message : "unknown WhatsApp canary error"
    );
    options.onEvent?.({ kind: "error", message });
  }

  async function finalize(
    reason: INeonWhatsAppCanaryTapCloseResult["reason"]
  ): Promise<void> {
    if (finalizePromise) {
      await finalizePromise;
      return;
    }
    stopped = true;
    finalizePromise = (async () => {
      cancelReconnectDelay?.();
      clearCurrentConnectionTimer();
      if (currentSocket) {
        closeNeonWhatsAppSocket(currentSocket);
        currentSocket = undefined;
      }
      await Promise.all([credentialQueue, messageQueue]);
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error("WhatsApp canary stopped before becoming ready"));
      }
      restoreLogGuard();
      await tapLock.release().catch((error: unknown) => {
        recordError(error);
      });
      if (!closedSettled) {
        closedSettled = true;
        resolveClosed({ reason });
      }
    })();
    await finalizePromise;
  }

  function clearCurrentConnectionTimer(): void {
    if (currentConnectionTimer) {
      clearTimeout(currentConnectionTimer);
      currentConnectionTimer = undefined;
    }
  }
}

function resolveMaxReconnects(value: number | undefined): number {
  const resolved = value ?? defaultMaxReconnects;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > maximumReconnects) {
    throw new Error(`WhatsApp canary maxReconnects must be between 0 and ${maximumReconnects}`);
  }
  return resolved;
}

function resolveConnectionTimeoutMs(value: number | undefined): number {
  const resolved = value ?? defaultConnectionTimeoutMs;
  if (!Number.isFinite(resolved) || resolved < 100 || resolved > 120_000) {
    throw new Error("WhatsApp canary connectionTimeoutMs must be between 100 and 120000");
  }
  return Math.floor(resolved);
}

function resolveReconnectDelayMs(attempt: number): number {
  return Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
