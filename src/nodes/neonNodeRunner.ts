import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { redactText } from "../harness/redaction.js";
import type { INeonNodeTransportDispatch, INeonNodeTransportResultInput } from "./neonNodeTransport.js";

export type TNeonNodeRunnerState = "idle" | "submitted" | "partial" | "blocked";
export type TNeonNodeRunnerDispatchState = "submitted" | "blocked" | "failed";
export type TNeonNodeRunnerFetch = typeof fetch;
export type TNeonNodeRunnerControlState = "running" | "stopped";
export type TNeonNodeRunnerHealthState = "idle" | "running" | "degraded" | "stopped";

export interface INeonNodeRunnerOptions {
  readonly gatewayUrl: string;
  readonly projectRoot: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly cursor?: string;
  readonly fetchImpl?: TNeonNodeRunnerFetch;
  readonly maxEntries?: number;
  readonly maxTextBytes?: number;
  readonly fetchTimeoutMs?: number;
}

export interface INeonNodeRunnerLoopOptions extends INeonNodeRunnerOptions {
  readonly intervalMs?: number;
  readonly maxCycles?: number;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface INeonNodeRunnerDispatchOptions {
  readonly fetchImpl?: TNeonNodeRunnerFetch;
  readonly maxEntries?: number;
  readonly maxTextBytes?: number;
  readonly fetchTimeoutMs?: number;
}

export interface INeonNodeRunnerDispatchReport {
  readonly dispatchId: string;
  readonly kind: string;
  readonly state: TNeonNodeRunnerDispatchState;
  readonly submitStatus?: number;
  readonly summary: string;
}

export interface INeonNodeRunnerOnceResult {
  readonly state: TNeonNodeRunnerState;
  readonly pollStatus: number;
  readonly replay?: string;
  readonly cursor?: string;
  readonly previousCursor?: string;
  readonly heartbeatAt?: string;
  readonly dispatches: number;
  readonly submitted: number;
  readonly blocked: number;
  readonly failed: number;
  readonly results: readonly INeonNodeRunnerDispatchReport[];
  readonly safety: INeonNodeRunnerSafety;
}

export interface INeonNodeRunnerSafety {
  readonly mutationExecuted: false;
  readonly sideEffectExecuted: false;
  readonly rawOutputPersisted: false;
  readonly rawTokenPersisted: false;
  readonly sessionSecretPersisted: false;
}

export interface INeonNodeRunnerControlInput {
  readonly desiredState: TNeonNodeRunnerControlState;
  readonly operatorId?: string;
  readonly reason?: string;
}

export interface INeonNodeRunnerControlRecord {
  readonly desiredState: TNeonNodeRunnerControlState;
  readonly updatedAt: string;
  readonly operatorId: string;
  readonly reason: string;
  readonly safety: INeonNodeRunnerSafety;
}

export interface INeonNodeRunnerTotals {
  readonly cycles: number;
  readonly pollRequests: number;
  readonly dispatches: number;
  readonly submitted: number;
  readonly blocked: number;
  readonly failed: number;
}

export interface INeonNodeRunnerHealthRecord {
  readonly runnerId: string;
  readonly state: TNeonNodeRunnerHealthState;
  readonly updatedAt: string;
  readonly gatewayUrl: string;
  readonly sessionId: string;
  readonly cursor?: string;
  readonly lastPollStatus?: number;
  readonly lastReplay?: string;
  readonly lastHeartbeatAt?: string;
  readonly totals: INeonNodeRunnerTotals;
  readonly results: readonly INeonNodeRunnerDispatchReport[];
  readonly safety: INeonNodeRunnerSafety;
}

export interface INeonNodeRunnerPaths {
  readonly controlPath: string;
  readonly healthPath: string;
}

export interface INeonNodeRunnerSnapshot {
  readonly state: TNeonNodeRunnerHealthState;
  readonly generatedAt: string;
  readonly control: INeonNodeRunnerControlRecord;
  readonly health?: INeonNodeRunnerHealthRecord;
  readonly source: INeonNodeRunnerPaths;
  readonly totals: INeonNodeRunnerTotals;
  readonly cursor?: string;
  readonly results: readonly INeonNodeRunnerDispatchReport[];
  readonly safety: INeonNodeRunnerSafety;
}

interface IRunnerPollResponse {
  readonly replay?: string;
  readonly cursor?: string;
  readonly previousCursor?: string;
  readonly heartbeatAt?: string;
  readonly dispatches: readonly INeonNodeTransportDispatch[];
}

interface IResolvedRunnerPath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

const runnerMaxEntriesDefault = 50;
const runnerMaxTextBytesDefault = 4096;
const runnerMaxTextPreviewLength = 4096;
const runnerMaxSummaryLength = 220;
const runnerMaxTargetLength = 300;
const runnerFetchTimeoutMsDefault = 1500;
const runnerLoopIntervalMsDefault = 2000;
const runnerControlFile = "node-runner-control.json";
const runnerHealthFile = "node-runner-health.json";
const runnerId = "local-node-runner";

export function resolveNeonNodeRunnerPaths(projectRoot: string): INeonNodeRunnerPaths {
  const stateRoot = join(resolve(projectRoot), "state", "nodes");

  return {
    controlPath: join(stateRoot, runnerControlFile),
    healthPath: join(stateRoot, runnerHealthFile)
  };
}

export async function writeNeonNodeRunnerControl(
  projectRoot: string,
  input: INeonNodeRunnerControlInput,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodeRunnerControlRecord> {
  const control = createRunnerControlRecord(input, (options.now ?? (() => new Date()))().toISOString());
  const paths = resolveNeonNodeRunnerPaths(projectRoot);

  await mkdir(resolve(projectRoot, "state", "nodes"), { recursive: true });
  await writeFile(paths.controlPath, `${JSON.stringify(control, null, 2)}\n`, "utf8");

  return control;
}

export async function readNeonNodeRunnerControl(projectRoot: string): Promise<INeonNodeRunnerControlRecord> {
  const paths = resolveNeonNodeRunnerPaths(projectRoot);
  const raw = await readJsonFile(paths.controlPath);
  return parseRunnerControlRecord(raw) ?? createDefaultRunnerControl();
}

export async function readNeonNodeRunnerHealth(projectRoot: string): Promise<INeonNodeRunnerHealthRecord | undefined> {
  const paths = resolveNeonNodeRunnerPaths(projectRoot);
  return parseRunnerHealthRecord(await readJsonFile(paths.healthPath));
}

export async function createNeonNodeRunnerSnapshot(
  projectRoot: string,
  options: {
    readonly now?: () => Date;
  } = {}
): Promise<INeonNodeRunnerSnapshot> {
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const control = await readNeonNodeRunnerControl(projectRoot);
  const health = await readNeonNodeRunnerHealth(projectRoot);
  const state = control.desiredState === "stopped" ? "stopped" : health?.state ?? "idle";
  const totals = health?.totals ?? createEmptyRunnerTotals();

  return {
    state,
    generatedAt,
    control,
    ...(health ? { health } : {}),
    source: resolveNeonNodeRunnerPaths(projectRoot),
    totals,
    ...(health?.cursor ? { cursor: health.cursor } : {}),
    results: health?.results ?? [],
    safety: createRunnerSafety()
  };
}

export async function runNeonNodeRunnerLoop(options: INeonNodeRunnerLoopOptions): Promise<INeonNodeRunnerSnapshot> {
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? waitForRunnerInterval;
  const maxCycles = options.maxCycles ?? Number.POSITIVE_INFINITY;
  const intervalMs = options.intervalMs ?? runnerLoopIntervalMsDefault;
  let control = await readNeonNodeRunnerControl(options.projectRoot);
  let health = await readNeonNodeRunnerHealth(options.projectRoot);
  let cursor = options.cursor ?? health?.cursor;
  let cycles = 0;

  if (control.desiredState !== "running") {
    await writeRunnerHealth(options.projectRoot, createStoppedRunnerHealth(options, health, now().toISOString()));
    return createNeonNodeRunnerSnapshot(options.projectRoot, { now });
  }

  while (control.desiredState === "running" && cycles < maxCycles) {
    const result = await runNeonNodeRunnerOnce({
      gatewayUrl: options.gatewayUrl,
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      sessionSecret: options.sessionSecret,
      ...(cursor ? { cursor } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
      ...(options.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: options.fetchTimeoutMs })
    });

    cycles += 1;
    cursor = result.cursor ?? cursor;
    health = createRunnerHealthRecord(options, result, health, cursor, now().toISOString());
    await writeRunnerHealth(options.projectRoot, health);
    control = await readNeonNodeRunnerControl(options.projectRoot);

    if (control.desiredState !== "running" || cycles >= maxCycles) {
      break;
    }

    await wait(intervalMs);
  }

  return createNeonNodeRunnerSnapshot(options.projectRoot, { now });
}

export async function runNeonNodeRunnerOnce(options: INeonNodeRunnerOptions): Promise<INeonNodeRunnerOnceResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const pollUrl = createGatewayEndpoint(options.gatewayUrl, "/api/neon-nodes/transport/poll");

  if (options.cursor) {
    pollUrl.searchParams.set("cursor", options.cursor);
  }

  const pollResponse = await fetchImpl(pollUrl, {
    headers: createSessionHeaders(options)
  });
  const pollJson: unknown = await readResponseJson(pollResponse);

  if (!pollResponse.ok) {
    return {
      state: "blocked",
      pollStatus: pollResponse.status,
      dispatches: 0,
      submitted: 0,
      blocked: 1,
      failed: 0,
      results: [],
      safety: createRunnerSafety()
    };
  }

  const poll = parseRunnerPollResponse(pollJson);
  const results: INeonNodeRunnerDispatchReport[] = [];

  for (const dispatch of poll.dispatches) {
    const resultInput = await executeNeonNodeRunnerDispatch(options.projectRoot, dispatch, {
      fetchImpl,
      ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
      ...(options.maxTextBytes === undefined ? {} : { maxTextBytes: options.maxTextBytes }),
      ...(options.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: options.fetchTimeoutMs })
    });
    const submitUrl = createGatewayEndpoint(options.gatewayUrl, "/api/neon-nodes/transport/results");
    const submitResponse = await fetchImpl(submitUrl, {
      method: "POST",
      headers: {
        ...createSessionHeaders(options),
        "content-type": "application/json"
      },
      body: JSON.stringify(resultInput)
    });
    const resultState: TNeonNodeRunnerDispatchState =
      submitResponse.status === 201 ? (resultInput.state === "blocked" ? "blocked" : "submitted") : "failed";

    results.push({
      dispatchId: dispatch.dispatchId,
      kind: dispatch.kind,
      state: resultState,
      submitStatus: submitResponse.status,
      summary: createRunnerSummary(resultInput.summary ?? `${dispatch.kind} result submitted.`)
    });
  }

