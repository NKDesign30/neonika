import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  appendNeonRoundtableTurn,
  createNeonRoundtableRoom,
  normalizeNeonRoundtableRoundId,
  readNeonRoundtableRoom,
  redactNeonRoundtableTurnText,
  renderNeonRoundtableRoomReport,
  resolveNeonRoundtableRoomPath,
  writeNeonRoundtableRoom,
  type INeonRoundtableRoomFile
} from "../src/index.js";

// Fixture times anchor to the wall clock (repo rule: pinned calendar
// timestamps are time bombs against real-clock readers).
const base = Date.now();
const at = (offsetMs: number): string => new Date(base + offsetMs).toISOString();

function buildCleanRoom(): INeonRoundtableRoomFile {
  let room = createNeonRoundtableRoom({
    roundId: "fixture-round",
    purpose: "discuss-a-solution",
    createdAt: at(0),
    participants: [
      { id: "neo", runtime: "claude", role: "moderator" },
      { id: "chaty", runtime: "codex", role: "discussant" },
      { id: "owner", runtime: "human-gate", role: "judge" }
    ]
  });
  room = appendNeonRoundtableTurn(room, {
    speaker: "neo",
    kind: "contribution",
    text: "Closed-shape store first.",
    at: at(1_000)
  });
  room = appendNeonRoundtableTurn(room, {
    speaker: "chaty",
    kind: "contribution",
    text: "Small and atomic.",
    at: at(2_000)
  });
  return room;
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-roundtable-test-"));
}

