/**
 * Neonika Roundtable rooms projection (spec issue #15, ticket #22).
 *
 * A read-only projection across every persisted Roundtable room, so an operator
 * can see the running (or last) round without touching a live process. The
 * discourse loop, the LLM invoker and the decision gate write rooms (tickets
 * #16-#19); this slice only reads them and picks the one to surface.
 *
 * Every room is read back through the store's own `readNeonRoundtableRoom`
 * normalizer, so a tampered or foreign file is dropped or coerced to the closed
 * shape and every turn's text is re-redacted on the way out. On top of that the
 * projection is leak-safe by construction:
 *   - NO filesystem paths cross this boundary (unlike the WhatsApp status
 *     snapshot, which exposes its status path): a round id and a speaker are
 *     bounded slugs, never a path, and the rooms directory itself is never
 *     placed in the snapshot. This is ticket #22's explicit "curl returns no
 *     path" contract.
 *   - Turn content is projected as a bounded `preview` (redaction seam re-run,
 *     then capped), never the raw stored text, so neither a secret shape nor a
 *     wall of text can reach the HTTP payload or the panel.
 *   - The directory scan, the room list and the projected turn log are all
 *     capped, so a pathological state directory cannot render an unbounded
 *     payload.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { redactSnapshotText } from "../harness/redaction.js";
import {
  readNeonRoundtableRoom,
  type INeonRoundtableParticipant,
  type INeonRoundtableRoomFile,
  type TNeonRoundtablePurpose,
  type TNeonRoundtableRoomStatus,
  type TNeonRoundtableTurnKind
} from "./roundtableRoomStore.js";

/** Max room files read from the directory — bounds work on a huge state dir. */
export const NEON_ROUNDTABLE_MAX_ROOMS_SCANNED = 500;
/** Max entries in the `rooms` list — bounds the projected summary. */
export const NEON_ROUNDTABLE_ROOM_LIST_LIMIT = 50;
/** Max turns projected into `current` — most recent kept, older elided. */
export const NEON_ROUNDTABLE_PROJECTION_TURN_LIMIT = 20;
/** Per-turn preview ceiling for the projection (display truncation only). */
export const NEON_ROUNDTABLE_TURN_PREVIEW_CAP = 240;

/**
 * A round is "running" while it is still in play — an open discussion or one
 * blocked on a judge escalation. `resolved`/`abandoned` are terminal.
 */
const RUNNING_STATUSES: ReadonlySet<TNeonRoundtableRoomStatus> = new Set(["open", "awaiting-judge"]);

export function isNeonRoundtableRoomRunning(status: TNeonRoundtableRoomStatus): boolean {
  return RUNNING_STATUSES.has(status);
}

/** One turn projected for display — already redacted at the store, bounded here. */
export interface INeonRoundtableTurnProjection {
  readonly seq: number;
  readonly at: string;
  readonly speaker: string;
  readonly kind: TNeonRoundtableTurnKind;
  readonly preview: string;
}

/**
 * The highlighted round with a bounded, most-recent slice of its turn log.
 * `turnCount` is the true total; `turns` may hold fewer (older turns elided).
 */
export interface INeonRoundtableRoomProjection {
  readonly roundId: string;
  readonly purpose: TNeonRoundtablePurpose;
  readonly status: TNeonRoundtableRoomStatus;
  readonly running: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly participants: readonly INeonRoundtableParticipant[];
  readonly turnCount: number;
  readonly turns: readonly INeonRoundtableTurnProjection[];
  /** True when `turns` is a tail of a longer log (turnCount > turns.length). */
  readonly turnsTruncated: boolean;
}

/** A one-line summary for the list of all rooms. */
export interface INeonRoundtableRoomListEntry {
  readonly roundId: string;
  readonly purpose: TNeonRoundtablePurpose;
  readonly status: TNeonRoundtableRoomStatus;
  readonly running: boolean;
  readonly updatedAt: string;
  readonly participantCount: number;
  readonly turnCount: number;
}

/**
 * The read-only snapshot Mission Control and the HTTP endpoint share. Carries
 * NO filesystem path by construction (ticket #22 contract).
 */
export interface INeonRoundtableRoomsSnapshot {
  readonly generatedAt: string;
  readonly roomCount: number;
  readonly runningCount: number;
  /** All rooms, most-recently-updated first, capped at the list limit. */
  readonly rooms: readonly INeonRoundtableRoomListEntry[];
  /** The running round (else the most-recent round); omitted when no rooms exist. */
  readonly current?: INeonRoundtableRoomProjection;
}

