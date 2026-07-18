import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const DEFAULT_STATE_ROOT = "state";
const CODEX_HARNESS_STATE_DIR = "codex-harness";

export interface IHarnessStatePaths {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly harnessRoot: string;
  readonly bindingsRoot: string;
  readonly logsRoot: string;
  readonly cacheRoot: string;
}

export function resolveHarnessStatePaths(projectRoot: string): IHarnessStatePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, DEFAULT_STATE_ROOT);
  const harnessRoot = join(stateRoot, CODEX_HARNESS_STATE_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    stateRoot,
    harnessRoot,
    bindingsRoot: join(harnessRoot, "bindings"),
    logsRoot: join(harnessRoot, "logs"),
    cacheRoot: join(harnessRoot, "cache")
  };
}

export function resolveBindingPath(projectRoot: string, sessionKey: string): string {
  const paths = resolveHarnessStatePaths(projectRoot);
  const fileName = `${fingerprintSessionKey(sessionKey)}.json`;

  return join(paths.bindingsRoot, fileName);
}

export function fingerprintSessionKey(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 24);
}
