import type { Stats } from "node:fs";
import { lstat, readlink, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { createNeonAgentsSnapshot } from "../agents/registry.js";
import {
  listNeonChannelManifests,
  renderNeonChannelManifestLine,
  summarizeNeonChannelManifests
} from "../channels/channelManifest.js";
import {
  deriveCutoverGateStates,
  evaluateShadowExitGate,
  isNeonOutboundStage,
  isNeonSteadyCutoverStage,
  neonikaCutoverStages,
  readOptionalCutoverEnv,
  readReadyCutoverEnv,
  resolveCutoverStageFromEnv,
  type ICutoverGateState,
  type IShadowExitGateEvidence,
  type TCutoverStageId
} from "../core/cutover.js";
import { loadNeonCutoverEnv } from "../core/cutoverPromotion.js";
import { createNeonMirrorEvidenceSnapshot } from "../core/mirrorEvidence.js";
import { evaluateNeonCanaryLivePreconditions } from "../gateway/outboundSender.js";
import {
  assessNeonNodeRuntime,
  type INeonNodeRuntimeAssessment
} from "../core/nodeRuntimeGuard.js";
import {
  isNeonHeartbeatDaemonStale,
  readNeonHeartbeatDaemonLiveState,
  resolveNeonHeartbeatDaemonLivePath
} from "../automation/heartbeatDaemonService.js";
import { resolveNeonHeartbeatTimerGate } from "../automation/heartbeatTimerRuntime.js";
import { projectNeonIndexer } from "../indexer/indexerSnapshot.js";
import { scanNeonTranscripts } from "../indexer/transcriptScan.js";
import {
  queryGatewayRuns,
  readNeonGatewayRuns,
  readNeonGatewayStatus,
  resolveGatewayStatePaths,
  scanNeonRunStoreIntegrity,
  type INeonGatewayStatePaths,
  type INeonGatewayStatus
} from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import {
  createNeonGatewayRouteInspectionSnapshot,
  type INeonGatewayRouteInspectionSnapshot
} from "../gateway/routeInspection.js";
import {
  createDefaultNeonMemoryProvider,
  readNeonMemoryStatus,
  type INeonMemoryProvider,
  type INeonMemoryStatus
} from "../memory/neonMemory.js";
import {
  createNeonExtensionInventorySnapshot,
  createNeonSkillInventorySnapshot,
  resolveDefaultReferenceRoot,
  type INeonExtensionInventorySnapshot,
  type INeonSkillInventorySnapshot,
  type INeonSkillRootConfig
} from "../skills/neonSkills.js";
import { countOnePasswordSecretRefs } from "../secrets/secretRefs.js";
import {
  detectSuspiciousExternalContentPatterns,
  type INeonExternalContentFinding,
  type TNeonExternalContentPatternId
} from "../security/externalContent.js";
import {
  createNeonToolInventorySnapshot,
  type INeonToolInventorySnapshot
} from "../tools/neonTools.js";
import {
  createNeonNodePairingSnapshot,
  type INeonNodePairingSnapshot
} from "../nodes/neonNodePairing.js";
import { detectNeonCloudSyncedStateDir } from "./stateIntegrity.js";

export type TNeonDoctorState = "pass" | "warn" | "fail";

export type TNeonDoctorCheckId =
  | "gateway"
  | "node-runtime"
  | "runs"
  | "channels"
  | "channel-auth"
  | "channel-manifest"
  | "agents"
  | "memory"
  | "memory-files"
  | "delivery"
  | "secrets"
  | "external-content"
  | "secret-refs"
  | "filesystem"
  | "config"
  | "plugins"
  | "plugin-dependency-state"
  | "skill-security"
  | "tools"
  | "device-pairing"
  | "state-integrity"
  | "run-store-integrity"
  | "indexer"
  | "transcript"
  | "heartbeat-daemon"
  | "cutover"
  | "outbound";

export interface INeonDoctorCheck {
  readonly id: TNeonDoctorCheckId;
  readonly label: string;
  readonly state: TNeonDoctorState;
  readonly summary: string;
  readonly details: readonly string[];
}

export interface INeonDoctorTotals {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
}

export interface INeonDoctorSource {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly gatewayRoot: string;
  readonly runsPath: string;
  readonly configPaths: readonly string[];
  readonly extensionRoot: string;
}

export interface INeonDoctorSnapshot {
  readonly generatedAt: string;
  readonly state: TNeonDoctorState;
  readonly currentStage: TCutoverStageId;
  readonly totals: INeonDoctorTotals;
  readonly checks: readonly INeonDoctorCheck[];
  readonly source: INeonDoctorSource;
}

export interface ICreateNeonDoctorSnapshotOptions {
  readonly now?: () => Date;
  readonly maxRuns?: number;
  readonly currentStage?: TCutoverStageId;
  readonly referenceRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly includeMemoryStatus?: boolean;
  readonly memoryStatusProvider?: INeonMemoryProvider;
  /** Injected by tests; production reads process.versions.node. */
  readonly nodeVersion?: string;
  /** Transcript-indexer ingest root (~/.claude/projects by default). Injected by tests for determinism. */
  readonly transcriptProjectsDir?: string;
}

export async function createNeonDoctorSnapshot(
  projectRoot: string,
  options: ICreateNeonDoctorSnapshotOptions = {}
): Promise<INeonDoctorSnapshot> {
  const paths = resolveGatewayStatePaths(projectRoot);
  const generatedAt = options.now?.() ?? new Date();
  const extensionInventoryOptions = options.referenceRoot
    ? { generatedAt, referenceRoot: options.referenceRoot }
    : { generatedAt };
  const routeInspectionOptions = options.env
    ? { env: options.env, now: () => generatedAt }
    : { now: () => generatedAt };
  const [status, runs, rawRuns, routeInspection, mirrorEvidence] = await Promise.all([
    readNeonGatewayStatus(projectRoot),
    readNeonGatewayRuns(projectRoot, {
      maxRuns: options.maxRuns ?? 50
    }),
    readRawRuns(paths.runsPath),
    createNeonGatewayRouteInspectionSnapshot(projectRoot, routeInspectionOptions),
    createNeonMirrorEvidenceSnapshot(projectRoot, { now: () => generatedAt })
  ]);
  // The persisted cutover promotion merged under the live environment (live wins), so
  // every cutover-aware check reads the same effective state the runtime does. Reading
  // process.env alone made the doctor blind to anything persisted — it would report an
  // armed install as disarmed, and default the stage to shadow while the gate said
  // otherwise.
  const cutoverEnv = options.env ?? (await loadNeonCutoverEnv(projectRoot));
  const currentStage = options.currentStage ?? resolveCutoverStageFromEnv(cutoverEnv);
  const memoryStatus =
    options.includeMemoryStatus || options.memoryStatusProvider
      ? await readNeonMemoryStatus({
          now: () => generatedAt,
          provider: options.memoryStatusProvider ?? createDefaultNeonMemoryProvider()
        })
      : undefined;
  const skillSecurityRoots = buildDoctorSkillSecurityRoots(
    projectRoot,
    options.referenceRoot ?? resolveDefaultReferenceRoot()
  );
  const [filesystemCheck, configCheck, secretRefsCheck, memoryFilesCheck, pluginInventory, skillInventory] =
    await Promise.all([
      buildFilesystemCheck(paths),
      buildConfigFilesCheck(paths),
      buildSecretRefsCheck(paths),
      buildMemoryFilesCheck(paths.projectRoot),
      createNeonExtensionInventorySnapshot(projectRoot, extensionInventoryOptions),
      createNeonSkillInventorySnapshot(projectRoot, {
        generatedAt,
        skillRoots: skillSecurityRoots
      })
    ]);
  const pluginCheck = buildPluginInventoryCheck(pluginInventory);
  const pluginDependencyStateCheck = await buildPluginDependencyStateCheck(
    paths,
    options.referenceRoot ?? resolveDefaultReferenceRoot()
  );
  const skillSecurityCheck = buildSkillSecurityCheck(skillInventory);
  const memoryCheck = buildMemoryCheck(runs, memoryStatus);
  const secretsCheck = buildSecretsCheck(rawRuns);
  const toolsCheck = buildToolsCheck(createNeonToolInventorySnapshot({ now: () => generatedAt, env: cutoverEnv }));
  const pairingSnapshot = await createNeonNodePairingSnapshot(projectRoot, { now: () => generatedAt });
  const devicePairingCheck = buildDevicePairingCheck(pairingSnapshot);
  const transcriptCheck = await buildTranscriptCheck({
    now: generatedAt.getTime(),
    ...(options.transcriptProjectsDir ? { projectsDir: options.transcriptProjectsDir } : {})
  });
  const heartbeatDaemonCheck = await buildHeartbeatDaemonCheck(projectRoot, {
    env: cutoverEnv,
    nowMs: generatedAt.getTime()
  });
  const checksBeforeCutover = [
    buildNodeRuntimeCheck(assessNeonNodeRuntime(options.nodeVersion ?? process.versions.node)),
    buildGatewayCheck(status),
    buildRunsCheck(status),
    buildChannelsCheck(runs),
    buildChannelAuthCheck(routeInspection),
    buildChannelManifestCheck(),
    buildAgentsCheck(),
    memoryCheck,
    memoryFilesCheck,
    buildDeliveryCheck(runs, currentStage),
    secretsCheck,
    buildExternalContentCheck(rawRuns, runs),
    secretRefsCheck,
    filesystemCheck,
    configCheck,
    pluginCheck,
    pluginDependencyStateCheck,
    skillSecurityCheck,
    toolsCheck,
    devicePairingCheck,
    buildStateIntegrityCheck(paths.stateRoot),
    buildRunStoreIntegrityCheck(rawRuns),
    buildIndexerCheck(runs),
    transcriptCheck,
    heartbeatDaemonCheck
  ];
  const cutoverGateStates = deriveCutoverGateStates({
    shadowFailed:
      checksBeforeCutover.some((check) => check.state === "fail") || status.failedCount > 0,
    runCount: status.runCount,
    shadowRunCount: status.shadowRunCount,
    deliverySuppressedCount: status.deliverySuppressedCount,
    failedCount: status.failedCount,
    routeReady: routeInspection.state === "ready",
    memoryReady: memoryCheck.state === "pass",
    mirrorEvidenceReady: mirrorEvidence.state === "ready",
    mirrorAcceptedCount: mirrorEvidence.totals.accepted,
    rollbackConfigured: Boolean(readOptionalCutoverEnv(cutoverEnv, "NEON_CUTOVER_ROLLBACK_COMMAND")),
    canaryApproved: readReadyCutoverEnv(cutoverEnv, "NEON_CUTOVER_CANARY_APPROVED"),
    primaryApproved: readReadyCutoverEnv(cutoverEnv, "NEON_CUTOVER_PRIMARY_APPROVED"),
    doctorHasNoFailures: !checksBeforeCutover.some((check) => check.state === "fail"),
    completedCount: status.completedCount,
    retireEvidenceReady: readReadyCutoverEnv(cutoverEnv, "NEON_CUTOVER_RETIRE_EVIDENCE")
  });
  const checks = [
    ...checksBeforeCutover,
    buildCutoverCheck(currentStage, evaluateShadowExitGate(status), cutoverGateStates),
    buildOutboundCheck(cutoverEnv)
  ];
  const totals = countDoctorStates(checks);

  return {
    generatedAt: generatedAt.toISOString(),
    state: resolveDoctorState(totals),
    currentStage,
    totals,
    checks,
    source: {
      projectRoot: paths.projectRoot,
      stateRoot: paths.stateRoot,
      gatewayRoot: paths.gatewayRoot,
      runsPath: paths.runsPath,
      configPaths: resolveKnownConfigPaths(paths),
      extensionRoot: pluginInventory.source.extensionRoot
    }
  };
}

function buildNodeRuntimeCheck(assessment: INeonNodeRuntimeAssessment): INeonDoctorCheck {
  const details = [
    `node=${assessment.nodeVersion}`,
    `supported=${assessment.supportedRange}`,
    `reason=${assessment.reason}`
  ];

  return {
    id: "node-runtime",
    label: "Node Runtime",
    state: assessment.state === "supported" ? "pass" : "fail",
    summary:
      assessment.state === "supported"
        ? `Node runtime satisfies ${assessment.supportedRange}`
        : `Node runtime does not satisfy ${assessment.supportedRange}`,
    details
  };
}

export function renderNeonDoctorReport(snapshot: INeonDoctorSnapshot): string {
  const checkLines = snapshot.checks.map((check) => {
    return `${check.state.toUpperCase()} ${check.label}: ${check.summary}`;
  });

  return [
    `Neonika Doctor: ${snapshot.state}`,
    `Stage: ${snapshot.currentStage}`,
    `Checks: pass=${snapshot.totals.pass} warn=${snapshot.totals.warn} fail=${snapshot.totals.fail}`,
    `Runs: ${snapshot.source.runsPath}`,
    ...checkLines
  ].join("\n");
}

export function renderNeonDoctorExplainReport(snapshot: INeonDoctorSnapshot): string {
  const actionableChecks = snapshot.checks.filter((check) => check.state !== "pass");
  const lines = [
    `Neonika Doctor Explain: ${snapshot.state}`,
    "Mode: read-only; no repair, restart, config write, credential lookup, or chmod executed.",
    `Stage: ${snapshot.currentStage}`,
    `Checks: pass=${snapshot.totals.pass} warn=${snapshot.totals.warn} fail=${snapshot.totals.fail}`,
    `Runs: ${snapshot.source.runsPath}`
  ];

  if (actionableChecks.length === 0) {
    return [
      ...lines,
      "No warnings or failures. No repair steps required."
    ].join("\n");
  }

  return [
    ...lines,
    "Repair Plan:",
    ...actionableChecks.flatMap(formatDoctorExplainCheck)
  ].join("\n");
}

function formatDoctorExplainCheck(check: INeonDoctorCheck): readonly string[] {
  const details = formatDoctorExplainDetails(check);

  return [
    `- ${check.state.toUpperCase()} ${check.label}: ${check.summary}`,
    ...details.map((detail) => `  ${detail}`)
  ];
}

function formatDoctorExplainDetails(check: INeonDoctorCheck): readonly string[] {
  const details = [
    ...check.details,
    `action=${recommendedDoctorAction(check)}`
  ];

  return [...new Set(details)];
}

function recommendedDoctorAction(check: INeonDoctorCheck): string {
  if (check.details.some((detail) => detail.startsWith("remediation="))) {
    return "Review and run the listed remediation manually after confirming the path.";
  }

  switch (check.id) {
    case "node-runtime":
      return "Run Neonika on Node >=22.19.0 <23 or >=23.11.0; Node 23.0-23.10 is blocked.";
    case "gateway":
      return "Start or inspect the Neonika Gateway before cutover.";
    case "runs":
      return "Run node dist/src/cli.js gateway-shadow-smoke to capture baseline Gateway evidence.";
    case "channels":
      return "Run node dist/src/cli.js discord-shadow-smoke after route configuration is present.";
    case "channel-auth":
      return "Set scoped Discord guild/channel allowlists and bot identity before canary.";
    case "channel-manifest":
      return "Keep non-Discord channels gated (no-new-login) until a separate live-channel slice is approved.";
    case "agents":
      return "Restore the default Neon agent registry entry before routing work.";
    case "memory":
      return "Run node dist/src/cli.js gateway-memory-shadow-smoke for concrete Memory evidence.";
    case "memory-files":
      return "Rename a legacy memory.md to MEMORY.md; a missing workspace memory file is optional under shared memory-search.";
    case "delivery":
      return "Keep outbound delivery suppressed until the cutover gate explicitly allows it.";
    case "secrets":
      return "Remove or redact secret-looking values from Neon state before continuing.";
    case "external-content":
      return "Treat matching run content as untrusted input and add prompt wrapping before canary routing.";
    case "secret-refs":
      return "Keep SecretRefs reference-only; resolve values only inside an authenticated runtime provider.";
    case "filesystem":
      return "Restrict Neon state permissions before canary or primary cutover.";
    case "config":
      return "Restrict secret-bearing config file permissions before canary or primary cutover.";
    case "plugins":
      return "Keep extension inventory reference-only until an explicit Neon allowlist and loader policy exist.";
    case "plugin-dependency-state":
      return "Remove stale plugin dependency state only after confirming no active OpenClaw/Neon runtime still uses it.";
    case "skill-security":
      return "Quarantine flagged skills and review the matched rule ids before enabling skill invocation.";
    case "tools":
      return "Keep NEON_TOOLS_LIVE_ENABLED unset to hold the dry-run shadow posture for web/api/voice tools.";
    case "device-pairing":
      return "Keep device pairing diagnose read-only; token issuance stays canary-gated and there is no autonomous revoke.";
    case "state-integrity":
      return "Move NEON_* state off cloud-synced storage (iCloud/CloudStorage) to a local-only path.";
    case "run-store-integrity":
      return "Inspect runs.jsonl for truncated/corrupt lines before trusting run counts; a partial write may have dropped runs.";
    case "indexer":
      return "Run node dist/src/cli.js indexer-smoke to verify decision-candidate projection from Gateway runs.";
    case "transcript":
      return "Run node dist/src/cli.js transcript-smoke to verify Claude Code transcript session-digest projection.";
    case "heartbeat-daemon":
      return "Inspect node dist/src/cli.js heartbeat-daemon-status; a stale daemon means the loop crashed — restart it with heartbeat-daemon-run.";
    case "cutover":
      return "Review node dist/src/cli.js cutover-gate for the next gate requirement.";
    case "outbound":
      return "Run node dist/src/cli.js arm-outbound to review targets and arm sending.";
  }
}

function buildGatewayCheck(status: INeonGatewayStatus): INeonDoctorCheck {
  return {
    id: "gateway",
    label: "Gateway",
    state: status.state === "ready" ? "pass" : "fail",
    summary: `Gateway state is ${status.state}.`,
    details: [
      `projectRoot=${status.projectRoot}`,
      `runsPath=${status.runsPath}`
    ]
  };
}

function buildRunsCheck(status: INeonGatewayStatus): INeonDoctorCheck {
  if (status.runCount === 0) {
    return {
      id: "runs",
      label: "Runs",
      state: "warn",
      summary: "No persisted Gateway runs yet.",
      details: ["Run a shadow smoke before moving toward mirror."]
    };
  }

  return {
    id: "runs",
    label: "Runs",
    state: status.failedCount > 0 ? "warn" : "pass",
    summary: `${status.runCount} persisted run(s), ${status.failedCount} failed.`,
    details: [
      `shadow=${status.shadowRunCount}`,
      `completed=${status.completedCount}`,
      `latest=${status.latestRun?.runId ?? "none"}`
    ]
  };
}

// Transcript-indexer health: a read-only scan of ~/.claude/projects (count only,
// no extraction, no LLM). Never fails so it can't block the shadow gate — empty
// is a warn, like the gateway-run indexer.
async function buildTranscriptCheck(options: {
  readonly now: number;
  readonly projectsDir?: string;
}): Promise<INeonDoctorCheck> {
  const files = await scanNeonTranscripts({
    now: options.now,
    ...(options.projectsDir ? { projectsDir: options.projectsDir } : {})
  });

  if (files.length === 0) {
    return {
      id: "transcript",
      label: "Transcript indexer",
      state: "warn",
      summary: "No recent transcripts to index.",
      details: ["The transcript indexer projects Claude Code session digests once recent transcripts exist."]
    };
  }

  const projects = new Set(files.map((file) => file.project)).size;
  const subagentSessions = files.filter((file) => file.isSubagent).length;

  return {
    id: "transcript",
    label: "Transcript indexer",
    state: "pass",
    summary: `${files.length} recent transcript session(s) across ${projects} project(s).`,
    details: [`subagentSessions=${subagentSessions}`]
  };
}

function buildIndexerCheck(runs: readonly INeonGatewayShadowRun[]): INeonDoctorCheck {
  const projection = projectNeonIndexer(runs);

  if (projection.totals.sessions === 0) {
    return {
      id: "indexer",
      label: "Indexer",
      state: "warn",
      summary: "No sessions to index yet.",
      details: ["The indexer projects decision candidates once shadow runs exist."]
    };
  }

  return {
    id: "indexer",
    label: "Indexer",
    state: "pass",
    summary: `${projection.totals.sessions} session(s), ${projection.totals.candidates} decision candidate(s).`,
    details: [
      `runs=${projection.totals.runs}`,
      `decisionSignals=${projection.totals.decisionSignals}`
    ]
  };
}

async function buildHeartbeatDaemonCheck(
  projectRoot: string,
  options: { readonly env: Readonly<Record<string, string | undefined>>; readonly nowMs: number }
): Promise<INeonDoctorCheck> {
  const gate = resolveNeonHeartbeatTimerGate(options.env);
  const daemon = await readNeonHeartbeatDaemonLiveState(resolveNeonHeartbeatDaemonLivePath(projectRoot));
  // Static shadow-safety invariant: the heartbeat loop only ever writes terminal
  // shadow run-records; outbound is suppressed and no real channel send happens.
  const safetyDetail = "outbound=suppressed (shadow heartbeat never sends)";
  const gateDetail = `gate=${gate.enabled ? "armed" : "disabled"} (${gate.envKey})`;

  if (!daemon) {
    return {
      id: "heartbeat-daemon",
      label: "Heartbeat Daemon",
      state: "pass",
      summary: `Not running (optional gated shadow loop; gate ${gate.enabled ? "armed" : "disabled"}).`,
      details: [gateDetail, safetyDetail]
    };
  }

  if (isNeonHeartbeatDaemonStale(daemon, options.nowMs)) {
    return {
      id: "heartbeat-daemon",
      label: "Heartbeat Daemon",
      state: "warn",
      summary: "Claims alive but its next tick is overdue (crashed or hung).",
      details: [
        gateDetail,
        `pid=${daemon.pid}`,
        `lastTick=${daemon.lastTickAt ?? "none"}`,
        `nextTick=${daemon.nextTickAt ?? "none"}`,
        `ticks=${daemon.tickCount}`,
        `dueCommitmentsLastTick=${daemon.dueCommitmentsLastTick}`,
        `lifecycleCommitmentsLastTick=${daemon.lifecycleCommitmentsLastTick}`,
        `createdRuns=${daemon.createdRunsTotal}`,
        safetyDetail
      ]
    };
  }

  return {
    id: "heartbeat-daemon",
    label: "Heartbeat Daemon",
    state: "pass",
    summary: daemon.alive
      ? `Alive: ${daemon.tickCount} tick(s), ${daemon.createdRunsTotal} shadow run(s) created.`
      : `Stopped cleanly after ${daemon.tickCount} tick(s).`,
    details: [
      gateDetail,
      `alive=${daemon.alive}`,
      `lastTick=${daemon.lastTickAt ?? "none"}`,
      `nextTick=${daemon.nextTickAt ?? "none"}`,
      `dueIntentsLastTick=${daemon.dueIntentsLastTick}`,
      `dueCommitmentsLastTick=${daemon.dueCommitmentsLastTick}`,
      `lifecycleCommitmentsLastTick=${daemon.lifecycleCommitmentsLastTick}`,
      `createdRuns=${daemon.createdRunsTotal}`,
      safetyDetail
    ]
  };
}

function buildChannelsCheck(runs: readonly INeonGatewayShadowRun[]): INeonDoctorCheck {
  // Heartbeat/cron daemon runs ride the internal "cli" channel; counting them
  // would mask whether a real user channel (discord) is live. Observe user
  // channels only, but report the excluded system count for transparency.
  const userRuns = runs.filter((run) => !isNeonSystemOriginatedRun(run));
  const systemRunCount = runs.length - userRuns.length;
  const channels = new Set(userRuns.map((run) => run.request.channel));
  const systemNote = systemRunCount > 0 ? ` (+${systemRunCount} system run(s) excluded)` : "";

  if (channels.size === 0) {
    return {
      id: "channels",
      label: "Channels",
      state: "warn",
      summary: `No user-ingress channel activity in ${runs.length} run(s)${systemNote}.`,
      details: [
        "observed=0",
        `systemRuns=${systemRunCount}`,
        "Discord shadow smoke is the current first channel proof."
      ]
    };
  }

  return {
    id: "channels",
    label: "Channels",
    state: channels.has("discord") ? "pass" : "warn",
    summary: `Observed channel(s): ${[...channels].join(", ")}${systemNote}.`,
    details: [`observed=${channels.size}`, `systemRuns=${systemRunCount}`]
  };
}

function buildChannelAuthCheck(snapshot: INeonGatewayRouteInspectionSnapshot): INeonDoctorCheck {
  const unsafeAuth = snapshot.authStatus.filter((auth) => auth.state === "unsafe");
  const missingAuth = snapshot.authStatus.filter((auth) => auth.state === "needs-config");
  const details = snapshot.authStatus.flatMap((auth) => {
    return [
      `channel=${auth.channel} account=${auth.accountId} state=${auth.state}`,
      ...auth.checks,
      ...auth.recovery.map((step) => `recovery=${step}`)
    ];
  });

  if (unsafeAuth.length > 0) {
    return {
      id: "channel-auth",
      label: "Channel Auth",
      state: "fail",
      summary: `${unsafeAuth.length} channel auth route(s) use unsafe scope.`,
      details
    };
  }

  if (missingAuth.length > 0) {
    return {
      id: "channel-auth",
      label: "Channel Auth",
      state: "warn",
      summary: `${missingAuth.length} channel auth route(s) need configuration.`,
      details
    };
  }

  return {
    id: "channel-auth",
    label: "Channel Auth",
    state: "pass",
    summary: `${snapshot.authStatus.length} channel auth route(s) ready.`,
    details
  };
}

function buildChannelManifestCheck(): INeonDoctorCheck {
  const manifests = listNeonChannelManifests();
  const totals = summarizeNeonChannelManifests(manifests);
  const liveChannels = manifests.filter((manifest) => manifest.liveStatus === "live");
  // Invariant: every non-live channel must stay no-new-login. A gated channel that declared an
  // existing-session login would silently allow a second live connection.
  const escapedLogins = manifests.filter(
    (manifest) => manifest.liveStatus !== "live" && manifest.loginPolicy !== "no-new-login"
  );
  const details = [
    `total=${totals.total} live=${totals.live} gated=${totals.gated}`,
    `live=${liveChannels.map((manifest) => manifest.id).join(",") || "none"}`,
    ...manifests.map((manifest) => renderNeonChannelManifestLine(manifest))
  ];

  if (escapedLogins.length > 0) {
    return {
      id: "channel-manifest",
      label: "Channel Manifest",
      state: "fail",
      summary: `${escapedLogins.length} gated channel(s) declare a live login.`,
      details
    };
  }

  const liveIds = liveChannels.map((manifest) => manifest.id);
  if (liveIds.length !== 2 || liveIds[0] !== "discord" || liveIds[1] !== "whatsapp") {
    return {
      id: "channel-manifest",
      label: "Channel Manifest",
      state: "warn",
      summary: "Expected exactly two live shadow-ingress channels (Discord and WhatsApp).",
      details
    };
  }

  return {
    id: "channel-manifest",
    label: "Channel Manifest",
    state: "pass",
    summary: `${totals.total} channels inventoried: 2 live (discord,whatsapp), ${totals.gated} gated no-login.`,
    details
  };
}

function buildAgentsCheck(): INeonDoctorCheck {
  const snapshot = createNeonAgentsSnapshot();
  const defaultAgentExists = snapshot.agents.some((agent) => agent.id === snapshot.defaultAgentId);

  return {
    id: "agents",
    label: "Agents",
    state: defaultAgentExists && snapshot.agents.length > 0 ? "pass" : "fail",
    summary: `${snapshot.agents.length} Neon agent(s), default=${snapshot.defaultAgentId}.`,
    details: [
      `state=${snapshot.state}`,
      `defaultExists=${String(defaultAgentExists)}`
    ]
  };
}

function buildDevicePairingCheck(pairing: INeonNodePairingSnapshot): INeonDoctorCheck {
  // Read-only diagnose over the pairing request/approval snapshot only. Expired
  // pairing requests are a cleanup hint (warn); pending/approved-shadow are the
  // expected shadow posture, not a failure. No token is issued and nothing is
  // revoked here.
  //
  // The token-gate / cutover posture is intentionally NOT folded into this check:
  // createNeonNodePairingTokenGateSnapshot transitively calls the cutover gate,
  // and the cutover gate calls the doctor snapshot back. Aggregating it here would
  // create a doctor -> token-gate -> cutover -> doctor recursion (heap OOM). The
  // token-gate posture stays on its own surface (node-pairing-token-gate CLI /
  // /api/neon-nodes/pairing/token-gate).
  const expired = pairing.totals.expired;
  const state: TNeonDoctorState = expired > 0 ? "warn" : "pass";
  const summary =
    expired > 0
      ? `${expired} expired pairing request(s); ${pairing.totals.pending} pending, ${pairing.totals.approvedShadow} approved-shadow.`
      : `Pairing ${pairing.state}: ${pairing.totals.pending} pending, ${pairing.totals.approvedShadow} approved-shadow, ${pairing.totals.denied} denied.`;

  return {
    id: "device-pairing",
    label: "Device Pairing",
    state,
    summary,
    details: [
      `Requests: ${pairing.totals.requests} (pending ${pairing.totals.pending}, expired ${expired}, denied ${pairing.totals.denied})`,
      `Approvals: ${pairing.totals.approvedShadow} approved-shadow`,
      "Read-only diagnose: no token issued, no revoke. Token-gate posture on node-pairing-token-gate surface."
    ]
  };
}

function buildToolsCheck(snapshot: INeonToolInventorySnapshot): INeonDoctorCheck {
  // Posture check: a closed live gate (default) is the safe shadow state. An
  // armed gate is reported as warn — it permits live web/api/voice invocation,
  // which an operator should see, not a failure. No secret value is read here.
  const liveModeTools = snapshot.tools.filter((tool) => tool.mode === "live").length;
  const familySummary = snapshot.families
    .map((family) => `${family.family}=${family.available}/${family.total}`)
    .join(" ");

  return {
    id: "tools",
    label: "Tools",
    state: snapshot.gate.enabled ? "warn" : "pass",
    summary: `${snapshot.totals.available}/${snapshot.totals.tools} tools available, ${snapshot.totals.providersReady}/${snapshot.totals.providers} providers ready, live gate ${snapshot.gate.enabled ? "ARMED" : "closed"}.`,
    details: [
      `gate=${snapshot.gate.envKey}:${snapshot.gate.reason}`,
      `liveModeTools=${liveModeTools}`,
      `families=${familySummary}`,
      ...(snapshot.gate.enabled
        ? ["remediation=unset NEON_TOOLS_LIVE_ENABLED to return to dry-run shadow posture"]
        : [])
    ]
  };
}

async function statBytesOrZero(filePath: string): Promise<number> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? fileStat.size : 0;
  } catch {
    return 0;
  }
}

