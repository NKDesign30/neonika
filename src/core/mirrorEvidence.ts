import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { redactText } from "../harness/redaction.js";
import { resolveGatewayStatePaths } from "../gateway/runStore.js";

export type TNeonMirrorEvidenceVerdict = "match" | "acceptable" | "drift" | "failed";
export type TNeonMirrorEvidenceState = "ready" | "needs-evidence" | "blocked";

export interface INeonMirrorEvidenceInput {
  readonly prompt: string;
  readonly legacyOutput: string;
  readonly neonOutput: string;
  readonly verdict: TNeonMirrorEvidenceVerdict;
  readonly legacyLatencyMs?: number;
  readonly neonLatencyMs?: number;
  readonly legacyRunId?: string;
  readonly neonRunId?: string;
  readonly reviewer?: string;
  readonly notes?: string;
  readonly now?: () => Date;
  readonly evidenceId?: string;
}

export interface INeonMirrorEvidenceRecord {
  readonly evidenceId: string;
  readonly createdAt: string;
  readonly promptHash: string;
  readonly promptPreview: string;
  readonly legacyOutputPreview: string;
  readonly neonOutputPreview: string;
  readonly verdict: TNeonMirrorEvidenceVerdict;
  readonly legacyLatencyMs?: number;
  readonly neonLatencyMs?: number;
  readonly latencyDeltaMs?: number;
  readonly legacyRunId?: string;
  readonly neonRunId?: string;
  readonly reviewer?: string;
  readonly notesPreview?: string;
}

export interface INeonMirrorEvidenceReadOptions {
  readonly maxRecords?: number;
}

export interface INeonMirrorEvidencePaths {
  readonly projectRoot: string;
  readonly evidenceRoot: string;
  readonly evidencePath: string;
}

export interface INeonMirrorEvidenceTotals {
  readonly records: number;
  readonly accepted: number;
  readonly drift: number;
  readonly failed: number;
}

export interface INeonMirrorEvidenceSnapshot {
  readonly state: TNeonMirrorEvidenceState;
  readonly generatedAt: string;
  readonly totals: INeonMirrorEvidenceTotals;
  readonly latestRecord?: INeonMirrorEvidenceRecord;
  readonly records: readonly INeonMirrorEvidenceRecord[];
  readonly recovery: readonly string[];
  readonly source: INeonMirrorEvidencePaths;
}

const CUTOVER_STATE_DIR = "cutover";
const MIRROR_EVIDENCE_FILE = "mirror-evidence.jsonl";
const PREVIEW_LIMIT = 420;

export function resolveNeonMirrorEvidencePaths(projectRoot: string): INeonMirrorEvidencePaths {
  const gatewayPaths = resolveGatewayStatePaths(projectRoot);
  const evidenceRoot = join(gatewayPaths.stateRoot, CUTOVER_STATE_DIR);

  return {
    projectRoot: gatewayPaths.projectRoot,
    evidenceRoot,
    evidencePath: join(evidenceRoot, MIRROR_EVIDENCE_FILE)
  };
}

export async function writeNeonMirrorEvidence(
  projectRoot: string,
  input: INeonMirrorEvidenceInput
): Promise<INeonMirrorEvidenceRecord> {
  const paths = resolveNeonMirrorEvidencePaths(projectRoot);
  const record = createMirrorEvidenceRecord(input);

  await mkdir(dirname(paths.evidencePath), { recursive: true });
  await appendFile(paths.evidencePath, `${JSON.stringify(record)}\n`, "utf8");

  return record;
}

export async function readNeonMirrorEvidence(
  projectRoot: string,
  options: INeonMirrorEvidenceReadOptions = {}
): Promise<readonly INeonMirrorEvidenceRecord[]> {
  const paths = resolveNeonMirrorEvidencePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.evidencePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const records = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseMirrorEvidenceLine)
    .filter((record): record is INeonMirrorEvidenceRecord => record !== undefined);

  return options.maxRecords ? records.slice(-options.maxRecords) : records;
}

export async function createNeonMirrorEvidenceSnapshot(
  projectRoot: string,
  options: INeonMirrorEvidenceReadOptions & { readonly now?: () => Date } = {}
): Promise<INeonMirrorEvidenceSnapshot> {
  const records = await readNeonMirrorEvidence(projectRoot, options);
  const totals = countMirrorEvidence(records);
  const state = resolveMirrorEvidenceState(totals);
  const snapshotBase: Omit<INeonMirrorEvidenceSnapshot, "latestRecord"> = {
    state,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    totals,
    records,
    recovery: createMirrorRecovery(state, totals),
    source: resolveNeonMirrorEvidencePaths(projectRoot)
  };
  const latestRecord = records.at(-1);

  return latestRecord
    ? {
        ...snapshotBase,
        latestRecord
      }
    : snapshotBase;
}

export function renderNeonMirrorEvidenceReport(snapshot: INeonMirrorEvidenceSnapshot): string {
  return [
    `Neon Mirror Evidence: ${snapshot.state}`,
    `Records: ${snapshot.totals.records}`,
    `Accepted: ${snapshot.totals.accepted}`,
    `Drift: ${snapshot.totals.drift}`,
    `Failed: ${snapshot.totals.failed}`,
    `Latest: ${snapshot.latestRecord?.evidenceId ?? "none"}`,
    `Source: ${snapshot.source.evidencePath}`,
    "Recovery:",
    ...(snapshot.recovery.length > 0 ? snapshot.recovery.map((entry) => `- ${entry}`) : ["- none"])
  ].join("\n");
}

