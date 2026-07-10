import { createNeonActivityEntries, type INeonActivityEntry } from "./activitySnapshot.js";
import {
  createNeonRunFileStream,
  NEON_RUN_FILE_STREAM_DEFAULT_MAX_RUNS,
  type INeonRunFileStreamHandle
} from "./runFileStream.js";

/**
 * Server-push live activity stream over the persisted gateway runs.
 *
 * Upstream has no dashboard activity event stream (its "activity" is Discord
 * presence status / TUI status), so this is rebuild-native: a Neon-own live
 * activity feed. It pushes the leak-safe `createNeonActivityEntries` projection
 * for each appended run over the shared `runFileStream` watch primitive.
 */

export interface INeonActivityStreamFrame {
  readonly type: "activity-run";
  readonly seq: number;
  readonly runId: string;
  readonly entries: readonly INeonActivityEntry[];
}

export interface INeonActivityStreamOptions {
  readonly onFrame: (frame: INeonActivityStreamFrame) => void;
  readonly maxRuns?: number;
  readonly maxEntriesPerRun?: number;
  readonly debounceMs?: number;
}

export type INeonActivityStreamHandle = INeonRunFileStreamHandle;

export const NEON_ACTIVITY_STREAM_DEFAULT_MAX_RUNS = NEON_RUN_FILE_STREAM_DEFAULT_MAX_RUNS;
const NEON_ACTIVITY_STREAM_DEFAULT_MAX_ENTRIES_PER_RUN = 100;

export function createNeonActivityStream(
  projectRoot: string,
  options: INeonActivityStreamOptions
): INeonActivityStreamHandle {
  const maxEntriesPerRun = options.maxEntriesPerRun ?? NEON_ACTIVITY_STREAM_DEFAULT_MAX_ENTRIES_PER_RUN;

  return createNeonRunFileStream(projectRoot, {
    ...(options.maxRuns !== undefined ? { maxRuns: options.maxRuns } : {}),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    onRun: (run, seq) =>
      options.onFrame({
        type: "activity-run",
        seq,
        runId: run.runId,
        entries: createNeonActivityEntries([run], maxEntriesPerRun)
      })
  });
}

export function formatNeonActivityStreamFrame(frame: INeonActivityStreamFrame): string {
  return [`id: ${frame.seq}`, `event: ${frame.type}`, `data: ${JSON.stringify(frame)}`, "", ""].join(
    "\n"
  );
}