async function listWorkspaceEntryNames(projectRoot: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(projectRoot));
  } catch {
    return new Set<string>();
  }
}

/**
 * Read-only root memory file check. Ported from OpenClaw
 * `src/commands/doctor-workspace.ts` + `src/memory/root-memory-files.ts`
 * (`detectRootMemoryFiles`, canonical `MEMORY.md` / legacy `memory.md`). Existence
 * is checked via `readdir` entry names (exact case), not `stat`, because a
 * case-insensitive filesystem (macOS) collapses `MEMORY.md` and `memory.md` —
 * matching OpenClaw's `exactWorkspaceEntryExists`/`entries.has` approach.
 * Strategy: rebuild-native — OpenClaw treats a missing workspace memory file as
 * missing guidance, but Neonika agents recall through the shared `memory-search`
 * store, so absence is informational (pass). A legacy-only `memory.md` without the
 * canonical name is a genuine read-only repair signal (warn). Read-only, no write.
 * See THIRD_PARTY_NOTICES.md for attribution.
 */
async function buildMemoryFilesCheck(projectRoot: string): Promise<INeonDoctorCheck> {
  const canonicalPath = join(projectRoot, "MEMORY.md");
  const legacyPath = join(projectRoot, "memory.md");
  const entries = await listWorkspaceEntryNames(projectRoot);
  const canonicalPresent = entries.has("MEMORY.md");
  const legacyPresent = entries.has("memory.md");
  const baseDetails = [
    `canonical=${canonicalPath}`,
    "policy=read-only-readdir",
    "neonMemory=shared memory-search (workspace MEMORY.md is optional)"
  ];

  if (legacyPresent && !canonicalPresent) {
    return {
      id: "memory-files",
      label: "Memory Files",
      state: "warn",
      summary: `Legacy memory.md present without canonical MEMORY.md (${await statBytesOrZero(legacyPath)} bytes).`,
      details: [...baseDetails, `legacy=${legacyPath}`, "remediation=Rename memory.md to MEMORY.md."]
    };
  }

  if (canonicalPresent) {
    return {
      id: "memory-files",
      label: "Memory Files",
      state: "pass",
      summary: `Root MEMORY.md present (${await statBytesOrZero(canonicalPath)} bytes).`,
      details: baseDetails
    };
  }

  return {
    id: "memory-files",
    label: "Memory Files",
    state: "pass",
    summary: "No workspace root memory file; Neon agents use shared memory-search.",
    details: baseDetails
  };
}