  return {
    state: createRunnerState(results),
    pollStatus: pollResponse.status,
    ...(poll.replay ? { replay: poll.replay } : {}),
    ...(poll.cursor ? { cursor: poll.cursor } : {}),
    ...(poll.previousCursor ? { previousCursor: poll.previousCursor } : {}),
    ...(poll.heartbeatAt ? { heartbeatAt: poll.heartbeatAt } : {}),
    dispatches: poll.dispatches.length,
    submitted: results.filter((result) => result.state === "submitted").length,
    blocked: results.filter((result) => result.state === "blocked").length,
    failed: results.filter((result) => result.state === "failed").length,
    results,
    safety: createRunnerSafety()
  };
}

export async function executeNeonNodeRunnerDispatch(
  projectRoot: string,
  dispatch: INeonNodeTransportDispatch,
  options: INeonNodeRunnerDispatchOptions = {}
): Promise<INeonNodeTransportResultInput> {
  if (
    !dispatch.safety.readOnly ||
    dispatch.safety.mutationAllowed ||
    dispatch.safety.sideEffectExecuted ||
    dispatch.safety.rawOutputPersisted ||
    dispatch.safety.rawTokenExposed ||
    dispatch.safety.sessionSecretExposed
  ) {
    return createBlockedRunnerResult(dispatch, "unsafe-dispatch", "Runner refused an unsafe dispatch envelope.");
  }

  switch (dispatch.kind) {
    case "file.list":
    case "dir.list":
      return createFileListRunnerResult(projectRoot, dispatch, options);
    case "file.fetch":
      return createFileFetchRunnerResult(projectRoot, dispatch, options);
    case "browser.snapshot":
      return createBrowserSnapshotRunnerResult(dispatch, options);
    case "browser.tabs":
      return createBrowserTabsRunnerResult(dispatch, options);
    default:
      return createBlockedRunnerResult(dispatch, "high-risk-action-disabled", "Runner only executes read-only dispatches.");
  }
}

