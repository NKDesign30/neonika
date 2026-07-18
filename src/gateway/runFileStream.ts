import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";

import type { INeonGatewayShadowRun } from "./types.js";
import { readNeonGatewayRuns, resolveGatewayStatePaths } from "./runStore.js";

/**
 * Shared run-file watch primitive for the Neon live streams (replay, activity).
 *
 * It emits each newly-appended gateway run exactly once via `onRun`, in run
 * store order, using `fs.watch` on `runs.jsonl` — event-driven (not polling)
 * and cross-process-safe, because Neon's run writers (`cli.ts`,
 * `gateway/discordIngress.ts`) are decoupled from the HTTP-server process.
 * A monotonic per-stream `seq` is handed to `onRun` for SSE framing.
 */

export interface INeonRunFileStreamOptions {
  readonly onRun: (run: INeonGatewayShadowRun, seq: number) => void;
  readonly maxRuns?: number;
  readonly debounceMs?: number;
}

export interface INeonRunFileStreamHandle {
  /** Emit the current backlog, then watch for appended runs. */
  start(): Promise<void>;
  /** Re-scan the run store and emit any run ids not yet seen. */
  refresh(): Promise<void>;
  /** Stop watching and release the file watcher. */
  close(): void;
}

export const NEON_RUN_FILE_STREAM_DEFAULT_MAX_RUNS = 50;
const NEON_RUN_FILE_STREAM_DEFAULT_DEBOUNCE_MS = 100;

export function createNeonRunFileStream(
  projectRoot: string,
  options: INeonRunFileStreamOptions
): INeonRunFileStreamHandle {
  const paths = resolveGatewayStatePaths(projectRoot);
  const runsFileName = basename(paths.runsPath);
  const maxRuns = options.maxRuns ?? NEON_RUN_FILE_STREAM_DEFAULT_MAX_RUNS;
  const debounceMs = options.debounceMs ?? NEON_RUN_FILE_STREAM_DEFAULT_DEBOUNCE_MS;

  const seen = new Set<string>();
  let seq = 0;
  let watcher: FSWatcher | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let refreshing = false;
  let pendingRefresh = false;

  const refresh = async (): Promise<void> => {
    if (closed) {
      return;
    }
    if (refreshing) {
      pendingRefresh = true;
      return;
    }
    refreshing = true;
    try {
      const runs = await readNeonGatewayRuns(projectRoot, { maxRuns });
      for (const run of runs) {
        if (closed || seen.has(run.runId)) {
          continue;
        }
        seen.add(run.runId);
        seq += 1;
        options.onRun(run, seq);
      }
    } finally {
      refreshing = false;
      if (pendingRefresh && !closed) {
        pendingRefresh = false;
        await refresh();
      }
    }
  };

  const scheduleRefresh = (): void => {
    if (closed || debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, debounceMs);
  };

  return {
    refresh,
    start: async () => {
      await mkdir(paths.gatewayRoot, { recursive: true });
      await refresh();
      if (closed) {
        return;
      }
      watcher = watch(paths.gatewayRoot, (_eventType, filename) => {
        if (filename === null || basename(filename.toString()) === runsFileName) {
          scheduleRefresh();
        }
      });
    },
    close: () => {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      watcher?.close();
      watcher = undefined;
    }
  };
}