/**
 * Heartbeat and cron daemons persist runs with `request.userId === "system"`
 * (see automation/heartbeatRunExecutor.ts, automation/cronRunExecutor.ts).
 * Those runs never recall user memory by design, so the Memory doctor check
 * must exclude them; otherwise a window full of daemon ticks reads as
 * "Memory never attached" even though real user-ingress recall is healthy.
 */
function isNeonSystemOriginatedRun(run: INeonGatewayShadowRun): boolean {
  return run.request.userId === "system";
}

function buildMemoryCheck(
  runs: readonly INeonGatewayShadowRun[],
  memoryStatus?: INeonMemoryStatus
): INeonDoctorCheck {
  const memoryStatusDetails = formatMemoryStatusDetails(memoryStatus);

  if (runs.length === 0) {
    return {
      id: "memory",
      label: "Memory",
      state: memoryStatus?.state === "unavailable" ? "fail" : "warn",
      summary:
        memoryStatus?.state === "unavailable"
          ? "No gateway runs with Memory evidence yet; Memory backend unavailable."
          : "No gateway runs with Memory evidence yet.",
      details: ["Run gateway-memory-shadow-smoke for a concrete Memory proof.", ...memoryStatusDetails]
    };
  }

  const failed = queryGatewayRuns(runs, { memoryState: "failed" }).length;

  // Daemon-originated runs (heartbeat/cron) never recall user memory, so judge
  // the attachment state on real user-ingress runs only. A memory failure
  // anywhere still counts as a hard failure below.
  const userRuns = runs.filter((run) => !isNeonSystemOriginatedRun(run));
  const systemRunCount = runs.length - userRuns.length;
  const attached = userRuns.filter((run) => run.memoryState === "attached").length;
  const skipped = userRuns.filter((run) => run.memoryState === "skipped").length;
  const latestUserRun = userRuns.at(-1);
  const systemNote = systemRunCount > 0 ? ` (+${systemRunCount} system run(s) excluded)` : "";
  const runWord = systemRunCount > 0 ? "user run(s)" : "run(s)";
  const distributionSummary = `${userRuns.length} ${runWord}: ${attached} attached, ${skipped} skipped, ${failed} failed${systemNote}`;
  const details = [
    `userRuns=${userRuns.length}`,
    `systemRuns=${systemRunCount}`,
    `attached=${attached}`,
    `skipped=${skipped}`,
    `failed=${failed}`,
    `latestUserRun=${latestUserRun?.runId ?? "none"} state=${latestUserRun?.memoryState ?? "none"}`,
    ...memoryStatusDetails
  ];

  if (failed > 0 || memoryStatus?.state === "unavailable") {
    return {
      id: "memory",
      label: "Memory",
      state: "fail",
      summary:
        failed > 0
          ? `${distributionSummary}; Memory failure recorded.`
          : `${distributionSummary}; Memory backend unavailable.`,
      details
    };
  }

  if (userRuns.length === 0) {
    return {
      id: "memory",
      label: "Memory",
      state: "pass",
      summary: `${runs.length} run(s), all system-originated; no user-ingress run in window to evaluate Memory.`,
      details
    };
  }

  if (attached === 0) {
    return {
      id: "memory",
      label: "Memory",
      state: "warn",
      summary: `${distributionSummary}; Memory never attached.`,
      details
    };
  }

  if (memoryStatus?.state === "degraded") {
    return {
      id: "memory",
      label: "Memory",
      state: "warn",
      summary: `${distributionSummary}; Memory backend degraded.`,
      details
    };
  }

  return {
    id: "memory",
    label: "Memory",
    state: latestUserRun?.memoryState === "attached" ? "pass" : "warn",
    summary: `${distributionSummary}; latest run Memory state is ${latestUserRun?.memoryState ?? "none"}.`,
    details
  };
}