export function renderNeonNodeRunnerReport(result: INeonNodeRunnerOnceResult): string {
  const rows =
    result.results.length > 0
      ? result.results.map(
          (entry) => `- ${entry.dispatchId}: ${entry.kind} / ${entry.state} / HTTP ${entry.submitStatus ?? "n/a"}`
        )
      : ["- none"];

  return [
    `Neonika Node Runner: ${result.state}`,
    `Poll HTTP: ${result.pollStatus}`,
    `Replay: ${result.replay ?? "n/a"}`,
    `Dispatches: ${result.dispatches}`,
    `Submitted: ${result.submitted}`,
    `Blocked: ${result.blocked}`,
    `Failed: ${result.failed}`,
    `Mutation: ${result.safety.mutationExecuted}`,
    `Secrets persisted: ${result.safety.sessionSecretPersisted || result.safety.rawTokenPersisted}`,
    "Results:",
    ...rows
  ].join("\n");
}

export function renderNeonNodeRunnerSnapshotReport(snapshot: INeonNodeRunnerSnapshot): string {
  const rows =
    snapshot.results.length > 0
      ? snapshot.results.map((entry) => `- ${entry.dispatchId}: ${entry.kind} / ${entry.state} / ${entry.summary}`)
      : ["- none"];

  return [
    `Neonika Node Runner Snapshot: ${snapshot.state}`,
    `Control: ${snapshot.control.desiredState}`,
    `Updated: ${snapshot.health?.updatedAt ?? snapshot.control.updatedAt}`,
    `Cycles: ${snapshot.totals.cycles}`,
    `Polls: ${snapshot.totals.pollRequests}`,
    `Dispatches: ${snapshot.totals.dispatches}`,
    `Submitted: ${snapshot.totals.submitted}`,
    `Blocked: ${snapshot.totals.blocked}`,
    `Failed: ${snapshot.totals.failed}`,
    `Cursor: ${snapshot.cursor ? "persisted" : "none"}`,
    `Secrets persisted: ${snapshot.safety.sessionSecretPersisted || snapshot.safety.rawTokenPersisted}`,
    "Recent results:",
    ...rows
  ].join("\n");
}

