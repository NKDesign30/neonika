import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";

import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import type { IMemoryAttachment, IMemoryExcerpt } from "../harness/types.js";
import {
  createNeonMemoryDbProvider,
  defaultNeonMemoryDbPath,
  targetsRealNeonDb
} from "./neonMemoryDbProvider.js";

// Resolved from the environment so no operator's local layout is baked into the
// binary. Unset means "no CLI memory backend configured" — callers pass an
// explicit command, or use the SQLite provider in neonMemoryDbProvider.ts.
const memorySearchCommandEnvKey = "NEON_MEMORY_SEARCH_COMMAND" as const;

function resolveDefaultMemorySearchCommand(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return env[memorySearchCommandEnvKey]?.trim() ?? "";
}
const defaultMaxHits = 5;
const maxExcerptTextLength = 260;
const maxNoteLength = 420;
const maxMemoryWriteContentLength = 2_000;

export type TNeonMemoryMatchType = "fts" | "vector" | "hybrid";

export interface INeonMemorySearchHit {
  readonly source: string;
  readonly text: string;
  readonly score?: number;
  readonly matchType?: TNeonMemoryMatchType;
}

export interface INeonMemorySearchResult {
  readonly query: string;
  readonly hits: readonly INeonMemorySearchHit[];
  readonly diagnostics: readonly string[];
}

export interface INeonMemorySearchOptions {
  readonly maxHits?: number;
}

export interface INeonMemoryProvider {
  search(query: string, options?: INeonMemorySearchOptions): Promise<INeonMemorySearchResult>;
}

export interface INeonMemoryCliProviderOptions {
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly runCommand?: TNeonMemoryCommandRunner;
}

export type TNeonMemoryStatusState = "ready" | "degraded" | "unavailable";

export interface INeonMemoryStatus {
  readonly checkedAt: string;
  readonly diagnostics: readonly string[];
  readonly hitCount: number;
  readonly lastError?: string;
  readonly query: string;
  readonly state: TNeonMemoryStatusState;
}

export interface IReadNeonMemoryStatusOptions {
  readonly maxHits?: number;
  readonly now?: () => Date;
  readonly provider?: INeonMemoryProvider;
  readonly query?: string;
}

export interface INeonMemoryCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type TNeonMemoryCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number
) => Promise<INeonMemoryCommandResult>;

export function createNeonMemoryCliProvider(
  options: INeonMemoryCliProviderOptions = {}
): INeonMemoryProvider {
  const command = options.command ?? resolveDefaultMemorySearchCommand();
  const timeoutMs = options.timeoutMs ?? 6_000;
  const runCommand = options.runCommand ?? runMemorySearchCommand;

  return {
    search: async (query, searchOptions = {}) => {
      const result = await runCommand(command, [query], timeoutMs);
      const hits = parseMemorySearchOutput(result.stdout, searchOptions.maxHits ?? defaultMaxHits);
      const diagnostics = buildCommandDiagnostics(result);

      if (result.exitCode !== 0) {
        throw new Error(diagnostics.join("; ") || `memory-search exit=${result.exitCode}`);
      }

      return {
        query,
        hits,
        diagnostics
      };
    }
  };
}

/**
 * The autarkic default memory provider. Neonika must outlive the previous runtime, so
 * it reads the semantic memory DB directly when the DB file is present. Only when
 * the DB file is absent does it fall back to the legacy `memory-search` CLI, which
 * still calls v3's HTTP API. That fallback is surfaced as an explicit diagnostic
 * so the "v3-independent" claim stays honest: a missing DB degrades loudly (with
 * cause) instead of silently re-coupling Neonika to the previous runtime.
 *
 * Memory cutover (Slice K1): the primary DB path honours `NEON_MEMORY_DB_PATH`
 * (canonically the neonika `data/semantic-memory.db`). While the primary
 * differs from the frozen v2 DB, the v2 archive is searched as a read-only
 * secondary so consumers (chat context, merged provider) keep seeing the full
 * history - primary hits first, archive hits appended.
 */
