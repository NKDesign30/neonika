import { redactSnapshotText } from "../harness/redaction.js";
import { readNeonGatewayRuns, resolveGatewayStatePaths } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import type { TNeonChannel } from "../harness/types.js";

// Neon Live Indexer — slice 1: a read-only projection over the (already
// redacted, terminal-only) Gateway run store. It folds completed shadow runs
// into per-session decision-signal digests and surfaces "decision candidates"
// that a later, gated slice could promote into memory via memoryWriteRuntime.
//
// Intentionally-different from the previous runtime's live session indexer: that one
// ingests ~/.claude/projects transcripts and runs a mandatory LLM pass. Here
// the ingest source is runs.jsonl and the digest is fully deterministic — no
// LLM, no persistence, no scheduler, no env gate. Those arrive in later slices
// behind their own gates.

const INDEXER_PREVIEW_LIMIT = 160;

export type TNeonIndexerSnapshotState = "ready" | "empty";

export interface INeonIndexerSignalCounts {
  readonly fileWrites: number;
  readonly commandExits: number;
  readonly finals: number;
  readonly failures: number;
  readonly decisionSignals: number;
}

export interface INeonIndexerSessionDigest {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channel: TNeonChannel;
  readonly runCount: number;
  readonly signals: INeonIndexerSignalCounts;
  readonly latestRunId: string;
  readonly latestPreview: string;
  readonly updatedAt: string;
}

export interface INeonIndexerCandidate {
  readonly candidateId: string;
  readonly sessionKey: string;
  readonly agentId: string;
  readonly category: "indexer:decision";
  readonly decisionSignals: number;
  readonly summary: string;
  readonly runIds: readonly string[];
}

export interface INeonIndexerTotals {
  readonly sessions: number;
  readonly runs: number;
  readonly candidates: number;
  readonly decisionSignals: number;
}

export interface INeonIndexerProjection {
  readonly totals: INeonIndexerTotals;
  readonly sessions: readonly INeonIndexerSessionDigest[];
  readonly candidates: readonly INeonIndexerCandidate[];
}

export interface INeonIndexerSnapshot extends INeonIndexerProjection {
  readonly state: TNeonIndexerSnapshotState;
  readonly generatedAt: string;
  readonly source: ReturnType<typeof resolveGatewayStatePaths>;
}

export interface ICreateNeonIndexerSnapshotOptions {
  readonly maxRuns?: number;
  readonly now?: () => Date;
}

interface ISessionIndexAccumulator {
  readonly sessionKey: string;
  readonly agentId: string;
  readonly channel: TNeonChannel;
  runCount: number;
  fileWrites: number;
  commandExits: number;
  finals: number;
  failures: number;
  latestRun: INeonGatewayShadowRun;
}

// Pure, deterministic core: fold runs into session digests + decision
// candidates. No IO, no clock. Used by both the snapshot wrapper and the
// Doctor check (which already holds the runs).
export function projectNeonIndexer(
  runs: readonly INeonGatewayShadowRun[]
): INeonIndexerProjection {
  const accumulators = new Map<string, ISessionIndexAccumulator>();

  for (const run of runs) {
    const counts = countRunSignals(run);
    const existing = accumulators.get(run.harnessSessionKey);

    if (!existing) {
      accumulators.set(run.harnessSessionKey, {
        sessionKey: run.harnessSessionKey,
        agentId: run.request.agentId,
        channel: run.request.channel,
        runCount: 1,
        fileWrites: counts.fileWrites,
        commandExits: counts.commandExits,
        finals: counts.finals,
        failures: counts.failures,
        latestRun: run
      });
      continue;
    }

    existing.runCount += 1;
    existing.fileWrites += counts.fileWrites;
    existing.commandExits += counts.commandExits;
    existing.finals += counts.finals;
    existing.failures += counts.failures;
    if (isRunNewer(run, existing.latestRun)) {
      existing.latestRun = run;
    }
  }

  const sessions = Array.from(accumulators.values())
    .map(freezeSessionDigest)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const candidates = sessions
    .filter((session) => session.signals.decisionSignals > 0)
    .map(toCandidate)
    .sort((left, right) => right.decisionSignals - left.decisionSignals);

  return {
    totals: {
      sessions: sessions.length,
      runs: runs.length,
      candidates: candidates.length,
      decisionSignals: sessions.reduce((sum, session) => sum + session.signals.decisionSignals, 0)
    },
    sessions,
    candidates
  };
}

