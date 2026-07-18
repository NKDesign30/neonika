import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  NEON_ROUNDTABLE_PROJECTION_TURN_LIMIT,
  appendNeonRoundtableTurn,
  createNeonRoundtableRoom,
  createNeonRoundtableRoomsSnapshot,
  listenNeonGatewayHttpServer,
  renderNeonMissionControlRoundtableRoomsPanel,
  resolveNeonRoundtableRoomPath,
  writeNeonRoundtableRoom,
  type IAppendNeonRoundtableTurnInput,
  type INeonRoundtableParticipant,
  type INeonRoundtableRoomsSnapshot,
  type TNeonRoundtableRoomStatus
} from "../src/index.js";

// Wall-clock anchored fixtures (repo rule: no pinned-calendar time bombs).
const base = Date.now();
const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();

const PARTICIPANTS: readonly INeonRoundtableParticipant[] = [
  { id: "neo", runtime: "claude", role: "moderator" },
  { id: "chaty", runtime: "codex", role: "discussant" }
];

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-roundtable-http-test-"));
}

interface IWriteRoomInput {
  readonly roundId: string;
  readonly status: TNeonRoundtableRoomStatus;
  readonly createdAt: string;
  readonly turns?: readonly IAppendNeonRoundtableTurnInput[];
}

/** Writes a fixture room under the default `<root>/state/roundtable/rooms` dir. */
async function writeRoom(root: string, input: IWriteRoomInput): Promise<void> {
  let room = createNeonRoundtableRoom({
    roundId: input.roundId,
    purpose: "discuss-a-solution",
    createdAt: input.createdAt,
    participants: PARTICIPANTS,
    status: input.status
  });
  for (const turn of input.turns ?? []) {
    room = appendNeonRoundtableTurn(room, turn);
  }
  await writeNeonRoundtableRoom(resolveNeonRoundtableRoomPath(root, input.roundId), room);
}

