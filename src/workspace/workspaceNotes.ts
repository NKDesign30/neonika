import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";

export type TNeonWorkspaceNoteKind = "cron" | "heartbeat" | "dream" | "note";
export type TNeonWorkspaceNotesGateReason = "workspace-notes-disabled" | "workspace-notes-enabled";
export type TNeonWorkspaceNoteAppendState = "appended" | "blocked";

const workspaceNotesEnabledEnvKey = "NEON_WORKSPACE_NOTES_ENABLED" as const;
const maxWorkspaceNoteLength = 2_000;

export interface INeonWorkspaceNotesGate {
  readonly enabled: boolean;
  readonly reason: TNeonWorkspaceNotesGateReason;
  readonly envKey: typeof workspaceNotesEnabledEnvKey;
}

export interface INeonWorkspaceNoteInput {
  readonly kind: TNeonWorkspaceNoteKind;
  readonly title: string;
  readonly body: string;
  readonly source: string;
}

export interface INeonWorkspaceNotePaths {
  readonly root: string;
  readonly heartbeatPath: string;
  readonly dreamsPath: string;
  readonly notesPath: string;
  readonly dailyMemoryPath: string;
}

export interface INeonWorkspaceNoteAppendResult {
  readonly state: TNeonWorkspaceNoteAppendState;
  readonly gate: INeonWorkspaceNotesGate;
  readonly writtenPaths: readonly string[];
  readonly safety: {
    readonly localWorkspaceWrite: boolean;
    readonly semanticMemoryWritten: false;
    readonly outboundSent: false;
  };
  readonly diagnostics: readonly string[];
}

export interface INeonWorkspaceFileSnapshot {
  readonly path: string;
  readonly exists: boolean;
  readonly noteCount: number;
  readonly bytes: number;
}

export interface INeonWorkspaceSnapshot {
  readonly state: "ready";
  readonly root: string;
  readonly generatedAt: string;
  readonly files: {
    readonly heartbeat: INeonWorkspaceFileSnapshot;
    readonly dreams: INeonWorkspaceFileSnapshot;
    readonly notes: INeonWorkspaceFileSnapshot;
    readonly dailyMemory: INeonWorkspaceFileSnapshot;
  };
  readonly totals: {
    readonly filesPresent: number;
    readonly noteCount: number;
  };
  readonly safety: {
    readonly semanticMemoryWritten: false;
    readonly outboundSent: false;
  };
}

export function resolveNeonWorkspaceNotesGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonWorkspaceNotesGate {
  const enabled = readReadyCutoverEnv(env, workspaceNotesEnabledEnvKey);
  return {
    enabled,
    reason: enabled ? "workspace-notes-enabled" : "workspace-notes-disabled",
    envKey: workspaceNotesEnabledEnvKey
  };
}

export function resolveNeonWorkspaceNotePaths(projectRoot: string, now: Date = new Date()): INeonWorkspaceNotePaths {
  const root = join(resolve(projectRoot), "state", "workspace");
  const day = now.toISOString().slice(0, 10);
  return {
    root,
    heartbeatPath: join(root, "HEARTBEAT.md"),
    dreamsPath: join(root, "DREAMS.md"),
    notesPath: join(root, "NOTES.md"),
    dailyMemoryPath: join(root, "memory", `${day}.md`)
  };
}

export async function appendNeonWorkspaceNote(options: {
  readonly projectRoot: string;
  readonly gate: INeonWorkspaceNotesGate;
  readonly note: INeonWorkspaceNoteInput;
  readonly now?: () => Date;
}): Promise<INeonWorkspaceNoteAppendResult> {
  const now = (options.now ?? (() => new Date()))();
  const safety = {
    localWorkspaceWrite: false,
    semanticMemoryWritten: false,
    outboundSent: false
  } as const;

  if (!options.gate.enabled) {
    return {
      state: "blocked",
      gate: options.gate,
      writtenPaths: [],
      safety,
      diagnostics: [`workspace note write blocked: requires ${options.gate.envKey}`]
    };
  }

  const paths = resolveNeonWorkspaceNotePaths(options.projectRoot, now);
  const entry = renderWorkspaceNoteEntry(options.note, now);
  const targets = resolveWorkspaceNoteTargets(paths, options.note);

  for (const target of targets) {
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, entry, "utf8");
  }

  return {
    state: "appended",
    gate: options.gate,
    writtenPaths: targets,
    safety: { ...safety, localWorkspaceWrite: true },
    diagnostics: [`workspace note appended to ${targets.length} file(s)`]
  };
}