function formatMemoryStatusDetails(memoryStatus?: INeonMemoryStatus): readonly string[] {
  if (!memoryStatus) {
    return [];
  }

  return [
    `memoryBackend=${memoryStatus.state}`,
    `memoryBackendHits=${memoryStatus.hitCount}`,
    `memoryBackendCheckedAt=${memoryStatus.checkedAt}`,
    ...(memoryStatus.lastError ? [`memoryBackendLastError=${memoryStatus.lastError}`] : []),
    ...memoryStatus.diagnostics.map((diagnostic) => `memoryBackendDiagnostic=${diagnostic}`)
  ];
}

function buildDeliveryCheck(
  runs: readonly INeonGatewayShadowRun[],
  currentStage: TCutoverStageId
): INeonDoctorCheck {
  // Under shadow/mirror, outbound must stay suppressed and every non-suppressed
  // run is a contract violation. Under canary/primary, a delivered run is the
  // expected, gated outcome (the sender already enforced the channel allowlist).
  if (isNeonOutboundStage(currentStage)) {
    const deliveredRuns = queryGatewayRuns(runs, { deliveryState: "delivered" });

    return {
      id: "delivery",
      label: "Delivery",
      state: "pass",
      summary: `Outbound is live at the ${currentStage} stage; ${deliveredRuns.length} run(s) delivered.`,
      details: [`inspected=${runs.length}`, `delivered=${deliveredRuns.length}`]
    };
  }

  const unsafeRuns = queryGatewayRuns(runs, { deliveryStateNot: "suppressed" });

  if (unsafeRuns.length > 0) {
    return {
      id: "delivery",
      label: "Delivery",
      state: "fail",
      summary: `${unsafeRuns.length} run(s) are not shadow-suppressed.`,
      details: unsafeRuns.slice(0, 5).map((run) => run.runId)
    };
  }

  return {
    id: "delivery",
    label: "Delivery",
    state: "pass",
    summary: "All inspected runs keep outbound delivery suppressed.",
    details: [`inspected=${runs.length}`]
  };
}

