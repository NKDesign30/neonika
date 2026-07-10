import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  evaluateNeonDreamTick,
  createNeonWorkspaceSnapshot,
  readNeonDreamPhaseCursor,
  renderNeonDreamTickReport,
  resolveNeonWorkspaceNotePaths,
  resolveNeonWorkspaceNotesGate,
  runNeonDreamPhaseTick,
  selectNextNeonDreamPhase,
  type INeonDreamCandidate
} from "../src/index.js";

const OPEN_GATE = {
  enabled: true,
  reason: "dreaming-enabled" as const,
  envKey: "NEON_DREAMING_ENABLED" as const
};
const CLOSED_GATE = {
  enabled: false,
  reason: "dreaming-disabled" as const,
  envKey: "NEON_DREAMING_ENABLED" as const
};

const fixedNow = (): Date => new Date(Date.UTC(2026, 5, 3, 12, 0, 0));
const candidates: readonly INeonDreamCandidate[] = [
  { id: "m1", content: "frequently recalled note", accessCount: 5 },
  { id: "m2", content: "rarely seen note", accessCount: 1 }
];

test("selectNextNeonDreamPhase cycles light -> deep -> rem -> light", () => {
  assert.equal(selectNextNeonDreamPhase(undefined), "light");
  assert.equal(selectNextNeonDreamPhase("light"), "deep");
  assert.equal(selectNextNeonDreamPhase("deep"), "rem");
  assert.equal(selectNextNeonDreamPhase("rem"), "light");
});

test("evaluateNeonDreamTick disabled selects phase but runs no reflection", () => {
  const tick = evaluateNeonDreamTick({ gate: CLOSED_GATE, candidates, now: fixedNow });
  assert.equal(tick.armed, false);
  assert.equal(tick.phase, "light");
  assert.equal(tick.nextPhase, "deep");
  assert.equal(tick.reflection.dreamed, false);
  assert.equal(tick.reflection.proposals.length, 0);
});

test("evaluateNeonDreamTick armed runs reflection for the selected phase", () => {
  const tick = evaluateNeonDreamTick({ gate: OPEN_GATE, candidates, lastPhase: "rem", now: fixedNow });
  assert.equal(tick.armed, true);
  assert.equal(tick.phase, "light"); // rem -> light
  assert.equal(tick.reflection.dreamed, true);
  // light phase promotes frequently-recalled candidates (accessCount >= 3)
  assert.ok(tick.reflection.proposals.length >= 1);
});

test("runNeonDreamPhaseTick without a cursor path never persists", async () => {
  const result = await runNeonDreamPhaseTick({ gate: OPEN_GATE, candidates, now: fixedNow });
  assert.equal(result.cursorPersisted, false);
  assert.equal(result.ticks, 0);
  assert.equal(result.phase, "light");
  assert.equal(result.createdWorkspaceNoteCount, 0);
  assert.equal(result.safety.wroteWorkspaceNotes, false);
  assert.equal(result.safety.outboundSent, false);
});

test("runNeonDreamPhaseTick gate-closed does not write the cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-dream-"));
  const cursorPath = join(dir, "dream-phase-cursor.json");
  try {
    const result = await runNeonDreamPhaseTick({ gate: CLOSED_GATE, candidates, cursorPath, now: fixedNow });
    assert.equal(result.cursorPersisted, false);
    assert.equal(result.createdWorkspaceNoteCount, 0);
    // no file written -> read returns the empty cursor
    const cursor = await readNeonDreamPhaseCursor({ storePath: cursorPath });
    assert.equal(cursor.ticks, 0);
    assert.equal(cursor.lastPhase, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runNeonDreamPhaseTick armed advances the phase across ticks via the cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-dream-"));
  const cursorPath = join(dir, "dream-phase-cursor.json");
  try {
    const first = await runNeonDreamPhaseTick({ gate: OPEN_GATE, candidates, cursorPath, now: fixedNow });
    assert.equal(first.phase, "light");
    assert.equal(first.cursorPersisted, true);
    assert.equal(first.ticks, 1);

    const second = await runNeonDreamPhaseTick({ gate: OPEN_GATE, candidates, cursorPath, now: fixedNow });
    assert.equal(second.phase, "deep"); // advanced from persisted light
    assert.equal(second.ticks, 2);

    const persisted = await readNeonDreamPhaseCursor({ storePath: cursorPath });
    assert.equal(persisted.lastPhase, "deep");
    assert.equal(persisted.ticks, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runNeonDreamPhaseTick writes DREAMS workspace notes only when the workspace gate is armed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "neon-dream-workspace-"));
  const cursorPath = join(dir, "dream-phase-cursor.json");
  const dreamCandidates: readonly INeonDreamCandidate[] = [
    { id: "m1", content: "frequently recalled note", accessCount: 5 },
    { id: "m2", content: "never recalled note", accessCount: 0 }
  ];

  try {
    const closed = await runNeonDreamPhaseTick({
      gate: OPEN_GATE,
      candidates: dreamCandidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: resolveNeonWorkspaceNotesGate({}),
      now: fixedNow
    });
    const closedSnapshot = await createNeonWorkspaceSnapshot(dir, { now: fixedNow });
    assert.equal(closed.reflection.proposals.length, 1);
    assert.equal(closed.createdWorkspaceNoteCount, 0);
    assert.equal(closed.safety.wroteWorkspaceNotes, false);
    assert.equal(closedSnapshot.files.dreams.exists, false);

    const armed = await runNeonDreamPhaseTick({
      gate: OPEN_GATE,
      candidates: dreamCandidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" }),
      now: fixedNow
    });
    const snapshot = await createNeonWorkspaceSnapshot(dir, { now: fixedNow });
    const paths = resolveNeonWorkspaceNotePaths(dir, fixedNow());

    assert.equal(armed.phase, "deep");
    assert.equal(armed.createdWorkspaceNoteCount, 0);
    assert.equal(snapshot.files.dreams.exists, false);

    const rem = await runNeonDreamPhaseTick({
      gate: OPEN_GATE,
      candidates: dreamCandidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" }),
      now: fixedNow
    });
    const remSnapshot = await createNeonWorkspaceSnapshot(dir, { now: fixedNow });
    const remDreams = await readFile(paths.dreamsPath, "utf8");

    assert.equal(rem.phase, "rem");
    assert.equal(rem.createdWorkspaceNoteCount, 1);
    assert.equal(rem.safety.wroteWorkspaceNotes, true);
    assert.equal(remSnapshot.files.dreams.noteCount, 1);
    assert.equal(remSnapshot.files.notes.noteCount, 1);
    assert.equal(remSnapshot.files.dailyMemory.noteCount, 1);
    assert.match(remDreams, /Dream rem prune-candidate/u);
    assert.match(remDreams, /Never-recalled entry/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderNeonDreamTickReport reflects armed and disabled states", async () => {
  const armed = await runNeonDreamPhaseTick({ gate: OPEN_GATE, candidates, now: fixedNow });
  assert.match(renderNeonDreamTickReport(armed), /armed \/ phase light/);
  assert.match(renderNeonDreamTickReport(armed), /Workspace notes: 0 \(wrote=false\)/);
  const disabled = await runNeonDreamPhaseTick({ gate: CLOSED_GATE, candidates, now: fixedNow });
  assert.match(renderNeonDreamTickReport(disabled), /disabled \/ phase light/);
});