export async function createNeonWorkspaceSnapshot(
  projectRoot: string,
  options: { readonly now?: () => Date } = {}
): Promise<INeonWorkspaceSnapshot> {
  const now = (options.now ?? (() => new Date()))();
  const paths = resolveNeonWorkspaceNotePaths(projectRoot, now);
  const [heartbeat, dreams, notes, dailyMemory] = await Promise.all([
    readWorkspaceFileSnapshot(paths.heartbeatPath),
    readWorkspaceFileSnapshot(paths.dreamsPath),
    readWorkspaceFileSnapshot(paths.notesPath),
    readWorkspaceFileSnapshot(paths.dailyMemoryPath)
  ]);
  const files = { heartbeat, dreams, notes, dailyMemory };
  const allFiles = Object.values(files);

  return {
    state: "ready",
    root: paths.root,
    generatedAt: now.toISOString(),
    files,
    totals: {
      filesPresent: allFiles.filter((file) => file.exists).length,
      noteCount: allFiles.reduce((total, file) => total + file.noteCount, 0)
    },
    safety: { semanticMemoryWritten: false, outboundSent: false }
  };
}

export function renderNeonWorkspaceSnapshotReport(snapshot: INeonWorkspaceSnapshot): string {
  return [
    `Neon Workspace Notes: ${snapshot.state}`,
    `Root: ${snapshot.root}`,
    `Totals: files=${snapshot.totals.filesPresent} notes=${snapshot.totals.noteCount}`,
    `Safety: semanticMemoryWritten=${snapshot.safety.semanticMemoryWritten} outboundSent=${snapshot.safety.outboundSent}`,
    `- HEARTBEAT: ${formatWorkspaceFile(snapshot.files.heartbeat)}`,
    `- DREAMS: ${formatWorkspaceFile(snapshot.files.dreams)}`,
    `- NOTES: ${formatWorkspaceFile(snapshot.files.notes)}`,
    `- Daily memory: ${formatWorkspaceFile(snapshot.files.dailyMemory)}`
  ].join("\n");
}

function resolveWorkspaceNoteTargets(
  paths: INeonWorkspaceNotePaths,
  note: INeonWorkspaceNoteInput
): readonly string[] {
  const targets = new Set<string>([paths.notesPath, paths.dailyMemoryPath]);
  if (note.kind === "heartbeat" || note.source.toLowerCase().includes("heartbeat")) {
    targets.add(paths.heartbeatPath);
  }
  if (note.kind === "dream" || note.source.toLowerCase().includes("dream")) {
    targets.add(paths.dreamsPath);
  }
  return [...targets];
}

function renderWorkspaceNoteEntry(note: INeonWorkspaceNoteInput, now: Date): string {
  const title = boundWorkspaceText(redactText(note.title.replace(/\s+/g, " ").trim()));
  const body = boundWorkspaceText(redactText(note.body.replace(/\s+/g, " ").trim()));
  const source = boundWorkspaceText(redactText(note.source.replace(/\s+/g, " ").trim()));
  return [
    "",
    `### ${now.toISOString()} · ${note.kind} · ${title || "untitled"}`,
    "",
    `source: ${source || "unknown"}`,
    "",
    body || "(empty)",
    ""
  ].join("\n");
}

async function readWorkspaceFileSnapshot(path: string): Promise<INeonWorkspaceFileSnapshot> {
  try {
    const raw = await readFile(path, "utf8");
    return {
      path,
      exists: true,
      noteCount: raw.split("\n").filter((line) => line.startsWith("### ")).length,
      bytes: Buffer.byteLength(raw, "utf8")
    };
  } catch {
    return {
      path,
      exists: false,
      noteCount: 0,
      bytes: 0
    };
  }
}

function formatWorkspaceFile(file: INeonWorkspaceFileSnapshot): string {
  return `${file.exists ? "present" : "absent"} · notes=${file.noteCount} · bytes=${file.bytes} · ${file.path}`;
}

function boundWorkspaceText(value: string): string {
  return value.length <= maxWorkspaceNoteLength ? value : `${value.slice(0, maxWorkspaceNoteLength - 1)}…`;
}
