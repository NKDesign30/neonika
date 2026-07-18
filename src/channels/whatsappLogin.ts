import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readNeonSetupConfig, resolveNeonSetupPaths } from "../onboarding/neonSetup.js";
import {
  assertNeonWhatsAppAuthLinked,
  assertNeonWhatsAppCredentialsPersisted
} from "./whatsappAuth.js";
import { installNeonWhatsAppLibsignalLogGuard } from "./whatsappLogGuard.js";
import { acquireNeonWhatsAppTapLock } from "./whatsappTapLock.js";

export interface INeonWhatsAppLoginResult {
  readonly state: "linked";
  readonly accountId: "default";
  readonly qrShown: boolean;
  readonly transportRestarts: number;
  readonly sessionMarkerWritten: true;
  readonly secretsPrinted: false;
}

export interface IRunNeonWhatsAppLoginOptions {
  readonly configRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly loadRuntime?: () => Promise<INeonBaileysRuntime>;
  readonly showQr?: (qr: string) => Promise<void> | void;
}

export interface INeonBaileysRuntime {
  useMultiFileAuthState(path: string): Promise<{
    readonly state: unknown;
    readonly saveCreds: () => Promise<void>;
  }>;
  fetchLatestBaileysVersion(): Promise<{ readonly version: readonly number[] }>;
  createSocket(options: Readonly<Record<string, unknown>>): INeonWhatsAppSocket;
}

export interface INeonWhatsAppSocket {
  readonly ev: {
    on(event: string, listener: (value: unknown) => void): void;
  };
  end(error?: Error): void;
}

export async function runNeonWhatsAppLogin(
  options: IRunNeonWhatsAppLoginOptions = {}
): Promise<INeonWhatsAppLoginResult> {
  const env = options.env ?? process.env;
  const config = await readNeonSetupConfig(options.configRoot, env);
  if (config === undefined || config.channels.whatsapp.enabled !== true) {
    throw new Error("WhatsApp companion is not configured; run neonika onboard first");
  }
  if (config.channels.whatsapp.ownerPeerId === undefined) {
    throw new Error("WhatsApp companion has no explicit owner link");
  }

  const paths = resolveNeonSetupPaths(options.configRoot, env);
  await mkdir(paths.whatsappAuthPath, { recursive: true, mode: 0o700 });
  await chmod(paths.whatsappAuthPath, 0o700);
  await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
  const sessionLock = await acquireNeonWhatsAppTapLock(paths.whatsappTapLockPath, {
    ...(options.now ? { now: options.now } : {})
  });
  const restoreLogGuard = installNeonWhatsAppLibsignalLogGuard();
  const sockets: INeonWhatsAppSocket[] = [];
  try {
    const runtime = await (options.loadRuntime ?? loadNeonWhatsAppRuntime)();
    const auth = await runtime.useMultiFileAuthState(paths.whatsappAuthPath);
    const { version } = await runtime.fetchLatestBaileysVersion();
    let qrShown = false;
    let transportRestarts = 0;
    let activeSocket: INeonWhatsAppSocket | undefined;
    let credentialSaveQueue: Promise<void> = Promise.resolve();
    let credentialSaveFailed = false;
    const timeoutMs = options.timeoutMs ?? 120_000;
    return await new Promise<INeonWhatsAppLoginResult>((resolveLogin, rejectLogin) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        action();
      };
      const timeout = setTimeout(() => {
        finish(() => rejectLogin(new Error("WhatsApp linked-device login timed out")));
      }, timeoutMs);

      const queueCredentialSave = (): void => {
        credentialSaveQueue = credentialSaveQueue
          .then(async () => {
            await auth.saveCreds();
            await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
          })
          .catch(() => {
            credentialSaveFailed = true;
            finish(() => rejectLogin(new Error("WhatsApp credentials could not be persisted")));
          });
      };

      const openSocket = (): void => {
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
        activeSocket = socket;
        sockets.push(socket);
        socket.ev.on("creds.update", queueCredentialSave);
        socket.ev.on("connection.update", (value) => {
          void handleConnectionUpdate(socket, value).catch((error: unknown) => {
            const safeError = error instanceof Error ? error : new Error("WhatsApp login failed");
            finish(() => rejectLogin(safeError));
          });
        });
      };

      const handleConnectionUpdate = async (
        socket: INeonWhatsAppSocket,
        value: unknown
      ): Promise<void> => {
        if (socket !== activeSocket || !isRecord(value)) {
          return;
        }
        const qr = value["qr"];
        if (typeof qr === "string" && qr.length > 0) {
          qrShown = true;
          await (options.showQr ?? showNeonWhatsAppQr)(qr);
        }
        if (value["connection"] === "open") {
          await credentialSaveQueue;
          if (credentialSaveFailed) {
            throw new Error("WhatsApp credentials could not be persisted");
          }
          await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
          await assertNeonWhatsAppCredentialsPersisted(paths.whatsappAuthPath);
          await writeLinkedSessionMarker(paths.whatsappAuthPath, options.now?.() ?? new Date());
          await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
          await assertNeonWhatsAppAuthLinked(paths.whatsappAuthPath);
          finish(() =>
            resolveLogin({
              state: "linked",
              accountId: "default",
              qrShown,
              transportRestarts,
              sessionMarkerWritten: true,
              secretsPrinted: false
            })
          );
          return;
        }
        if (value["connection"] !== "close") {
          return;
        }
        const statusCode = readDisconnectStatusCode(value);
        const shouldRestart =
          transportRestarts === 0 &&
          (statusCode === 515 || (statusCode === 408 && qrShown));
        if (shouldRestart) {
          transportRestarts += 1;
          closeNeonWhatsAppSocket(socket);
          openSocket();
          return;
        }
        finish(() => rejectLogin(new Error("WhatsApp connection closed before login completed")));
      };

      openSocket();
    });
  } finally {
    for (const socket of sockets) {
      closeNeonWhatsAppSocket(socket);
    }
    restoreLogGuard();
    await sessionLock.release();
  }
}

