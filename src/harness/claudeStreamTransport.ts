import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { NeonBoundedLineReader } from "./boundedLineReader.js";
import { redactText } from "./redaction.js";
import type { IStdioChildProcess } from "./stdioTransport.js";

/**
 * Newline-delimited stream transport for the `claude` CLI in stream-json mode.
 *
 * Unlike the Codex transport this is NOT JSON-RPC: `claude --input-format
 * stream-json --output-format stream-json` reads one user message object per
 * line on stdin and writes one event object per line on stdout. The transport
 * therefore deals in already-encoded NDJSON lines on `send` and parsed JSON
 * objects on `onMessage`; the harness owns the protocol mapping.
 */
export interface IClaudeStreamTransport {
  /** Write an already newline-terminated stream-json frame to stdin. */
  send(line: string): Promise<void>;
  /** Subscribe to each parsed stdout JSON object. Returns an unsubscribe fn. */
  onMessage(handler: (message: unknown) => void): () => void;
  /** Subscribe to transport close (clean or error). Returns an unsubscribe fn. */
  onClose(handler: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

const STDERR_TAIL_MAX = 2_000;
const JSON_PREVIEW_MAX = 500;
const SAFE_INHERITED_ENV_KEYS = new Set([
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

export interface IClaudeStreamProcessTransportOptions {
  readonly maxStdoutLineBytes?: number | undefined;
}

export class ClaudeStreamProcessTransport implements IClaudeStreamTransport {
  private readonly events = new EventEmitter();
  private readonly stdoutReader: NeonBoundedLineReader;
  private stderrTail = "";
  private closing = false;
  private closed = false;

  constructor(
    private readonly child: IStdioChildProcess,
    options: IClaudeStreamProcessTransportOptions = {}
  ) {
    this.stdoutReader = new NeonBoundedLineReader({
      input: child.stdout,
      errorLabel: "Claude stream transport",
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
        this.events.emit("close");
        this.events.removeAllListeners();
        return;
      }

      this.fail(createExitError(code, signal, this.stderrTail));
    });
  }

  async send(line: string): Promise<void> {
    if (this.closed || this.closing) {
      throw new Error("Claude stream transport is closed");
    }

    const frame = line.endsWith("\n") ? line : `${line}\n`;

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

      this.fail(new Error(`Claude CLI emitted invalid JSON on stdout: preview=${preview}`));
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

export interface IClaudeProcessSpawnOptions {
  readonly cwd?: string;
  readonly detached: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  readonly windowsHide: boolean;
}

export type TClaudeProcessSpawn = (
  command: string,
  args: readonly string[],
  options: IClaudeProcessSpawnOptions
) => IStdioChildProcess;

export interface IClaudeProcessTransportSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly inheritEnv?: boolean;
}

export interface IClaudeProcessTransportRuntime {
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: TClaudeProcessSpawn;
}

export function createClaudeProcessTransport(
  spec: IClaudeProcessTransportSpec,
  runtime: IClaudeProcessTransportRuntime = {}
): ClaudeStreamProcessTransport {
  if (!spec.command) {
    throw new Error("Claude stream transport requires a command");
  }

  const platform = runtime.platform ?? process.platform;
  const spawnChild = runtime.spawn ?? spawnClaudeChild;
  const child = spawnChild(spec.command, spec.args, {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    detached: platform !== "win32",
    env: resolveClaudeEnvironment(spec, runtime.baseEnv ?? process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  return new ClaudeStreamProcessTransport(child);
}

export function resolveClaudeEnvironment(
  spec: IClaudeProcessTransportSpec,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;

  if (spec.inheritEnv) {
    copySafeEnvironmentEntries(env, baseEnv);
  } else {
    copySafeEnvironmentEntries(env, pickSafeBaseEnvironment(baseEnv));
  }

  copySafeEnvironmentEntries(env, spec.env ?? {});

  return env;
}

function spawnClaudeChild(
  command: string,
  args: readonly string[],
  options: IClaudeProcessSpawnOptions
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

function createExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string
): Error {
  const suffix = stderrTail.trim() ? ` stderr_tail=${redactText(stderrTail.trim())}` : "";

  return new Error(
    `Claude stream transport exited: code=${formatExitValue(code)} signal=${formatExitValue(signal)}${suffix}`
  );
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
