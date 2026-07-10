import { writeNeonGatewayRun } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import {
  appendNeonWorkspaceNote,
  resolveNeonWorkspaceNotesGate,
  type INeonWorkspaceNotesGate
} from "../workspace/workspaceNotes.js";
import type { INeonCronDaemonTickResult } from "./cronDaemonRuntime.js";

type TNeonCronShadowRunKind = "current" | "catch-up";

export interface INeonCronShadowRunEmission {
  readonly jobId: string;
  readonly windowKey: string;
  readonly kind: TNeonCronShadowRunKind;
}

export interface INeonCronExecutionResult {
  readonly createdRunIds: readonly string[];
  readonly createdRunCount: number;
  readonly createdWorkspaceNoteCount: number;
  readonly safety: {
    readonly outboundSent: false;
    readonly sentDiscord: false;
    readonly wroteRunStore: boolean;
    readonly wroteWorkspaceNotes: boolean;
    readonly executed: false;
  };
  readonly diagnostics: readonly string[];
}

export interface IExecuteNeonCronRunIntentsOptions {
  readonly projectRoot: string;
  readonly tick: INeonCronDaemonTickResult;
  readonly agentId?: string;
  readonly workspaceNotesGate?: INeonWorkspaceNotesGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injectable writer for tests; defaults to the real gateway run store. */
  readonly writeRun?: (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;
}

const cronRunChannel = "cli" as const;
const cronRunChannelId = "cron-daemon";
const defaultCronAgentId = "chaty";

export function buildNeonCronShadowRun(params: {
  readonly projectRoot: string;
  readonly tickAt: string;
  readonly agentId?: string;
  readonly emission: INeonCronShadowRunEmission;
}): INeonGatewayShadowRun {
  const agentId = params.agentId ?? defaultCronAgentId;
  const safeJobId = sanitizeCronRunIdPart(params.emission.jobId);
  const safeWindow = sanitizeCronRunIdPart(params.emission.windowKey);
  const runId = `cron-${safeJobId}-${safeWindow}-${params.emission.kind}`;

  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: cronRunChannel,
      accountId: "cron",
      channelId: cronRunChannelId,
      userId: "system",
      agentId,
      workspaceRoot: params.projectRoot,
      mode: "read-only",
      goal: `cron ${params.emission.jobId}`,
      contentPreview: `cron shadow run (${params.emission.jobId}, ${params.emission.kind}, ${params.emission.windowKey})`,
      receivedAt: params.tickAt
    },
    harnessId: "claude-cli",
    harnessSessionKey: `cron:${params.emission.jobId}`,
    memoryState: "skipped",
    events: [],
    finalText: "",
    delivery: {
      state: "suppressed",
      targetChannel: cronRunChannel,
      targetChannelId: cronRunChannelId,
      reason: "cron shadow run — outbound suppressed",
      finalText: ""
    },
    startedAt: params.emission.windowKey,
    completedAt: params.tickAt
  };
}

export async function executeNeonCronRunIntents(
  options: IExecuteNeonCronRunIntentsOptions
): Promise<INeonCronExecutionResult> {
  const writeRun = options.writeRun ?? writeNeonGatewayRun;
  const workspaceNotesGate =
    options.workspaceNotesGate ?? resolveNeonWorkspaceNotesGate(options.env ?? {});
  const createdRunIds: string[] = [];
  let createdWorkspaceNoteCount = 0;
  const emissions = buildCronShadowRunEmissions(options.tick);

  for (const emission of emissions) {
    const run = buildNeonCronShadowRun({
      projectRoot: options.projectRoot,
      tickAt: options.tick.tickAt,
      ...(options.agentId ? { agentId: options.agentId } : {}),
      emission
    });
    await writeRun(options.projectRoot, run);
    createdRunIds.push(run.runId);

    const noteResult = await appendNeonWorkspaceNote({
      projectRoot: options.projectRoot,
      gate: workspaceNotesGate,
      note: {
        kind: "cron",
        title: `Cron ${emission.jobId} ${emission.kind}`,
        source: `cron:${emission.jobId}:${emission.kind}`,
        body: `Cron window ${emission.windowKey} emitted a terminal shadow run-record ${run.runId}. Delivery stayed suppressed.`
      },
      now: () => new Date(options.tick.tickAt)
    });
    if (noteResult.state === "appended") {
      createdWorkspaceNoteCount += 1;
    }
  }

  const wroteRunStore = createdRunIds.length > 0;
  const wroteWorkspaceNotes = createdWorkspaceNoteCount > 0;
  return {
    createdRunIds,
    createdRunCount: createdRunIds.length,
    createdWorkspaceNoteCount,
    safety: { outboundSent: false, sentDiscord: false, wroteRunStore, wroteWorkspaceNotes, executed: false },
    diagnostics: [
      wroteRunStore
        ? `Wrote ${createdRunIds.length} terminal shadow cron run-record(s); delivery suppressed on every record.`
        : "No cron run intents to execute; no run-store write.",
      wroteWorkspaceNotes
        ? `Wrote ${createdWorkspaceNoteCount} local workspace note(s).`
        : `No workspace note written (${workspaceNotesGate.reason}).`
    ]
  };
}

function buildCronShadowRunEmissions(tick: INeonCronDaemonTickResult): readonly INeonCronShadowRunEmission[] {
  const emissions: INeonCronShadowRunEmission[] = [];
  for (const entry of tick.catchup) {
    emissions.push({
      jobId: entry.jobId,
      windowKey: entry.window,
      kind: "catch-up"
    });
  }
  for (const jobId of tick.tick.emitted) {
    const windowKey = tick.tick.nextEmitted[jobId];
    if (!windowKey) {
      continue;
    }
    emissions.push({
      jobId,
      windowKey,
      kind: "current"
    });
  }
  return emissions;
}

function sanitizeCronRunIdPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "unknown";
}