describe("Neonika Roundtable rooms snapshot", () => {
  it("projects an empty view when no rooms exist", async () => {
    const root = await tempRoot();
    try {
      const snapshot = await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) });
      assert.equal(snapshot.roomCount, 0);
      assert.equal(snapshot.runningCount, 0);
      assert.deepEqual(snapshot.rooms, []);
      assert.equal(snapshot.current, undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("surfaces the running round even when a terminal round is more recent", async () => {
    const root = await tempRoot();
    try {
      await writeRoom(root, { roundId: "open-round", status: "open", createdAt: at(-10_000) });
      await writeRoom(root, { roundId: "resolved-round", status: "resolved", createdAt: at(0) });

      const snapshot = await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) });
      assert.equal(snapshot.roomCount, 2);
      assert.equal(snapshot.runningCount, 1);
      // List is recency-first: the resolved round is the most recent entry.
      assert.equal(snapshot.rooms[0]?.roundId, "resolved-round");
      // Current is the running round despite the resolved one being newer.
      assert.equal(snapshot.current?.roundId, "open-round");
      assert.equal(snapshot.current?.running, true);
      assert.equal(snapshot.current?.status, "open");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("falls back to the most-recent round when nothing is running", async () => {
    const root = await tempRoot();
    try {
      await writeRoom(root, { roundId: "old-resolved", status: "resolved", createdAt: at(-20_000) });
      await writeRoom(root, { roundId: "new-abandoned", status: "abandoned", createdAt: at(-5_000) });

      const snapshot = await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) });
      assert.equal(snapshot.runningCount, 0);
      assert.equal(snapshot.current?.roundId, "new-abandoned");
      assert.equal(snapshot.current?.running, false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("truncates the projected turn log to the most recent turns", async () => {
    const root = await tempRoot();
    try {
      const total = NEON_ROUNDTABLE_PROJECTION_TURN_LIMIT + 5;
      const turns: IAppendNeonRoundtableTurnInput[] = Array.from({ length: total }, (_unused, index) => ({
        speaker: "neo",
        kind: "contribution",
        text: `turn number ${index + 1}`,
        at: at(index * 1_000)
      }));
      await writeRoom(root, { roundId: "long-round", status: "open", createdAt: at(-1_000), turns });

      const snapshot = await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) });
      assert.equal(snapshot.current?.turnCount, total);
      assert.equal(snapshot.current?.turns.length, NEON_ROUNDTABLE_PROJECTION_TURN_LIMIT);
      assert.equal(snapshot.current?.turnsTruncated, true);
      // The tail is kept: the last turn is present, the first is elided.
      assert.equal(snapshot.current?.turns.at(-1)?.seq, total);
      assert.equal(
        snapshot.current?.turns.some((turn) => turn.seq === 1),
        false
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("carries no secret and no filesystem path across the projection boundary", async () => {
    const root = await tempRoot();
    try {
      await writeRoom(root, {
        roundId: "leaky-round",
        status: "open",
        createdAt: at(-1_000),
        turns: [
          {
            speaker: "neo",
            kind: "contribution",
            text: "Use sk-ABCDEFGHIJKLMNOP1234567890 from op://Private/twin/token, config at /Users/operator/.neon/twin-channel.json.",
            at: at(0)
          }
        ]
      });

      const snapshot = await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) });
      const serialized = JSON.stringify(snapshot);
      assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{16,}/);
      assert.equal(serialized.includes("op://"), false);
      assert.equal(serialized.includes("/Users/"), false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("Neonika Mission Control Roundtable rooms panel", () => {
  it("renders an honest not-loaded state without a snapshot", () => {
    const html = renderNeonMissionControlRoundtableRoomsPanel();
    assert.match(html, /id="roundtableRoomsPanel"/);
    assert.match(html, /not loaded/);
  });

  it("renders an honest empty state when there are no rooms", async () => {
    const root = await tempRoot();
    try {
      const html = renderNeonMissionControlRoundtableRoomsPanel(
        await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) })
      );
      assert.match(html, /id="roundtableRoomsPanel"/);
      assert.match(html, /No rounds yet/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders the running round, participants and turn log from the snapshot", async () => {
    const root = await tempRoot();
    try {
      await writeRoom(root, {
        roundId: "live-round",
        status: "open",
        createdAt: at(-1_000),
        turns: [{ speaker: "chaty", kind: "contribution", text: "I would ship the store first", at: at(0) }]
      });
      const html = renderNeonMissionControlRoundtableRoomsPanel(
        await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) })
      );
      assert.match(html, /id="roundtableCurrentStatus">open</);
      assert.match(html, /1 running/);
      assert.match(html, /live-round · discuss-a-solution · open \(running\)/);
      assert.match(html, /neo\(claude\/moderator\)/);
      assert.match(html, /I would ship the store first/);
      assert.match(html, /read-only projection/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("carries no secret and no filesystem path into the panel HTML", async () => {
    const root = await tempRoot();
    try {
      await writeRoom(root, {
        roundId: "leaky-panel",
        status: "open",
        createdAt: at(-1_000),
        turns: [
          {
            speaker: "neo",
            kind: "contribution",
            text: "Leak sk-ABCDEFGHIJKLMNOP1234567890 from op://Private/twin/token at /Users/operator/.neon/twin-channel.json.",
            at: at(0)
          }
        ]
      });
      const html = renderNeonMissionControlRoundtableRoomsPanel(
        await createNeonRoundtableRoomsSnapshot(root, { now: () => new Date(base) })
      );
      assert.doesNotMatch(html, /sk-[A-Za-z0-9_-]{16,}/);
      assert.equal(html.includes("op://"), false);
      assert.equal(html.includes("/Users/"), false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("Neonika Gateway /api/neon-roundtable and Mission Control wiring", () => {
  it("serves the redacted projection over HTTP and embeds the panel into the gateway HTML", async () => {
    const root = await tempRoot();
    try {
      await writeRoom(root, {
        roundId: "served-round",
        status: "awaiting-judge",
        createdAt: at(-2_000),
        turns: [
          {
            speaker: "neo",
            kind: "escalation",
            text: "This is a will call — needs the judge. Secret sk-ABCDEFGHIJKLMNOP1234567890 must not leak.",
            at: at(0)
          }
        ]
      });

      const handle = await listenNeonGatewayHttpServer({ projectRoot: root }, { host: "127.0.0.1", port: 0 });
      try {
        const response = await fetch(`${handle.url}/api/neon-roundtable`);
        assert.equal(response.status, 200);
        const payload = (await response.json()) as INeonRoundtableRoomsSnapshot;
        assert.equal(payload.roomCount, 1);
        assert.equal(payload.current?.roundId, "served-round");
        assert.equal(payload.current?.status, "awaiting-judge");
        const serialized = JSON.stringify(payload);
        assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{16,}/);
        assert.equal(serialized.includes("/Users/"), false);

        const htmlResponse = await fetch(`${handle.url}/mission-control/gateway`);
        assert.equal(htmlResponse.status, 200);
        const html = await htmlResponse.text();
        assert.match(html, /id="roundtableRoomsPanel"/);
        assert.match(html, /id="roundtableCurrentStatus">awaiting-judge</);
      } finally {
        await handle.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
