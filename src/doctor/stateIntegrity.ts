import { homedir as osHomedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * Read-only detection of a Neon state directory that lives on a cloud-synced
 * macOS location (Z272). iCloud Drive and the CloudStorage providers
 * (Dropbox/Google Drive/OneDrive) replicate SQLite/JSONL state across devices,
 * which can corrupt the run store and leak transcripts/tokens. The Doctor
 * surfaces this as a `warn` so the operator can move NEON_* state to local-only
 * storage.
 *
 * Pure + dependency-injected (platform/homedir/realpath) so it is deterministic
 * in tests and never touches the live store. Mirrors upstream
 * `src/commands/doctor-state-integrity.ts` detectMacCloudSyncedStateDir, trimmed
 * to the macOS cloud-sync axis (the Linux SD/eMMC axis is not a Neon target).
 */
export type TNeonCloudSyncStorage = "iCloud Drive" | "CloudStorage provider";

export interface INeonCloudSyncedStateDir {
  readonly path: string;
  readonly storage: TNeonCloudSyncStorage;
}

export interface INeonCloudSyncDetectionDeps {
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
  readonly resolveRealPath?: (target: string) => string | undefined;
}

interface INeonCloudSyncRoot {
  readonly storage: TNeonCloudSyncStorage;
  readonly root: string;
}

function isPathUnderRoot(candidate: string, root: string): boolean {
  // Resolved-path prefix match; the trailing separator stops a state dir like
  // "…/CloudStorageLocal" from matching the "…/CloudStorage" root.
  return candidate === root || candidate.startsWith(root + sep);
}

export function detectNeonCloudSyncedStateDir(
  stateDir: string,
  deps: INeonCloudSyncDetectionDeps = {}
): INeonCloudSyncedStateDir | undefined {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") {
    // Cloud-sync roots here are macOS-specific; other platforms are out of scope.
    return undefined;
  }
  const home = deps.homedir ?? osHomedir();
  const roots: readonly INeonCloudSyncRoot[] = [
    { storage: "iCloud Drive", root: resolve(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")) },
    { storage: "CloudStorage provider", root: resolve(join(home, "Library", "CloudStorage")) }
  ];
  // Prefer the realpath target so a symlinked-but-local state dir is not
  // misclassified by a cloud-synced symlink prefix.
  const resolved = deps.resolveRealPath?.(stateDir);
  const candidate = resolve(resolved ?? stateDir);
  for (const { storage, root } of roots) {
    if (isPathUnderRoot(candidate, root)) {
      return { path: candidate, storage };
    }
  }
  return undefined;
}