export function closeNeonWhatsAppSocket(socket: INeonWhatsAppSocket): void {
  try {
    socket.end();
  } catch {
    // Transport cleanup must not mask the verified login or its original error.
  }
}

export function renderNeonWhatsAppLoginReport(result: INeonWhatsAppLoginResult): string {
  return [
    `WhatsApp login: ${result.state}`,
    `Account: ${result.accountId}`,
    `QR shown: ${result.qrShown ? "yes" : "not required (existing session)"}`,
    `Controlled transport restarts: ${result.transportRestarts}`,
    `Verified session marker: ${result.sessionMarkerWritten ? "written" : "missing"}`,
    `Secrets printed: ${result.secretsPrinted ? "yes" : "no"}`,
    "Outbound agent messages: suppressed"
  ].join("\n");
}

export async function loadNeonWhatsAppRuntime(): Promise<INeonBaileysRuntime> {
  const moduleName = "baileys";
  let loaded: unknown;
  try {
    loaded = await import(moduleName);
  } catch {
    throw new Error("WhatsApp runtime dependency is missing; reinstall Neonika");
  }
  if (!isRecord(loaded)) {
    throw new Error("WhatsApp runtime dependency has an unsupported shape");
  }
  const useMultiFileAuthState = loaded["useMultiFileAuthState"];
  const fetchLatestBaileysVersion = loaded["fetchLatestBaileysVersion"];
  const createSocket = loaded["default"] ?? loaded["makeWASocket"];
  if (
    typeof useMultiFileAuthState !== "function" ||
    typeof fetchLatestBaileysVersion !== "function" ||
    typeof createSocket !== "function"
  ) {
    throw new Error("WhatsApp runtime dependency has an unsupported API");
  }
  return {
    useMultiFileAuthState: async (path) => {
      const result = (await Reflect.apply(useMultiFileAuthState, loaded, [path])) as unknown;
      if (!isRecord(result) || typeof result["saveCreds"] !== "function") {
        throw new Error("WhatsApp auth runtime returned an invalid state");
      }
      const saveCreds = result["saveCreds"];
      return {
        state: result["state"],
        saveCreds: async () => {
          await Reflect.apply(saveCreds, result, []);
        }
      };
    },
    fetchLatestBaileysVersion: async () => {
      const result = (await Reflect.apply(fetchLatestBaileysVersion, loaded, [])) as unknown;
      if (!isRecord(result) || !Array.isArray(result["version"])) {
        throw new Error("WhatsApp runtime returned an invalid protocol version");
      }
      const version = result["version"].filter((entry): entry is number => typeof entry === "number");
      if (version.length < 3) {
        throw new Error("WhatsApp runtime returned an incomplete protocol version");
      }
      return { version };
    },
    createSocket: (socketOptions) => {
      const socket = Reflect.apply(createSocket, loaded, [socketOptions]) as unknown;
      if (!isRecord(socket) || !isRecord(socket["ev"]) || typeof socket["end"] !== "function") {
        throw new Error("WhatsApp runtime returned an invalid socket");
      }
      const emitter = socket["ev"];
      const on = emitter["on"];
      if (typeof on !== "function") {
        throw new Error("WhatsApp runtime returned an invalid event emitter");
      }
      const end = socket["end"];
      return {
        ev: {
          on: (event, listener) => {
            Reflect.apply(on, emitter, [event, listener]);
          }
        },
        end: (error) => {
          Reflect.apply(end, socket, error ? [error] : []);
        }
      };
    }
  };
}

