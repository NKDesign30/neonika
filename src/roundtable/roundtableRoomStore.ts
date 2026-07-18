/**
 * Neonika Roundtable room store (spec issue #15, ticket #16).
 *
 * The state foundation for a Neonika Roundtable round: a room (its purpose,
 * status and participants) plus an ordered, append-only log of turns (who
 * said what). Nothing here invokes a model — this slice is persistence only;
 * the discourse loop, the LLM invoker and the decision gate live in later
 * tickets and drive this store from the session.
 *
 * Mirrors the `whatsappRuntimeStatus` closed-shape store: closed enums, ISO
 * timestamps, counters, unknown fields dropped on read, atomic temp+rename
 * writes. Leak-safety is by construction — every turn's text crosses the
 * redaction seam (`redactSnapshotText`: secret shapes stripped, filesystem
 * paths stripped, bounded length) before it can be persisted or displayed, so
 * a raw secret or a local path can never reach the store, the CLI or a later
 * HTTP projection. `readNeonRoundtableRoom` normalizes a tampered or foreign
 * file back to the closed shape (unknown fields dropped, free-form strings in
 * enum fields rejected) and re-redacts every turn on the way out, so even a
 * hand-tampered file cannot smuggle a secret into a renderer.
 *
 * Identity fields (round id, participant id, speaker) carry a NARROWER
 * guarantee than turn text: they are charset-bounded slugs with secret shapes
 * stripped (path-safe, no `sk-`/`ghp_`/`op://` token survives), but they are
 * NOT a general PII scrubber — bare digit runs and plain words pass through, so
 * a phone number or email fragment used as an id would persist. Callers must
 * pass system-assigned head slugs (neo/chaty/owner/specialist-N), never user-
 * or channel-derived free text.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactSnapshotText, redactText } from "../harness/redaction.js";

/**
 * Head runtime, on the same axis the agent registry already carries
 * (`codex | claude | hybrid | human-gate`, spec Weiche 2). The owner is a
 * `human-gate` participant (the judge); the two default heads are `claude`
 * (Neo) and `codex` (Chaty); on-demand third heads reuse the same set.
 */
export type TNeonRoundtableRuntime = "claude" | "codex" | "hybrid" | "human-gate";

const ROUNDTABLE_RUNTIMES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "hybrid",
  "human-gate"
]);

/**
 * A participant's function in the round. The starting head is all three of
 * moderator + discussant + bridge; the owner is the judge; a pulled-in third
 * head is a specialist.
 */
export type TNeonRoundtableRole = "moderator" | "discussant" | "judge" | "specialist";

const ROUNDTABLE_ROLES: ReadonlySet<string> = new Set([
  "moderator",
  "discussant",
  "judge",
  "specialist"
]);

/** What the round is meant to converge toward (spec US17). */
export type TNeonRoundtablePurpose = "discuss-a-solution" | "gather-info";

const ROUNDTABLE_PURPOSES: ReadonlySet<string> = new Set(["discuss-a-solution", "gather-info"]);

/**
 * Lifecycle of a round. `open` = discussion in progress; `awaiting-judge` =
 * blocked on a will/tradeoff escalation to the human; `resolved` = a result
 * was emitted; `abandoned` = closed without a result.
 */
export type TNeonRoundtableRoomStatus = "open" | "awaiting-judge" | "resolved" | "abandoned";

const ROUNDTABLE_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "awaiting-judge",
  "resolved",
  "abandoned"
]);

/**
 * Kind of a single turn. `contribution` = a head's argument; `question` = a
 * sub-question (to a third head or the group); `escalation` = a will/tradeoff
 * kicked to the judge; `judge-answer` = the human judge's decision folded back
 * in (#19); `resolution` = the emitted recommendation/result; `system` = a
 * moderator/bookkeeping note.
 */
export type TNeonRoundtableTurnKind =
  | "contribution"
  | "question"
  | "escalation"
  | "judge-answer"
  | "resolution"
  | "system";

const ROUNDTABLE_TURN_KINDS: ReadonlySet<string> = new Set([
  "contribution",
  "question",
  "escalation",
  "judge-answer",
  "resolution",
  "system"
]);

/**
 * Per-turn text ceiling. `redactSnapshotText` runs the turn content through
 * secret + filesystem-path redaction and caps it here. Unlike a snapshot
 * preview this cap is generous — the store IS the durable discussion, so a
 * real head contribution should survive intact — it exists only so a tampered
 * or runaway file cannot render a wall of text into the CLI/HTTP projection.
 */
