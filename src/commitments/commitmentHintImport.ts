import { readFile } from "node:fs/promises";

import {
  appendNeonCommitment,
  buildNeonCommitmentRecord,
  findActiveNeonCommitmentByDedupeKey,
  readNeonCommitments,
  type INeonCommitmentRecord,
  type INeonCommitmentStoreGate
} from "./commitmentStore.js";

/**
 * Commitment-Hint import (v3 -> Neonika migration, Phase A).
 *
 * Migrates a previous runtime's `data/action-inbox/commitment-hints.json` into the
 * Neonika gated commitment store. Pure mapping (`buildNeonCommitmentFromHint`)
 * is separated from I/O (`importNeonCommitmentHints`) so the mapping is testable
 * without touching disk.
 *
 * Idempotent: every hint maps to a deterministic `dedupeKey` (`v3-hint:<id>`),
 * so a re-run skips hints already present as an active commitment. The append
 * itself stays behind the same store gate as every other persistence seam
 * (`NEON_COMMITMENTS_STORE_ENABLED` + explicit `storePath`) — a default-off run
 * is blocked, never silently writing production.
 *
 * Source of truth stays the v3 JSON; this only reads it.
 */

const defaultDueWindowMs = 24 * 60 * 60 * 1000;
const importedAgentId = "neo";
const importedSessionKey = "v3-import";
const fallbackChannel = "import";

export interface INeonCommitmentHint {
  readonly id: string;
  readonly title: string;
  readonly source?: string;
  readonly excerpt?: string;
  readonly priorityHint?: string;
  readonly confidence?: number;
  readonly capturedAt?: string;
}

export interface INeonCommitmentHintParseResult {
  readonly hints: readonly INeonCommitmentHint[];
  readonly diagnostics: readonly string[];
}

export type TNeonCommitmentHintImportState = "imported" | "skipped" | "blocked";

export interface INeonCommitmentHintImportResult {
  readonly state: TNeonCommitmentHintImportState;
  readonly gate: INeonCommitmentStoreGate;
  readonly storePath?: string;
  readonly imported: readonly INeonCommitmentRecord[];
  readonly skipped: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface IImportNeonCommitmentHintsOptions {
  readonly hintsPath: string;
  readonly storePath: string;
  readonly gate: INeonCommitmentStoreGate;
  readonly now?: () => number;
}

/**
 * Safe-parse the v3 `{ hints: [...] }` envelope. Never throws: malformed JSON or
 * unexpected shapes return an empty hint list plus a diagnostic. Each hint needs
 * at least a non-empty string `id` and `title`; everything else is optional.
 */
export function parseNeonCommitmentHintsContent(raw: string): INeonCommitmentHintParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { hints: [], diagnostics: ["commitment-hints: invalid JSON"] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { hints: [], diagnostics: ["commitment-hints: expected an object with a 'hints' array"] };
  }
  const hintsValue = (parsed as Record<string, unknown>)["hints"];
  if (!Array.isArray(hintsValue)) {
    return { hints: [], diagnostics: ["commitment-hints: missing 'hints' array"] };
  }

  const hints: INeonCommitmentHint[] = [];
  const diagnostics: string[] = [];
  hintsValue.forEach((value, index) => {
    const hint = parseSingleHint(value);
    if (hint === undefined) {
      diagnostics.push(`commitment-hints: skipped malformed hint at index ${index}`);
      return;
    }
    hints.push(hint);
  });
  return { hints, diagnostics };
}

/**
 * Pure mapping: v3 hint -> Neon commitment record. Deterministic id + dedupeKey
 * derived from the hint id keep re-imports idempotent. `kind` is `open_loop`
 * (hints are open follow-ups) and `source` is `inferred_user_context` (captured
 * from chat context). The due window opens at `capturedAt` (or `nowMs`) and lasts
 * 24h. `suggestedText` is redacted inside `buildNeonCommitmentRecord`.
 */
