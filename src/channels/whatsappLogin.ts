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
  readonly protocolVersionCurrent: boolean;
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
  fetchProtocolVersion(): Promise<INeonWhatsAppProtocolVersion>;
  createSocket(options: Readonly<Record<string, unknown>>): INeonWhatsAppSocket;
}

export interface INeonWhatsAppProtocolVersion {
  readonly version: readonly number[];
  /**
   * False when the resolver could not reach WhatsApp and fell back to the
   * version bundled with the installed Baileys release. A stale protocol
   * version is refused by current servers, so this must stay visible instead of
   * failing later as an unexplained disconnect.
   */
  readonly isCurrent: boolean;
}

export interface INeonWhatsAppSocket {
  readonly ev: {
    on(event: string, listener: (value: unknown) => void): void;
  };
  readonly sendText?: (
    peerJid: string,
    body: string,
    messageId: string
  ) => Promise<{ readonly messageId: string }>;
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
    const { version, isCurrent } = await runtime.fetchProtocolVersion();
    if (!isCurrent) {
      process.stderr.write(
        "WhatsApp protocol version could not be confirmed against WhatsApp Web; the server may refuse this login.\n"
      );
    }
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

      // Only the write is serialised here. Hardening walks the whole auth tree
      // and Baileys creates and unlinks pre-key files throughout pairing, so
      // doing it per credential event races that churn. It runs once the burst
      // has been flushed, just before the state is validated.
      const queueCredentialSave = (): void => {
        credentialSaveQueue = credentialSaveQueue
          .then(() => auth.saveCreds())
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
          // `open` is not the last credential event: Baileys emits a further
          // `creds.update` right after it. Appending the verification to the
          // same queue the writes use keeps that late save from rewriting
          // creds.json underneath the check, without guessing at a delay.
          const verification = credentialSaveQueue.then(async () => {
            if (credentialSaveFailed) {
              throw new Error("WhatsApp credentials could not be persisted");
            }
            await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
            await assertNeonWhatsAppCredentialsPersisted(paths.whatsappAuthPath);
            await writeLinkedSessionMarker(paths.whatsappAuthPath, options.now?.() ?? new Date());
            await hardenNeonWhatsAppAuthDirectory(paths.whatsappAuthPath);
            await assertNeonWhatsAppAuthLinked(paths.whatsappAuthPath);
          });
          credentialSaveQueue = verification.catch(() => undefined);
          await verification;
          finish(() =>
            resolveLogin({
              state: "linked",
              accountId: "default",
              qrShown,
              transportRestarts,
              sessionMarkerWritten: true,
              secretsPrinted: false,
              protocolVersionCurrent: isCurrent
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
    `Protocol version: ${result.protocolVersionCurrent ? "confirmed against WhatsApp Web" : "unconfirmed (bundled fallback)"}`,
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
  // `fetchLatestBaileysVersion` reads the version pinned in the Baileys
  // repository, which trails the live WhatsApp Web protocol and gets refused by
  // current servers. `fetchLatestWaWebVersion` reads the revision WhatsApp Web
  // itself ships, so it is the one to use whenever the installed release has it.
  const fetchWaWebVersion = loaded["fetchLatestWaWebVersion"];
  const fetchPinnedVersion = loaded["fetchLatestBaileysVersion"];
  const resolveVersion =
    typeof fetchWaWebVersion === "function" ? fetchWaWebVersion : fetchPinnedVersion;
  const createSocket = loaded["default"] ?? loaded["makeWASocket"];
  if (
    typeof useMultiFileAuthState !== "function" ||
    typeof resolveVersion !== "function" ||
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
    fetchProtocolVersion: async () => {
      const result = (await Reflect.apply(resolveVersion, loaded, [])) as unknown;
      if (!isRecord(result) || !Array.isArray(result["version"])) {
        throw new Error("WhatsApp runtime returned an invalid protocol version");
      }
      const version = result["version"].filter((entry): entry is number => typeof entry === "number");
      if (version.length < 3) {
        throw new Error("WhatsApp runtime returned an incomplete protocol version");
      }
      // Baileys reports a failed lookup by returning its bundled version with
      // `isLatest: false` instead of throwing, so the flag is the only signal.
      return { version, isCurrent: result["isLatest"] === true };
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
      const sendMessage = socket["sendMessage"];
      return {
        ev: {
          on: (event, listener) => {
            Reflect.apply(on, emitter, [event, listener]);
          }
        },
        ...(typeof sendMessage === "function"
          ? {
              sendText: async (peerJid: string, body: string, messageId: string) => {
                const sent = (await Reflect.apply(sendMessage, socket, [
                  peerJid,
                  { text: body },
                  { messageId }
                ])) as unknown;
                const key = isRecord(sent) ? sent["key"] : undefined;
                const returnedMessageId =
                  isRecord(key) && typeof key["id"] === "string" ? key["id"].trim() : "";
                if (returnedMessageId === "") {
                  throw new Error("WhatsApp transport returned no message id");
                }
                return { messageId: returnedMessageId };
              }
            }
          : {}),
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
  // Baileys rotates pre-key files while this walk runs, so a child listed a
  // moment ago can already be gone. A file that no longer exists cannot carry
  // unsafe permissions, so skipping it is safe and every entry still present is
  // still hardened. The root is different: its absence means the auth state is
  // gone entirely, which must stay an error.
  const entry = depth === 0 ? await lstat(path) : await ignoreMissingEntry(() => lstat(path));
  if (entry === undefined) {
    return;
  }
  if (entry.isSymbolicLink()) {
    throw new Error("WhatsApp auth state may not contain symbolic links");
  }
  if (entry.isDirectory()) {
    await ignoreMissingEntry(() => chmod(path, 0o700));
    const children = await ignoreMissingEntry(() => readdir(path));
    for (const child of children ?? []) {
      await hardenAuthEntry(join(path, child), depth + 1);
    }
    return;
  }
  if (!entry.isFile()) {
    throw new Error("WhatsApp auth state contains an unsupported filesystem entry");
  }
  await ignoreMissingEntry(() => chmod(path, 0o600));
}

async function ignoreMissingEntry<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (isMissingEntryError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
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
