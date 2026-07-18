/**
 * Neon Operator Shell — read-only data loader.
 *
 * Bridges the pure shell contract (`operatorShell.ts`) to the existing snapshot
 * builders. Every panel reuses a real Neon read-only projection plus its render
 * function, so the operator shell never duplicates rendering logic and never
 * introduces a side effect. A failing panel is isolated: its error is redacted
 * and surfaced as an `error` state so one bad read cannot break the dashboard.
 */

import { renderNeonCutoverGateReport, createNeonCutoverGateSnapshot } from "../core/cutoverGate.js";
import { renderProductManifest } from "../core/product.js";
import { createNeonDoctorSnapshot, renderNeonDoctorReport } from "../doctor/neonDoctor.js";
import {
  createNeonDeliveryQueueSnapshot,
  renderNeonDeliveryQueueReport
} from "../gateway/deliveryQueue.js";
import {
  createNeonGatewayRouteInspectionSnapshot,
  renderNeonGatewayRouteInspectionReport
} from "../gateway/routeInspection.js";
import { readNeonGatewayStatus, type INeonGatewayStatus } from "../gateway/runStore.js";
import {
  createNeonSessionsSnapshot,
  renderNeonSessionsReport
} from "../gateway/sessionSnapshot.js";
import { redactText } from "../harness/redaction.js";

import {
  neonTuiPanelDescriptors,
  resolveNeonTuiPanelDescriptor,
  type INeonTuiDashboard,
  type INeonTuiPanelView,
  type TNeonTuiPanelId
} from "./operatorShell.js";

const DEFAULT_SESSIONS_MAX_RUNS = 50;
const DEFAULT_DELIVERY_MAX_CANDIDATES = 50;

/** Options for loading operator panels read-only. */
export interface ILoadNeonTuiDashboardOptions {
  /** Injectable clock so dashboard/cutover/doctor timestamps are deterministic. */
  readonly now?: () => Date;
  readonly sessionsMaxRuns?: number;
  readonly deliveryMaxCandidates?: number;
}

interface IPanelData {
  readonly state: string;
  readonly lines: readonly string[];
}

type TPanelLoader = (
  projectRoot: string,
  options: ILoadNeonTuiDashboardOptions
) => Promise<IPanelData>;

const panelLoaders: Readonly<Record<TNeonTuiPanelId, TPanelLoader>> = {
  status: async () => ({ state: "ready", lines: toLines(renderProductManifest()) }),
  gateway: async (projectRoot) => {
    const status = await readNeonGatewayStatus(projectRoot);

    return { state: status.state, lines: renderGatewayStatusLines(status) };
  },
  routes: async (projectRoot) => {
    const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot);

    return { state: snapshot.state, lines: toLines(renderNeonGatewayRouteInspectionReport(snapshot)) };
  },
  sessions: async (projectRoot, options) => {
    const snapshot = await createNeonSessionsSnapshot(projectRoot, {
      maxRuns: options.sessionsMaxRuns ?? DEFAULT_SESSIONS_MAX_RUNS
    });

    return { state: snapshot.state, lines: toLines(renderNeonSessionsReport(snapshot)) };
  },
  delivery: async (projectRoot, options) => {
    const snapshot = await createNeonDeliveryQueueSnapshot(projectRoot, {
      maxCandidates: options.deliveryMaxCandidates ?? DEFAULT_DELIVERY_MAX_CANDIDATES
    });

    return { state: snapshot.state, lines: toLines(renderNeonDeliveryQueueReport(snapshot)) };
  },
  cutover: async (projectRoot, options) => {
    const snapshot = await createNeonCutoverGateSnapshot(
      projectRoot,
      options.now ? { now: options.now } : {}
    );

    return { state: snapshot.state, lines: toLines(renderNeonCutoverGateReport(snapshot)) };
  },
  doctor: async (projectRoot, options) => {
    const snapshot = await createNeonDoctorSnapshot(projectRoot, {
      includeMemoryStatus: true,
      ...(options.now ? { now: options.now } : {})
    });

    return { state: snapshot.state, lines: toLines(renderNeonDoctorReport(snapshot)) };
  }
};

/** Load a single operator panel read-only. Errors become an `error` state. */
export async function loadNeonTuiPanel(
  projectRoot: string,
  panelId: TNeonTuiPanelId,
  options: ILoadNeonTuiDashboardOptions = {}
): Promise<INeonTuiPanelView> {
  const descriptor = resolveNeonTuiPanelDescriptor(panelId);

  if (!descriptor) {
    throw new Error(`Unknown Neon operator panel: ${panelId}`);
  }

  try {
    const data = await panelLoaders[panelId](projectRoot, options);

    return {
      id: descriptor.id,
      title: descriptor.title,
      command: descriptor.command,
      state: data.state,
      lines: data.lines
    };
  } catch (error) {
    return {
      id: descriptor.id,
      title: descriptor.title,
      command: descriptor.command,
      state: "error",
      lines: [`Failed to load ${descriptor.command}: ${redactText(describeError(error))}`]
    };
  }
}

/** Load every operator panel read-only into a single dashboard snapshot. */
export async function loadNeonTuiDashboard(
  projectRoot: string,
  options: ILoadNeonTuiDashboardOptions = {}
): Promise<INeonTuiDashboard> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const panels = await Promise.all(
    neonTuiPanelDescriptors.map((descriptor) => loadNeonTuiPanel(projectRoot, descriptor.id, options))
  );

  return {
    generatedAt,
    projectRoot,
    panels
  };
}

function renderGatewayStatusLines(status: INeonGatewayStatus): readonly string[] {
  const latest = status.latestRun
    ? [
        `Latest: ${status.latestRun.runId}`,
        `Latest status: ${status.latestRun.status}`,
        `Latest channel: ${status.latestRun.channel}/${status.latestRun.channelId}`,
        `Latest agent: ${status.latestRun.agentId}`,
        `Latest memory: ${status.latestRun.memoryState}`
      ]
    : ["Latest: none"];

  return [
    `Gateway: ${status.state}`,
    `Runs: ${status.runCount}`,
    `Shadow: ${status.shadowRunCount}`,
    `Completed: ${status.completedCount}`,
    `Failed: ${status.failedCount}`,
    `Cancelled: ${status.cancelledCount}`,
    `Running: ${status.runningCount}`,
    `Delivery suppressed: ${status.deliverySuppressedCount}`,
    `Runs path: ${status.runsPath}`,
    ...latest
  ];
}

function toLines(report: string): readonly string[] {
  return report.split("\n");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