function createRunnerControlRecord(input: INeonNodeRunnerControlInput, updatedAt: string): INeonNodeRunnerControlRecord {
  return {
    desiredState: input.desiredState,
    updatedAt,
    operatorId: createRunnerSummary(input.operatorId ?? "operator"),
    reason: createRunnerSummary(input.reason ?? `${input.desiredState} runner`),
    safety: createRunnerSafety()
  };
}

function createDefaultRunnerControl(): INeonNodeRunnerControlRecord {
  return createRunnerControlRecord(
    {
      desiredState: "stopped",
      operatorId: "system",
      reason: "Runner has not been started."
    },
    "never"
  );
}

function createRunnerHealthRecord(
  options: INeonNodeRunnerLoopOptions,
  result: INeonNodeRunnerOnceResult,
  previousHealth: INeonNodeRunnerHealthRecord | undefined,
  cursor: string | undefined,
  updatedAt: string
): INeonNodeRunnerHealthRecord {
  const totals = addRunnerTotals(previousHealth?.totals ?? createEmptyRunnerTotals(), result);
  const state: TNeonNodeRunnerHealthState =
    result.failed > 0 || result.pollStatus >= 400 ? "degraded" : "running";

  return {
    runnerId,
    state,
    updatedAt,
    gatewayUrl: createRunnerTargetText(options.gatewayUrl),
    sessionId: createRunnerSummary(options.sessionId),
    ...(cursor ? { cursor } : {}),
    lastPollStatus: result.pollStatus,
    ...(result.replay ? { lastReplay: result.replay } : {}),
    ...(result.heartbeatAt ? { lastHeartbeatAt: result.heartbeatAt } : {}),
    totals,
    results: result.results.slice(-10),
    safety: createRunnerSafety()
  };
}

function createStoppedRunnerHealth(
  options: INeonNodeRunnerLoopOptions,
  previousHealth: INeonNodeRunnerHealthRecord | undefined,
  updatedAt: string
): INeonNodeRunnerHealthRecord {
  return {
    runnerId,
    state: "stopped",
    updatedAt,
    gatewayUrl: createRunnerTargetText(options.gatewayUrl),
    sessionId: createRunnerSummary(options.sessionId),
    ...(previousHealth?.cursor ? { cursor: previousHealth.cursor } : {}),
    totals: previousHealth?.totals ?? createEmptyRunnerTotals(),
    results: previousHealth?.results ?? [],
    safety: createRunnerSafety()
  };
}

function createEmptyRunnerTotals(): INeonNodeRunnerTotals {
  return {
    cycles: 0,
    pollRequests: 0,
    dispatches: 0,
    submitted: 0,
    blocked: 0,
    failed: 0
  };
}

function addRunnerTotals(
  totals: INeonNodeRunnerTotals,
  result: INeonNodeRunnerOnceResult
): INeonNodeRunnerTotals {
  return {
    cycles: totals.cycles + 1,
    pollRequests: totals.pollRequests + 1,
    dispatches: totals.dispatches + result.dispatches,
    submitted: totals.submitted + result.submitted,
    blocked: totals.blocked + result.blocked,
    failed: totals.failed + result.failed
  };
}

async function writeRunnerHealth(projectRoot: string, health: INeonNodeRunnerHealthRecord): Promise<void> {
  const paths = resolveNeonNodeRunnerPaths(projectRoot);

  await mkdir(resolve(projectRoot, "state", "nodes"), { recursive: true });
  await writeFile(paths.healthPath, `${JSON.stringify(health, null, 2)}\n`, "utf8");
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    return undefined;
  }
}

function parseRunnerControlRecord(value: unknown): INeonNodeRunnerControlRecord | undefined {
  const input = isRecord(value) ? value : undefined;
  const desiredState = parseRunnerControlState(input?.["desiredState"]);
  const updatedAt = readText(input?.["updatedAt"]);
  const operatorId = readText(input?.["operatorId"]);
  const reason = readText(input?.["reason"]);

  if (!desiredState || !updatedAt || !operatorId || !reason) {
    return undefined;
  }

  return {
    desiredState,
    updatedAt,
    operatorId: createRunnerSummary(operatorId),
    reason: createRunnerSummary(reason),
    safety: createRunnerSafety()
  };
}

