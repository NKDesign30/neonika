import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

import type {
  ICodexAppServerRequest,
  ICodexAppServerResponse,
  ICodexAppServerStartOptions
} from "./appServerProtocol.js";
import { NeonBoundedLineReader } from "./boundedLineReader.js";
import type { ICodexJsonRpcTransport } from "./jsonRpcClient.js";
import { redactText } from "./redaction.js";

const SAFE_INHERITED_ENV_KEYS = new Set([
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME"
]);
const UNSAFE_ENVIRONMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STDERR_TAIL_MAX = 2_000;
const JSON_PREVIEW_MAX = 500;

export interface IStdioChildProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(eventName: "error", listener: (error: Error) => void): this;
  once(eventName: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
  unref?(): void;
}

export interface ICodexStdioSpawnOptions {
  readonly cwd?: string;
  readonly detached: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: boolean;
}

export type TCodexStdioSpawn = (
  command: string,
  args: readonly string[],
  options: ICodexStdioSpawnOptions
) => IStdioChildProcess;

export interface ICodexStdioTransportRuntime {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: TCodexStdioSpawn;
}

export interface ICodexStdioJsonRpcTransportOptions {
  readonly maxStdoutLineBytes?: number | undefined;
}

export class CodexStdioJsonRpcTransport implements ICodexJsonRpcTransport {
  private readonly events = new EventEmitter();
  private readonly stdoutReader: NeonBoundedLineReader;
  private stderrTail = "";
  private closing = false;
  private closed = false;

  constructor(
    private readonly child: IStdioChildProcess,
    options: ICodexStdioJsonRpcTransportOptions = {}
  ) {
    this.stdoutReader = new NeonBoundedLineReader({
      input: child.stdout,
      errorLabel: "Codex app-server stdio transport",
      maxLineBytes: options.maxStdoutLineBytes,
      onLine: (line) => {
        this.handleLine(line);
      },
      onError: (error) => {
        this.fail(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrTail = appendBoundedTail(this.stderrTail, chunk.toString(), STDERR_TAIL_MAX);
    });
    child.stderr.on("error", (error: Error) => {
      this.stderrTail = appendBoundedTail(this.stderrTail, error.message, STDERR_TAIL_MAX);
    });
    child.once("error", (error) => {
      this.fail(error);
    });
    child.once("exit", (code, signal) => {
      if (this.closing) {
        this.closed = true;
        return;
      }

      this.fail(createExitError(code, signal, this.stderrTail));
    });
  }

  async send(message: ICodexAppServerRequest | ICodexAppServerResponse): Promise<void> {
    if (this.closed || this.closing) {
      throw new Error("Codex app-server stdio transport is closed");
    }

    const frame = `${JSON.stringify(message)}\n`;

    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.events.on("message", handler);

    return () => {
      this.events.off("message", handler);
    };
  }

  onClose(handler: (error?: Error) => void): () => void {
    this.events.on("close", handler);

    return () => {
      this.events.off("close", handler);
    };
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) {
      return;
    }

    this.closing = true;
    this.stdoutReader.close();
    this.child.stdin.end();

    if (!this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }

    this.child.unref?.();
    this.closed = true;
    this.events.removeAllListeners();
  }

  getStderrTailForTests(): string {
    return this.stderrTail;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(trimmed);

      this.events.emit("message", parsed);
    } catch {
      const preview = redactText(trimmed.slice(0, JSON_PREVIEW_MAX));

      this.fail(new Error(`Codex app-server emitted invalid JSON on stdout: preview=${preview}`));
    }
  }

  private fail(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.closing = true;
    this.stdoutReader.close();

    if (!this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }

    this.events.emit("close", error);
    this.events.removeAllListeners();
  }
}

export function createCodexStdioTransport(
  options: ICodexAppServerStartOptions,
  runtime: ICodexStdioTransportRuntime = {}
): CodexStdioJsonRpcTransport {
  if (options.transport !== "stdio") {
    throw new Error("Codex stdio transport requires stdio start options");
  }

  if (!options.command) {
    throw new Error("Codex stdio transport requires a command");
  }

  const platform = runtime.platform ?? process.platform;
  const spawnChild = runtime.spawn ?? spawnStdioChild;
  const child = spawnChild(options.command, options.args ?? [], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: platform !== "win32",
    env: resolveCodexStdioEnvironment(options, runtime.baseEnv ?? process.env, platform),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  return new CodexStdioJsonRpcTransport(child);
}

export function resolveCodexStdioEnvironment(
  options: ICodexAppServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;

  if (options.inheritEnv) {
    copySafeEnvironmentEntries(env, baseEnv);
  } else {
    copySafeEnvironmentEntries(env, pickSafeBaseEnvironment(baseEnv));
  }

  copySafeEnvironmentEntries(env, options.env ?? {});
  clearEnvironmentKeys(env, options.clearEnv, platform);

  return env;
}

function spawnStdioChild(
  command: string,
  args: readonly string[],
  options: ICodexStdioSpawnOptions
): IStdioChildProcess {
  return spawn(command, [...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    detached: options.detached,
    env: options.env,
    stdio: [...options.stdio],
    windowsHide: options.windowsHide
  });
}

function pickSafeBaseEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && (SAFE_INHERITED_ENV_KEYS.has(key) || key.startsWith("LC_"))) {
      env[key] = value;
    }
  }

  return env;
}

function copySafeEnvironmentEntries(
  target: NodeJS.ProcessEnv,
  source: Readonly<Record<string, string | undefined>>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_ENVIRONMENT_KEYS.has(key) || value === undefined) {
      continue;
    }

    target[key] = value;
  }
}

function clearEnvironmentKeys(
  target: NodeJS.ProcessEnv,
  rawKeys: readonly string[],
  platform: NodeJS.Platform
): void {
  const keys = rawKeys.map((key) => key.trim()).filter((key) => key.length > 0);

  if (platform !== "win32") {
    for (const key of keys) {
      delete target[key];
    }

    return;
  }

  const lowerCaseKeys = new Set(keys.map((key) => key.toLowerCase()));

  for (const key of Object.keys(target)) {
    if (lowerCaseKeys.has(key.toLowerCase())) {
      delete target[key];
    }
  }
}

function createExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string
): Error {
  const suffix = stderrTail.trim() ? ` stderr_tail=${redactText(stderrTail.trim())}` : "";

  return new Error(`Codex app-server stdio transport exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}${suffix}`);
}

function formatExitValue(value: number | string | null): string {
  return value === null ? "null" : String(value);
}

function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = `${current}${next}`;

  if (combined.length <= maxLength) {
    return combined;
  }

  return combined.slice(combined.length - maxLength);
}
