import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  runNeonDreamingReflection,
  type INeonDreamCandidate,
  type INeonDreamingGate,
  type INeonDreamingReflectionResult,
  type INeonDreamProposal,
  type TNeonDreamingPhase
} from "./dreamingRuntime.js";
import {
  appendNeonWorkspaceNote,
  resolveNeonWorkspaceNotesGate,
  type INeonWorkspaceNotesGate
} from "../workspace/workspaceNotes.js";

/**
 * Dreaming phase tick + continuous-loop mechanism (P4 Automation).
 *
 * `runNeonDreamingReflection` already exists as a single-shot (it takes a phase
 * and emits read-only proposals). What was missing is the *loop*: advancing the
 * phase across ticks. This module adds the pure phase cycle, a gated tick that
 * picks the next phase and runs one reflection, and an optional persisted phase
 * cursor (same gated tick+cursor pattern as the cron daemon).
 *
 * Deliberately simpler than upstream's idle-driven phase scheduler: Neon rotates
 * light -> deep -> rem -> light deterministically per armed tick (no idle-signal
 * heuristic). Everything stays behind `NEON_DREAMING_ENABLED` (default-off) and
 * read-only — proposals are emitted, never promoted (promotion is the separate
 * gated DP-11 memory-write).
 */
const DREAM_PHASE_CYCLE: readonly TNeonDreamingPhase[] = ["light", "deep", "rem"];

export interface INeonDreamPhaseCursor {
  readonly version: 1;
  readonly lastPhase?: TNeonDreamingPhase;
  readonly lastTickAt?: string;
  readonly ticks: number;
}

export interface IEvaluateNeonDreamTickOptions {
  readonly gate: INeonDreamingGate;
  readonly candidates: readonly INeonDreamCandidate[];
  readonly lastPhase?: TNeonDreamingPhase;
  readonly now?: () => Date;
}

export interface INeonDreamTickResult {
  readonly armed: boolean;
  readonly gate: INeonDreamingGate;
  readonly phase: TNeonDreamingPhase;
  readonly nextPhase: TNeonDreamingPhase;
  readonly evaluatedAt: string;
  readonly reflection: INeonDreamingReflectionResult;
  readonly diagnostics: readonly string[];
}