function buildSecretsCheck(rawRuns: string | undefined): INeonDoctorCheck {
  const leaks = rawRuns ? detectSecretLeakLabels(rawRuns) : [];

  if (leaks.length > 0) {
    return {
      id: "secrets",
      label: "Secrets",
      state: "fail",
      summary: "Potential secret-looking values found in Gateway run storage.",
      details: leaks
    };
  }

  return {
    id: "secrets",
    label: "Secrets",
    state: "pass",
    summary: "No secret-looking values detected in inspected Gateway run storage.",
    details: [rawRuns ? "runsFile=present" : "runsFile=missing"]
  };
}

function buildStateIntegrityCheck(stateRoot: string): INeonDoctorCheck {
  const cloudSynced = detectNeonCloudSyncedStateDir(stateRoot);
  if (cloudSynced) {
    return {
      id: "state-integrity",
      label: "State integrity",
      state: "warn",
      summary: `State directory is on ${cloudSynced.storage} (corruption/leak risk).`,
      details: [
        `stateRoot=${cloudSynced.path}`,
        "Cloud-synced folders (iCloud/Dropbox/Google Drive/OneDrive) can corrupt SQLite/JSONL state and replicate transcripts/tokens to other devices.",
        "Move NEON_* state to a local-only path for durability and leak-safety."
      ]
    };
  }
  return {
    id: "state-integrity",
    label: "State integrity",
    state: "pass",
    summary: "State directory is on local (non-cloud-synced) storage.",
    details: [`stateRoot=${stateRoot}`]
  };
}

function buildRunStoreIntegrityCheck(rawRuns: string | undefined): INeonDoctorCheck {
  const integrity = scanNeonRunStoreIntegrity(rawRuns);
  if (integrity.corruptLines > 0) {
    return {
      id: "run-store-integrity",
      label: "Run store integrity",
      state: "warn",
      summary: `${integrity.corruptLines} of ${integrity.totalLines} run-store line(s) are unparsable and dropped on read.`,
      details: [
        `totalLines=${integrity.totalLines}`,
        `parsedRuns=${integrity.parsedRuns}`,
        `corruptLines=${integrity.corruptLines}`,
        "Truncated/corrupt runs.jsonl lines are silently dropped on read; inspect the run store for a partial write or disk fault."
      ]
    };
  }
  return {
    id: "run-store-integrity",
    label: "Run store integrity",
    state: "pass",
    summary:
      integrity.totalLines > 0
        ? `All ${integrity.totalLines} run-store line(s) parse cleanly.`
        : "Run store is empty or absent.",
    details: [`totalLines=${integrity.totalLines}`, `parsedRuns=${integrity.parsedRuns}`]
  };
}

function buildExternalContentCheck(
  rawRuns: string | undefined,
  runs: readonly INeonGatewayShadowRun[]
): INeonDoctorCheck {
  const findings = rawRuns ? detectSuspiciousExternalContentPatterns(rawRuns) : [];
  const persistedDetails = formatPersistedFindingDetails(runs);
  if (findings.length > 0) {
    const totalMatches = findings.reduce((sum, finding) => sum + finding.count, 0);
    return {
      id: "external-content",
      label: "External Content",
      state: "warn",
      summary: `${totalMatches} suspicious external-content pattern match(es) detected in Gateway run storage.`,
      details: [...formatExternalContentFindingDetails(findings), ...persistedDetails]
    };
  }

  return {
    id: "external-content",
    label: "External Content",
    state: "pass",
    summary: "No prompt-injection-like external-content patterns detected in inspected Gateway run storage.",
    details: [rawRuns ? "runsFile=present" : "runsFile=missing", ...persistedDetails]
  };
}

function formatExternalContentFindingDetails(
  findings: readonly INeonExternalContentFinding[]
): readonly string[] {
  return findings.map((finding) => {
    return `${finding.id}: severity=${finding.severity} count=${finding.count}`;
  });
}

/**
 * Aggregates the persisted suspicious-findings recorded on the parsed runs
 * (request.suspiciousFindings, Slice 8) into a compact, deterministic detail view.
 *
 * This is a read-only detail enrichment and does NOT influence the check state:
 * the warn/pass decision is driven solely by the on-the-fly rawRuns detection.
 * Carries only the pattern id, the per-id match-count sum, and how many runs hold
 * that finding. No raw text. The hyphenated pattern ids never match the
 * external-content regexes, so appending them to details cannot inflate the check.
 */