export interface ICreateNeonRoundtableRoomsSnapshotOptions {
  readonly now?: () => Date;
  /** Injected by tests; production resolves from projectRoot. */
  readonly roomsDir?: string;
}

export function resolveNeonRoundtableRoomsDir(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "roundtable", "rooms");
}

/**
 * Reads every `*.json` room in the directory read-only, normalizing each
 * through the store's own reader. Missing directory or unreadable/foreign files
 * degrade to "skipped" (never throw): a projection of an empty or partly
 * tampered state directory is an honest empty/partial view, not an error.
 */
async function readRoundtableRooms(roomsDir: string): Promise<readonly INeonRoundtableRoomFile[]> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(roomsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rooms: INeonRoundtableRoomFile[] = [];
  for (const entry of entries) {
    if (rooms.length >= NEON_ROUNDTABLE_MAX_ROOMS_SCANNED) {
      break;
    }
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const room = await readNeonRoundtableRoom(join(roomsDir, entry.name));
    if (room) {
      rooms.push(room);
    }
  }
  return rooms;
}

/**
 * Sort key: most-recently-updated first, ties broken by round id for a stable
 * order. `updatedAt` is a canonical ISO string, so a lexical compare is also a
 * chronological compare.
 */
function byRecencyThenId(a: INeonRoundtableRoomFile, b: INeonRoundtableRoomFile): number {
  const recency = b.updatedAt.localeCompare(a.updatedAt);
  return recency !== 0 ? recency : a.roundId.localeCompare(b.roundId);
}

function toListEntry(room: INeonRoundtableRoomFile): INeonRoundtableRoomListEntry {
  return {
    roundId: room.roundId,
    purpose: room.purpose,
    status: room.status,
    running: isNeonRoundtableRoomRunning(room.status),
    updatedAt: room.updatedAt,
    participantCount: room.participants.length,
    turnCount: room.turnCount
  };
}

function toRoomProjection(room: INeonRoundtableRoomFile): INeonRoundtableRoomProjection {
  const tail = room.turns.slice(-NEON_ROUNDTABLE_PROJECTION_TURN_LIMIT);
  const turns = tail.map<INeonRoundtableTurnProjection>((turn) => ({
    seq: turn.seq,
    at: turn.at,
    speaker: turn.speaker,
    kind: turn.kind,
    // The stored text is already redacted; re-running the seam is idempotent and
    // additionally caps it to the preview length for a display projection.
    preview: redactSnapshotText(turn.text, { previewLimit: NEON_ROUNDTABLE_TURN_PREVIEW_CAP })
  }));
  return {
    roundId: room.roundId,
    purpose: room.purpose,
    status: room.status,
    running: isNeonRoundtableRoomRunning(room.status),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    participants: room.participants,
    turnCount: room.turnCount,
    turns,
    turnsTruncated: room.turnCount > turns.length
  };
}

/**
 * Builds the read-only rooms snapshot. Pure aside from the directory read: the
 * caller supplies the clock (repo rule — projections never read the wall clock
 * inside their logic, so tests stay deterministic) and may inject the rooms
 * directory. The "current" round is the running one, or — when nothing is
 * running — the most recently updated round, so the operator always sees the
 * round that matters most right now.
 */
export async function createNeonRoundtableRoomsSnapshot(
  projectRoot: string,
  options: ICreateNeonRoundtableRoomsSnapshotOptions = {}
): Promise<INeonRoundtableRoomsSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const roomsDir = options.roomsDir ?? resolveNeonRoundtableRoomsDir(projectRoot);
  const rooms = [...(await readRoundtableRooms(roomsDir))].sort(byRecencyThenId);

  const runningRooms = rooms.filter((room) => isNeonRoundtableRoomRunning(room.status));
  // rooms is already recency-sorted, so the first running room (or, with none
  // running, the first room overall) is the most recent of its group.
  const currentRoom = runningRooms[0] ?? rooms[0];

  return {
    generatedAt: now.toISOString(),
    roomCount: rooms.length,
    runningCount: runningRooms.length,
    rooms: rooms.slice(0, NEON_ROUNDTABLE_ROOM_LIST_LIMIT).map(toListEntry),
    ...(currentRoom ? { current: toRoomProjection(currentRoom) } : {})
  };
}
