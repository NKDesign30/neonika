import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { INeonAgentProfile, TNeonAgentRuntime } from "./registry.js";

/**
 * Filesystem source for an operator-supplied agent roster.
 *
 * Mirrors the plugin manifest reader ({@link ../plugins/manifestSource.ts}): the
 * FS layer reads a raw JSON record and reports problems as collected issues, and
 * the caller — not this module — decides what to do with them. Reading is
 * read-only and never imports, requires, or executes anything.
 *
 * The roster is operator input, not runtime state, so it lives under `config/`
 * rather than `state/`. It is deliberately a local file: a profile carries
 * `instructions`, which is prompt surface, so it must stay at the same trust
 * level as the source the operator would otherwise have forked. Nothing here
 * fetches over a network.
 */

const agentRosterFileName = "agents.json";
const agentRosterDirName = "config";
const maxAgentRosterBytes = 256 * 1024;

const agentRuntimes: readonly TNeonAgentRuntime[] = ["codex", "claude", "hybrid", "human-gate"];

export interface INeonAgentRosterRead {
  readonly rosterPath: string;
  /** Profiles that parsed cleanly. A malformed entry is skipped, not fatal. */
  readonly profiles: readonly INeonAgentProfile[];
  /** Human-readable problems. Empty means the file was absent or fully valid. */
  readonly issues: readonly string[];
  /** False when no roster file exists — the ordinary case, and not an issue. */
  readonly present: boolean;
}

export function resolveNeonAgentRosterPath(projectRoot: string): string {
  return join(resolve(projectRoot), agentRosterDirName, agentRosterFileName);
}

/**
 * Reads and validates the roster file. An absent file is the ordinary case and
 * yields `present: false` with no issues. A file that exists but cannot be used
 * yields issues and whatever profiles did parse — one bad entry must not
 * discard the good ones, or a typo in the last profile silently unregisters the
 * rest.
 */
export async function readNeonAgentRoster(projectRoot: string): Promise<INeonAgentRosterRead> {
  const rosterPath = resolveNeonAgentRosterPath(projectRoot);

  // Size first, then read — checking after the read would already have allocated
  // the file. `plugins/manifestSource.ts` stats before reading for the same
  // reason, and this path is reachable per HTTP request.
  let rosterStat: Stats;
  try {
    rosterStat = await stat(rosterPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { rosterPath, profiles: [], issues: [], present: false };
    }
    return { rosterPath, profiles: [], issues: ["agent roster could not be read"], present: true };
  }

  if (!rosterStat.isFile()) {
    return { rosterPath, profiles: [], issues: ["agent roster is not a file"], present: true };
  }

  if (rosterStat.size > maxAgentRosterBytes) {
    return {
      rosterPath,
      profiles: [],
      issues: [`agent roster exceeds ${maxAgentRosterBytes} bytes and was not parsed`],
      present: true
    };
  }

  let raw: string;
  try {
    raw = await readFile(rosterPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { rosterPath, profiles: [], issues: [], present: false };
    }
    // The message is omitted on purpose: it can contain the resolved path of a
    // symlink target, and these issues reach the doctor snapshot and HTTP.
    return { rosterPath, profiles: [], issues: ["agent roster could not be read"], present: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately not the parser's message: V8 quotes the offending input in it
    // ("Unexpected token 'A', \"AWS_SECRET\"..."), and these issues surface in the
    // doctor snapshot and over HTTP. A misplaced secrets file would echo its own
    // first bytes back out. `skills/skillPolicySource.ts` draws the same line.
    return {
      rosterPath,
      profiles: [],
      issues: ["agent roster is not valid JSON"],
      present: true
    };
  }

  const entries = extractRosterEntries(parsed);
  if (!entries) {
    return {
      rosterPath,
      profiles: [],
      issues: ['agent roster must be an array of profiles, or an object with an "agents" array'],
      present: true
    };
  }

  const profiles: INeonAgentProfile[] = [];
  const issues: string[] = [];
  const seenIds = new Set<string>();

  entries.forEach((entry, index) => {
    const parsedProfile = parseAgentProfileRecord(entry, index);
    if (typeof parsedProfile === "string") {
      issues.push(parsedProfile);
      return;
    }
    // A roster that lists the same id twice has one entry silently winning.
    // Say so rather than letting file order decide an identity.
    if (seenIds.has(parsedProfile.id)) {
      issues.push(`agent roster entry ${index} repeats id "${parsedProfile.id}" — the later entry wins`);
    }
    seenIds.add(parsedProfile.id);
    profiles.push(parsedProfile);
  });

  return { rosterPath, profiles, issues, present: true };
}

function extractRosterEntries(parsed: unknown): readonly unknown[] | undefined {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed["agents"])) {
    return parsed["agents"];
  }
  return undefined;
}

function parseAgentProfileRecord(entry: unknown, index: number): INeonAgentProfile | string {
  if (!isRecord(entry)) {
    return `agent roster entry ${index} is not an object`;
  }

  const id = readRequiredString(entry, "id");
  if (!id) {
    return `agent roster entry ${index} is missing a non-empty "id"`;
  }

  const displayName = readRequiredString(entry, "displayName");
  if (!displayName) {
    return `agent roster entry ${index} ("${id}") is missing a non-empty "displayName"`;
  }

  const role = readRequiredString(entry, "role");
  if (!role) {
    return `agent roster entry ${index} ("${id}") is missing a non-empty "role"`;
  }

  const runtime = readRequiredString(entry, "runtime");
  if (!runtime || !isAgentRuntime(runtime)) {
    return `agent roster entry ${index} ("${id}") has runtime "${String(
      entry["runtime"]
    )}" — expected one of ${agentRuntimes.join(", ")}`;
  }

  const aliases = readStringArray(entry, "aliases");
  if (typeof aliases === "string") {
    return `agent roster entry ${index} ("${id}"): ${aliases}`;
  }
  const instructions = readStringArray(entry, "instructions");
  if (typeof instructions === "string") {
    return `agent roster entry ${index} ("${id}"): ${instructions}`;
  }
  const memoryQuerySeeds = readStringArray(entry, "memoryQuerySeeds");
  if (typeof memoryQuerySeeds === "string") {
    return `agent roster entry ${index} ("${id}"): ${memoryQuerySeeds}`;
  }
  const capabilities = readStringArray(entry, "capabilities");
  if (typeof capabilities === "string") {
    return `agent roster entry ${index} ("${id}"): ${capabilities}`;
  }

  return { id, aliases, displayName, role, runtime, instructions, memoryQuerySeeds, capabilities };
}

function isAgentRuntime(value: string): value is TNeonAgentRuntime {
  return (agentRuntimes as readonly string[]).includes(value);
}

function readRequiredString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Returns the parsed list, or a problem description when the field is unusable. */
function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string
): readonly string[] | string {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return `"${key}" must be an array of strings`;
  }
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return `"${key}" must contain only strings`;
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      entries.push(trimmed);
    }
  }
  return entries;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error["code"] === "ENOENT";
}