function parseRunnerHealthRecord(value: unknown): INeonNodeRunnerHealthRecord | undefined {
  const input = isRecord(value) ? value : undefined;
  const state = parseRunnerHealthState(input?.["state"]);
  const updatedAt = readText(input?.["updatedAt"]);
  const gatewayUrl = readText(input?.["gatewayUrl"]);
  const sessionId = readText(input?.["sessionId"]);
  const totals = parseRunnerTotals(input?.["totals"]);
  const cursor = readText(input?.["cursor"]);
  const lastPollStatus = readNonNegativeInteger(input?.["lastPollStatus"]);
  const lastReplay = readText(input?.["lastReplay"]);
  const lastHeartbeatAt = readText(input?.["lastHeartbeatAt"]);

  if (!state || !updatedAt || !gatewayUrl || !sessionId || !totals) {
    return undefined;
  }

  return {
    runnerId: readText(input?.["runnerId"]) ?? runnerId,
    state,
    updatedAt,
    gatewayUrl: createRunnerTargetText(gatewayUrl),
    sessionId: createRunnerSummary(sessionId),
    ...(cursor ? { cursor } : {}),
    ...(lastPollStatus === undefined ? {} : { lastPollStatus }),
    ...(lastReplay ? { lastReplay } : {}),
    ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
    totals,
    results: parseRunnerDispatchReports(input?.["results"]),
    safety: createRunnerSafety()
  };
}

function parseRunnerTotals(value: unknown): INeonNodeRunnerTotals | undefined {
  const input = isRecord(value) ? value : undefined;
  const cycles = readNonNegativeInteger(input?.["cycles"]);
  const pollRequests = readNonNegativeInteger(input?.["pollRequests"]);
  const dispatches = readNonNegativeInteger(input?.["dispatches"]);
  const submitted = readNonNegativeInteger(input?.["submitted"]);
  const blocked = readNonNegativeInteger(input?.["blocked"]);
  const failed = readNonNegativeInteger(input?.["failed"]);

  if (
    cycles === undefined ||
    pollRequests === undefined ||
    dispatches === undefined ||
    submitted === undefined ||
    blocked === undefined ||
    failed === undefined
  ) {
    return undefined;
  }

  return {
    cycles,
    pollRequests,
    dispatches,
    submitted,
    blocked,
    failed
  };
}

function parseRunnerDispatchReports(value: unknown): readonly INeonNodeRunnerDispatchReport[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => parseRunnerDispatchReport(entry))
    .filter((entry): entry is INeonNodeRunnerDispatchReport => Boolean(entry));
}

function parseRunnerDispatchReport(value: unknown): INeonNodeRunnerDispatchReport | undefined {
  const input = isRecord(value) ? value : undefined;
  const dispatchId = readText(input?.["dispatchId"]);
  const kind = readText(input?.["kind"]);
  const state = parseRunnerDispatchState(input?.["state"]);
  const summary = readText(input?.["summary"]);
  const submitStatus = readNonNegativeInteger(input?.["submitStatus"]);

  if (!dispatchId || !kind || !state || !summary) {
    return undefined;
  }

  return {
    dispatchId: createRunnerSummary(dispatchId),
    kind: createRunnerSummary(kind),
    state,
    ...(submitStatus === undefined ? {} : { submitStatus }),
    summary: createRunnerSummary(summary)
  };
}

function parseRunnerControlState(value: unknown): TNeonNodeRunnerControlState | undefined {
  return value === "running" || value === "stopped" ? value : undefined;
}

function parseRunnerHealthState(value: unknown): TNeonNodeRunnerHealthState | undefined {
  return value === "idle" || value === "running" || value === "degraded" || value === "stopped"
    ? value
    : undefined;
}

function parseRunnerDispatchState(value: unknown): TNeonNodeRunnerDispatchState | undefined {
  return value === "submitted" || value === "blocked" || value === "failed" ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function waitForRunnerInterval(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) => {
    setTimeout(resolveWait, Math.max(0, milliseconds));
  });
}

async function createFileListRunnerResult(
  projectRoot: string,
  dispatch: INeonNodeTransportDispatch,
  options: INeonNodeRunnerDispatchOptions
): Promise<INeonNodeTransportResultInput> {
  const target = resolveRunnerWorkspacePath(projectRoot, dispatch.target.path ?? ".");

  if (!target) {
    return createBlockedRunnerResult(dispatch, "unsafe-target", "File list target escapes the workspace root.");
  }

  try {
    const targetStats = await lstat(target.absolutePath);

    if (!targetStats.isDirectory()) {
      return createBlockedRunnerResult(dispatch, "not-a-directory", "File list target is not a directory.");
    }

    const directoryEntries = await readdir(target.absolutePath, { withFileTypes: true });
    const maxEntries = options.maxEntries ?? runnerMaxEntriesDefault;
    const entries = await Promise.all(
      directoryEntries.slice(0, maxEntries).map(async (entry) => {
        const absoluteEntryPath = join(target.absolutePath, entry.name);
        const relativePath = createWorkspaceRelativePath(projectRoot, absoluteEntryPath) ?? entry.name;
        const entryStats = await lstat(absoluteEntryPath);
        const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";

        return {
          name: createRunnerTargetText(entry.name),
          kind,
          relativePath,
          ...(entryStats.isFile() ? { sizeBytes: entryStats.size } : {})
        };
      })
    );

    return {
      dispatchId: dispatch.dispatchId,
      summary: createRunnerSummary(`Runner listed ${entries.length} entries under ${target.relativePath}.`),
      entries,
      totalEntries: directoryEntries.length,
      truncated: directoryEntries.length > entries.length
    };
  } catch {
    return createBlockedRunnerResult(dispatch, "read-error", "File list failed during bounded read.");
  }
}