export function buildNeonCommitmentFromHint(
  hint: INeonCommitmentHint,
  nowMs: number
): INeonCommitmentRecord {
  const capturedMs = hint.capturedAt ? Date.parse(hint.capturedAt) : Number.NaN;
  const earliestMs = Number.isFinite(capturedMs) ? capturedMs : nowMs;
  const suggestedText = hint.title.trim() || (hint.excerpt ?? "").trim() || `Follow-up ${hint.id}`;
  return buildNeonCommitmentRecord(
    {
      id: `hint-${hint.id}`,
      agentId: importedAgentId,
      sessionKey: importedSessionKey,
      channel: deriveChannel(hint.source),
      kind: "open_loop",
      source: "inferred_user_context",
      suggestedText,
      dedupeKey: `v3-hint:${hint.id}`,
      confidence: typeof hint.confidence === "number" ? hint.confidence : 0.5,
      dueWindow: {
        earliestMs,
        latestMs: earliestMs + defaultDueWindowMs,
        timezone: "UTC"
      }
    },
    nowMs
  );
}

/**
 * Read the v3 hints file and append each new hint to the gated commitment store.
 * Default-off (gate disabled) blocks without writing. Re-runs skip hints whose
 * `dedupeKey` is already an active commitment.
 */
export async function importNeonCommitmentHints(
  options: IImportNeonCommitmentHintsOptions
): Promise<INeonCommitmentHintImportResult> {
  if (!options.gate.enabled) {
    return {
      state: "blocked",
      gate: options.gate,
      storePath: options.storePath,
      imported: [],
      skipped: [],
      diagnostics: [
        `commitment-hint import blocked: set ${options.gate.envKey} to arm the store write`
      ]
    };
  }

  let raw: string;
  try {
    raw = await readFile(options.hintsPath, "utf8");
  } catch {
    return {
      state: "skipped",
      gate: options.gate,
      storePath: options.storePath,
      imported: [],
      skipped: [],
      diagnostics: [`commitment-hint import: hints file not readable at ${options.hintsPath}`]
    };
  }

  const parse = parseNeonCommitmentHintsContent(raw);
  const nowMs = (options.now ?? (() => Date.now()))();
  const existing = await readNeonCommitments({ storePath: options.storePath });
  const known = [...existing];
  const imported: INeonCommitmentRecord[] = [];
  const skipped: string[] = [];

  for (const hint of parse.hints) {
    const commitment = buildNeonCommitmentFromHint(hint, nowMs);
    if (findActiveNeonCommitmentByDedupeKey(known, commitment.dedupeKey)) {
      skipped.push(`duplicate:${commitment.dedupeKey}`);
      continue;
    }
    const append = await appendNeonCommitment({
      commitment,
      gate: options.gate,
      storePath: options.storePath
    });
    if (append.state === "appended") {
      imported.push(commitment);
      known.push(commitment);
    } else {
      skipped.push(`append-blocked:${commitment.id}`);
    }
  }

  return {
    state: imported.length > 0 ? "imported" : "skipped",
    gate: options.gate,
    storePath: options.storePath,
    imported,
    skipped,
    diagnostics: [
      ...parse.diagnostics,
      `commitment-hint import: ${parse.hints.length} hint(s), imported ${imported.length}, skipped ${skipped.length}.`
    ]
  };
}

function parseSingleHint(value: unknown): INeonCommitmentHint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = record["id"];
  const title = record["title"];
  if (typeof id !== "string" || id.trim().length === 0) {
    return undefined;
  }
  if (typeof title !== "string") {
    return undefined;
  }
  const source = record["source"];
  const excerpt = record["excerpt"];
  const priorityHint = record["priorityHint"];
  const confidence = record["confidence"];
  const capturedAt = record["capturedAt"];
  return {
    id,
    title,
    ...(typeof source === "string" ? { source } : {}),
    ...(typeof excerpt === "string" ? { excerpt } : {}),
    ...(typeof priorityHint === "string" ? { priorityHint } : {}),
    ...(typeof confidence === "number" ? { confidence } : {}),
    ...(typeof capturedAt === "string" ? { capturedAt } : {})
  };
}

function deriveChannel(source: string | undefined): string {
  if (!source) {
    return fallbackChannel;
  }
  const prefix = source.split(":", 1)[0]?.trim();
  if (!prefix) {
    return fallbackChannel;
  }
  const sanitized = prefix.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return sanitized.length > 0 ? sanitized : fallbackChannel;
}