export function createDefaultNeonMemoryProvider(
  options: { readonly dbPath?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {}
): INeonMemoryProvider {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath ?? (env["NEON_MEMORY_DB_PATH"]?.trim() || defaultNeonMemoryDbPath);
  if (existsSync(dbPath)) {
    const primary = createNeonMemoryDbProvider({ dbPath });
    // Realpath-safe check via targetsRealNeonDb: a symlink/`./`-variant of the
    // v2 default must not be merged with itself (duplicate hits).
    const useArchive = !targetsRealNeonDb(dbPath) && existsSync(defaultNeonMemoryDbPath);
    if (!useArchive) {
      return primary;
    }
    const archive = createNeonMemoryDbProvider({ dbPath: defaultNeonMemoryDbPath });
    return {
      search: async (query, searchOptions) => {
        const [primaryResult, archiveResult] = await Promise.allSettled([
          primary.search(query, searchOptions),
          archive.search(query, searchOptions)
        ]);
        const primaryOk = primaryResult.status === "fulfilled"
          ? primaryResult.value
          : { query, hits: [], diagnostics: ["primary memory DB search failed"] };
        const archiveOk = archiveResult.status === "fulfilled"
          ? archiveResult.value
          : { query, hits: [], diagnostics: ["v2 archive search failed (skipped)"] };
        // Same default as the sub-providers (defaultSearchLimit = 20) so the
        // composite never widens or narrows the contract on its own.
        const maxHits = searchOptions?.maxHits ?? 20;
        return {
          query,
          hits: [...primaryOk.hits, ...archiveOk.hits].slice(0, Math.max(maxHits, primaryOk.hits.length)),
          diagnostics: [...primaryOk.diagnostics, ...archiveOk.diagnostics]
        };
      }
    };
  }

  const fallback = createNeonMemoryCliProvider();
  return {
    search: async (query, searchOptions) => {
      const result = await fallback.search(query, searchOptions);
      return {
        ...result,
        diagnostics: [
          "memory DB absent; legacy memory-search fallback still depends on an external service",
          ...result.diagnostics
        ]
      };
    }
  };
}

// Memory write is gated by the shadow contract: the default mode is `dry-run`,
// which validates + redacts + plans a write but executes NOTHING. A productive
// write is hard-blocked unless BOTH an explicit `allowProductive` gate and a
// write command are injected. Upstream writes memory through its plugin-sdk
// memory host; Neonika has no productive write CLI, so this is rebuild-native:
// the gate IS the feature (productive blocked by default, no side effect).

export type TNeonMemoryWriteMode = "dry-run" | "productive";

export type TNeonMemoryWriteState = "planned" | "written" | "blocked";

export interface INeonMemoryWriteRequest {
  readonly content: string;
  readonly category?: string;
  readonly source?: string;
}

export interface INeonMemoryWriteOptions {
  readonly mode?: TNeonMemoryWriteMode;
}

export interface INeonMemoryWriteResult {
  readonly mode: TNeonMemoryWriteMode;
  readonly state: TNeonMemoryWriteState;
  /** The redacted content that would be (dry-run) or was (productive) written. */
  readonly redactedContent: string;
  /** The command name that would run in productive mode (no arguments, no secrets). */
  readonly command?: string;
  readonly diagnostics: readonly string[];
}

export interface INeonMemoryWriter {
  write(
    request: INeonMemoryWriteRequest,
    options?: INeonMemoryWriteOptions
  ): Promise<INeonMemoryWriteResult>;
}

export interface INeonMemoryCliWriterOptions {
  /** Productive write command. Absent => productive write stays blocked. */
  readonly command?: string;
  readonly timeoutMs?: number;
  readonly runCommand?: TNeonMemoryCommandRunner;
  /** Explicit productive gate. Default false => productive write stays blocked. */
  readonly allowProductive?: boolean;
}

export function createNeonMemoryCliWriter(
  options: INeonMemoryCliWriterOptions = {}
): INeonMemoryWriter {
  const timeoutMs = options.timeoutMs ?? 6_000;
  const allowProductive = options.allowProductive ?? false;

  return {
    write: async (request, writeOptions = {}) => {
      const mode = writeOptions.mode ?? "dry-run";
      const redactedContent = truncateText(
        redactText(request.content.replace(/\s+/g, " ").trim()),
        maxMemoryWriteContentLength
      );
      const category = request.category ? redactText(request.category) : undefined;

      if (redactedContent.length === 0) {
        return {
          mode,
          state: "blocked",
          redactedContent,
          diagnostics: ["memory-write blocked: empty content"]
        };
      }

      if (mode !== "productive") {
        return {
          mode: "dry-run",
          state: "planned",
          redactedContent,
          ...(options.command ? { command: options.command } : {}),
          diagnostics: [
            "dry-run: no memory write executed",
            ...(category ? [`category=${category}`] : [])
          ]
        };
      }

      if (!allowProductive || !options.command) {
        return {
          mode: "productive",
          state: "blocked",
          redactedContent,
          ...(options.command ? { command: options.command } : {}),
          diagnostics: [
            "productive memory-write blocked: requires allowProductive gate and a write command"
          ]
        };
      }

      const runCommand = options.runCommand ?? runMemorySearchCommand;
      const args = [
        redactedContent,
        ...(request.category ? ["--category", redactText(request.category)] : [])
      ];
      const result = await runCommand(options.command, args, timeoutMs);

      return {
        mode: "productive",
        state: result.exitCode === 0 ? "written" : "blocked",
        redactedContent,
        command: options.command,
        diagnostics: buildCommandDiagnostics(result)
      };
    }
  };
}

export async function createNeonMemoryAttachment(
  provider: INeonMemoryProvider,
  query: string,
  options: INeonMemorySearchOptions = {}
): Promise<IMemoryAttachment> {
  try {
    const result = await provider.search(query, options);

    if (result.hits.length === 0) {
      return {
        state: "skipped",
        hitCount: 0,
        note: "No Neonika Memory hits"
      };
    }

    const excerpts = result.hits.map(toMemoryExcerpt);

    return {
      state: "attached",
      hitCount: excerpts.length,
      note: buildMemoryAttachmentNote(excerpts),
      excerpts
    };
  } catch (error) {
    return {
      state: "failed",
      hitCount: 0,
      note: `Neonika Memory search failed: ${error instanceof Error ? redactText(error.message) : "unknown error"}`
    };
  }
}

export async function readNeonMemoryStatus(
  options: IReadNeonMemoryStatusOptions = {}
): Promise<INeonMemoryStatus> {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const query = options.query ?? "neon core memory";
  const provider = options.provider ?? createDefaultNeonMemoryProvider();

  try {
    const result = await provider.search(query, {
      maxHits: options.maxHits ?? 3
    });
    const diagnostics = result.diagnostics.map((diagnostic) => redactText(diagnostic));

    return {
      checkedAt,
      diagnostics,
      hitCount: result.hits.length,
      query,
      state: diagnostics.length > 0 ? "degraded" : "ready"
    };
  } catch (error) {
    return {
      checkedAt,
      diagnostics: [],
      hitCount: 0,
      lastError: error instanceof Error ? redactText(error.message) : "unknown error",
      query,
      state: "unavailable"
    };
  }
}

export function parseMemorySearchOutput(
  output: string,
  maxHits: number = defaultMaxHits
): readonly INeonMemorySearchHit[] {
  const hits: INeonMemorySearchHit[] = [];
  let currentSource: string | undefined;
  let currentText: string[] = [];

  const flush = (): void => {
    if (!currentSource) {
      currentText = [];
      return;
    }

    const text = normalizeMemoryText(currentText.join(" "));

    if (text.length > 0) {
      hits.push({
        source: currentSource,
        text
      });
    }

    currentSource = undefined;
    currentText = [];
  };

  for (const line of output.split(/\r?\n/)) {
    const source = parseMemorySourceLine(line);

    if (source) {
      flush();
      currentSource = source;
      continue;
    }

    if (currentSource && isMemoryContentLine(line)) {
      currentText.push(stripMemoryContentPrefix(line));
    }

    if (hits.length >= maxHits) {
      break;
    }
  }

  flush();

  return hits.slice(0, maxHits);
}

function parseMemorySourceLine(line: string): string | undefined {
  const match = /^\s*\[([^\]]+)\]/.exec(line);

  if (!match) {
    return undefined;
  }

  return redactText(match[1] ?? "memory");
}