function formatPersistedFindingDetails(
  runs: readonly INeonGatewayShadowRun[]
): readonly string[] {
  const runsWithFindings = queryGatewayRuns(runs, { hasSuspiciousFindings: true }).length;

  const aggregates = new Map<TNeonExternalContentPatternId, { runs: number; count: number }>();
  for (const run of runs) {
    for (const finding of run.request.suspiciousFindings ?? []) {
      const current = aggregates.get(finding.id) ?? { runs: 0, count: 0 };
      aggregates.set(finding.id, {
        runs: current.runs + 1,
        count: current.count + finding.count
      });
    }
  }

  const details: string[] = [`persistedRunsWithFindings=${runsWithFindings}`];
  for (const id of PERSISTED_FINDING_ID_ORDER) {
    const aggregate = aggregates.get(id);
    if (aggregate) {
      details.push(`persisted ${id}: runs=${aggregate.runs} count=${aggregate.count}`);
    }
  }

  return details;
}

const PERSISTED_FINDING_ID_ORDER: readonly TNeonExternalContentPatternId[] = [
  "ignore-previous-instructions",
  "system-role-boundary",
  "tool-call-injection",
  "exfiltration-request",
  "instruction-reset"
];

async function buildSecretRefsCheck(paths: INeonGatewayStatePaths): Promise<INeonDoctorCheck> {
  const findings = await collectSecretRefScanFindings(paths);
  const warningFindings = findings.filter((finding) => finding.state === "warn");
  const refCount = findings.reduce((total, finding) => total + finding.refCount, 0);

  if (warningFindings.length > 0) {
    return {
      id: "secret-refs",
      label: "Secret Refs",
      state: "warn",
      summary: `${warningFindings.length} config file(s) could not be scanned for SecretRefs.`,
      details: warningFindings.map((finding) => finding.detail)
    };
  }

  if (refCount > 0) {
    return {
      id: "secret-refs",
      label: "Secret Refs",
      state: "pass",
      summary: `${refCount} SecretRef reference(s) configured; raw values were not resolved.`,
      details: findings.filter((finding) => finding.refCount > 0).map((finding) => finding.detail)
    };
  }

  return {
    id: "secret-refs",
    label: "Secret Refs",
    state: "pass",
    summary: "No SecretRef references found in inspected config files.",
    details: findings.map((finding) => finding.detail)
  };
}

async function buildFilesystemCheck(paths: INeonGatewayStatePaths): Promise<INeonDoctorCheck> {
  try {
    const stateRootStat = await stat(paths.stateRoot);

    if (!stateRootStat.isDirectory()) {
      return {
        id: "filesystem",
        label: "Filesystem",
        state: "fail",
        summary: "State path exists but is not a directory.",
        details: [
          `stateRoot=${paths.stateRoot}`,
          "remediation=Move the file out of the way and create a private state directory."
        ]
      };
    }

    return buildFilesystemPermissionCheck(paths, stateRootStat.mode);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return {
        id: "filesystem",
        label: "Filesystem",
        state: "pass",
        summary: "State directory has not been created yet.",
        details: [
          `stateRoot=${paths.stateRoot}`,
          "next=First Gateway write will create state/gateway/runs.jsonl."
        ]
      };
    }

    return {
      id: "filesystem",
      label: "Filesystem",
      state: "warn",
      summary: "State directory permissions could not be inspected.",
      details: [
        `stateRoot=${paths.stateRoot}`,
        `error=${formatUnknownError(error)}`
      ]
    };
  }
}

function buildFilesystemPermissionCheck(
  paths: INeonGatewayStatePaths,
  rawMode: number
): INeonDoctorCheck {
  const mode = rawMode & 0o777;
  const modeLabel = formatPosixMode(mode);
  const isWorldWritable = hasPermissionBit(mode, 0o002);
  const isGroupWritable = hasPermissionBit(mode, 0o020);
  const isReadableByOthers = hasPermissionBit(mode, 0o044);

  if (isWorldWritable) {
    return {
      id: "filesystem",
      label: "Filesystem",
      state: "fail",
      summary: `State directory is world-writable (${modeLabel}).`,
      details: buildFilesystemPermissionDetails(paths, modeLabel)
    };
  }

  if (isGroupWritable) {
    return {
      id: "filesystem",
      label: "Filesystem",
      state: "warn",
      summary: `State directory is group-writable (${modeLabel}).`,
      details: buildFilesystemPermissionDetails(paths, modeLabel)
    };
  }

  if (isReadableByOthers) {
    return {
      id: "filesystem",
      label: "Filesystem",
      state: "warn",
      summary: `State directory is readable by group or other users (${modeLabel}).`,
      details: buildFilesystemPermissionDetails(paths, modeLabel)
    };
  }

  return {
    id: "filesystem",
    label: "Filesystem",
    state: "pass",
    summary: `State directory permissions are private (${modeLabel}).`,
    details: [
      `stateRoot=${paths.stateRoot}`,
      `mode=${modeLabel}`
    ]
  };
}

function buildFilesystemPermissionDetails(
  paths: INeonGatewayStatePaths,
  modeLabel: string
): readonly string[] {
  return [
    `stateRoot=${paths.stateRoot}`,
    `mode=${modeLabel}`,
    `remediation=chmod 700 ${shellQuote(paths.stateRoot)}`
  ];
}

async function buildConfigFilesCheck(paths: INeonGatewayStatePaths): Promise<INeonDoctorCheck> {
  const findings = await collectConfigFilePermissionFindings(paths);
  const presentCount = findings.filter((finding) => finding.state !== "pass" || finding.present).length;
  const failingFindings = findings.filter((finding) => finding.state === "fail");
  const warningFindings = findings.filter((finding) => finding.state === "warn");

  if (failingFindings.length > 0) {
    return {
      id: "config",
      label: "Config Files",
      state: "fail",
      summary: `${failingFindings.length} config file permission issue(s) can expose or alter secrets.`,
      details: formatConfigFileFindingDetails(failingFindings)
    };
  }

  if (warningFindings.length > 0) {
    return {
      id: "config",
      label: "Config Files",
      state: "warn",
      summary: `${warningFindings.length} config file permission warning(s) need review.`,
      details: formatConfigFileFindingDetails(warningFindings)
    };
  }

  return {
    id: "config",
    label: "Config Files",
    state: "pass",
    summary: presentCount === 0 ? "No secret-bearing config files found." : `${presentCount} config file(s) have private permissions.`,
    details: findings.map((finding) => finding.detail)
  };
}

interface IConfigFilePermissionFinding {
  readonly path: string;
  readonly state: TNeonDoctorState;
  readonly present: boolean;
  readonly detail: string;
  readonly remediation?: string;
}

interface ISecretRefScanFinding {
  readonly path: string;
  readonly state: TNeonDoctorState;
  readonly present: boolean;
  readonly detail: string;
  readonly refCount: number;
}

async function collectConfigFilePermissionFindings(
  paths: INeonGatewayStatePaths
): Promise<readonly IConfigFilePermissionFinding[]> {
  const findings = await Promise.all(
    resolveKnownConfigPaths(paths).map(async (configPath) => {
      return await inspectConfigFilePermissions(configPath);
    })
  );

  return findings;
}

async function collectSecretRefScanFindings(
  paths: INeonGatewayStatePaths
): Promise<readonly ISecretRefScanFinding[]> {
  return await Promise.all(resolveKnownConfigPaths(paths).map(scanConfigFileSecretRefs));
}

async function scanConfigFileSecretRefs(configPath: string): Promise<ISecretRefScanFinding> {
  try {
    const configStat = await lstat(configPath);

    if (!configStat.isFile()) {
      return {
        path: configPath,
        state: "warn",
        present: true,
        refCount: 0,
        detail: `${configPath} secretRefScan=skipped non-file`
      };
    }

    const raw = await readFile(configPath, "utf8");
    const refCount = countOnePasswordSecretRefs(raw);

    return {
      path: configPath,
      state: "pass",
      present: true,
      refCount,
      detail:
        refCount > 0
          ? `${configPath} secretRefStatus=ref provider=1password count=${refCount}`
          : `${configPath} secretRefStatus=none`
    };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return {
        path: configPath,
        state: "pass",
        present: false,
        refCount: 0,
        detail: `${configPath} secretRefScan=missing`
      };
    }

    return {
      path: configPath,
      state: "warn",
      present: true,
      refCount: 0,
      detail: `${configPath} SecretRef scan failed: ${formatUnknownError(error)}`
    };
  }
}

async function inspectConfigFilePermissions(configPath: string): Promise<IConfigFilePermissionFinding> {
  try {
    const configStat = await lstat(configPath);

    if (configStat.isSymbolicLink()) {
      return {
        path: configPath,
        state: "warn",
        present: true,
        detail: `${configPath} is a symlink; verify the target trust boundary.`
      };
    }

    if (!configStat.isFile()) {
      return {
        path: configPath,
        state: "warn",
        present: true,
        detail: `${configPath} exists but is not a file.`
      };
    }

    return buildConfigFileModeFinding(configPath, configStat);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return {
        path: configPath,
        state: "pass",
        present: false,
        detail: `${configPath}=missing`
      };
    }

    return {
      path: configPath,
      state: "warn",
      present: true,
      detail: `${configPath} permissions could not be inspected: ${formatUnknownError(error)}`
    };
  }
}