async function showNeonWhatsAppQr(qr: string): Promise<void> {
  const moduleName = "qrcode-terminal";
  let loaded: unknown;
  try {
    loaded = await import(moduleName);
  } catch {
    throw new Error("QR renderer dependency is missing; reinstall Neonika");
  }
  const candidate = isRecord(loaded) ? loaded["default"] ?? loaded : loaded;
  if (!isRecord(candidate) || typeof candidate["generate"] !== "function") {
    throw new Error("QR renderer dependency has an unsupported API");
  }
  const generate = candidate["generate"];
  await new Promise<void>((resolveQr) => {
    Reflect.apply(generate, candidate, [qr, { small: true }, (rendered: string) => {
      process.stdout.write(`${rendered}\n`);
      resolveQr();
    }]);
  });
}

async function writeLinkedSessionMarker(authPath: string, now: Date): Promise<void> {
  const markerPath = join(authPath, "session.json");
  const tempPath = `${markerPath}.${randomUUID()}.tmp`;
  const marker = {
    version: 1,
    state: "linked",
    accountId: "default",
    verifiedAt: now.toISOString()
  } as const;
  try {
    await writeFile(tempPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await chmod(tempPath, 0o600);
    await rename(tempPath, markerPath);
    await chmod(markerPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export function createSilentNeonWhatsAppLogger(): Readonly<Record<string, unknown>> {
  const logger: Record<string, unknown> = {};
  const ignore = (): void => undefined;
  logger["level"] = "silent";
  logger["trace"] = ignore;
  logger["debug"] = ignore;
  logger["info"] = ignore;
  logger["warn"] = ignore;
  logger["error"] = ignore;
  logger["fatal"] = ignore;
  logger["child"] = () => logger;
  return logger;
}

export async function hardenNeonWhatsAppAuthDirectory(authPath: string): Promise<void> {
  await hardenAuthEntry(authPath, 0);
}

async function hardenAuthEntry(path: string, depth: number): Promise<void> {
  if (depth > 5) {
    throw new Error("WhatsApp auth directory nesting exceeds the supported depth");
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    throw new Error("WhatsApp auth state may not contain symbolic links");
  }
  if (entry.isDirectory()) {
    await chmod(path, 0o700);
    const children = await readdir(path);
    for (const child of children) {
      await hardenAuthEntry(join(path, child), depth + 1);
    }
    return;
  }
  if (!entry.isFile()) {
    throw new Error("WhatsApp auth state contains an unsupported filesystem entry");
  }
  await chmod(path, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDisconnectStatusCode(value: Record<string, unknown>): number | undefined {
  const lastDisconnect = value["lastDisconnect"];
  if (!isRecord(lastDisconnect)) {
    return undefined;
  }
  return findStatusCode(lastDisconnect["error"], 0);
}

function findStatusCode(value: unknown, depth: number): number | undefined {
  if (depth > 5 || !isRecord(value)) {
    return undefined;
  }
  for (const key of ["statusCode", "status", "code"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  for (const key of ["output", "data", "cause", "response"]) {
    const candidate = findStatusCode(value[key], depth + 1);
    if (candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}
