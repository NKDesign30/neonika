import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";
import type {
  INeonMemoryWriteRequest,
  TNeonMemoryWriteMode,
  TNeonMemoryWriteState
} from "./neonMemory.js";

/**
 * Productive memory-write runtime (DP-11).
 *
 * The existing `createNeonMemoryCliWriter` plans a redacted dry-run and hard-blocks
 * productive writes. This adds the actual gated productive path WITHOUT ever touching
 * the real semantic-memory DB: it persists a redacted entry to an isolated JSON store
 * file that the operator explicitly designates via `storePath`. Two independent gates
 * must both be set for a write to happen — `NEON_MEMORY_WRITE_ENABLED` (default-off)
 * AND an explicit `storePath`. Default and any missing gate stay dry-run/blocked with
 * no file side effect. Pointing this at the real memory DB is a deliberate operator/product
 * decision (a live target), so the runtime never defaults a real-memory path.
 */
export type TNeonMemoryWriteGateReason = "write-disabled" | "write-enabled";

const memoryWriteEnabledEnvKey = "NEON_MEMORY_WRITE_ENABLED";
const maxMemoryEntryLength = 2_000;

export interface INeonMemoryWriteGate {
  readonly enabled: boolean;
  readonly reason: TNeonMemoryWriteGateReason;
  readonly envKey: typeof memoryWriteEnabledEnvKey;
}

export interface INeonMemoryStoreEntry {
  readonly id: string;
  readonly content: string;
  readonly category?: string;
  readonly source?: string;
  readonly writtenAt: string;
}

export interface INeonMemoryWriteRuntimeResult {
  readonly mode: TNeonMemoryWriteMode;
  readonly state: TNeonMemoryWriteState;
  readonly redactedContent: string;
  readonly gate: INeonMemoryWriteGate;
  readonly entryId?: string;
  readonly storePath?: string;
  readonly safety: { readonly isolatedStore: true; readonly targetedRealMemoryDb: false };
  readonly diagnostics: readonly string[];
}

export interface IWriteNeonMemoryEntryOptions {
  readonly request: INeonMemoryWriteRequest;
  readonly gate: INeonMemoryWriteGate;
  readonly mode?: TNeonMemoryWriteMode;
  readonly storePath?: string;
  readonly now?: () => Date;
}

const safety = { isolatedStore: true, targetedRealMemoryDb: false } as const;

export function resolveNeonMemoryWriteGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonMemoryWriteGate {
  const enabled = readReadyCutoverEnv(env, memoryWriteEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "write-enabled" : "write-disabled",
    envKey: memoryWriteEnabledEnvKey
  };
}

export async function writeNeonMemoryEntry(
  options: IWriteNeonMemoryEntryOptions
): Promise<INeonMemoryWriteRuntimeResult> {
  const mode = options.mode ?? "dry-run";
  const redactedContent = truncate(
    redactText(options.request.content.replace(/\s+/g, " ").trim()),
    maxMemoryEntryLength
  );
  const category = options.request.category ? redactText(options.request.category) : undefined;
  const source = options.request.source ? redactText(options.request.source) : undefined;

  if (redactedContent.length === 0) {
    return base("blocked", "dry-run", redactedContent, options.gate, ["memory-write blocked: empty content"]);
  }

  if (mode !== "productive") {
    return base("planned", "dry-run", redactedContent, options.gate, [
      "dry-run: no memory entry written",
      ...(category ? [`category=${category}`] : [])
    ]);
  }

  if (!options.gate.enabled || !options.storePath) {
    return base("blocked", "productive", redactedContent, options.gate, [
      "productive memory-write blocked: requires NEON_MEMORY_WRITE_ENABLED and an explicit isolated storePath"
    ]);
  }

  const writtenAt = (options.now?.() ?? new Date()).toISOString();
  const existing = await readNeonMemoryStore(options.storePath);
  const id = `mem-${createHash("sha256")
    .update([redactedContent, writtenAt, String(existing.length)].join(""))
    .digest("hex")
    .slice(0, 16)}`;
  const entry: INeonMemoryStoreEntry = {
    id,
    content: redactedContent,
    writtenAt,
    ...(category ? { category } : {}),
    ...(source ? { source } : {})
  };

  await mkdir(dirname(options.storePath), { recursive: true });
  await writeFile(options.storePath, `${JSON.stringify([...existing, entry], null, 2)}\n`, "utf8");

  return {
    mode: "productive",
    state: "written",
    redactedContent,
    gate: options.gate,
    entryId: id,
    storePath: options.storePath,
    safety,
    diagnostics: [`memory entry written to isolated store (${existing.length + 1} total)`]
  };
}

export async function readNeonMemoryStore(
  storePath: string
): Promise<readonly INeonMemoryStoreEntry[]> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map(parseStoreEntry)
      .filter((entry): entry is INeonMemoryStoreEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export function renderNeonMemoryWriteRuntimeReport(result: INeonMemoryWriteRuntimeResult): string {
  return [
    `Neon Memory Write: ${result.mode} / ${result.state} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Redacted content: ${result.redactedContent}`,
    `Entry id: ${result.entryId ?? "none"}`,
    `Store: ${result.storePath ?? "none (isolated store required for productive)"}`,
    `Safety: isolatedStore=${result.safety.isolatedStore} targetedRealMemoryDb=${result.safety.targetedRealMemoryDb}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function base(
  state: TNeonMemoryWriteState,
  mode: TNeonMemoryWriteMode,
  redactedContent: string,
  gate: INeonMemoryWriteGate,
  diagnostics: readonly string[]
): INeonMemoryWriteRuntimeResult {
  return { mode, state, redactedContent, gate, safety, diagnostics };
}

function parseStoreEntry(value: unknown): INeonMemoryStoreEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const content = record["content"];
  const writtenAt = record["writtenAt"];
  const category = record["category"];
  const source = record["source"];
  if (typeof id !== "string" || typeof content !== "string" || typeof writtenAt !== "string") {
    return undefined;
  }
  return {
    id,
    content,
    writtenAt,
    ...(typeof category === "string" ? { category } : {}),
    ...(typeof source === "string" ? { source } : {})
  };
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
