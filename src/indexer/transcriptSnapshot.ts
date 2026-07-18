import { redactSnapshotText } from "../harness/redaction.js";
import {
  defaultTranscriptsDir,
  scanNeonTranscripts,
  type INeonTranscriptSessionFile,
  type TNeonTranscriptMode
} from "./transcriptScan.js";
import {
  extractNeonTranscript,
  type INeonTranscriptExtract,
  type INeonTranscriptMessage
} from "./transcriptExtract.js";

// Neonika Transcript Indexer — projection stage. Folds scanned + extracted Claude
// Code transcripts into per-session digests and totals. Read-only, deterministic,
// redaction-first: every preview already passed redactSnapshotText in the extract
// stage and the source path is path-stripped here. The Neon-native, shadow-safe
// rebuild of v3's Live Session Indexer floor — the LLM summary/decision passes,
// memory persistence, and scheduler are separate, gated slices.

export type TNeonTranscriptSnapshotState = "ready" | "empty";

export interface INeonTranscriptSessionDigest {
  readonly sessionKey: string;
  readonly project: string;
  readonly sessionId: string;
  readonly mode: TNeonTranscriptMode;
  readonly isSubagent: boolean;
  readonly messageCount: number;
  readonly userCount: number;
  readonly assistantCount: number;
  readonly toolFailureCount: number;
  readonly latestPreview: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
  /** Redacted per-turn texts — only present when the snapshot was created with includeMessages. */
  readonly messages?: readonly INeonTranscriptMessage[];
}

export interface INeonTranscriptTotals {
  readonly sessions: number;
  readonly messages: number;
  readonly projects: number;
  readonly subagentSessions: number;
}

export interface INeonTranscriptProjection {
  readonly totals: INeonTranscriptTotals;
  readonly sessions: readonly INeonTranscriptSessionDigest[];
}

export interface INeonTranscriptSource {
  readonly projectsDir: string;
}

export interface INeonTranscriptSnapshot extends INeonTranscriptProjection {
  readonly state: TNeonTranscriptSnapshotState;
  readonly generatedAt: string;
  readonly source: INeonTranscriptSource;
}

export interface INeonTranscriptInput {
  readonly file: INeonTranscriptSessionFile;
  readonly extract: INeonTranscriptExtract;
}

export interface ICreateNeonTranscriptSnapshotOptions {
  readonly projectsDir?: string;
  readonly now?: number;
  readonly maxAgeMs?: number;
  readonly minBytes?: number;
  readonly maxSessions?: number;
  /**
   * Attach redacted per-turn messages to each digest (proposal/voice input).
   * Default false — the HTTP snapshot and doctor paths stay lean.
   */
  readonly includeMessages?: boolean;
}

// Pure, deterministic core: fold scan+extract pairs into digests + totals. No IO,
// no clock. Reusable by the Doctor check (which can scan-and-extract once).
export function projectNeonTranscript(
  inputs: readonly INeonTranscriptInput[]
): INeonTranscriptProjection {
  const sessions = inputs
    .map(toDigest)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  const projects = new Set(sessions.map((session) => session.project));

  return {
    totals: {
      sessions: sessions.length,
      messages: sessions.reduce((sum, session) => sum + session.messageCount, 0),
      projects: projects.size,
      subagentSessions: sessions.filter((session) => session.isSubagent).length
    },
    sessions
  };
}

export async function createNeonTranscriptSnapshot(
  options: ICreateNeonTranscriptSnapshotOptions = {}
): Promise<INeonTranscriptSnapshot> {
  const now = options.now ?? Date.now();
  const projectsDir = options.projectsDir ?? defaultTranscriptsDir();

  const files = await scanNeonTranscripts({
    projectsDir,
    now,
    ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
    ...(options.minBytes !== undefined ? { minBytes: options.minBytes } : {})
  });

  const limited =
    options.maxSessions !== undefined ? files.slice(0, Math.max(0, options.maxSessions)) : files;

  const inputs: INeonTranscriptInput[] = [];
  for (const file of limited) {
    const extract = await extractNeonTranscript(
      file.jsonlPath,
      options.includeMessages === true ? { includeMessages: true } : {}
    );
    inputs.push({ file, extract });
  }

  const projection = projectNeonTranscript(inputs);

  return {
    state: projection.sessions.length > 0 ? "ready" : "empty",
    generatedAt: new Date(now).toISOString(),
    source: { projectsDir: redactSnapshotText(projectsDir, { previewLimit: 200 }) },
    ...projection
  };
}

export function renderNeonTranscriptReport(snapshot: INeonTranscriptSnapshot): string {
  const sessionLines = snapshot.sessions.slice(0, 20).map((session, index) => {
    return [
      `${index + 1}. ${session.project} · ${session.mode}${session.isSubagent ? " · subagent" : ""}`,
      `   messages: ${session.messageCount} (${session.userCount} user / ${session.assistantCount} assistant), tool-failures: ${session.toolFailureCount}`,
      `   preview: ${session.latestPreview}`
    ].join("\n");
  });

  return [
    `Neonika Transcript Indexer: ${snapshot.state}`,
    `Sessions: ${snapshot.totals.sessions}`,
    `Messages: ${snapshot.totals.messages}`,
    `Projects: ${snapshot.totals.projects} (subagent sessions: ${snapshot.totals.subagentSessions})`,
    ...sessionLines
  ].join("\n");
}

function toDigest(input: INeonTranscriptInput): INeonTranscriptSessionDigest {
  const { file, extract } = input;

  return {
    sessionKey: `${file.project}:${file.sessionId}`,
    project: file.project,
    sessionId: file.sessionId,
    mode: file.mode,
    isSubagent: file.isSubagent,
    messageCount: extract.messageCount,
    userCount: extract.userCount,
    assistantCount: extract.assistantCount,
    toolFailureCount: extract.toolFailureCount,
    latestPreview: extract.latestPreview,
    sizeBytes: file.sizeBytes,
    updatedAt: new Date(file.mtimeMs).toISOString(),
    ...(extract.messages !== undefined ? { messages: extract.messages } : {})
  };
}
