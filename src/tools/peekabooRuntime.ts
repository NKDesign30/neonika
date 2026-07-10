import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TNeonPeekabooBridgeSocketSource = "env" | "candidate" | "none";

export interface INeonPeekabooBridgeSocketResolution {
  readonly source: TNeonPeekabooBridgeSocketSource;
  readonly socketPath?: string;
  readonly candidates: readonly string[];
}

export interface IResolveNeonPeekabooBridgeSocketOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly exists?: (path: string) => boolean;
}

export interface INeonPeekabooAppServerEnv {
  readonly PATH: string;
  readonly PEEKABOO_BIN: string;
  readonly PEEKABOO_BRIDGE_SOCKET?: string;
}

const DEFAULT_PEEKABOO_BIN = "/opt/homebrew/bin/peekaboo";
const DEFAULT_PATH = "/usr/bin:/bin";
const BRIDGE_SOCKET_NAME = "bridge.sock";
const BRIDGE_APP_SUPPORT_DIRS = [
  "Peekaboo",
  "Claude",
  "OpenClaw",
  "clawdbot",
  "clawdis",
  "moltbot"
] as const;

export function resolveNeonPeekabooBin(env: NodeJS.ProcessEnv = process.env): string {
  return env["PEEKABOO_BIN"]?.trim() || DEFAULT_PEEKABOO_BIN;
}

export function resolveNeonPeekabooPathPrepend(peekabooBin: string): string | undefined {
  return peekabooBin.startsWith("/") ? dirname(peekabooBin) : undefined;
}

export function getNeonPeekabooBridgeSocketCandidates(homeDir: string = homedir()): readonly string[] {
  const appSupportDir = join(homeDir, "Library", "Application Support");

  return BRIDGE_APP_SUPPORT_DIRS.map((dir) => join(appSupportDir, dir, BRIDGE_SOCKET_NAME));
}

export function resolveNeonPeekabooBridgeSocket(
  options: IResolveNeonPeekabooBridgeSocketOptions = {}
): INeonPeekabooBridgeSocketResolution {
  const env = options.env ?? process.env;
  const candidates = getNeonPeekabooBridgeSocketCandidates(options.homeDir ?? env["HOME"] ?? homedir());
  const explicitSocket = env["PEEKABOO_BRIDGE_SOCKET"]?.trim();

  if (explicitSocket) {
    return {
      source: "env",
      socketPath: explicitSocket,
      candidates
    };
  }

  const exists = options.exists ?? existsSync;
  const socketPath = candidates.find((candidate) => exists(candidate));

  return {
    source: socketPath ? "candidate" : "none",
    ...(socketPath ? { socketPath } : {}),
    candidates
  };
}

export function createNeonPeekabooAppServerEnv(options: {
  readonly basePath?: string;
  readonly pathPrefix?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly exists?: (path: string) => boolean;
} = {}): INeonPeekabooAppServerEnv {
  const env = options.env ?? process.env;
  const peekabooBin = resolveNeonPeekabooBin(env);
  const peekabooDir = resolveNeonPeekabooPathPrepend(peekabooBin);
  const pathValue = [...(options.pathPrefix ?? []), peekabooDir, options.basePath ?? env["PATH"] ?? DEFAULT_PATH]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(":");
  const bridgeSocket = resolveNeonPeekabooBridgeSocket({
    env,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.exists ? { exists: options.exists } : {})
  });

  return {
    PATH: pathValue,
    PEEKABOO_BIN: peekabooBin,
    ...(bridgeSocket.socketPath ? { PEEKABOO_BRIDGE_SOCKET: bridgeSocket.socketPath } : {})
  };
}

export function renderNeonPeekabooBridgeSocketExportShell(homeDir: string): string {
  const candidates = getNeonPeekabooBridgeSocketCandidates(homeDir)
    .map((candidate) => quoteNeonShellValue(candidate))
    .join(" ");

  return [
    "if [ -z \"${PEEKABOO_BRIDGE_SOCKET:-}\" ]; then",
    `for socket in ${candidates}; do`,
    "if [ -S \"$socket\" ] || [ -e \"$socket\" ]; then",
    "export PEEKABOO_BRIDGE_SOCKET=\"$socket\";",
    "break;",
    "fi;",
    "done;",
    "fi"
  ].join(" ");
}

function quoteNeonShellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