async function createFileFetchRunnerResult(
  projectRoot: string,
  dispatch: INeonNodeTransportDispatch,
  options: INeonNodeRunnerDispatchOptions
): Promise<INeonNodeTransportResultInput> {
  const target = resolveRunnerWorkspacePath(projectRoot, dispatch.target.path ?? ".");

  if (!target) {
    return createBlockedRunnerResult(dispatch, "unsafe-target", "File fetch target escapes the workspace root.");
  }

  try {
    const targetStats = await lstat(target.absolutePath);

    if (!targetStats.isFile()) {
      return createBlockedRunnerResult(dispatch, "not-a-file", "File fetch target is not a regular file.");
    }

    const maxTextBytes = options.maxTextBytes ?? runnerMaxTextBytesDefault;
    const bytesToRead = Math.min(maxTextBytes, targetStats.size);
    const fileHandle = await open(target.absolutePath, "r");

    try {
      const buffer = Buffer.alloc(bytesToRead);
      const readResult = bytesToRead > 0 ? await fileHandle.read(buffer, 0, bytesToRead, 0) : { bytesRead: 0 };
      const previewBuffer = buffer.subarray(0, readResult.bytesRead);
      const binary = !isLikelyTextBuffer(previewBuffer);

      return {
        dispatchId: dispatch.dispatchId,
        summary: createRunnerSummary(`Runner fetched ${target.relativePath} (${targetStats.size} bytes).`),
        sizeBytes: targetStats.size,
        binary,
        ...(binary ? {} : { textPreview: createRunnerPreview(new TextDecoder("utf-8").decode(previewBuffer)) }),
        truncated: targetStats.size > readResult.bytesRead
      };
    } finally {
      await fileHandle.close();
    }
  } catch {
    return createBlockedRunnerResult(dispatch, "read-error", "File fetch failed during bounded read.");
  }
}

async function createBrowserSnapshotRunnerResult(
  dispatch: INeonNodeTransportDispatch,
  options: INeonNodeRunnerDispatchOptions
): Promise<INeonNodeTransportResultInput> {
  const url = parseLoopbackHttpUrl(dispatch.target.url);

  if (!url) {
    return createBlockedRunnerResult(dispatch, "unsafe-target", "Browser snapshot only allows loopback HTTP URLs.");
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.fetchTimeoutMs ?? runnerFetchTimeoutMsDefault)
    });
    const rawText = await response.text();
    const boundedText = rawText.slice(0, options.maxTextBytes ?? runnerMaxTextBytesDefault);
    const textPreview = createRunnerPreview(stripHtmlForRunnerPreview(boundedText)) || "[empty]";
    const title = extractHtmlTitle(boundedText);

    return {
      dispatchId: dispatch.dispatchId,
      summary: createRunnerSummary(`Runner fetched loopback snapshot ${response.status} from ${new URL(url).pathname || "/"}.`),
      url,
      status: response.status,
      ...(title ? { title } : {}),
      textPreview,
      truncated: rawText.length > boundedText.length
    };
  } catch {
    return createBlockedRunnerResult(dispatch, "read-error", "Browser snapshot failed during loopback fetch.");
  }
}

const runnerMaxBrowserTabsDefault = 24;

interface INeonNodeBrowserTab {
  readonly title: string;
  readonly host: string;
}