describe("Neonika Roundtable room store", () => {
  it("round-trips a room through write and normalized read", async () => {
    const root = await tempRoot();
    try {
      const room = buildCleanRoom();
      const roomPath = resolveNeonRoundtableRoomPath(root, room.roundId);
      await writeNeonRoundtableRoom(roomPath, room);
      const read = await readNeonRoundtableRoom(roomPath);
      assert.deepEqual(read, room);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes atomically and leaves no temp file behind", async () => {
    const root = await tempRoot();
    try {
      const room = buildCleanRoom();
      const roomPath = resolveNeonRoundtableRoomPath(root, room.roundId);
      await writeNeonRoundtableRoom(roomPath, room);
      const entries = await readdir(join(root, "state", "roundtable", "rooms"));
      // Only the final room file — no `.tmp` sidecar survived the rename.
      assert.deepEqual(entries, ["fixture-round.json"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("appends turns with sequential seq, bumped updatedAt and status transitions", () => {
    let room = createNeonRoundtableRoom({
      roundId: "seq-round",
      purpose: "gather-info",
      createdAt: at(0),
      participants: [{ id: "neo", runtime: "claude", role: "moderator" }]
    });
    assert.equal(room.status, "open");
    assert.equal(room.turnCount, 0);

    room = appendNeonRoundtableTurn(room, {
      speaker: "neo",
      kind: "question",
      text: "What does the doc say?",
      at: at(1_000)
    });
    room = appendNeonRoundtableTurn(room, {
      speaker: "neo",
      kind: "escalation",
      text: "This is a will decision.",
      at: at(2_000),
      status: "awaiting-judge"
    });

    assert.deepEqual(
      room.turns.map((t) => t.seq),
      [1, 2]
    );
    assert.equal(room.turnCount, 2);
    assert.equal(room.updatedAt, at(2_000));
    assert.equal(room.status, "awaiting-judge");
  });

  it("rejects files that do not match the closed shape", async () => {
    const root = await tempRoot();
    try {
      const roomPath = join(root, "room.json");

      await writeFile(roomPath, "not json", "utf8");
      assert.equal(await readNeonRoundtableRoom(roomPath), undefined);

      await writeFile(roomPath, JSON.stringify({ version: 2 }), "utf8");
      assert.equal(await readNeonRoundtableRoom(roomPath), undefined);

      const valid = buildCleanRoom();
      // A free-form string smuggled into an enum field invalidates the file
      // (required field) instead of passing through to a renderer.
      await writeFile(roomPath, JSON.stringify({ ...valid, purpose: "chit-chat" }), "utf8");
      assert.equal(await readNeonRoundtableRoom(roomPath), undefined);

      await writeFile(roomPath, JSON.stringify({ ...valid, status: "on-fire" }), "utf8");
      assert.equal(await readNeonRoundtableRoom(roomPath), undefined);

      // A round id that slugifies to nothing (all punctuation) is unusable.
      await writeFile(roomPath, JSON.stringify({ ...valid, roundId: "///" }), "utf8");
      assert.equal(await readNeonRoundtableRoom(roomPath), undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("drops non-conforming participants and turns so PII cannot ride along", async () => {
    const root = await tempRoot();
    try {
      const roomPath = join(root, "room.json");
      await writeFile(
        roomPath,
        JSON.stringify({
          version: 1,
          roundId: "tampered",
          purpose: "gather-info",
          status: "open",
          createdAt: at(0),
          updatedAt: at(5_000),
          participants: [
            { id: "neo", runtime: "claude", role: "moderator" },
            { id: "neo", runtime: "codex", role: "discussant" }, // duplicate id -> dropped
            { id: "spy", runtime: "not-a-runtime", role: "judge" }, // bad enum -> dropped
            "a bare string, not a participant object" // not an object -> dropped
          ],
          turns: [
            { seq: 1, at: at(1_000), speaker: "neo", kind: "contribution", text: "ok" },
            { seq: 2, at: at(2_000), speaker: "neo", kind: "chatter", text: "bad kind" }, // dropped
            { seq: 3, at: "not-a-time", speaker: "neo", kind: "contribution", text: "bad time" }, // dropped
            { seq: 4, at: at(3_000), kind: "system", text: "no speaker" } // kept, speaker -> unknown
          ],
          turnCount: 999,
          secretField: "should-be-ignored"
        }),
        "utf8"
      );

      const read = await readNeonRoundtableRoom(roomPath);
      assert.ok(read);
      assert.deepEqual(
        read.participants.map((p) => p.id),
        ["neo"]
      );
      assert.equal(read.turns.length, 2);
      assert.equal(read.turnCount, 2); // recomputed, never the lying stored 999
      assert.equal(read.turns[1]?.speaker, "unknown");
      assert.equal((read as unknown as Record<string, unknown>)["secretField"], undefined);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("redacts secrets and filesystem paths in persisted turn text", async () => {
    const root = await tempRoot();
    try {
      const secretToken = "sk-test1234abcd5678EFGH";
      const secretRef = "op://Private/twin/token";
      const localPath = "/Users/operator/.neon/twin-channel.json";

      let room = createNeonRoundtableRoom({
        roundId: "leaky-round",
        purpose: "discuss-a-solution",
        createdAt: at(0),
        participants: [{ id: "chaty", runtime: "codex", role: "discussant" }]
      });
      room = appendNeonRoundtableTurn(room, {
        speaker: "chaty",
        kind: "contribution",
        text: `Use ${secretToken} from ${secretRef}, config lives at ${localPath}.`,
        at: at(1_000)
      });

      const roomPath = resolveNeonRoundtableRoomPath(root, room.roundId);
      await writeNeonRoundtableRoom(roomPath, room);

      const serialized = await readFile(roomPath, "utf8");
      assert.doesNotMatch(serialized, /sk-[A-Za-z0-9_-]{16,}/);
      assert.equal(serialized.includes(secretToken), false);
      assert.equal(serialized.includes(secretRef), false);
      assert.equal(serialized.includes("/Users/"), false);

      const read = await readNeonRoundtableRoom(roomPath);
      const text = read?.turns[0]?.text ?? "";
      assert.match(text, /\[REDACTED_SECRET\]/);
      assert.match(text, /\[REDACTED_SECRET_REF\]/);
      assert.match(text, /\[REDACTED_PATH\]/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("re-redacts a hand-tampered raw secret on read", async () => {
    const root = await tempRoot();
    try {
      const roomPath = join(root, "room.json");
      await writeFile(
        roomPath,
        JSON.stringify({
          version: 1,
          roundId: "hand-tampered",
          purpose: "gather-info",
          status: "open",
          createdAt: at(0),
          updatedAt: at(1_000),
          participants: [{ id: "neo", runtime: "claude", role: "moderator" }],
          turns: [
            {
              seq: 1,
              at: at(500),
              speaker: "neo",
              kind: "contribution",
              text: "leaked ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here"
            }
          ]
        }),
        "utf8"
      );

      const read = await readNeonRoundtableRoom(roomPath);
      const text = read?.turns[0]?.text ?? "";
      assert.doesNotMatch(text, /ghp_[A-Za-z0-9]{20,}/);
      assert.match(text, /\[REDACTED_SECRET\]/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("strips secret-shaped identity fields to a charset-bounded slug", async () => {
    const root = await tempRoot();
    try {
      const roomPath = join(root, "room.json");
      await writeFile(
        roomPath,
        JSON.stringify({
          version: 1,
          roundId: "id-scrub",
          purpose: "gather-info",
          status: "open",
          createdAt: at(0),
          updatedAt: at(1_000),
          // A secret smuggled into an id (object form) must not survive as a
          // raw token — identity fields are secret-shape-stripped, not just
          // path-safe. (Digit-run PII is a documented caller contract, not
          // scrubbed here.)
          participants: [{ id: "sk-test1234abcd5678EFGH", runtime: "codex", role: "specialist" }],
          turns: [{ seq: 1, at: at(500), speaker: "sk-test1234abcd5678EFGH", kind: "system", text: "hi" }]
        }),
        "utf8"
      );

      const read = await readNeonRoundtableRoom(roomPath);
      const id = read?.participants[0]?.id ?? "";
      assert.doesNotMatch(id, /sk-[a-z0-9]{16,}/);
      assert.ok(id.length > 0);
      assert.doesNotMatch(read?.turns[0]?.speaker ?? "", /sk-[a-z0-9]{16,}/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders a leak-safe report", () => {
    const room = buildCleanRoom();
    const report = renderNeonRoundtableRoomReport(room);
    assert.match(report, /Neonika Roundtable Room: fixture-round · discuss-a-solution · open/);
    assert.match(report, /neo\(claude\/moderator\)/);
    assert.match(report, /Turns 2/);
    assert.doesNotMatch(report, /\/Users\//);
  });

  it("normalizes a round id to a bounded slug and rejects empty ids", () => {
    // Branding-freies Testdatum: ein Rename der Marke darf einen Slug-Test
    // nicht kippen — hier geht es um Kleinschreibung, Trennzeichen und das
    // Entfernen von Sonderzeichen, nicht um den Produktnamen.
    assert.equal(normalizeNeonRoundtableRoundId("Design Review #1!"), "design-review-1");
    assert.equal(normalizeNeonRoundtableRoundId("///"), undefined);
    assert.equal(normalizeNeonRoundtableRoundId(42), undefined);
  });

  it("keeps redaction idempotent on already-redacted text", () => {
    const once = redactNeonRoundtableTurnText("token sk-test1234abcd5678EFGH end");
    assert.equal(redactNeonRoundtableTurnText(once), once);
  });
});