export const NEON_ROUNDTABLE_TURN_TEXT_CAP = 20_000;

/**
 * Display-time truncation for the CLI report — the stored text is already
 * redacted, so this is truncation only.
 */
const ROUNDTABLE_REPORT_LINE_CAP = 200;

/**
 * Slug length ceilings — a room/participant identity can never be free-form
 * text (it would leak).
 */
const ROUNDTABLE_ROUND_ID_CAP = 64;
const ROUNDTABLE_PARTICIPANT_ID_CAP = 48;

/** Structural ceilings against a tampered file rendering absurd volumes. */
const ROUNDTABLE_MAX_PARTICIPANTS = 64;
const ROUNDTABLE_MAX_TURNS = 100_000;

/**
 * A single participant in the room. `id` is a bounded slug, `runtime` and
 * `role` are closed enums — none of the three can carry PII or a path.
 */
export interface INeonRoundtableParticipant {
  readonly id: string;
  readonly runtime: TNeonRoundtableRuntime;
  readonly role: TNeonRoundtableRole;
}

/**
 * One entry in the ordered turn log. `text` is always the output of the
 * redaction seam — there is no code path that persists raw content.
 */
export interface INeonRoundtableTurn {
  readonly seq: number;
  readonly at: string;
  readonly speaker: string;
  readonly kind: TNeonRoundtableTurnKind;
  readonly text: string;
}

/** The persisted room file. Closed shape — see module header. */
export interface INeonRoundtableRoomFile {
  readonly version: 1;
  readonly roundId: string;
  readonly purpose: TNeonRoundtablePurpose;
  readonly status: TNeonRoundtableRoomStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly participants: readonly INeonRoundtableParticipant[];
  readonly turns: readonly INeonRoundtableTurn[];
  readonly turnCount: number;
}

/**
 * Normalizes an identity to a bounded slug: secret shapes stripped first
 * (`redactText`), then lowercased, non `[a-z0-9-]` collapsed to dashes, edges
 * trimmed, capped. Returns `undefined` when nothing usable remains. This makes
 * an id path-safe (no `/` or `..` reaches the on-disk file name) and free of
 * secret-shaped tokens — but it is NOT a general PII scrubber (see module
 * header): digit runs and plain words survive, so callers must pass
 * system-assigned head slugs, never user- or channel-derived free text.
 */
function normalizeSlug(value: unknown, cap: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const slug = redactText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, cap)
    .replace(/-$/g, "");
  return slug.length > 0 ? slug : undefined;
}

export function normalizeNeonRoundtableRoundId(value: unknown): string | undefined {
  return normalizeSlug(value, ROUNDTABLE_ROUND_ID_CAP);
}

/**
 * Re-render a timestamp to a canonical ISO string, or drop it. A "timestamp"
 * field can then never echo anything but an ISO instant across a boundary.
 */
function readRoundtableIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

/**
 * The one redaction entry point for turn content. Every persist and every
 * display routes text through here, so secrets and filesystem paths are gone
 * before the text can be stored or shown. Idempotent (already-redacted text
 * has no secret shape and no path left), so a defensive second pass on write
 * or read is a no-op on clean content.
 */
export function redactNeonRoundtableTurnText(value: string): string {
  return redactSnapshotText(value, { previewLimit: NEON_ROUNDTABLE_TURN_TEXT_CAP });
}

export function resolveNeonRoundtableRoomPath(projectRoot: string, roundId: string): string {
  // Slugify defensively even though callers pass a normalized id: the round id
  // becomes a file name, so a stray `../` or `/` must never reach the path.
  const slug = normalizeNeonRoundtableRoundId(roundId) ?? "round";
  return join(resolve(projectRoot), "state", "roundtable", "rooms", `${slug}.json`);
}

function normalizeParticipant(value: unknown): INeonRoundtableParticipant | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = normalizeSlug(record["id"], ROUNDTABLE_PARTICIPANT_ID_CAP);
  const runtime =
    typeof record["runtime"] === "string" && ROUNDTABLE_RUNTIMES.has(record["runtime"])
      ? (record["runtime"] as TNeonRoundtableRuntime)
      : undefined;
  const role =
    typeof record["role"] === "string" && ROUNDTABLE_ROLES.has(record["role"])
      ? (record["role"] as TNeonRoundtableRole)
      : undefined;
  if (!id || !runtime || !role) {
    return undefined;
  }
  return { id, runtime, role };
}