interface INeonNodeBrowserTabInventory {
  readonly tabs: readonly INeonNodeBrowserTab[];
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Read-only browser tab inventory over a loopback Chrome DevTools Protocol
 * endpoint (`http://localhost:9222/json/list`). Upstream runs a full CDP browser
 * session manager (`src/node-host/runner.ts`, `src/config/types.browser.ts`
 * `cdpPort`/`cdpUrl`). Strategy: rebuild-native — Neon's shadow runner only READS
 * the CDP tab list (loopback-only, same guard as browser.snapshot), surfaces
 * title + host per tab, and never the page URL query, `webSocketDebuggerUrl`
 * control handle, or page content. No tab open/close/navigate.
 */
async function createBrowserTabsRunnerResult(
  dispatch: INeonNodeTransportDispatch,
  options: INeonNodeRunnerDispatchOptions
): Promise<INeonNodeTransportResultInput> {
  const url = parseLoopbackHttpUrl(dispatch.target.url);

  if (!url) {
    return createBlockedRunnerResult(dispatch, "unsafe-target", "Browser tab inventory only allows loopback HTTP URLs.");
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(options.fetchTimeoutMs ?? runnerFetchTimeoutMsDefault)
    });
    const rawText = await response.text();
    const boundedText = rawText.slice(0, options.maxTextBytes ?? runnerMaxTextBytesDefault);
    const inventory = parseBrowserTabsInventory(boundedText, options.maxEntries ?? runnerMaxBrowserTabsDefault);
    const textPreview =
      createRunnerPreview(inventory.tabs.map((tab) => tab.title || tab.host || "tab").join(" | ")) || "[no tabs]";

    return {
      dispatchId: dispatch.dispatchId,
      summary: createRunnerSummary(`Runner read ${inventory.tabs.length} loopback browser tab(s) (${response.status}).`),
      url,
      status: response.status,
      tabs: inventory.tabs,
      totalEntries: inventory.total,
      textPreview,
      truncated: inventory.truncated || rawText.length > boundedText.length
    };
  } catch {
    return createBlockedRunnerResult(dispatch, "read-error", "Browser tab inventory failed during loopback fetch.");
  }
}

function parseBrowserTabsInventory(rawText: string, maxTabs: number): INeonNodeBrowserTabInventory {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { tabs: [], total: 0, truncated: false };
  }

  if (!Array.isArray(parsed)) {
    return { tabs: [], total: 0, truncated: false };
  }

  // CDP /json/list entries — only real pages, never background/service-worker
  // targets or debugger control handles.
  const pages = parsed.filter((entry): entry is Record<string, unknown> => {
    if (!isRecord(entry)) {
      return false;
    }

    const type = typeof entry["type"] === "string" ? entry["type"] : "page";
    return type === "page";
  });
  const tabs = pages.slice(0, maxTabs).map((entry) => ({
    title: createRunnerTargetText(typeof entry["title"] === "string" ? entry["title"] : ""),
    host: safeHostFromUrl(entry["url"])
  }));

  return { tabs, total: pages.length, truncated: pages.length > tabs.length };
}

function safeHostFromUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function createBlockedRunnerResult(
  dispatch: INeonNodeTransportDispatch,
  blockReason: string,
  summary: string
): INeonNodeTransportResultInput {
  return {
    dispatchId: dispatch.dispatchId,
    state: "blocked",
    blockReason: createRunnerSummary(blockReason),
    summary: createRunnerSummary(summary)
  };
}

function createRunnerState(results: readonly INeonNodeRunnerDispatchReport[]): TNeonNodeRunnerState {
  if (results.length === 0) {
    return "idle";
  }

  const failed = results.some((result) => result.state === "failed");
  const submitted = results.some((result) => result.state === "submitted");
  const blocked = results.some((result) => result.state === "blocked");

  if (failed || (submitted && blocked)) {
    return "partial";
  }

  return submitted ? "submitted" : "blocked";
}

function createRunnerSafety(): INeonNodeRunnerSafety {
  return {
    mutationExecuted: false,
    sideEffectExecuted: false,
    rawOutputPersisted: false,
    rawTokenPersisted: false,
    sessionSecretPersisted: false
  };
}

function createSessionHeaders(input: { readonly sessionId: string; readonly sessionSecret: string }): Record<string, string> {
  return {
    "x-neon-node-session-id": input.sessionId,
    "x-neon-node-session-secret": input.sessionSecret
  };
}

