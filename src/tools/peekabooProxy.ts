import { spawn } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { dirname, join } from "node:path";

import { resolveNeonPeekabooBin } from "./peekabooRuntime.js";

export interface INeonPeekabooProxyRequest {
  readonly args: readonly string[];
}

export interface INeonPeekabooProxyResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface INeonPeekabooProxyServerHandle {
  readonly socketPath: string;
  readonly tcpUrl: string;
  readonly close: () => Promise<void>;
}

export interface IListenNeonPeekabooProxyOptions {
  readonly projectRoot: string;
  readonly socketPath?: string;
  readonly tcpHost?: string;
  readonly tcpPort?: number;
  readonly targetBin?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface IRequestNeonPeekabooProxyOptions {
  readonly socketPath?: string;
  readonly tcpUrl?: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface IRenderNeonPeekabooProxyShimScriptOptions {
  readonly projectRoot: string;
  readonly socketPath: string;
  readonly tcpUrl?: string;
  readonly nodePath: string;
  readonly targetBin: string;
}

const DEFAULT_PROXY_TIMEOUT_MS = 180_000;
const DEFAULT_PROXY_TCP_HOST = "127.0.0.1";
const DEFAULT_PROXY_TCP_PORT = 18_790;
export const NEON_PEEKABOO_PROXY_MAX_JSON_BYTES = 16 * 1024 * 1024;
export const NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES = 1024 * 1024;

const peekabooProxyTruncationMarker = "... (truncated) ";

export function resolveNeonPeekabooProxySocketPath(projectRoot: string): string {
  return join(projectRoot, "state", "gateway", "peekaboo-proxy.sock");
}

export function resolveNeonPeekabooProxyTcpUrl(
  host: string = DEFAULT_PROXY_TCP_HOST,
  port: number = DEFAULT_PROXY_TCP_PORT
): string {
  return `tcp://${host}:${port}`;
}

export function renderNeonPeekabooProxyShimScript(
  options: IRenderNeonPeekabooProxyShimScriptOptions
): string {
  return [
    "#!/bin/sh",
    "set -eu",
    `PROXY_URL="\${NEON_PEEKABOO_PROXY_URL:-${options.tcpUrl ?? ""}}"`,
    "if [ -n \"$PROXY_URL\" ]; then",
    `  cd ${quotePosixDouble(options.projectRoot)}`,
    `  exec ${quotePosixDouble(options.nodePath)} dist/src/cli.js peekaboo-proxy-client "$@"`,
    "fi",
    `SOCKET="\${NEON_PEEKABOO_PROXY_SOCKET:-${options.socketPath}}"`,
    "if [ -S \"$SOCKET\" ]; then",
    `  cd ${quotePosixDouble(options.projectRoot)}`,
    `  exec ${quotePosixDouble(options.nodePath)} dist/src/cli.js peekaboo-proxy-client "$@"`,
    "fi",
    `exec ${quotePosixDouble(options.targetBin)} "$@"`,
    ""
  ].join("\n");
}

export async function listenNeonPeekabooProxy(
  options: IListenNeonPeekabooProxyOptions
): Promise<INeonPeekabooProxyServerHandle> {
  const socketPath = options.socketPath ?? resolveNeonPeekabooProxySocketPath(options.projectRoot);
  const tcpHost = options.tcpHost ?? DEFAULT_PROXY_TCP_HOST;
  const tcpPort = options.tcpPort ?? DEFAULT_PROXY_TCP_PORT;
  const targetBin = options.targetBin ?? resolveNeonPeekabooBin(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const createProxyServer = (): Server => createServer((socket) => {
    let raw = "";
    let handled = false;
    const finish = (response: INeonPeekabooProxyResponse): void => {
      socket.write(JSON.stringify(response));
      socket.end();
    };
    const handleOnce = (): void => {
      if (handled) {
        return;
      }

      handled = true;
      void handleProxySocketRequest(socket, raw, { targetBin, timeoutMs, env: options.env ?? process.env });
    };
    const rejectOversizedRequest = (): void => {
      if (handled) {
        return;
      }

      handled = true;
      finish({
        exitCode: 64,
        stdout: "",
        stderr: "",
        error: `Peekaboo proxy request exceeded ${NEON_PEEKABOO_PROXY_MAX_JSON_BYTES} bytes`
      });
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const nextRaw = `${raw}${chunk}`;
      const newlineIndex = nextRaw.indexOf("\n");
      if (newlineIndex >= 0) {
        raw = nextRaw.slice(0, newlineIndex);
        handleOnce();
        return;
      }
      if (Buffer.byteLength(nextRaw, "utf8") > NEON_PEEKABOO_PROXY_MAX_JSON_BYTES) {
        rejectOversizedRequest();
        return;
      }
      raw = nextRaw;
    });
    socket.on("end", () => {
      handleOnce();
    });
  });
  const socketServer = createProxyServer();
  const tcpServer = createProxyServer();

  await mkdir(dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });
  await listenOnUnixSocket(socketServer, socketPath);
  await chmod(socketPath, 0o600);
  try {
    await listenOnTcp(tcpServer, tcpHost, tcpPort);
  } catch (error) {
    await closeServer(socketServer, socketPath);
    throw error;
  }
  const tcpAddress = tcpServer.address() as AddressInfo | null;
  const tcpUrl = resolveNeonPeekabooProxyTcpUrl(tcpHost, tcpAddress?.port ?? tcpPort);

  return {
    socketPath,
    tcpUrl,
    close: async () => {
      await Promise.all([closeServer(socketServer, socketPath), closeTcpServer(tcpServer)]);
    }
  };
}

export async function requestNeonPeekabooProxy(
  options: IRequestNeonPeekabooProxyOptions
): Promise<INeonPeekabooProxyResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;