function normalizeParticipants(value: unknown): readonly INeonRoundtableParticipant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: INeonRoundtableParticipant[] = [];
  for (const entry of value) {
    if (result.length >= ROUNDTABLE_MAX_PARTICIPANTS) {
      break;
    }
    const participant = normalizeParticipant(entry);
    if (!participant || seen.has(participant.id)) {
      continue;
    }
    seen.add(participant.id);
    result.push(participant);
  }
  return result;
}

function normalizeTurn(value: unknown, seq: number): INeonRoundtableTurn | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const at = readRoundtableIso(record["at"]);
  const kind =
    typeof record["kind"] === "string" && ROUNDTABLE_TURN_KINDS.has(record["kind"])
      ? (record["kind"] as TNeonRoundtableTurnKind)
      : undefined;
  if (!at || !kind) {
    return undefined;
  }
  // Sequence is canonical — the turn's contiguous position in the kept log, not
  // the stored value — so a tampered file cannot render duplicate or
  // non-monotone seq numbers.
  // A missing/foreign speaker becomes the closed sentinel `unknown` rather than
  // dropping an otherwise-valid turn or letting a free-form string through.
  const speaker = normalizeSlug(record["speaker"], ROUNDTABLE_PARTICIPANT_ID_CAP) ?? "unknown";
  const text = redactNeonRoundtableTurnText(typeof record["text"] === "string" ? record["text"] : "");
  return { seq, at, speaker, kind, text };
}

function normalizeTurns(value: unknown): readonly INeonRoundtableTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: INeonRoundtableTurn[] = [];
  for (const entry of value) {
    if (result.length >= ROUNDTABLE_MAX_TURNS) {
      break;
    }
    const turn = normalizeTurn(entry, result.length + 1);
    if (turn) {
      result.push(turn);
    }
  }
  return result;
}

export interface ICreateNeonRoundtableRoomInput {
  readonly roundId: string;
  readonly purpose: TNeonRoundtablePurpose;
  readonly createdAt: string;
  readonly participants: readonly INeonRoundtableParticipant[];
  readonly status?: TNeonRoundtableRoomStatus;
}

/**
 * Builds a fresh room with an empty turn log. Participants are normalized and
 * deduped, the round id is slugified, the clock is caller-supplied (repo rule:
 * store logic never reads the wall clock, so tests stay deterministic).
 */
export function createNeonRoundtableRoom(
  input: ICreateNeonRoundtableRoomInput
): INeonRoundtableRoomFile {
  const roundId = normalizeNeonRoundtableRoundId(input.roundId) ?? "round";
  const createdAt = readRoundtableIso(input.createdAt) ?? new Date(0).toISOString();
  return {
    version: 1,
    roundId,
    purpose: input.purpose,
    status: input.status ?? "open",
    createdAt,
    updatedAt: createdAt,
    participants: normalizeParticipants(input.participants),
    turns: [],
    turnCount: 0
  };
}

export interface IAppendNeonRoundtableTurnInput {
  readonly speaker: string;
  readonly kind: TNeonRoundtableTurnKind;
  readonly text: string;
  readonly at: string;
  /**
   * Optionally transition the round as this turn lands (e.g. an `escalation`
   * turn moving the round to `awaiting-judge`).
   */
  readonly status?: TNeonRoundtableRoomStatus;
}

/**
 * Appends one turn to the ordered log. Pure: returns a new room, redacts the
 * turn text on the way in, assigns the next sequence number, and bumps
 * `updatedAt` to the turn's own timestamp.
 */
export function appendNeonRoundtableTurn(
  room: INeonRoundtableRoomFile,
  input: IAppendNeonRoundtableTurnInput
): INeonRoundtableRoomFile {
  const lastSeq = room.turns.length > 0 ? (room.turns[room.turns.length - 1]?.seq ?? 0) : 0;
  const at = readRoundtableIso(input.at) ?? room.updatedAt;
  const turn: INeonRoundtableTurn = {
    seq: lastSeq + 1,
    at,
    speaker: normalizeSlug(input.speaker, ROUNDTABLE_PARTICIPANT_ID_CAP) ?? "unknown",
    kind: input.kind,
    text: redactNeonRoundtableTurnText(input.text)
  };
  const turns = [...room.turns, turn];
  return {
    ...room,
    status: input.status ?? room.status,
    updatedAt: at,
    turns,
    turnCount: turns.length
  };
}