export async function createNeonIndexerSnapshot(
  projectRoot: string,
  options: ICreateNeonIndexerSnapshotOptions = {}
): Promise<INeonIndexerSnapshot> {
  const runs = await readNeonGatewayRuns(projectRoot, options.maxRuns ? { maxRuns: options.maxRuns } : {});
  const projection = projectNeonIndexer(runs);

  return {
    state: projection.sessions.length > 0 ? "ready" : "empty",
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    source: resolveGatewayStatePaths(projectRoot),
    ...projection
  };
}

export function renderNeonIndexerReport(snapshot: INeonIndexerSnapshot): string {
  const candidateLines = snapshot.candidates.map((candidate, index) => {
    return [
      `${index + 1}. ${candidate.summary}`,
      `   id: ${candidate.candidateId}`,
      `   signals: ${candidate.decisionSignals}`,
      `   runs: ${candidate.runIds.length}`
    ].join("\n");
  });

  return [
    `Neon Indexer: ${snapshot.state}`,
    `Sessions: ${snapshot.totals.sessions}`,
    `Runs: ${snapshot.totals.runs}`,
    `Decision candidates: ${snapshot.totals.candidates} (${snapshot.totals.decisionSignals} signal(s))`,
    ...candidateLines
  ].join("\n");
}

function countRunSignals(run: INeonGatewayShadowRun): {
  readonly fileWrites: number;
  readonly commandExits: number;
  readonly finals: number;
  readonly failures: number;
} {
  let fileWrites = 0;
  let commandExits = 0;
  let finals = 0;
  let failures = 0;

  for (const event of run.events) {
    if (event.kind === "file-write") {
      fileWrites += 1;
    } else if (event.kind === "command-exit") {
      commandExits += 1;
    } else if (event.kind === "final") {
      finals += 1;
    } else if (event.kind === "failed") {
      failures += 1;
    }
  }

  return { fileWrites, commandExits, finals, failures };
}

function freezeSessionDigest(accumulator: ISessionIndexAccumulator): INeonIndexerSessionDigest {
  const decisionSignals = accumulator.fileWrites + accumulator.commandExits + accumulator.finals;

  return {
    sessionKey: accumulator.sessionKey,
    agentId: accumulator.agentId,
    channel: accumulator.channel,
    runCount: accumulator.runCount,
    signals: {
      fileWrites: accumulator.fileWrites,
      commandExits: accumulator.commandExits,
      finals: accumulator.finals,
      failures: accumulator.failures,
      decisionSignals
    },
    latestRunId: accumulator.latestRun.runId,
    latestPreview: redactIndexerText(accumulator.latestRun.request.contentPreview),
    updatedAt: accumulator.latestRun.completedAt
  };
}

function toCandidate(session: INeonIndexerSessionDigest): INeonIndexerCandidate {
  const summary = redactIndexerText(
    `${session.agentId} @ ${session.channel}: ` +
      `${session.signals.fileWrites} file-write(s), ` +
      `${session.signals.commandExits} command(s), ` +
      `${session.signals.finals} final(s)`
  );

  return {
    candidateId: `indexer:${session.sessionKey}`,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    category: "indexer:decision",
    decisionSignals: session.signals.decisionSignals,
    summary,
    runIds: [session.latestRunId]
  };
}

// Path-stripping redaction for any text the indexer synthesizes for output, via
// the shared snapshot redactor (redactText + path-strip + truncate). The indexer
// preview limit is 160.
function redactIndexerText(value: string): string {
  return redactSnapshotText(value, { previewLimit: INDEXER_PREVIEW_LIMIT });
}

function isRunNewer(left: INeonGatewayShadowRun, right: INeonGatewayShadowRun): boolean {
  return timestampMs(left.completedAt) >= timestampMs(right.completedAt);
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : 0;
}