  return new Promise<INeonPeekabooProxyResponse>((resolve, reject) => {
    const client = createProxyClient(options);
    let raw = "";
    let rawBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new Error(`Peekaboo proxy request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      fn();
    };

    client.setEncoding("utf8");
    client.on("connect", () => {
      client.write(`${JSON.stringify({ args: options.args })}\n`);
    });
    client.on("data", (chunk) => {
      rawBytes += Buffer.byteLength(chunk, "utf8");
      if (rawBytes > NEON_PEEKABOO_PROXY_MAX_JSON_BYTES) {
        settle(() => {
          client.destroy();
          reject(new Error(`Peekaboo proxy response exceeded ${NEON_PEEKABOO_PROXY_MAX_JSON_BYTES} bytes`));
        });
        return;
      }
      raw += chunk;
    });
    client.on("error", (error) => {
      settle(() => reject(error));
    });
    client.on("end", () => {
      settle(() => {
        const response = parseProxyResponse(raw);

        if (!response) {
          reject(new Error("Peekaboo proxy returned malformed JSON"));
          return;
        }

        resolve(response);
      });
    });
  });
}

function truncateUtf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  const markerBytes = Buffer.byteLength(peekabooProxyTruncationMarker, "utf8");
  const tailBudget = Math.max(0, maxBytes - markerBytes);
  let start = Math.max(0, bytes.byteLength - tailBudget);
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) {
    start += 1;
  }

  return `${peekabooProxyTruncationMarker}${bytes.subarray(start).toString("utf8")}`;
}

function appendBoundedUtf8Tail(current: string, next: string, maxBytes: number): string {
  return truncateUtf8Tail(`${current}${next}`, maxBytes);
}

function createProxyClient(options: IRequestNeonPeekabooProxyOptions): ReturnType<typeof createConnection> {
  if (options.tcpUrl?.trim()) {
    const parsed = parseTcpUrl(options.tcpUrl);

    return createConnection({ host: parsed.host, port: parsed.port });
  }

  if (options.socketPath?.trim()) {
    return createConnection(options.socketPath);
  }

  throw new Error("Peekaboo proxy request requires tcpUrl or socketPath");
}

function parseTcpUrl(value: string): { readonly host: string; readonly port: number } {
  const parsed = new URL(value);

  if (parsed.protocol !== "tcp:" || parsed.hostname !== DEFAULT_PROXY_TCP_HOST) {
    throw new Error("Peekaboo proxy TCP URL must use tcp://127.0.0.1:<port>");
  }

  const port = Number(parsed.port);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Peekaboo proxy TCP URL has an invalid port");
  }

  return { host: parsed.hostname, port };
}

async function handleProxySocketRequest(
  socket: NodeJS.WritableStream,
  raw: string,
  options: {
    readonly targetBin: string;
    readonly timeoutMs: number;
    readonly env: NodeJS.ProcessEnv;
  }
): Promise<void> {
  const request = parseProxyRequest(raw);
  const response = request
    ? await executePeekabooRequest(request, options)
    : { exitCode: 64, stdout: "", stderr: "", error: "Malformed Peekaboo proxy request" };

  socket.write(JSON.stringify(response));
  socket.end();
}

async function executePeekabooRequest(
  request: INeonPeekabooProxyRequest,
  options: {
    readonly targetBin: string;
    readonly timeoutMs: number;
    readonly env: NodeJS.ProcessEnv;
  }
): Promise<INeonPeekabooProxyResponse> {
  return new Promise<INeonPeekabooProxyResponse>((resolve) => {
    const child = spawn(options.targetBin, [...request.args], {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBoundedUtf8Tail(stdout, chunk, NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBoundedUtf8Tail(stderr, chunk, NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ exitCode: 127, stdout, stderr, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr,
        ...(timedOut ? { error: `Peekaboo proxy timed out after ${options.timeoutMs}ms` } : {}),
        ...(!timedOut && signal ? { error: `Peekaboo exited via signal ${signal}` } : {})
      });
    });
  });
}

function parseProxyRequest(raw: string): INeonPeekabooProxyRequest | undefined {
  const parsed = parseJson(raw);

  if (!isRecord(parsed) || !Array.isArray(parsed["args"])) {
    return undefined;
  }

  const args = parsed["args"];

  if (!args.every((arg): arg is string => typeof arg === "string")) {
    return undefined;
  }

  return { args };
}

function parseProxyResponse(raw: string): INeonPeekabooProxyResponse | undefined {
  const parsed = parseJson(raw);

  if (
    !isRecord(parsed) ||
    typeof parsed["exitCode"] !== "number" ||
    typeof parsed["stdout"] !== "string" ||
    typeof parsed["stderr"] !== "string"
  ) {
    return undefined;
  }

  return {
    exitCode: parsed["exitCode"],
    stdout: parsed["stdout"],
    stderr: parsed["stderr"],
    ...(typeof parsed["error"] === "string" ? { error: parsed["error"] } : {})
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listenOnUnixSocket(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function listenOnTcp(server: Server, host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server, socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      void rm(socketPath, { force: true })
        .then(() => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        })
        .catch(reject);
    });
  });
}

function closeTcpServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function quotePosixDouble(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}