/**
 * Re-redacts every turn and recomputes the count, so no caller-built room can
 * persist raw content or a lying turn count.
 */
function sanitizeRoomForPersist(room: INeonRoundtableRoomFile): INeonRoundtableRoomFile {
  const turns = room.turns.map((turn) => ({
    ...turn,
    speaker: normalizeSlug(turn.speaker, ROUNDTABLE_PARTICIPANT_ID_CAP) ?? "unknown",
    text: redactNeonRoundtableTurnText(turn.text)
  }));
  return { ...room, turns, turnCount: turns.length };
}

export async function writeNeonRoundtableRoom(
  roomPath: string,
  room: INeonRoundtableRoomFile
): Promise<void> {
  await mkdir(dirname(roomPath), { recursive: true });
  const safe = sanitizeRoomForPersist(room);
  // Atomic replace (temp + rename): a read-only reader (CLI/HTTP/Mission
  // Control) must never observe a torn half-written round file. The unique
  // suffix keeps two concurrent writers to the same room (a later discourse
  // loop) from sharing a temp path and clobbering each other's write.
  const tempPath = `${roomPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  await rename(tempPath, roomPath);
}

/**
 * Reads and normalizes a room file. Anything that does not match the closed
 * shape (missing/mis-typed required fields, bad version, free-form enum
 * values) yields `undefined`; participants and turns that fail their own
 * checks are dropped rather than passed through; every surviving turn's text
 * is re-redacted so a tampered file cannot smuggle a secret into a renderer.
 */
export async function readNeonRoundtableRoom(
  roomPath: string
): Promise<INeonRoundtableRoomFile | undefined> {
  try {
    const raw = await readFile(roomPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeRoomFile(parsed);
  } catch {
    return undefined;
  }
}

function normalizeRoomFile(parsed: unknown): INeonRoundtableRoomFile | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record["version"] !== 1) {
    return undefined;
  }
  const roundId = normalizeNeonRoundtableRoundId(record["roundId"]);
  const purpose =
    typeof record["purpose"] === "string" && ROUNDTABLE_PURPOSES.has(record["purpose"])
      ? (record["purpose"] as TNeonRoundtablePurpose)
      : undefined;
  const status =
    typeof record["status"] === "string" && ROUNDTABLE_STATUSES.has(record["status"])
      ? (record["status"] as TNeonRoundtableRoomStatus)
      : undefined;
  const createdAt = readRoundtableIso(record["createdAt"]);
  const updatedAt = readRoundtableIso(record["updatedAt"]);
  if (!roundId || !purpose || !status || !createdAt || !updatedAt) {
    return undefined;
  }
  const turns = normalizeTurns(record["turns"]);
  return {
    version: 1,
    roundId,
    purpose,
    status,
    createdAt,
    updatedAt,
    participants: normalizeParticipants(record["participants"]),
    turns,
    turnCount: turns.length
  };
}

/**
 * Leak-safe text report (CLI `roundtable-inspect`). Slugs, enums, ISO
 * timestamps and counts only; turn text is already redacted and is further
 * truncated for the line view.
 */
export function renderNeonRoundtableRoomReport(room: INeonRoundtableRoomFile): string {
  const participants =
    room.participants.length > 0
      ? room.participants.map((p) => `${p.id}(${p.runtime}/${p.role})`).join(", ")
      : "none";
  const lines = [
    `Neonika Roundtable Room: ${room.roundId} · ${room.purpose} · ${room.status}`,
    `Created ${room.createdAt} · Updated ${room.updatedAt} · Turns ${room.turnCount}`,
    `Participants: ${participants}`
  ];
  if (room.turns.length === 0) {
    lines.push("(no turns yet)");
    return lines.join("\n");
  }
  lines.push("--- turns ---");
  for (const turn of room.turns) {
    const preview = redactSnapshotText(turn.text, { previewLimit: ROUNDTABLE_REPORT_LINE_CAP });
    lines.push(`#${turn.seq} ${turn.at} ${turn.speaker} [${turn.kind}]: ${preview}`);
  }
  return lines.join("\n");
}