function createMirrorEvidenceRecord(input: INeonMirrorEvidenceInput): INeonMirrorEvidenceRecord {
  const prompt = redactText(input.prompt);
  const legacyOutput = redactText(input.legacyOutput);
  const neonOutput = redactText(input.neonOutput);
  const notes = input.notes ? redactText(input.notes) : undefined;
  const latencyDeltaMs =
    input.legacyLatencyMs !== undefined && input.neonLatencyMs !== undefined
      ? input.neonLatencyMs - input.legacyLatencyMs
      : undefined;
  let record: INeonMirrorEvidenceRecord = {
    evidenceId: input.evidenceId ?? `mirror-${randomUUID()}`,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    promptHash: hashText(prompt),
    promptPreview: previewText(prompt),
    legacyOutputPreview: previewText(legacyOutput),
    neonOutputPreview: previewText(neonOutput),
    verdict: input.verdict
  };

  if (input.legacyLatencyMs !== undefined) {
    record = { ...record, legacyLatencyMs: input.legacyLatencyMs };
  }

  if (input.neonLatencyMs !== undefined) {
    record = { ...record, neonLatencyMs: input.neonLatencyMs };
  }

  if (latencyDeltaMs !== undefined) {
    record = { ...record, latencyDeltaMs };
  }

  if (input.legacyRunId !== undefined) {
    record = { ...record, legacyRunId: input.legacyRunId };
  }

  if (input.neonRunId !== undefined) {
    record = { ...record, neonRunId: input.neonRunId };
  }

  if (input.reviewer !== undefined) {
    record = { ...record, reviewer: previewText(redactText(input.reviewer), 80) };
  }

  if (notes !== undefined) {
    record = { ...record, notesPreview: previewText(notes) };
  }

  return record;
}

function parseMirrorEvidenceLine(line: string): INeonMirrorEvidenceRecord | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  return parseMirrorEvidenceRecord(parsed);
}

function parseMirrorEvidenceRecord(value: unknown): INeonMirrorEvidenceRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value["evidenceId"] !== "string" ||
    typeof value["createdAt"] !== "string" ||
    typeof value["promptHash"] !== "string" ||
    typeof value["promptPreview"] !== "string" ||
    typeof value["legacyOutputPreview"] !== "string" ||
    typeof value["neonOutputPreview"] !== "string" ||
    !isMirrorEvidenceVerdict(value["verdict"])
  ) {
    return undefined;
  }

  const recordBase: INeonMirrorEvidenceRecord = {
    evidenceId: value["evidenceId"],
    createdAt: value["createdAt"],
    promptHash: value["promptHash"],
    promptPreview: value["promptPreview"],
    legacyOutputPreview: value["legacyOutputPreview"],
    neonOutputPreview: value["neonOutputPreview"],
    verdict: value["verdict"]
  };

  let record = recordBase;
  const legacyLatencyMs = optionalNumber(value["legacyLatencyMs"]);
  const neonLatencyMs = optionalNumber(value["neonLatencyMs"]);
  const latencyDeltaMs = optionalNumber(value["latencyDeltaMs"]);
  const legacyRunId = optionalString(value["legacyRunId"]);
  const neonRunId = optionalString(value["neonRunId"]);
  const reviewer = optionalString(value["reviewer"]);
  const notesPreview = optionalString(value["notesPreview"]);

  if (legacyLatencyMs !== undefined) {
    record = { ...record, legacyLatencyMs };
  }

  if (neonLatencyMs !== undefined) {
    record = { ...record, neonLatencyMs };
  }

  if (latencyDeltaMs !== undefined) {
    record = { ...record, latencyDeltaMs };
  }

  if (legacyRunId !== undefined) {
    record = { ...record, legacyRunId };
  }

  if (neonRunId !== undefined) {
    record = { ...record, neonRunId };
  }

  if (reviewer !== undefined) {
    record = { ...record, reviewer };
  }

  if (notesPreview !== undefined) {
    record = { ...record, notesPreview };
  }

  return record;
}

function countMirrorEvidence(records: readonly INeonMirrorEvidenceRecord[]): INeonMirrorEvidenceTotals {
  return records.reduce<INeonMirrorEvidenceTotals>(
    (totals, record) => ({
      records: totals.records + 1,
      accepted: totals.accepted + (record.verdict === "match" || record.verdict === "acceptable" ? 1 : 0),
      drift: totals.drift + (record.verdict === "drift" ? 1 : 0),
      failed: totals.failed + (record.verdict === "failed" ? 1 : 0)
    }),
    {
      records: 0,
      accepted: 0,
      drift: 0,
      failed: 0
    }
  );
}

function resolveMirrorEvidenceState(totals: INeonMirrorEvidenceTotals): TNeonMirrorEvidenceState {
  if (totals.failed > 0 || totals.drift > 0) {
    return "blocked";
  }

  return totals.accepted > 0 ? "ready" : "needs-evidence";
}

function createMirrorRecovery(
  state: TNeonMirrorEvidenceState,
  totals: INeonMirrorEvidenceTotals
): readonly string[] {
  if (state === "ready") {
    return [];
  }

  if (state === "blocked") {
    return ["Review drift or failed mirror records before canary routing."];
  }

  return [
    totals.records === 0
      ? "Record at least one old-vs-new mirror comparison."
      : "Mark at least one mirror comparison as match or acceptable."
  ];
}

function previewText(value: string, maxLength = PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMirrorEvidenceVerdict(value: unknown): value is TNeonMirrorEvidenceVerdict {
  return value === "match" || value === "acceptable" || value === "drift" || value === "failed";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