function isMemoryContentLine(line: string): boolean {
  return /^\s{4,}-\s+/.test(line) || /^\s{4,}\S/.test(line);
}

function stripMemoryContentPrefix(line: string): string {
  return line.replace(/^\s{4,}-\s+/, "").trim();
}

function normalizeMemoryText(text: string): string {
  return truncateText(redactText(text.replace(/\s+/g, " ").trim()), maxExcerptTextLength);
}

function toMemoryExcerpt(hit: INeonMemorySearchHit): IMemoryExcerpt {
  return {
    source: hit.source,
    text: normalizeMemoryText(hit.text)
  };
}

function buildMemoryAttachmentNote(excerpts: readonly IMemoryExcerpt[]): string {
  const note = `Attached ${excerpts.length} Neonika Memory hit(s): ${excerpts
    .map((excerpt) => excerpt.source)
    .join(", ")}`;

  return truncateText(note, maxNoteLength);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${truncateUtf16Safe(text, maxLength - 1)}…`;
}

async function runMemorySearchCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number
): Promise<INeonMemoryCommandResult> {
  // Only the real runner needs an executable; injected runners are free to
  // ignore the command string. 127 is the shell's "command not found", so an
  // unconfigured backend degrades exactly like a missing binary rather than
  // surfacing a raw execFile("") error.
  if (command.trim() === "") {
    return {
      exitCode: 127,
      stdout: "",
      stderr: `No memory-search command configured - set ${memorySearchCommandEnvKey} or pass options.command.`
    };
  }

  return await new Promise<INeonMemoryCommandResult>((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 256 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: readExitCode(error),
          stdout,
          stderr
        });
      }
    );
  });
}

function buildCommandDiagnostics(result: INeonMemoryCommandResult): readonly string[] {
  const diagnostics: string[] = [];

  if (result.exitCode !== 0) {
    diagnostics.push(`memory-search exit=${result.exitCode}`);
  }

  if (result.stderr.trim().length > 0) {
    diagnostics.push(redactText(result.stderr.trim()));
  }

  return diagnostics;
}

function readExitCode(error: ExecFileException | null): number {
  if (!error) {
    return 0;
  }

  if (typeof error.code === "number") {
    return error.code;
  }

  return 1;
}