function buildConfigFileModeFinding(
  configPath: string,
  configStat: Stats
): IConfigFilePermissionFinding {
  const mode = configStat.mode & 0o777;
  const modeLabel = formatPosixMode(mode);
  const isWritableByOthers = hasPermissionBit(mode, 0o022);
  const isWorldReadable = hasPermissionBit(mode, 0o004);
  const isGroupReadable = hasPermissionBit(mode, 0o040);

  if (isWritableByOthers) {
    return {
      path: configPath,
      state: "fail",
      present: true,
      detail: `${configPath} is writable by group or other users (${modeLabel}).`,
      remediation: `chmod 600 ${shellQuote(configPath)}`
    };
  }

  if (isWorldReadable) {
    return {
      path: configPath,
      state: "fail",
      present: true,
      detail: `${configPath} is world-readable (${modeLabel}).`,
      remediation: `chmod 600 ${shellQuote(configPath)}`
    };
  }

  if (isGroupReadable) {
    return {
      path: configPath,
      state: "warn",
      present: true,
      detail: `${configPath} is group-readable (${modeLabel}).`,
      remediation: `chmod 600 ${shellQuote(configPath)}`
    };
  }

  return {
    path: configPath,
    state: "pass",
    present: true,
    detail: `${configPath} mode=${modeLabel}`
  };
}

function formatConfigFileFindingDetails(
  findings: readonly IConfigFilePermissionFinding[]
): readonly string[] {
  return findings.flatMap((finding) => {
    return finding.remediation ? [finding.detail, `remediation=${finding.remediation}`] : [finding.detail];
  });
}

function resolveKnownConfigPaths(paths: INeonGatewayStatePaths): readonly string[] {
  return [
    join(paths.projectRoot, ".env"),
    join(paths.projectRoot, ".env.local"),
    join(paths.stateRoot, "nodes", "node-runner.env")
  ];
}

function buildDoctorSkillSecurityRoots(
  projectRoot: string,
  referenceRoot: string
): readonly INeonSkillRootConfig[] {
  // Deterministic, doctor-governed roots only. The home-based skill roots
  // (~/.codex, ~/.agents, ~/.claude) are deliberately excluded: a health check
  // must not reach into the operator's private skill bodies, and including them
  // would make this signal environment-dependent.
  return [
    {
      id: "workspace-skills",
      label: "Workspace skills",
      kind: "workspace",
      path: join(projectRoot, "skills"),
      trust: "trusted-project"
    },
    {
      id: "openclaw-bundled-skills",
      label: "OpenClaw bundled skills",
      kind: "upstream-reference",
      path: join(referenceRoot, "skills"),
      trust: "reference-only"
    }
  ];
}

function buildSkillSecurityCheck(inventory: INeonSkillInventorySnapshot): INeonDoctorCheck {
  const { skills, flaggedSkills, criticalSkillFindings, warnSkillFindings, scannedSkillScripts } =
    inventory.totals;
  const baseDetails = [
    `skillRoots=${inventory.roots.map((root) => `${root.id}:${root.trust}`).join(" ")}`,
    "policy=static-read-only-scan",
    "codeExecution=false",
    `scanned=${skills} skill(s), ${scannedSkillScripts} sibling script(s)`,
    "referenceRef=src/security/audit-extra.async.ts (scanDirectoryWithSummary) + src/skills/security/scanner.ts"
  ];
  // Leak boundary: only rule ids + counts + the skill's own name/trust — never
  // the matched body text (the summary itself carries no raw source).
  const flaggedDetails = inventory.skills
    .filter((skill) => skill.security.state === "flagged")
    .slice(0, 5)
    .map(
      (skill) =>
        `${skill.name} (${skill.trust}): ${skill.security.findings
          .map((finding) => `${finding.ruleId}=${finding.count}`)
          .join(", ")}`
    );

  if (criticalSkillFindings > 0) {
    return {
      id: "skill-security",
      label: "Skill Security",
      state: "fail",
      summary: `${criticalSkillFindings} critical skill finding(s) across ${flaggedSkills} flagged skill(s).`,
      details: [...baseDetails, ...flaggedDetails]
    };
  }

  if (warnSkillFindings > 0 || flaggedSkills > 0) {
    return {
      id: "skill-security",
      label: "Skill Security",
      state: "warn",
      summary: `${flaggedSkills} flagged skill(s) with ${warnSkillFindings} warning-level finding(s).`,
      details: [...baseDetails, ...flaggedDetails]
    };
  }

  return {
    id: "skill-security",
    label: "Skill Security",
    state: "pass",
    summary:
      skills > 0
        ? `${skills} scanned skill(s) are clean; no dangerous patterns detected.`
        : "No workspace or reference skills found to scan.",
    details: baseDetails
  };
}

interface ILegacyPluginDependencyStateFinding {
  readonly path: string;
  readonly detail: string;
}

interface IStalePluginRuntimeSymlinkFinding {
  readonly name: string;
  readonly path: string;
  readonly target: string;
  readonly detail: string;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

async function buildPluginDependencyStateCheck(
  paths: INeonGatewayStatePaths,
  referenceRoot: string
): Promise<INeonDoctorCheck> {
  const candidates = uniqueStrings([
    join(paths.projectRoot, "plugin-runtime-deps"),
    join(paths.projectRoot, "bundled-plugin-runtime-deps"),
    join(paths.projectRoot, ".openclaw-pnpm-store"),
    join(paths.projectRoot, ".openclaw-install-backups"),
    join(paths.projectRoot, ".local", "bundled-plugin-runtime-deps"),
    join(paths.stateRoot, "plugin-runtime-deps"),
    join(paths.stateRoot, "bundled-plugin-runtime-deps"),
    join(referenceRoot, "plugin-runtime-deps"),
    join(referenceRoot, "bundled-plugin-runtime-deps"),
    join(referenceRoot, ".openclaw-pnpm-store"),
    join(referenceRoot, ".openclaw-install-backups"),
    join(referenceRoot, ".local", "bundled-plugin-runtime-deps")
  ]);
  const [findings, symlinkFindings] = await Promise.all([
    Promise.all(candidates.map(inspectLegacyPluginDependencyState)).then((results) =>
      results.filter((finding): finding is ILegacyPluginDependencyStateFinding => finding !== undefined)
    ),
    collectStalePluginRuntimeSymlinks(referenceRoot, candidates)
  ]);
  const baseDetails = [
    "policy=read-only-legacy-state-scan",
    "codeExecution=false",
    "referenceRef=src/commands/doctor/shared/plugin-dependency-cleanup.ts",
    "referenceRef=src/commands/doctor/shared/plugin-runtime-symlinks.ts"
  ];

  if (findings.length > 0 || symlinkFindings.length > 0) {
    return {
      id: "plugin-dependency-state",
      label: "Plugin Dependency State",
      state: "warn",
      summary: `${findings.length} legacy plugin dependency state path(s) and ${symlinkFindings.length} stale plugin-runtime symlink(s) need review.`,
      details: [
        ...baseDetails,
        ...findings.slice(0, 8).map((finding) => finding.detail),
        ...symlinkFindings.slice(0, 8).map((finding) => finding.detail),
        "remediation=Review and remove stale plugin dependency state manually after confirming it is not active."
      ]
    };
  }

  return {
    id: "plugin-dependency-state",
    label: "Plugin Dependency State",
    state: "pass",
    summary: "No legacy plugin dependency state found.",
    details: baseDetails
  };
}

async function inspectLegacyPluginDependencyState(
  candidatePath: string
): Promise<ILegacyPluginDependencyStateFinding | undefined> {
  try {
    const candidateStat = await lstat(candidatePath);
    if (!candidateStat.isDirectory() && !candidateStat.isSymbolicLink()) {
      return undefined;
    }

    return {
      path: candidatePath,
      detail: `${candidatePath} legacy-plugin-dependency-state=present`
    };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    return {
      path: candidatePath,
      detail: `${candidatePath} legacy-plugin-dependency-state=unreadable ${formatUnknownError(error)}`
    };
  }
}

async function collectStalePluginRuntimeSymlinks(
  referenceRoot: string,
  staleRoots: readonly string[]
): Promise<readonly IStalePluginRuntimeSymlinkFinding[]> {
  const containingNodeModules = dirname(referenceRoot);
  if (basename(containingNodeModules) !== "node_modules") {
    return [];
  }

  const entries = await readdir(containingNodeModules, { withFileTypes: true }).catch(() => []);
  const stale: IStalePluginRuntimeSymlinkFinding[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("@")) {
      const scopeDir = join(containingNodeModules, entry.name);
      const scopeEntries = await readdir(scopeDir, { withFileTypes: true }).catch(() => []);
      for (const scopeEntry of scopeEntries) {
        const symlinkPath = join(scopeDir, scopeEntry.name);
        const target = await inspectPluginRuntimeSymlinkCandidate(symlinkPath, staleRoots);
        if (target) {
          stale.push({
            name: `${entry.name}/${scopeEntry.name}`,
            path: symlinkPath,
            target,
            detail: `${symlinkPath} stale-plugin-runtime-symlink=${entry.name}/${scopeEntry.name} target=${target}`
          });
        }
      }
      continue;
    }

    if (!entry.isSymbolicLink()) {
      continue;
    }

    const symlinkPath = join(containingNodeModules, entry.name);
    const target = await inspectPluginRuntimeSymlinkCandidate(symlinkPath, staleRoots);
    if (target) {
      stale.push({
        name: entry.name,
        path: symlinkPath,
        target,
        detail: `${symlinkPath} stale-plugin-runtime-symlink=${entry.name} target=${target}`
      });
    }
  }

