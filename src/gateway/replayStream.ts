import { createReplayRun, type INeonReplayRun } from "./replaySnapshot.js";
import {
  createNeonRunFileStream,
  NEON_RUN_FILE_STREAM_DEFAULT_MAX_RUNS,
  type INeonRunFileStreamHandle
} from "./runFileStream.js";

/**
 * Server-push live replay stream over the persisted gateway runs.
 *
 * Upstream reference: `src/config/sessions/transcript-stream.ts` streams session
 * JSONL via pull-based async generators. Neon is intentionally-different: it
 * pushes the leak-safe `createReplayRun` projection for each appended run over
 * the shared `runFileStream` watch primitive (browser server-push, cross-process
 * safe), rather than serving a pull-based generator.
 */

export interface INeonReplayStreamFrame {
  readonly type: "replay-run";
  readonly seq: number;
  readonly run: INeonReplayRun;
}

export interface INeonReplayStreamOptions {
  readonly onFrame: (frame: INeonReplayStreamFrame) => void;
  readonly maxRuns?: number;
  readonly maxEventsPerRun?: number;
  readonly debounceMs?: number;
}

export type INeonReplayStreamHandle = INeonRunFileStreamHandle;

export const NEON_REPLAY_STREAM_DEFAULT_MAX_RUNS = NEON_RUN_FILE_STREAM_DEFAULT_MAX_RUNS;

export function createNeonReplayStream(
  projectRoot: string,
  options: INeonReplayStreamOptions
): INeonReplayStreamHandle {
  const maxEventsPerRun = options.maxEventsPerRun ?? 50;

  return createNeonRunFileStream(projectRoot, {
    ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    onRun: (run, seq) =>
      options.onFrame({ type: "replay-run", seq, run: createReplayRun(run, maxEventsPerRun) })
  });
}

export function formatNeonReplayStreamFrame(frame: INeonReplayStreamFrame): string {
  return [`id: ${frame.seq}`, `event: ${frame.type}`, `data: ${JSON.stringify(frame)}`, "", ""].join(
    "\n"
  );
}