export interface IRunNeonDreamPhaseTickOptions {
  readonly gate: INeonDreamingGate;
  readonly candidates: readonly INeonDreamCandidate[];
  readonly cursorPath?: string;
  readonly projectRoot?: string;
  readonly workspaceNotesGate?: INeonWorkspaceNotesGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

export interface INeonDreamPhaseTickResult extends INeonDreamTickResult {
  readonly cursorPath?: string;
  readonly cursorPersisted: boolean;
  readonly ticks: number;
  readonly createdWorkspaceNoteCount: number;
  readonly safety: INeonDreamTickResult["reflection"]["safety"] & {
    readonly wroteWorkspaceNotes: boolean;
    readonly outboundSent: false;
  };
}

const emptyDreamCursor: INeonDreamPhaseCursor = { version: 1, ticks: 0 };

export function selectNextNeonDreamPhase(lastPhase?: TNeonDreamingPhase): TNeonDreamingPhase {
  if (lastPhase === undefined) {
    return "light";
  }
  const index = DREAM_PHASE_CYCLE.indexOf(lastPhase);
  if (index < 0) {
    return "light";
  }
  return DREAM_PHASE_CYCLE[(index + 1) % DREAM_PHASE_CYCLE.length] ?? "light";
}

/**
 * Pure tick: pick the next phase from `lastPhase` and run one reflection. When
 * the gate is closed, the phase is still selected but no reflection runs.
 */
export function evaluateNeonDreamTick(options: IEvaluateNeonDreamTickOptions): INeonDreamTickResult {
  const phase = selectNextNeonDreamPhase(options.lastPhase);
  const reflection = runNeonDreamingReflection({
    gate: options.gate,
    phase,
    candidates: options.candidates,
    ...(options.now ? { now: options.now } : {})
  });
  const nextPhase = selectNextNeonDreamPhase(phase);

  const diagnostics = options.gate.enabled
    ? [
        `Dream tick armed: phase ${options.lastPhase ?? "(none)"} -> ${phase}; ${reflection.proposals.length} read-only proposal(s). Next phase would be ${nextPhase}.`,
        "Proposals are read-only; promotion routes through the gated memory-write (DP-11)."
      ]
    : [
        "Dream tick disabled (default). Phase selected but no reflection ran; set NEON_DREAMING_ENABLED to arm read-only proposal generation."
      ];

  return {
    armed: options.gate.enabled,
    gate: options.gate,
    phase,
    nextPhase,
    evaluatedAt: reflection.evaluatedAt,
    reflection,
    diagnostics
  };
}

export function resolveNeonDreamPhaseCursorPath(projectRoot: string): string {
  return join(resolve(projectRoot), "state", "automation", "dream-phase-cursor.json");
}

export async function readNeonDreamPhaseCursor(options: {
  readonly storePath: string;
}): Promise<INeonDreamPhaseCursor> {
  try {
    const raw = await readFile(options.storePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeDreamCursor(parsed);
  } catch {
    return emptyDreamCursor;
  }
}

export async function writeNeonDreamPhaseCursor(
  storePath: string,
  cursor: INeonDreamPhaseCursor
): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
}

/**
 * Daemon-style tick: read the persisted phase cursor, evaluate the next tick,
 * and (only when armed AND a cursor path is given) persist the advanced phase.
 * Default-off: no reflection, no cursor write.
 */
export async function runNeonDreamPhaseTick(
  options: IRunNeonDreamPhaseTickOptions
): Promise<INeonDreamPhaseTickResult> {
  const now = (options.now ?? (() => new Date()))();
  const workspaceNotesGate =
    options.workspaceNotesGate ?? resolveNeonWorkspaceNotesGate(options.env ?? {});
  const previous = options.cursorPath
    ? await readNeonDreamPhaseCursor({ storePath: options.cursorPath })
    : emptyDreamCursor;

  const tick = evaluateNeonDreamTick({
    gate: options.gate,
    candidates: options.candidates,
    now: () => now,
    ...(previous.lastPhase ? { lastPhase: previous.lastPhase } : {})
  });

  let cursorPersisted = false;
  let ticks = previous.ticks;
  if (options.gate.enabled && options.cursorPath) {
    ticks = previous.ticks + 1;
    await writeNeonDreamPhaseCursor(options.cursorPath, {
      version: 1,
      lastPhase: tick.phase,
      lastTickAt: now.toISOString(),
      ticks
    });
    cursorPersisted = true;
  }
  const createdWorkspaceNoteCount =
    options.projectRoot && tick.reflection.proposals.length > 0
      ? await appendDreamWorkspaceNotes({
          projectRoot: options.projectRoot,
          gate: workspaceNotesGate,
          proposals: tick.reflection.proposals,
          phase: tick.phase,
          now
        })
      : 0;

  return {
    ...tick,
    ...(options.cursorPath ? { cursorPath: options.cursorPath } : {}),
    cursorPersisted,
    ticks,
    createdWorkspaceNoteCount,
    safety: {
      ...tick.reflection.safety,
      wroteWorkspaceNotes: createdWorkspaceNoteCount > 0,
      outboundSent: false
    }
  };
}

export function renderNeonDreamTickReport(result: INeonDreamPhaseTickResult): string {
  return [
    `Neon Dream Tick: ${result.armed ? "armed" : "disabled"} / phase ${result.phase} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Next phase: ${result.nextPhase}`,
    `Proposals: ${result.reflection.proposals.length} (read-only; promotion stays gated)`,
    `Workspace notes: ${result.createdWorkspaceNoteCount} (wrote=${result.safety.wroteWorkspaceNotes})`,
    `Cursor: ${result.cursorPersisted ? `persisted -> ${result.cursorPath ?? "?"} (tick #${result.ticks})` : "not written (gate closed or no path)"}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

async function appendDreamWorkspaceNotes(options: {
  readonly projectRoot: string;
  readonly gate: INeonWorkspaceNotesGate;
  readonly proposals: readonly INeonDreamProposal[];
  readonly phase: TNeonDreamingPhase;
  readonly now: Date;
}): Promise<number> {
  let created = 0;
  for (const proposal of options.proposals) {
    const result = await appendNeonWorkspaceNote({
      projectRoot: options.projectRoot,
      gate: options.gate,
      note: {
        kind: "dream",
        title: `Dream ${options.phase} ${proposal.kind}`,
        source: `dream:${options.phase}:${proposal.id}`,
        body: `${proposal.summary}\nsourceIds: ${proposal.sourceIds.join(", ")}`
      },
      now: () => options.now
    });
    if (result.state === "appended") {
      created += 1;
    }
  }
  return created;
}

function normalizeDreamCursor(value: unknown): INeonDreamPhaseCursor {
  if (typeof value !== "object" || value === null) {
    return emptyDreamCursor;
  }
  const record = value as Record<string, unknown>;
  const ticksRaw = record["ticks"];
  const ticks =
    typeof ticksRaw === "number" && Number.isFinite(ticksRaw) ? Math.max(0, Math.floor(ticksRaw)) : 0;
  const lastPhase = record["lastPhase"];
  const lastTickAt = record["lastTickAt"];

  return {
    version: 1,
    ticks,
    ...(isDreamPhase(lastPhase) ? { lastPhase } : {}),
    ...(typeof lastTickAt === "string" ? { lastTickAt } : {})
  };
}

function isDreamPhase(value: unknown): value is TNeonDreamingPhase {
  return value === "light" || value === "deep" || value === "rem";
}