  return stale.sort((left, right) => left.name.localeCompare(right.name));
}

async function inspectPluginRuntimeSymlinkCandidate(
  symlinkPath: string,
  staleRoots: readonly string[]
): Promise<string | undefined> {
  const symlinkStat = await lstat(symlinkPath).catch(() => undefined);
  if (!symlinkStat?.isSymbolicLink()) {
    return undefined;
  }

  const target = await readlink(symlinkPath).catch(() => undefined);
  if (!target?.includes("plugin-runtime-deps")) {
    return undefined;
  }

  const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(symlinkPath), target);
  if (staleRoots.some((root) => isPathInsideRoot(resolvedTarget, root))) {
    return resolvedTarget;
  }

  try {
    await stat(resolvedTarget);
    return undefined;
  } catch (error) {
    return isNodeErrorWithCode(error, "ENOENT") || isNodeErrorWithCode(error, "ENOTDIR")
      ? resolvedTarget
      : undefined;
  }
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function buildPluginInventoryCheck(inventory: INeonExtensionInventorySnapshot): INeonDoctorCheck {
  const unsafeTrustCount = inventory.extensions.filter((extension) => extension.trust !== "reference-only").length;
  const baseDetails = [
    `extensionRoot=${inventory.source.extensionRoot}`,
    "policy=reference-only-manifest-scan",
    "codeExecution=false",
    "referenceRisk=OpenClaw warns when extensions exist without plugins.allow because discovered plugins may auto-load."
  ];

  if (unsafeTrustCount > 0) {
    return {
      id: "plugins",
      label: "Plugin Trust",
      state: "fail",
      summary: `${unsafeTrustCount} extension manifest(s) are not reference-only.`,
      details: [
        ...baseDetails,
        ...inventory.extensions
          .filter((extension) => extension.trust !== "reference-only")
          .slice(0, 5)
          .map((extension) => `${extension.id}: trust=${extension.trust}`)
      ]
    };
  }

  if (inventory.totals.invalidExtensionManifests > 0) {
    return {
      id: "plugins",
      label: "Plugin Trust",
      state: "warn",
      summary: `${inventory.totals.invalidExtensionManifests} reference extension manifest(s) could not be parsed.`,
      details: [
        ...baseDetails,
        ...inventory.issues.slice(0, 5),
        "remediation=Fix or remove malformed reference manifests before implementing a Neon extension loader."
      ]
    };
  }

  if (inventory.totals.extensionManifests === 0) {
    return {
      id: "plugins",
      label: "Plugin Trust",
      state: "warn",
      summary: "No OpenClaw reference extension manifests found.",
      details: [
        ...baseDetails,
        "next=Point referenceRoot at the local OpenClaw checkout or keep plugin rebuild scoped out."
      ]
    };
  }

  return {
    id: "plugins",
    label: "Plugin Trust",
    state: "pass",
    summary: `${inventory.totals.referenceExtensions}/${inventory.totals.extensionManifests} extension manifest(s) are reference-only; no plugin code is loaded.`,
    details: baseDetails
  };
}

function buildCutoverCheck(
  currentStage: TCutoverStageId,
  shadowExitGate: IShadowExitGateEvidence,
  gateStates: readonly ICutoverGateState[]
): INeonDoctorCheck {
  const stage = neonikaCutoverStages.find((entry) => entry.id === currentStage);

  return {
    id: "cutover",
    label: "Cutover",
    state: isNeonSteadyCutoverStage(currentStage) ? "pass" : "warn",
    summary: `Current stage is ${stage?.label ?? currentStage}.`,
    details: [
      stage?.meaning ?? "Unknown stage.",
      `exitGate=${stage?.exitGate ?? "unknown"}`,
      `gates=${gateStates.map((gate) => `${gate.id}=${gate.state}`).join(" ")}`,
      `shadowExitGateMet=${shadowExitGate.met}`,
      ...shadowExitGate.reasons.map((reason) => `shadowExitGate: ${reason}`)
    ]
  };
}

/**
 * Answers the one question an operator asks after installing: will this send?
 *
 * Deliberately built on the same precondition evaluation the sender consults, so the
 * two can never disagree. Reporting "armed" while the sender would still refuse is
 * worse than reporting nothing at all.
 *
 * Silence is not a problem to flag — a disarmed install is doing exactly what it
 * promises. What earns a warning is a contradiction: arming turned on while some
 * other requirement is missing, where an operator believes they are sending and are
 * not.
 */
function buildOutboundCheck(
  env: Readonly<Record<string, string | undefined>>
): INeonDoctorCheck {
  const preconditions = evaluateNeonCanaryLivePreconditions(env);
  const missing: string[] = [];

  if (!preconditions.tokenPresent) {
    missing.push("bot token");
  }
  if (!preconditions.channelConfigured) {
    missing.push("channel allowlist");
  }
  if (!preconditions.canaryApproved) {
    missing.push("approval flag");
  }
  if (!preconditions.stageAllowsOutbound) {
    missing.push("outbound-capable stage");
  }

  const details = [
    `stage=${preconditions.stageAllowsOutbound ? "outbound-capable" : "suppressed"}`,
    `token=${preconditions.tokenPresent ? "present" : "missing"}`,
    `allowlist=${preconditions.channelConfigured ? "configured" : "unset"}`,
    `approval=${preconditions.canaryApproved ? "ready" : "unset"}`,
    `armed=${preconditions.outboundEnabled ? "yes" : "no"}`
  ];

  if (preconditions.ready) {
    return {
      id: "outbound",
      label: "Outbound",
      state: "pass",
      summary: "Outbound is armed — replies can leave this process.",
      details
    };
  }

  if (preconditions.outboundEnabled) {
    return {
      id: "outbound",
      label: "Outbound",
      state: "warn",
      summary: `Outbound is armed but cannot send: ${missing.join(", ")} missing.`,
      details: [...details, "Arming alone does not send; every requirement must hold."]
    };
  }

  return {
    id: "outbound",
    label: "Outbound",
    state: "pass",
    summary: "Outbound is disarmed — nothing leaves this process.",
    details: [...details, `To arm: ${missing.length > 0 ? `provide ${missing.join(", ")}, then ` : ""}run arm-outbound.`]
  };
}

function countDoctorStates(checks: readonly INeonDoctorCheck[]): INeonDoctorTotals {
  return {
    pass: checks.filter((check) => check.state === "pass").length,
    warn: checks.filter((check) => check.state === "warn").length,
    fail: checks.filter((check) => check.state === "fail").length
  };
}

function resolveDoctorState(totals: INeonDoctorTotals): TNeonDoctorState {
  if (totals.fail > 0) {
    return "fail";
  }

  if (totals.warn > 0) {
    return "warn";
  }

  return "pass";
}

async function readRawRuns(runsPath: string): Promise<string | undefined> {
  try {
    return await readFile(runsPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }
}

function detectSecretLeakLabels(value: string): readonly string[] {
  const labels: string[] = [];
  const checks: readonly [string, RegExp][] = [
    ["env-secret-assignment", /\b[A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD)[A-Z0-9_]*\s*=\s*(?!\[REDACTED\])[^\s"'`]+/i],
    ["openai-style-key", /\bsk-[A-Za-z0-9_-]{16,}\b/],
    ["discord-bot-token", /\bM[TA][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/],
    ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/=-]{18,}(?=$|[\s"'`,;])/i],
    ["aws-access-key-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ["aws-secret-access-key", /\bAWS_SECRET_ACCESS_KEY\s*=\s*(?!\[REDACTED\])[A-Za-z0-9/+=]{32,}(?=$|[\s"'`,;])/i],
    ["onepassword-reference", /\bop:\/\/[^\s"'`]+/i]
  ];

  for (const [label, pattern] of checks) {
    if (pattern.test(value)) {
      labels.push(label);
    }
  }

  return labels;
}

function hasPermissionBit(mode: number, mask: number): boolean {
  return (mode & mask) !== 0;
}

function formatPosixMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