function createGatewayEndpoint(gatewayUrl: string, path: string): URL {
  const base = gatewayUrl.endsWith("/") ? gatewayUrl : `${gatewayUrl}/`;
  return new URL(path.replace(/^\//u, ""), base);
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return {};
  }
}

function parseRunnerPollResponse(value: unknown): IRunnerPollResponse {
  const input = isRecord(value) ? value : {};
  const rawDispatches = Array.isArray(input["dispatches"]) ? input["dispatches"] : [];
  const dispatches = rawDispatches
    .map((dispatch) => parseRunnerDispatch(dispatch))
    .filter((dispatch): dispatch is INeonNodeTransportDispatch => Boolean(dispatch));

  return {
    ...(typeof input["replay"] === "string" ? { replay: input["replay"] } : {}),
    ...(typeof input["cursor"] === "string" ? { cursor: input["cursor"] } : {}),
    ...(typeof input["previousCursor"] === "string" ? { previousCursor: input["previousCursor"] } : {}),
    ...(typeof input["heartbeatAt"] === "string" ? { heartbeatAt: input["heartbeatAt"] } : {}),
    dispatches
  };
}

function parseRunnerDispatch(value: unknown): INeonNodeTransportDispatch | undefined {
  const input = isRecord(value) ? value : undefined;

  if (!input || input["state"] !== "ready" || input["delivery"] !== "poll") {
    return undefined;
  }

  const dispatchId = readText(input["dispatchId"]);
  const approvalId = readText(input["approvalId"]);
  const requestId = readText(input["requestId"]);
  const sessionId = readText(input["sessionId"]);
  const deviceId = readText(input["deviceId"]);
  const kind = parseRunnerDispatchKind(input["kind"]);
  const target = parseRunnerTarget(input["target"]);
  const requestedAt = readText(input["requestedAt"]);
  const approvedAt = readText(input["approvedAt"]);
  const generatedAt = readText(input["generatedAt"]);
  const safety = parseRunnerDispatchSafety(input["safety"]);

  if (
    !dispatchId ||
    !approvalId ||
    !requestId ||
    !sessionId ||
    !deviceId ||
    !kind ||
    !target ||
    !requestedAt ||
    !approvedAt ||
    !generatedAt ||
    !safety
  ) {
    return undefined;
  }

  return {
    dispatchId,
    state: "ready",
    approvalId,
    requestId,
    sessionId,
    deviceId,
    kind,
    target,
    requestedAt,
    approvedAt,
    generatedAt,
    delivery: "poll",
    safety
  };
}

function parseRunnerDispatchKind(value: unknown): INeonNodeTransportDispatch["kind"] | undefined {
  return value === "file.list" || value === "dir.list" || value === "file.fetch" || value === "browser.tabs" || value === "browser.snapshot"
    ? value
    : undefined;
}

function parseRunnerTarget(value: unknown): INeonNodeTransportDispatch["target"] | undefined {
  const input = isRecord(value) ? value : undefined;

  if (!input) {
    return undefined;
  }

  const path = readText(input["path"]);
  const url = readText(input["url"]);

  return {
    ...(path ? { path } : {}),
    ...(url ? { url } : {})
  };
}

function parseRunnerDispatchSafety(value: unknown): INeonNodeTransportDispatch["safety"] | undefined {
  const input = isRecord(value) ? value : undefined;

  if (
    !input ||
    input["readOnly"] !== true ||
    input["mutationAllowed"] !== false ||
    input["sideEffectExecuted"] !== false ||
    input["rawOutputPersisted"] !== false ||
    input["rawTokenExposed"] !== false ||
    input["sessionSecretExposed"] !== false
  ) {
    return undefined;
  }

  return {
    readOnly: true,
    mutationAllowed: false,
    sideEffectExecuted: false,
    rawOutputPersisted: false,
    rawTokenExposed: false,
    sessionSecretExposed: false
  };
}

function resolveRunnerWorkspacePath(projectRoot: string, targetPath: string): IResolvedRunnerPath | undefined {
  const resolvedRoot = resolve(projectRoot);
  const resolvedTarget = resolve(resolvedRoot, targetPath);
  const relativePath = createWorkspaceRelativePath(resolvedRoot, resolvedTarget);

  if (!relativePath) {
    return undefined;
  }

  return {
    absolutePath: resolvedTarget,
    relativePath
  };
}

function createWorkspaceRelativePath(projectRoot: string, absolutePath: string): string | undefined {
  const resolvedRoot = resolve(projectRoot);
  const resolvedTarget = resolve(absolutePath);
  const relativePath = relative(resolvedRoot, resolvedTarget);

  if (relativePath === "") {
    return ".";
  }

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return undefined;
  }

  return createRunnerTargetText(relativePath.split(sep).join("/"));
}

function createRunnerTargetText(value: string): string {
  return redactText(value).slice(0, runnerMaxTargetLength);
}

function createRunnerSummary(value: string): string {
  const redacted = redactText(value).replace(/\s+/gu, " ").trim();
  return redacted.length <= runnerMaxSummaryLength ? redacted : `${redacted.slice(0, runnerMaxSummaryLength - 1)}…`;
}

function createRunnerPreview(value: string): string {
  return redactText(value).slice(0, runnerMaxTextPreviewLength);
}

function parseLoopbackHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

    if ((url.protocol === "http:" || url.protocol === "https:") && loopback) {
      return redactText(`${url.origin}${url.pathname}`).slice(0, runnerMaxTargetLength);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function stripHtmlForRunnerPreview(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractHtmlTitle(value: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(value);
  const title = match ? stripHtmlForRunnerPreview(match[1] ?? "") : "";
  return title.length > 0 ? createRunnerSummary(title) : undefined;
}

function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.byteLength === 0) {
    return true;
  }

  if (buffer.includes(0)) {
    return false;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }

  let controlBytes = 0;

  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      controlBytes += 1;
    }
  }

  return controlBytes / buffer.byteLength < 0.01;
}

function readText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
