#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { ThreadAutoArchiveDuration, type ChatInputCommandInteraction, type Message } from "discord.js";
import WebSocket, { type RawData as WsRawData } from "ws";

import {
  CodexAppServerClientPool,
  CodexJsonRpcClient,
  buildNeonAgentMemoryQuery,
  createClaudeCliHarness,
  createClaudeProcessTransport,
  createCodexAppServerHarness,
  createNeonDiscordCapacityFingerprint,
  createNeonDiscordCapacityGate,
  NEON_DISCORD_ACCENT_COLOR,
  createCodexStdioTransport,
  createDiscordJsShadowTapAdapter,
  createDryRunHarness,
  createNeonAutomationSnapshot,
  evaluateNeonCronTick,
  resolveNeonCronTimerGate,
  renderNeonCronTickReport,
  runNeonCronDaemonTick,
  renderNeonCronDaemonTickReport,
  createNeonCronDaemonService,
  createNeonCronStoreAutomationSnapshot,
  buildNeonCronIntentEntries,
  appendNeonCronIntentLog,
  appendNeonCronStoreEvent,
  projectNeonCronStoreJobs,
  readNeonCronStoreEvents,
  renderNeonCronDeliveryPreview,
  renderNeonCronStoreJobs,
  processNeonCronCommand,
  resolveNeonCronMutation,
  resolveNeonCronStoreGate,
  type IResolveNeonCronMutationInput,
  type TNeonCronJobMutation,
  readNeonCronIntentLog,
  renderNeonCronIntentLog,
  writeNeonCronDaemonCursor,
  createNeonCronDaemonStatusSnapshot,
  renderNeonCronDaemonStatusReport,
  type INeonAutomationJob,
  type INeonCronTimerGate,
  evaluateNeonHeartbeatTick,
  resolveNeonHeartbeatTimerGate,
  renderNeonHeartbeatTickReport,
  runNeonHeartbeatDaemonTick,
  renderNeonHeartbeatDaemonTickReport,
  writeNeonHeartbeatDaemonCursor,
  buildNeonHeartbeatIntentEntries,
  appendNeonHeartbeatIntentLog,
  readNeonHeartbeatIntentLog,
  renderNeonHeartbeatIntentLog,
  createNeonHeartbeatDaemonStatusSnapshot,
  renderNeonHeartbeatDaemonStatusReport,
  createNeonHeartbeatDaemonService,
  resolveNeonHeartbeatAgentsFromEnv,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatTimerGate,
  appendNeonWorkspaceNote,
  createNeonWorkspaceSnapshot,
  renderNeonWorkspaceSnapshotReport,
  resolveNeonWorkspaceNotesGate,
  dispatchNeonInternalHook,
  resolveNeonHookDispatchGate,
  renderNeonHookDispatchReport,
  runNeonDreamingReflection,
  resolveNeonDreamingGate,
  runNeonDreamPhaseTick,
  renderNeonDreamTickReport,
  resolveNeonDreamPhaseCursorPath,
  type INeonDreamCandidate,
  type INeonDreamingGate,
  renderNeonDreamingReflectionReport,
  applyNeonDoctorPermissionFix,
  resolveNeonDoctorFixGate,
  rollbackNeonDoctorPermissionFix,
  renderNeonDoctorPermissionFixReport,
  resolveNeonSecretResolutionGate,
  resolveNeonSecretRef,
  renderNeonSecretResolutionReport,
  type TNeonOpRunner,
  resolveNeonMirrorRunGate,
  runNeonMirrorComparison,
  renderNeonMirrorComparisonReport,
  writeNeonMemoryEntry,
  readNeonMemoryStore,
  resolveNeonMemoryWriteGate,
  renderNeonMemoryWriteRuntimeReport,
  writeNeonMemoryDbEntry,
  resolveNeonMemoryDbWriteGate,
  renderNeonMemoryDbWriteReport,
  searchNeonMemoryDb,
  createNeonLocalEmbeddingProvider,
  createNeonOllamaEmbeddingProvider,
  recalcNeonMemoryImportance,
  renderNeonImportanceRecalcReport,
  discoverNeonMemoryRelations,
  renderNeonRelationDiscoveryReport,
  pruneNeonMemory,
  renderNeonPruneReport,
  createNeonMemoryBackup,
  renderNeonMemoryBackupReport,
  runNeonMemoryMaintenance,
  renderNeonMemoryMaintenanceReport,
  resolveNeonMemoryRecallDbPath,
  targetsRealNeonDb,
  createNeonMemoryImportPlan,
  createNeonMemoryExportManifest,
  renderNeonMemoryImportPlanReport,
  renderNeonMemoryExportManifest,
  writeNeonNodeFile,
  resolveNeonNodeFileWriteGate,
  renderNeonNodeFileWriteReport,
  createNeonCutoverGateSnapshot,
  createNeonDoctorSnapshot,
  createNeonActivitySnapshot,
  createNeonAgentsSnapshot,
  createNeonChatSnapshot,
  createNeonCanaryOutboundSender,
  createNeonDeliveryQueueSnapshot,
  planNeonDeliveryDrain,
  renderNeonDeliveryDrainPlanReport,
  renderNeonDeliveryRetryScheduleReport,
  reconcileNeonDeliveryRecovery,
  renderNeonDeliveryReconcileReport,
  shouldDebounceNeonTextInbound,
  resolveNeonInboundDebounceMs,
  renderNeonInboundDebounceReport,
  resolveNeonInboundMentionDecision,
  renderNeonInboundMentionDecisionReport,
  resolveNeonInboundAccessDecision,
  renderNeonInboundAccessDecisionReport,
  type TNeonAccessGroup,
  resolveNeonAllowlistMatchSimple,
  formatNeonAllowlistMatchMeta,
  compileNeonAllowFrom,
  mergeNeonDmAllowFromSources,
  resolveNeonGroupAllowFromSources,
  renderNeonAllowFromPolicyReport,
  createNeonTypingStartGuard,
  renderNeonTypingStartGuardReport,
  resolveNeonDeliveryDrainGate,
  createNeonInFlightRunRegistry,
  createNeonSessionActorQueue,
  createNeonDiscordRunControl,
  createNeonDiscordProgressCardRuntime,
  createNeonDiscordRecoveryRuntime,
  createNeonDiscordAgentButtonsRuntime,
  createNeonDiscordPlanApprovalRuntime,
  createNeonDiscordSessionRuntimePicker,
  isNeonDiscordAgentButtonsActionType,
  isNeonDiscordPlanApprovalActionType,
  neonDiscordClaudeRuntimePresets,
  type INeonDiscordAgentButtonsRuntime,
  type INeonDiscordPlanApprovalRuntime,
  createNeonDiscordThreadWorkspaceRuntime,
  createNeonPdfReviewRuntime,
  deliverNeonCanaryReplyForRun,
  isNeonPdfReviewActionType,
  isNeonDiscordRecoveryActionType,
  isNeonDiscordSessionRuntimeActionType,
  planNeonRunLifecycleAction,
  renderNeonInFlightRunReport,
  renderNeonGatedSideEffectPostureReport,
  resolveNeonGatedSideEffectPosture,
  createNeonBlockedRowReadinessSnapshot,
  renderNeonBlockedRowReadinessReport,
  readNeonCanaryStabilityEvidence,
  renderNeonCanaryStabilityReport,
  createNeonLiveSessionReadinessSnapshot,
  renderNeonLiveSessionReadinessReport,
  renderNeonRunLifecycleDecisionReport,
  resolveNeonInFlightRunGate,
  resolveNeonDeliveryQueuePaths,
  type INeonDeliveryQueueCandidate,
  createNeonDiscordOutboundTransport,
  createNeonDiscordComponentActionRegistry,
  resolveNeonDiscordComponentActionStatePath,
  createSessionBindingFromGatewayMessage,
  deriveCodexSessionKey,
  createNeonDiscordReactionTransport,
  createNeonDiscordTypingTransport,
  buildNeonDiscordEmbedPayload,
  type INeonDiscordEmbed,
  buildNeonDiscordComponentPayload,
  type TNeonDiscordActionRow,
  buildNeonDiscordMediaPayload,
  type TNeonDiscordMediaAttachment,
  createNeonDiscordPresenceTransport,
  buildNeonDiscordPresencePayload,
  type INeonDiscordPresence,
  createNeonDiscordSlashDeployTransport,
  buildNeonSlashCommandPayload,
  createNeonDiscordOperatorSlashCommands,
  planNeonDeliveryRetryAfterSendError,
  dispatchNeonAutoReply,
  renderNeonAutoReplyDispatchReport,
  createNeonDiscordInboundReplayGuard,
  type INeonDiscordMessageEnvelope,
  type INeonDiscordIngressPolicy,
  type INeonAutoReplyPolicy,
  buildNeonWebhookPayload,
  createNeonDiscordWebhookTransport,
  evaluateNeonWebhookLivePreconditions,
  type INeonWebhookPayload,
  buildNeonDiscordStickerPayload,
  buildNeonDiscordPollPayload,
  type INeonDiscordPoll,
  createNeonDryRunOutboundSender,
  createNeonCanaryReactionSender,
  createNeonDryRunReactionSender,
  createNeonDryRunMessageEditSender,
  runNeonSecretsAudit,
  collectNeonSecretAuditFields,
  renderNeonSecretsAuditReport,
  runNeonSecurityAudit,
  renderNeonSecurityAuditReport,
  applyNeonStatusReaction,
  planNeonStatusReactionEmit,
  shouldEmitNeonStatusReaction,
  deliverAndRecordNeonApprovedCandidate,
  evaluateNeonCanaryLivePreconditions,
  renderNeonDeliveryDispatchReport,
  resolveNeonCanaryChannelAllowlist,
  createNeonChannelRegistrySnapshot,
  renderNeonChannelRegistryReport,
  describeNeonChannelRoute,
  neonChannelRouteFromInboundIdentity,
  normalizeNeonChannelRoute,
  type INeonChannelInboundIdentity,
  type INeonChannelRouteInput,
  captureNeonCommitmentsFromRun,
  resolveNeonCommitmentCaptureGate,
  createNeonGatewayRouteInspectionSnapshot,
  createNeonGatewayProtocolSnapshot,
  createNeonAgentMemoryAttachment,
  createNeonMemoryAttachment,
  createNeonMemoryCliProvider,
  createNeonMemoryCliWriter,
  recallNeonAgentMemory,
  planNeonMemoryFlush,
  appendNeonRecallEvent,
  resolveNeonRecallTrackingGate,
  renderNeonRecallTrackingReport,
  appendNeonMemoryEvent,
  buildNeonDreamCompletedEvent,
  resolveNeonMemoryEventLogGate,
  renderNeonMemoryEventLogReport,
  createNeonMirrorEvidenceSnapshot,
  createNeonNodesSnapshot,
  createNeonNodeActionRequestSnapshot,
  createNeonNodeActionResultPreview,
  createNeonNodeTransportSnapshot,
  createNeonNodeDeviceSessionSnapshot,
  createNeonNodePairingCanaryTokenSnapshot,
  createNeonNodePairingRequest,
  createNeonNodePairingSnapshot,
  createNeonNodePairingTokenGateSnapshot,
  createNeonOnboardingSnapshot,
  applyNeonSetupEnvironment,
  readNeonSetupConfig,
  resolveNeonCanonicalPeer,
  resolveNeonSetupPaths,
  runNeonSetup,
  runNeonWhatsAppLogin,
  startNeonWhatsAppShadowTap,
  createNeonWhatsAppStatusSnapshot,
  createNeonReplaySnapshot,
  createNeonSessionsSnapshot,
  createNeonIndexerSnapshot,
  renderNeonIndexerReport,
  createNeonTranscriptSnapshot,
  renderNeonTranscriptReport,
  resolveNeonLlmGate,
  renderNeonLlmGateReport,
  createNeonDryRunLlmInvoker,
  runNeonTranscriptSummaryProposal,
  runNeonTranscriptDecisionProposals,
  renderNeonTranscriptProposalReport,
  createNeonClaudeCliLlmInvoker,
  createNeonClaudeCliProcessRunner,
  resolveNeonTranscriptArming,
  renderNeonTranscriptArmingReport,
  type INeonTranscriptProposal,
  promoteNeonTranscriptProposal,
  renderNeonTranscriptPersistReport,
  type INeonTranscriptPersistResult,
  buildNeonTranscriptScheduleIntent,
  renderNeonTranscriptScheduleIntentReport,
  runNeonLiveIndexMemorySync,
  renderNeonLiveIndexMemorySyncReport,
  renderNeonLiveIndexDaemonReport,
  resolveNeonLiveIndexDaemonOptionsFromEnv,
  scanNeonLiveIndexDaemon,
  createNeonExtensionInventorySnapshot,
  createNeonPluginInventorySnapshot,
  renderNeonPluginsReport,
  resolveNeonPluginInstallPlan,
  renderNeonPluginInstallPlanReport,
  type INeonPluginInventorySnapshot,
  type INeonPluginInstallPlanResult,
  createNeonSkillInventorySnapshot,
  createNeonSkillCommandCatalog,
  resolveNeonControlCommandGate,
  renderNeonControlCommandGateReport,
  createNeonToolInventorySnapshot,
  renderNeonToolInventoryReport,
  resolveNeonToolsLiveGate,
  createNeonPeekabooAppServerEnv,
  listenNeonPeekabooProxy,
  renderNeonPeekabooProxyShimScript,
  requestNeonPeekabooProxy,
  resolveNeonPeekabooProxySocketPath,
  resolveNeonPeekabooProxyTcpUrl,
  executeNeonWebFetch,
  renderNeonWebFetchResult,
  collectPresentToolSecretRefs,
  resolveNeonWebSearchProviders,
  renderNeonWebSearchResolution,
  executeNeonWebSearch,
  renderNeonWebSearchResult,
  resolveNeonWebSearchProviderKeyRef,
  evaluateNeonBindingResume,
  type ICodexThreadBinding,
  type INeonBindingResumeSpec,
  createNeonDeliveryDryRunCandidate,
  deliverNeonDeliveryDryRunCandidate,
  enqueueNeonDeliveryDryRunCandidate,
  fetchNeonMissionControlGatewaySnapshot,
  loadNeonTuiDashboard,
  renderNeonTuiDashboard,
  runNeonOperatorShell,
  listenNeonGatewayHttpServer,
  mapDiscordJsMessageToEnvelope,
  mapDiscordJsInteractionToSlashEnvelope,
  openNeonNodeDeviceSession,
  parseNeonGatewayFrameJson,
  readNeonGatewayStatus,
  rescueNeonGatewayRunStore,
  renderNeonRunStoreRescueReport,
  recordNeonNodeActionApproval,
  recordNeonNodeActionRequest,
  recordNeonNodeTransportResult,
  renderNeonNodeRunnerReport,
  renderNeonNodeRunnerSnapshotReport,
  issueNeonNodePairingCanaryToken,
  renderNeonCutoverGateReport,
  writeNeonCutoverPromotion,
  readNeonCutoverPromotion,
  renderNeonCutoverPromotionReport,
  resolveNeonCutoverPromotionPath,
  sanitizeNeonCutoverPromotionEnv,
  renderNeonRetireRoundTripReport,
  verifyNeonRetireRoundTrip,
  readNeonGatewayRuns,
  readCodexThreadBinding,
  renderNeonDoctorExplainReport,
  renderNeonDoctorReport,
  renderNeonGatewayRouteInspectionReport,
  renderNeonGatewayProtocolReport,
  renderNeonActivityReport,
  filterNeonMissionControlActivity,
  renderNeonMissionControlFilterReport,
  type INeonMissionControlFilterCriteria,
  type TNeonActivityStatus,
  type TNeonActivityEntryKind,
  renderNeonAgentIdentity,
  renderNeonChatReport,
  renderNeonDeliveryQueueReport,
  renderNeonMirrorEvidenceReport,
  renderNeonNodesReport,
  renderNeonNodeActionRequestReport,
  renderNeonNodeTransportReport,
  renderNeonNodeDeviceSessionReport,
  renderNeonNodePairingCanaryTokenReport,
  renderNeonNodePairingReport,
  renderNeonNodePairingTokenGateReport,
  renderNeonOnboardingReport,
  renderNeonSetupReport,
  renderNeonWhatsAppLoginReport,
  renderNeonWhatsAppStatusReport,
  renderNeonReplayReport,
  renderNeonExtensionsReport,
  renderNeonSkillInventoryReport,
  renderNeonSkillCommandCatalogReport,
  completeNeonSlashCommand,
  renderNeonSlashCompletions,
  computeNeonNextRunAtMs,
  describeNeonCronSchedule,
  renderNeonSessionsReport,
  resolveNeonAgentAttachment,
  selectNeonHarness,
  recordNeonNodePairingApproval,
  approveNeonNodeRunnerServiceAction,
  createNeonNodeRunnerSnapshot,
  createNeonNodeRunnerServiceActionSnapshot,
  createNeonNodeRunnerServiceCanarySnapshot,
  createNeonNodeRunnerServiceSnapshot,
  executeNeonNodeRunnerServiceAction,
  requestNeonNodeRunnerServiceAction,
  renderNeonNodeRunnerServicePlist,
  renderNeonNodeRunnerServiceCanaryReport,
  renderNeonNodeRunnerServiceReport,
  resolveNeonNodeRunnerPaths,
  runNeonNodeRunnerLoop,
  runNeonNodeRunnerOnce,
  writeNeonNodeRunnerControl,
  runNeonGatewayShadow,
  createNeonDiscordIngressDecision,
  runNeonDiscordShadowIngress,
  runNeonDiscordSlashInteractionShadow,
  resolveNeonSlashCommandRegistrationPlan,
  renderNeonSlashCommandRegistrationPlanReport,
  submitNeonChatSend,
  renderNeonChatSendReport,
  isNeonDiscordCapacityActionType,
  markNeonGatewayRunDelivered,
  neonDiscordCapacityRuntimes,
  redactText,
  resolveNeonDiscordCapacityDecision,
  resolveNeonDiscordVoiceReplyOptionsFromEnv,
  resolveNeonDiscordVoiceTranscriptionOptionsFromEnv,
  createNeonDiscordTikTokVideoWorkflow,
  renderNeonTikTokDiscordVideoWorkflow,
  startNeonDiscordShadowTap,
  interruptCodexTurn,
  startOrResumeCodexThread,
  unsubscribeCodexThread,
  writeNeonGatewayRun,
  writeNeonGatewayRunLatest,
  writeNeonMirrorEvidence,
  type IClaudeStreamTransport,
  type TClaudeCliEffort,
  type TClaudeCliPermissionMode,
  type ICodexHarness,
  type INeonDiscordCapacityGate,
  type INeonDiscordCapacityRuntime,
  type INeonHarnessRuntimeMetadata,
  type INeonDiscordRuntimeOption,
  type INeonDiscordRecoveryRuntime,
  type INeonDiscordSessionRuntimePicker,
  type INeonDiscordSessionRuntimeSelection,
  type ICodexAppServerClient,
  type ICodexAppServerNotification,
  type ICodexAppServerStartOptions,
  type TCodexAppServerMethod,
  type TCodexAppServerNotificationHandler,
  type TJsonValue,
  type INeonInFlightRunRecord,
  type INeonInFlightRunRegistry,
  type INeonGatewayHttpServerHandle,
  type INeonGatewayInboundMessage,
  type INeonGatewayShadowRun,
  type INeonPdfReviewRuntime,
  type INeonChannelRegistrySnapshot,
  type INeonGatewayRouteInspectionSnapshot,
  type INeonGatewayRuntimeEventFrame,
  type INeonGatewayRuntimeSnapshot,
  type INeonGatewayStatus,
  type INeonGatewayRunControlHttpRequest,
  type INeonGatewayRunControlHttpResult,
  type INeonGatewayRunControlRuntime,
  type INeonGatewayProtocolSnapshot,
  type TNeonGatewayFrame,
  type INeonAgentMemoryAttachment,
  type INeonAgentScopedRecall,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot,
  type INeonChatSnapshot,
  type INeonDeliveryQueueSnapshot,
  type INeonActivitySnapshot,
  type INeonMirrorEvidenceInput,
  type INeonMirrorEvidenceSnapshot,
  type INeonMissionControlGatewaySnapshot,
  type INeonReplaySnapshot,
  type INeonTuiDashboard,
  type INeonNodeActionRequestSnapshot,
  type INeonNodeTransportSnapshot,
  type INeonNodeTransportResultRecord,
  type INeonNodeDeviceSessionSnapshot,
  type INeonNodesSnapshot,
  type INeonNodePairingCanaryTokenSnapshot,
  type INeonNodePairingSnapshot,
  type INeonNodePairingTokenGateSnapshot,
  type INeonSessionsSnapshot,
  type INeonAgentSkillPolicyResult,
  type INeonExtensionInventorySnapshot,
  type INeonSkillInventorySnapshot,
  type INeonToolInventorySnapshot,
  type TNeonMirrorEvidenceVerdict,
  createNeonWorkboardSnapshot,
  renderNeonWorkboardReport,
  writeNeonTask,
  readNeonTasks,
  readNeonFlows,
  findNeonTaskByRunId,
  findLatestNeonTaskForSessionKey,
  listNeonTasksForFlowId,
  listNeonTasksForOwner,
  resolveNeonTaskForLookupToken,
  scopeNeonTaskToOwner,
  listNeonTaskAuditFindings,
  summarizeNeonTaskAuditFindings,
  renderNeonTaskAuditReport,
  listNeonFlowAuditFindings,
  summarizeNeonFlowAuditFindings,
  renderNeonFlowAuditReport,
  decideNeonTaskTerminalDelivery,
  formatNeonTaskTerminalMessage,
  type INeonTaskDeliveryInput,
  appendNeonCommitment,
  applyNeonCommitmentStatus,
  buildNeonCommitmentRecord,
  listNeonDueCommitments,
  markNeonCommitmentsHeartbeatObserved,
  readNeonCommitments,
  renderNeonDueCommitmentsReport,
  resolveNeonCommitmentLifecycleGate,
  resolveNeonCommitmentStoreGate,
  importNeonCommitmentHints,
  type INeonCommitmentStoreGate,
  type INeonTaskRecord,
  type INeonWorkboardSnapshot,
  type INeonWorkboardListResult,
  createNeonDryRunWorkboardExecutor,
  createNeonGatewayShadowWorkboardExecutor,
  createNeonWorkboardCard,
  readNeonWorkboardCards,
  renderNeonWorkboardAutoDispatchReport,
  runNeonWorkboardAutoDispatchOnce,
  type INeonWorkboardAutoDispatchOptions,
  type TNeonWorkboardAutoDispatchExecutor,
  createNeonFlowsSnapshot,
  planNeonFlowExecution,
  readNeonFlow,
  renderNeonFlowPlanReport,
  renderNeonFlowsReport,
  writeNeonFlow,
  type INeonFlowDefinition,
  type INeonFlowExecutionPlan,
  type INeonFlowsSnapshot,
  createNeonContextPack,
  createMergedNeonMemoryProvider,
  renderNeonContextPackReport,
  type INeonContextPack,
  type IRunNeonSetupOptions,
  type TNeonChannel,
  renderArchitectureSummary,
  renderNeonAutomationCronJobReport,
  renderNeonAutomationCronListReport,
  renderNeonAutomationReport,
  renderCutoverPlan,
  renderNeonSdkManifest,
  renderProductManifest
} from "./index.js";
import { createNeonPeekabooAppServerRequestHandler } from "./tools/peekabooDynamicTool.js";

interface ICommand {
  readonly description: string;
  readonly run: () => string | undefined | Promise<string | undefined>;
}

let discordTapClientPool: CodexAppServerClientPool | undefined;

const PACKAGED_CONTROL_UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "control-ui");

const commands: Record<string, ICommand> = {
  status: {
    description: "Print the Neonika product manifest.",
    run: renderProductManifest
  },
  sdk: {
    description: "Print the Neonika SDK surface manifest (gateway-client / channel / tool / plugin).",
    run: renderNeonSdkManifest
  },
  architecture: {
    description: "Print the Neon architecture.",
    run: renderArchitectureSummary
  },
  cutover: {
    description: "Print the Shadow/Mirror/Canary/Primary/Retire plan.",
    run: renderCutoverPlan
  },
  "cutover-gate": {
    description: "Print evidence-based Neonika cutover gates.",
    run: runCutoverGate
  },
  "cutover-promote": {
    description:
      "Persist the current cutover stage/flags so all readers agree (gated by NEON_CUTOVER_PROMOTE_ENABLED=ready).",
    run: runCutoverPromote
  },
  "cutover-smoke": {
    description: "Start a local API server and verify cutover gates.",
    run: runCutoverSmoke
  },
  "mirror-evidence": {
    description: "Print stored old-vs-new mirror comparison evidence.",
    run: runMirrorEvidence
  },
  "mirror-record": {
    description: "Record old-vs-new mirror comparison evidence from environment.",
    run: runMirrorRecord
  },
  "mirror-smoke": {
    description: "Verify mirror evidence storage and API on a temporary project root.",
    run: runMirrorSmoke
  },
  "cutover-retire-smoke": {
    description: "Prove run-history portability with a real export/import round-trip (retire evidence).",
    run: runCutoverRetireSmoke
  },
  automation: {
    description: "Print read-only Neonika Automation jobs, hooks, and dreams.",
    run: runAutomationReport
  },
  "cron-list": {
    description: "Print the read-only Neon cron job list (cron-only, richer per-job fields).",
    run: runCronList
  },
  "cron-get": {
    description: "Print read-only detail and run intent for one Neon cron job (cron-get <jobId> [--force]).",
    run: runCronGet
  },
  "automation-smoke": {
    description: "Start a local API server and verify Neonika Automation inventory.",
    run: runAutomationSmoke
  },
  "cron-timer-smoke": {
    description:
      "Fire ONE cron timer tick against the real catalog. Default-off: emits read-only run intents only when NEON_CRON_TIMER_ENABLED is set, never executes a run. Use --force <jobId> to force-due a job.",
    run: runCronTimerSmoke
  },
  "cron-daemon-smoke": {
    description:
      "Drive the cron daemon tick: default-off (no cursor write) vs armed with a seeded 100m-behind cursor (bounded catch-up + persisted dedup cursor). Never executes a run or writes the run store.",
    run: runCronDaemonSmoke
  },
  "cron-daemon-status": {
    description:
      "Print the read-only cron daemon status (gate, persisted cursor, cron-job catalog, shadow-safety) for the current project. Reads only; never arms, ticks, or writes.",
    run: runCronDaemonStatus
  },
  "cron-daemon-run": {
    description:
      "Run the autonomous cron daemon (real setInterval loop). Each tick reads store-backed cron jobs and writes terminal SHADOW run-records (delivery suppressed, stage unchanged). Flags: --interval <ms> (default NEON_CRON_DAEMON_INTERVAL_MS or 60000), --ticks <n> (stop after n ticks; default runs until Ctrl+C). Emission needs NEON_CRON_TIMER_ENABLED.",
    run: runCronDaemonRun
  },
  "cron-daemon-service-smoke": {
    description:
      "Drive the cron daemon SERVICE through deterministic ticks against an isolated tmp cron store. Shows off vs armed: armed writes terminal shadow cron run-records and liveness, no outbound.",
    run: runCronDaemonServiceSmoke
  },
  "cron-intent-log-smoke": {
    description:
      "Feed a real cron daemon tick into the gated intent history (emitted/catch-up/skipped). Default-off append is blocked; armed path writes to an isolated tmp JSONL and renders it. Never executes a run.",
    run: runCronIntentLogSmoke
  },
  "cron-store-list": {
    description: "List persisted operator cron jobs from the append-only cron store (read-only).",
    run: runCronStoreList
  },
  "cron-add": {
    description:
      "Add a persisted operator cron job: cron-add <id> <schedule> <label...>. Requires NEON_CRON_STORE_ENABLED=ready.",
    run: runCronAdd
  },
  "cron-edit": {
    description:
      "Update a persisted operator cron job: cron-edit <id> [--schedule <schedule>] [--label <label...>]. Requires NEON_CRON_STORE_ENABLED=ready.",
    run: runCronEdit
  },
  "cron-enable": {
    description: "Enable a persisted operator cron job: cron-enable <id>. Requires NEON_CRON_STORE_ENABLED=ready.",
    run: runCronEnable
  },
  "cron-disable": {
    description: "Disable a persisted operator cron job: cron-disable <id>. Requires NEON_CRON_STORE_ENABLED=ready.",
    run: runCronDisable
  },
  "cron-rm": {
    description: "Remove a persisted operator cron job: cron-rm <id>. Requires NEON_CRON_STORE_ENABLED=ready.",
    run: runCronRemove
  },
  "cron-store-smoke": {
    description:
      "Exercise the gated Cron-job CRUD store (add/edit/remove/enable/disable). Default-off (NEON_CRON_STORE_ENABLED): writes are blocked, no file. Armed: CRUD against an isolated tmp JSONL, then the projected job set. Persists job definitions only — no scheduler, no delivery.",
    run: runCronStoreSmoke
  },
  "cron-command-smoke": {
    description:
      "Exercise explicit Discord-style /cron commands against the gated Cron store. Default-off blocks writes; armed add/list writes routed jobs into an isolated tmp store. No harness run, no outbound.",
    run: runCronCommandSmoke
  },
  "workspace-notes": {
    description:
      "Print the local Neon workspace notes snapshot (HEARTBEAT/DREAMS/NOTES/daily memory). Read-only.",
    run: runWorkspaceNotesReport
  },
  "workspace-notes-smoke": {
    description:
      "Exercise gated local workspace note writes. Default-off blocks, armed writes redacted Markdown into an isolated tmp state/workspace; no semantic memory DB and no outbound.",
    run: runWorkspaceNotesSmoke
  },
  "heartbeat-timer-smoke": {
    description:
      "Fire ONE heartbeat timer tick over a small agent fixture. Default-off: emits read-only wake intents only when NEON_HEARTBEAT_TIMER_ENABLED is set, never starts a run or sends. Shows the off vs armed tick side by side.",
    run: runHeartbeatTimerSmoke
  },
  "heartbeat-daemon-smoke": {
    description:
      "Drive the heartbeat daemon tick: default-off (no cursor write) vs armed with a seeded behind-cursor (bounded catch-up + persisted dedup cursor). Never starts a run or writes the run store.",
    run: runHeartbeatDaemonSmoke
  },
  "heartbeat-daemon-status": {
    description:
      "Print the read-only heartbeat daemon status (gate, persisted cursor, per-agent last-emitted window, shadow-safety) for the current project. Reads only; never arms, ticks, or writes.",
    run: runHeartbeatDaemonStatus
  },
  "heartbeat-intent-log-smoke": {
    description:
      "Feed a real heartbeat daemon tick into the gated intent history (emitted/catch-up/deferred/deduped). Default-off append is blocked; armed writes an isolated tmp JSONL and renders it. Never starts a run.",
    run: runHeartbeatIntentLogSmoke
  },
  "heartbeat-daemon-run": {
    description:
      "Run the autonomous heartbeat daemon (real setInterval loop). Each tick evaluates env-configured agents and writes terminal SHADOW run-records (delivery suppressed, stage unchanged). Flags: --interval <ms> (default NEON_HEARTBEAT_DAEMON_INTERVAL_MS or 60000), --ticks <n> (stop after n ticks; default runs until Ctrl+C). Emission needs NEON_HEARTBEAT_TIMER_ENABLED; never sends, never changes the cutover stage.",
    run: runHeartbeatDaemonRun
  },
  "heartbeat-daemon-service-smoke": {
    description:
      "Drive the heartbeat daemon SERVICE through 3 deterministic ticks (injected clock, isolated tmp store + run store). Shows off vs armed: armed writes terminal shadow run-records and tracks liveness (alive/lastTick/nextTick/createdRuns). Outbound suppressed, stage unchanged.",
    run: runHeartbeatDaemonServiceSmoke
  },
  "route-projection-smoke": {
    description:
      "Project accepted inbound identities to the route a reply would target, and normalize partial routes. Pure read, no send: a workspace message routes to a channel post, a DM to a direct message; an unknown channel or empty target is not routable. Target ids are redacted in the printed description.",
    run: runRouteProjectionSmoke
  },
  "hook-dispatch-smoke": {
    description:
      "Dispatch ONE internal hook event. Default-off: runs read-only observer handlers only when NEON_HOOK_DISPATCH_ENABLED is set, never sends/writes/mutates. Use --event <key> and --payload <text>.",
    run: runHookDispatchSmoke
  },
  "dream-tick-smoke": {
    description:
      "Drive the gated dreaming phase tick: default-off (no reflection, no cursor) vs armed across two ticks (phase advances light -> deep via the persisted cursor). Emits read-only proposals only; never promotes.",
    run: runDreamTickSmoke
  },
  "dream-tick-run": {
    description:
      "Run one dreaming phase tick against the current project. Reads recent Gateway runs as candidates; writes DREAMS/NOTES workspace artifacts only when NEON_DREAMING_ENABLED and NEON_WORKSPACE_NOTES_ENABLED are armed.",
    run: runDreamTickRun
  },
  "dreaming-reflect-smoke": {
    description:
      "Run ONE dreaming reflection (light/deep/rem) over sample candidates. Default-off: emits read-only consolidation proposals only when NEON_DREAMING_ENABLED is set, never writes memory. Use --phase <light|deep|rem> and --concept-merge for deep concept-tag grouping.",
    run: runDreamingReflectSmoke
  },
  "agents-smoke": {
    description: "Print the Neonika Agents registry and selected agent identity.",
    run: runAgentsSmoke
  },
  "harness-smoke": {
    description: "Run a local dry Neonika Codex Harness turn.",
    run: runHarnessSmoke
  },
  "claude-harness-smoke": {
    description:
      "Run a local Neonika Claude CLI harness turn against a scripted stream-json transport (no real claude binary).",
    run: runClaudeHarnessSmoke
  },
  "claude-harness-live-smoke": {
    description:
      "Opt-in live smoke: spawn the real `claude` binary in stream-json mode and run one read-only Neonika Claude harness turn. Requires NEON_CLAUDE_HARNESS_LIVE_SMOKE=ready.",
    run: runClaudeHarnessLiveSmoke
  },
  "binding-resume-smoke": {
    description:
      "Show the persisted-binding resume decision (resume vs restart) the harness applies before reusing a Codex thread. Pure, no Codex run: same spec resumes; cwd/approval/sandbox/model drift restarts.",
    run: runBindingResumeSmoke
  },
  "appserver-smoke": {
    description: "Start Codex app-server over stdio and verify initialize.",
    run: runAppServerSmoke
  },
  "thread-smoke": {
    description: "Start and unsubscribe an ephemeral Codex app-server thread.",
    run: runThreadSmoke
  },
  "gateway-shadow-smoke": {
    description: "Run a Neonika Gateway shadow message without outbound delivery.",
    run: runGatewayShadowSmoke
  },
  "shadow-run": {
    description:
      "Run one real Codex shadow turn for a trailing-argument prompt (read-only, delivery suppressed). Opt-in via NEON_SHADOW_RUN_ENABLED=ready. Drives the Neon side for mirror parity without any outbound send.",
    run: runShadowRun
  },
  "memory-smoke": {
    description: "Search Neonika Memory and render the bounded attachment payload.",
    run: runMemorySmoke
  },
  "memory-write": {
    description: "Plan a Neonika Memory write in gated dry-run mode (no productive write).",
    run: runMemoryWriteDryRun
  },
  "memory-write-productive-smoke": {
    description:
      "Exercise the gated productive memory-write against an isolated temp JSON store. Default-off: dry-run plan unless NEON_MEMORY_WRITE_ENABLED is set, then writes + roundtrip-reads the isolated store. Never touches the real memory DB.",
    run: runMemoryWriteProductiveSmoke
  },
  "memory-db-write-smoke": {
    description:
      "Exercise the gated SQLite memory writer against an isolated temp DB: bootstrap the real v2 schema, content_hash-dedup upsert + vector BLOB, then FTS roundtrip. Default-off (NEON_MEMORY_WRITE_ENABLED). Hard-refuses the real semantic-memory DB.",
    run: runMemoryDbWriteSmoke
  },
  "memory-maintain-smoke": {
    description:
      "Run the full memory-maintenance pipeline against an isolated temp DB: Ebbinghaus importance recalc, vector relation discovery, archive-not-delete prune, and a VACUUM-INTO backup. Default-off (NEON_MEMORY_WRITE_ENABLED) — plan-only unless armed. Replaces v2's evolution-engine + nightly-cleanup + backup cronjobs. Never touches the real DB.",
    run: runMemoryMaintainSmoke
  },
  "memory-maintain": {
    description:
      "Productive memory maintenance against the neonika DB (NEON_MEMORY_DB_PATH): backup FIRST, then Ebbinghaus importance recalc + relation discovery; prune stays plan-only unless --prune-apply is passed. Gated via NEON_MEMORY_WRITE_ENABLED; hard-refuses the real v2 archive DB. Memory cutover Slice K5 — the facade replacing v2's maintenance cronjobs.",
    run: runMemoryMaintain
  },
  "memory-import-export-smoke": {
    description:
      "Print the dry-run import plan + portable export manifest for isolated-store entries. Read-only: connects to no real semantic-memory DB and writes nothing.",
    run: runMemoryImportExportSmoke
  },
  "memory-flush-plan-smoke": {
    description:
      "Print the gated memory-flush plan in read-only dry-run mode: canonical memory/YYYY-MM-DD.md target, token thresholds, append-only/read-only prompts. Writes nothing; the real flush is gated behind NEON_MEMORY_FLUSH_ENABLED (default-off).",
    run: runMemoryFlushPlanSmoke
  },
  "memory-recall-tracking-smoke": {
    description:
      "Resolve the gated recall-tracking gate and show a dry-run recall append (blocked by default: needs NEON_MEMORY_WRITE_ENABLED + an explicit isolated storePath). Writes nothing.",
    run: runRecallTrackingSmoke
  },
  "memory-event-log-smoke": {
    description:
      "Resolve the gated memory-event-log gate and show a dry-run audit append (blocked by default: needs NEON_MEMORY_WRITE_ENABLED + an explicit isolated storePath). Writes nothing.",
    run: runMemoryEventLogSmoke
  },
  "gateway-memory-shadow-smoke": {
    description: "Run a Neonika Gateway shadow message with read-only Neonika Memory context.",
    run: runGatewayMemoryShadowSmoke
  },
  "agent-recall-smoke": {
    description:
      "Scope a read-only Neonika Memory recall to one agent: agent-recall-smoke <agentId> \"query\". Folds the agent's profile seeds into the query and prints redacted, agent-tagged excerpts.",
    run: runAgentRecallSmoke
  },
  "discord-shadow-smoke": {
    description: "Run a Discord-shaped inbound message through Neonika Gateway shadow mode.",
    run: runDiscordShadowSmoke
  },
  "discord-shadow-tap": {
    description: "Connect a Discord bot as a shadow-only tap without sending replies.",
    run: runDiscordShadowTap
  },
  "discord-ingress-codex-live-smoke": {
    description:
      "Opt-in live smoke: send one private Discord canary message, ingest it through the real tap, and run the Codex harness. Requires NEON_DISCORD_INGRESS_CODEX_LIVE_SMOKE=ready.",
    run: runDiscordIngressCodexLiveSmoke
  },
  "discord-ingress-control-live-smoke": {
    description:
      "Opt-in live smoke: start one private Discord ingress Codex turn, observe HTTP/SSE running state, then stop it through /api/neon-runs/control. Requires NEON_DISCORD_INGRESS_CONTROL_LIVE_SMOKE=ready.",
    run: runDiscordIngressControlLiveSmoke
  },
  "discord-tap-canary-reply-live-smoke": {
    description:
      "Opt-in live smoke: ingest one private Discord message through the real tap and send the final Codex reply back through the gated Canary sender. Requires NEON_DISCORD_TAP_CANARY_REPLY_LIVE_SMOKE=ready.",
    run: runDiscordTapCanaryReplyLiveSmoke
  },
  "peekaboo-proxy": {
    description:
      "Run the local Neonika Peekaboo proxy from an interactive, TCC-granted context. The Discord app-server shim uses this instead of direct headless Peekaboo.",
    run: runPeekabooProxy
  },
  "peekaboo-proxy-client": {
    description:
      "Internal entrypoint used by the generated Peekaboo shim. Proxies argv to the local Neonika Peekaboo proxy socket.",
    run: runPeekabooProxyClient
  },
  "delivery-queue": {
    description: "Print queued Neon delivery dry-runs without sending outbound messages.",
    run: runDeliveryQueueReport
  },
  "delivery-drain-plan": {
    description: "Print the reconnect delivery-drain plan for pending-drain candidates (no re-send).",
    run: runDeliveryDrainPlanReport
  },
  "delivery-drain-plan-smoke": {
    description: "Seed pending-drain candidates and verify the gated drain plan never re-sends.",
    run: runDeliveryDrainPlanSmoke
  },
  "delivery-retry-policy": {
    description: "Print the delivery retry backoff schedule (no send).",
    run: runDeliveryRetryPolicyReport
  },
  "delivery-reconcile-smoke": {
    description: "Verify delivery recovery reconcile: permanent error gives up, transient retries, none sends.",
    run: runDeliveryReconcileSmoke
  },
  "slash-command-gate-smoke": {
    description: "Verify the slash/control command authorization gate (no dispatch).",
    run: runSlashCommandGateSmoke
  },
  "inbound-debounce-smoke": {
    description: "Verify the inbound text debounce policy (decision matrix + window precedence).",
    run: runInboundDebounceSmoke
  },
  "inbound-mention-smoke": {
    description: "Verify the inbound mention decision (require/implicit/bypass, no side effect).",
    run: runInboundMentionSmoke
  },
  "inbound-access-smoke": {
    description: "Run the inbound access chain (allow-from, access groups, DM guard, command auth, mention) over representative allow/deny cases.",
    run: runInboundAccessSmoke
  },
  "slash-interaction-shadow-smoke": {
    description: "Dispatch a native slash interaction through the shadow ingress (no-send run); show an admitted run, a command-not-authorized drop, and the read-only registration plan.",
    run: runSlashInteractionShadowSmoke
  },
  "chat-send-smoke": {
    description: "Submit an operator chat-send through the shadow gateway and enqueue a dry-run delivery candidate (no-send, outboundSent:false).",
    run: runChatSendSmoke
  },
  "inbound-allowlist-smoke": {
    description: "Verify the inbound access allowlist matcher (wildcard/id/name, leak-safe meta).",
    run: runInboundAllowlistSmoke
  },
  "inbound-allow-from-smoke": {
    description: "Verify allow-from source resolution (DM merge, group fallback, sender decision).",
    run: runInboundAllowFromSmoke
  },
  "typing-start-guard-smoke": {
    description: "Verify the typing-indicator start guard (seal/skip, success, trip-after-failures).",
    run: runTypingStartGuardSmoke
  },
  "run-lifecycle-smoke": {
    description: "Drive the gated in-flight run lifecycle (start/stop/end) without mutating the run store.",
    run: runRunLifecycleSmoke
  },
  "run-lifecycle-harness-smoke": {
    description:
      "Drive a real Gateway->Codex-harness lifecycle turn against a delayed fake app-server, then prove stop maps to turn/interrupt. No model call, no send.",
    run: runRunLifecycleHarnessSmoke
  },
  "run-lifecycle-codex-live-smoke": {
    description:
      "Opt-in live smoke: start a real codex app-server turn, observe in-flight lifecycle, then interrupt it. Requires NEON_RUN_LIFECYCLE_CODEX_LIVE_SMOKE=ready.",
    run: runRunLifecycleCodexLiveSmoke
  },
  "gates-posture": {
    description: "Print the gated side-effect posture (every NEON_* live-effect gate and its state).",
    run: runGatesPostureReport
  },
  "blocked-readiness": {
    description: "Print the operator readiness decision for every blocked capability row (why/effect/rollback/verify/env/operator).",
    run: runBlockedReadinessReport
  },
  "canary-stability": {
    description: "Print canary stability evidence from the delivery store (last N runs, verdict, primary stays blocked).",
    run: runCanaryStabilityReport
  },
  "live-session-readiness": {
    description: "Print live-session runtime readiness (what is missing for resume/branch/delete/checkpoints; no fake actions).",
    run: runLiveSessionReadinessReport
  },
  "delivery-dry-run-smoke": {
    description: "Create and verify a no-send delivery candidate from a Gateway run.",
    run: runDeliveryDryRunSmoke
  },
  "delivery-dry-run-send-smoke": {
    description: "Send a delivery candidate through the no-send outbound sender and verify outboundSent:false.",
    run: runDeliveryDryRunSendSmoke
  },
  "canary-outbound-smoke": {
    description: "Verify the gated canary outbound sender stays no-send without flags and transport (outboundSent:false).",
    run: runCanaryOutboundSmoke
  },
  "reaction-dry-run-smoke": {
    description: "Verify the gated canary reaction sender stays no-send without flags and transport (reactionSent:false).",
    run: runReactionDryRunSmoke
  },
  "status-reaction-smoke": {
    description: "Verify the status-reaction policy (scope gate + debounce decision + dry-run sender) stays no-send (reactionSent:false).",
    run: runStatusReactionSmoke
  },
  "message-edit-dry-run-smoke": {
    description: "Verify the gated message edit/delete sender stays no-send without flags and transport (editSent:false/deleteSent:false).",
    run: runMessageEditDryRunSmoke
  },
  "secrets-audit-smoke": {
    description: "Run the read-only secrets audit over a fixture env (PLAINTEXT/REF_UNRESOLVED). No `op` resolve, no secret values in the output.",
    run: runSecretsAuditSmoke
  },
  "security-audit-smoke": {
    description: "Run the read-only security footgun audit over a fixture env (armed gates, gateway auth, ws-origin, cutover-vs-approval). No side effects.",
    run: runSecurityAuditSmoke
  },
  "canary-outbound-live-smoke": {
    description:
      "Send ONE real Discord message to a single allowlisted canary channel, behind the full env gate (stage=canary + approved + outbound-enabled + NEON_DISCORD_BOT_TOKEN). Stays suppressed if any precondition is missing. Token never printed.",
    run: runCanaryOutboundLiveSmoke
  },
  "canary-embed-live-smoke": {
    description:
      "Send ONE gated embed to the single allowlisted canary channel. The embed payload is always validated up front; the send stays suppressed with NO transport unless the full canary gate is open (stage=canary + approved + outbound-enabled + NEON_DISCORD_BOT_TOKEN). Token never printed.",
    run: runCanaryEmbedLiveSmoke
  },
  "components-canary-live-smoke": {
    description:
      "Send ONE gated interactive component message (button/select action rows + body text) to the single allowlisted canary channel. The component payload is always validated up front; the send stays suppressed with NO transport unless the full canary gate is open. Token never printed.",
    run: runComponentsCanaryLiveSmoke
  },
  "media-canary-live-smoke": {
    description:
      "Upload ONE gated inline media attachment (a tiny in-process file) to the single allowlisted canary channel. The attachment is always validated up front (size/filename/mime; url sources run the SSRF guard); the upload stays suppressed with NO transport unless the full canary gate is open. Token never printed.",
    run: runMediaCanaryLiveSmoke
  },
  "tiktok-discord-plan-smoke": {
    description:
      "Plan the official Discord-video -> TikTok Content Posting API pipeline. No network, no upload, no token output.",
    run: runTikTokDiscordPlanSmoke
  },
  "presence-canary-live-smoke": {
    description:
      "Set ONE gated bot presence update (status + activity) — client-global, no channel. The presence is always validated up front; it stays suppressed with NO transport unless the full canary gate is open. Token never printed.",
    run: runPresenceCanaryLiveSmoke
  },
  "slash-deploy-canary-live-smoke": {
    description:
      "Deploy a gated GUILD-scoped slash-command set (bulk overwrite) to the canary guild. The registration plan blocks global; the command set is always validated up front; the deploy stays suppressed with NO transport unless the full canary gate is open AND NEON_CANARY_GUILD_ID is set. Token never printed.",
    run: runSlashDeployCanaryLiveSmoke
  },
  "delivery-retry-classify-smoke": {
    description:
      "Classify representative Discord send failures (429 retry-after, 503, permanent 403) and show the durable-delivery retry decision (honour retry-after over backoff, give up on permanent). Pure read-only, no gate, no send.",
    run: runDeliveryRetryClassifySmoke
  },
  "auto-reply-dispatch-smoke": {
    description:
      "Run inbound envelopes through the real ingress decision + auto-reply policy + replay guard and plan a dry-run reply (typing/chunks/reaction). Shows accepted-dispatch, ingress-drop, not-mentioned skip, and duplicate skip. Always outboundSent:false, no send, no gate.",
    run: runAutoReplyDispatchSmoke
  },
  "webhook-canary-live-smoke": {
    description:
      "Send ONE gated webhook message (proxy identity: username/avatar) via its OWN identity gate (NEON_DISCORD_WEBHOOK_URL + NEON_WEBHOOK_OUTBOUND_ENABLED) on top of the canary stage+approval. The payload is always validated up front; it stays suppressed with NO client unless every precondition holds. Webhook URL/token never printed.",
    run: runWebhookCanaryLiveSmoke
  },
  "stickers-poll-canary-live-smoke": {
    description:
      "Validate a gated sticker set and a poll payload (question/answers/duration) for the allowlisted canary channel. Both are always validated up front; the send stays suppressed with NO transport unless the full canary gate is open. Token never printed.",
    run: runStickersPollCanaryLiveSmoke
  },
  "reaction-canary-live-smoke": {
    description:
      "Add ONE gated reaction to a message in the single allowlisted canary channel. Stays suppressed with NO transport unless the full canary gate is open AND NEON_CANARY_REACTION_MESSAGE_ID is set. Token never printed.",
    run: runReactionCanaryLiveSmoke
  },
  "typing-canary-live-smoke": {
    description:
      "Trigger ONE gated typing indicator in the single allowlisted canary channel. The typing start guard stays sealed (skipped, no transport) unless the full canary gate is open. Token never printed.",
    run: runTypingCanaryLiveSmoke
  },
  "status-reaction-canary-live-smoke": {
    description:
      "Drive ONE gated lifecycle status reaction (planNeonStatusReactionEmit decides the emoji) to the allowlisted canary channel. Stays suppressed with NO transport unless the full canary gate is open AND NEON_CANARY_REACTION_MESSAGE_ID is set. Token never printed.",
    run: runStatusReactionCanaryLiveSmoke
  },
  "delivery-dispatch-smoke": {
    description:
      "Exercise the full DeliveryQueue -> approval -> canary sender dispatch path on a temp project. Default no-send (no transport): proves an approved candidate stays suppressed and ack stays queued.",
    run: runDeliveryDispatchSmoke
  },
  "gateway-status": {
    description: "Print persisted Neonika Gateway run status.",
    run: runGatewayStatus
  },
  "gateway-run-store-rescue": {
    description:
      "Archive failed gateway runs into state/gateway/archive and rewrite runs.jsonl without them (kept runs untouched). Dry-run unless NEON_RUN_STORE_RESCUE_ENABLED=ready.",
    run: runGatewayRunStoreRescue
  },
  "gateway-api-smoke": {
    description: "Start a local Neonika Gateway API server and fetch status.",
    run: runGatewayApiSmoke
  },
  "lifecycle-smoke": {
    description: "Verify Neonika Gateway lifecycle snapshot and event stream.",
    run: runLifecycleSmoke
  },
  "gateway-protocol": {
    description: "Print the Neonika Gateway WebSocket RPC/event protocol contract.",
    run: runGatewayProtocolReport
  },
  "gateway-protocol-smoke": {
    description: "Verify the Neonika Gateway protocol endpoint and frame parser.",
    run: runGatewayProtocolSmoke
  },
  "gateway-websocket-smoke": {
    description: "Verify the Neonika Gateway WebSocket challenge, hello, event, and RPC path.",
    run: runGatewayWebSocketSmoke
  },
  "route-inspect": {
    description: "Print Discord route and allowlist inspection without secrets.",
    run: runRouteInspect
  },
  "routes-smoke": {
    description: "Start a local API server and verify route inspection.",
    run: runRoutesSmoke
  },
  "channel-registry": {
    description: "Print the multi-channel registry (Discord and WhatsApp shadow ingress) without secrets.",
    run: runChannelRegistry
  },
  "channel-registry-smoke": {
    description: "Start a local API server and verify the channel registry endpoint.",
    run: runChannelRegistrySmoke
  },
  "whatsapp-login": {
    description:
      "Link the configured WhatsApp companion by terminal QR. Writes private auth state; agent-message outbound remains suppressed.",
    run: runWhatsAppLogin
  },
  "whatsapp-status": {
    description:
      "Print WhatsApp configuration, private auth evidence, and shadow delivery posture without ids or paths.",
    run: runWhatsAppStatus
  },
  "whatsapp-shadow-tap": {
    description:
      "Run the linked WhatsApp companion as owner-only shadow ingress with shared memory and fully suppressed replies.",
    run: runWhatsAppShadowTap
  },
  workboard: {
    description: "Print the Neonika Workboard (tasks grouped into status columns) from the task store.",
    run: runWorkboardReport
  },
  "workboard-smoke": {
    description: "Write seed tasks to a temp project and verify the Neonika Workboard API and columns.",
    run: runWorkboardSmoke
  },
  "workboard-autopilot-once": {
    description: "Claim and process ready Workboard cards once (gated by NEON_WORKBOARD_AUTOPILOT_ENABLED=ready).",
    run: runWorkboardAutopilotOnce
  },
  "workboard-autopilot-loop": {
    description: "Poll and process ready Workboard cards until stopped (gated).",
    run: runWorkboardAutopilotLoop
  },
  "workboard-autopilot-smoke": {
    description: "Verify Workboard autopilot claim, completion, block, and empty-queue behavior on a temp project.",
    run: runWorkboardAutopilotSmoke
  },
  "task-lookup": {
    description:
      "Resolve tasks from the real task store by key: task-lookup <token> | --run <id> | --flow <id> | --owner <id> | --session <key>. Read-only, in-memory selectors.",
    run: runTaskLookup
  },
  "task-audit": {
    description:
      "Read-only task audit over the real task store: overdue, stale-in-progress, stale-blocked, orphaned-run-link, inconsistent-timestamps. No state, no gate.",
    run: runTaskAudit
  },
  "flow-audit": {
    description:
      "Read-only flow audit over the real flow store: inconsistent-timestamps, armed-empty, armed-side-effect. No state, no gate.",
    run: runFlowAudit
  },
  "task-delivery-smoke": {
    description:
      "Exercise the task terminal-delivery policy: per-status deliver decision + leak-safe message format. Outbound stays suppressed (shadow): never sends.",
    run: runTaskDeliverySmoke
  },
  "commitments-smoke": {
    description:
      "Exercise the gated commitment store + lifecycle + read-only due-view: default-off append is blocked, armed path writes to an isolated tmp JSONL, then status transition + due-view render. Never sends.",
    run: runCommitmentsSmoke
  },
  "commitment-capture-smoke": {
    description:
      "Exercise structural Commitment capture from a completed Gateway/Discord run. Default-off blocks; armed writes deduped pending commitments to an isolated tmp store; never sends.",
    run: runCommitmentCaptureSmoke
  },
  "commitment-lifecycle-smoke": {
    description:
      "Exercise the Heartbeat commitment lifecycle: default-off blocks; armed path snoozes a due commitment after a shadow wake and increments attempts. Never sends.",
    run: runCommitmentLifecycleSmoke
  },
  "commitment-hints-import-smoke": {
    description:
      "Exercise the v3 -> Neonika commitment-hint import (Phase A migration): default-off blocks; armed path imports a sample hints file into an isolated tmp store; a second run is idempotent (skipped). Never touches production, never sends.",
    run: runCommitmentHintsImportSmoke
  },
  flows: {
    description: "Print stored Neonika Flows (trigger + steps + gated-step counts) from the flow store.",
    run: runFlowsReport
  },
  "flow-plan": {
    description: "Print the dry-run execution plan for a stored flow: flow-plan <flowId> (gated steps stay blocked).",
    run: runFlowPlanReport
  },
  "flows-smoke": {
    description: "Write seed flows to a temp project and verify the Neonika Flows API and the gated dry-run plan.",
    run: runFlowsSmoke
  },
  "context-pack": {
    description: "Build a bounded, leak-safe Neon context pack from the cwd stores: context-pack [agentId] [channel] [query].",
    run: runContextPackReport
  },
  "context-smoke": {
    description: "Seed a run + task in a temp project and verify the Neon context pack API (bounded, redacted).",
    run: runContextSmoke
  },
  chat: {
    description: "Print Neonika Chat conversations from Gateway runs.",
    run: runChatReport
  },
  "chat-smoke": {
    description: "Start a local API server and verify Neonika Chat conversations.",
    run: runChatSmoke
  },
  sessions: {
    description: "Print Neonika Sessions from Gateway runs.",
    run: runSessionsReport
  },
  "sessions-smoke": {
    description: "Start a local API server and verify Neonika Sessions.",
    run: runSessionsSmoke
  },
  indexer: {
    description: "Print the Neonika Indexer projection (decision candidates from Gateway runs).",
    run: runIndexerReport
  },
  "indexer-smoke": {
    description: "Start a local API server and verify the Neonika Indexer projection.",
    run: runIndexerSmoke
  },
  transcript: {
    description: "Print the Neonika Transcript Indexer projection (Claude Code session digests).",
    run: runTranscriptReport
  },
  "transcript-smoke": {
    description: "Start a local API server and verify the Neonika Transcript Indexer projection.",
    run: runTranscriptSmoke
  },
  "llm-gate": {
    description: "Print the Neon transcript LLM gate posture (claude -p only, default-off).",
    run: runLlmGateReport
  },
  "llm-gate-smoke": {
    description: "Verify the default LLM invoker is dry-run (never calls a model).",
    run: runLlmGateSmoke
  },
  "transcript-proposals": {
    description: "Plan transcript summary + decision proposals (dry-run, no memory write).",
    run: runTranscriptProposalsReport
  },
  "transcript-proposals-smoke": {
    description: "Verify transcript proposals stay planned (no call, no write) by default.",
    run: runTranscriptProposalsSmoke
  },
  "transcript-persist": {
    description: "Plan transcript proposal persistence (dry-run, writes nothing by default).",
    run: runTranscriptPersistReport
  },
  "transcript-persist-smoke": {
    description: "Verify transcript persistence writes nothing without the memory-write gate.",
    run: runTranscriptPersistSmoke
  },
  "transcript-schedule": {
    description: "Print the gated transcript-indexer schedule intent (starts no timer).",
    run: runTranscriptScheduleReport
  },
  "transcript-schedule-smoke": {
    description: "Verify the transcript schedule intent starts no timer and executes nothing.",
    run: runTranscriptScheduleSmoke
  },
  "transcript-production-check": {
    description:
      "Check whether the transcript indexer is production-armed: LLM pass (NEON_TRANSCRIPT_LLM_ENABLED) and gated persistence (NEON_MEMORY_WRITE_ENABLED + NEON_TRANSCRIPT_STORE_PATH).",
    run: () => Promise.resolve(renderNeonTranscriptArmingReport(resolveNeonTranscriptArming()))
  },
  "live-index-sync": {
    description:
      "Collect Discord/Gateway, Claude transcript and Codex session digests, then sync them through the gated SQLite memory writer. Default plan-only unless NEON_MEMORY_WRITE_ENABLED + NEON_LIVE_INDEX_MEMORY_DB_PATH are set.",
    run: runLiveIndexSyncReport
  },
  "live-index-sync-smoke": {
    description:
      "Verify end-to-end live-index sync with fixture Discord, Claude and Codex sources against an isolated temp semantic-memory DB.",
    run: runLiveIndexSyncSmoke
  },
  "live-index-daemon": {
    description:
      "Scan Discord/Gateway, Claude transcript and Codex session digests into the persistent Neon live-index daemon state.",
    run: runLiveIndexDaemonReport
  },
  "live-index-daemon-smoke": {
    description:
      "Verify the live-index daemon persists source state and detects unchanged second scans with fixture Discord, Claude and Codex sources.",
    run: runLiveIndexDaemonSmoke
  },
  "live-index-production-check": {
    description:
      "Check whether the live-index daemon is production-armed for interval scans and gated memory promotion.",
    run: runLiveIndexProductionCheck
  },
  activity: {
    description: "Print Neonika Activity from Gateway runs.",
    run: runActivityReport
  },
  "activity-smoke": {
    description: "Start a local API server and verify Neonika Activity.",
    run: runActivitySmoke
  },
  "mission-control-filter": {
    description: "Filter the Mission-Control activity view (--search/--agent/--tool/--status/--kind).",
    run: runMissionControlFilterReport
  },
  "mission-control-filter-smoke": {
    description: "Verify the Mission-Control activity filter against a seeded Gateway run.",
    run: runMissionControlFilterSmoke
  },
  replay: {
    description: "Print detailed Neonika Replay runs from Gateway history.",
    run: runReplayReport
  },
  "replay-smoke": {
    description: "Start a local API server and verify Neonika Replay filters and redaction.",
    run: runReplaySmoke
  },
  skills: {
    description: "Print local Neonika Skills and upstream reference extensions.",
    run: runSkillsReport
  },
  "skills-smoke": {
    description: "Start a local API server and verify Neonika Skills inventory.",
    run: runSkillsSmoke
  },
  "skill-commands": {
    description: "Print the read-only /skill: command catalog with owners and collisions.",
    run: runSkillCommandsReport
  },
  "chat-completions": {
    description:
      "Autocomplete /skill:<name> slash commands for a prefix from the real skill inventory: chat-completions [prefix]. Pure read path, no side effect.",
    run: runChatCompletionsSmoke
  },
  "cron-next-run": {
    description:
      "Compute the next 3 UTC run times for a cron schedule: cron-next-run \"<expr>\" [--now <ISO>]. Supports 5-field cron, every-<N>m|h|d, manual-only. Pure, no timer armed.",
    run: runCronNextRunSmoke
  },
  tools: {
    description: "Print the Neonika Tools inventory (families, providers, gated invocation plan).",
    run: runToolsReport
  },
  "tools-smoke": {
    description: "Start a local API server and verify the gated, leak-safe Neonika Tools inventory.",
    run: runToolsSmoke
  },
  "web-fetch-smoke": {
    description:
      "Classify web.fetch.url targets through the SSRF guard and run the gated executor. Default-off (NEON_TOOLS_LIVE_ENABLED): public URLs return a dry-run (no network), private/loopback/link-local URLs are blocked. Pass a URL to test one; otherwise samples are shown.",
    run: runWebFetchSmoke
  },
  "web-search-resolve": {
    description:
      "Resolve which web-search provider would run (auto-detect from present API-key refs) + the fallback chain. Read-only, no secret values, no network. Live provider search stays gated.",
    run: runWebSearchResolve
  },
  "web-search-smoke": {
    description:
      "Run the gated web.search.run executor. Default-off (NEON_TOOLS_LIVE_ENABLED): returns a dry-run with NO provider call. Armed + a present provider key: executes a real search (Tavily) and returns a bounded, redacted preview. Pass a query to override the sample.",
    run: runWebSearchSmoke
  },
  extensions: {
    description: "Print upstream reference extension manifests without loading them.",
    run: runExtensionsReport
  },
  "extensions-smoke": {
    description: "Start a local API server and verify Neonika Extensions inventory.",
    run: runExtensionsSmoke
  },
  plugins: {
    description: "Print the Neon plugin catalog (manifest descriptors + trust) without loading any plugin code.",
    run: runPluginsReport
  },
  "plugins-smoke": {
    description: "Start a local API server and verify the Neon plugin inventory and trust gate.",
    run: runPluginsSmoke
  },
  "plugin-install-plan": {
    description: "Print the gated install/enable/load plan for one plugin (id via NEON_PLUGIN_ID). Never executes.",
    run: runPluginInstallPlan
  },
  "skill-policy-smoke": {
    description: "Start a local API server and verify the per-agent skill enable/deny policy.",
    run: runSkillPolicySmoke
  },
  nodes: {
    description: "Print local Neonika Nodes and device capability policy.",
    run: runNodesReport
  },
  "node-pairing": {
    description: "Print persisted Neon node pairing requests and approval audit.",
    run: runNodePairingReport
  },
  "node-pairing-request": {
    description: "Record a shadow-only node pairing request from environment.",
    run: runNodePairingRequest
  },
  "node-pairing-approve": {
    description: "Record an operator pairing approval without issuing a token.",
    run: runNodePairingApprove
  },
  "node-pairing-token-gate": {
    description: "Print canary token-readiness gates for approved node pairings.",
    run: runNodePairingTokenGate
  },
  "node-pairing-token-gate-smoke": {
    description: "Verify node pairing token gate remains locked before canary.",
    run: runNodePairingTokenGateSmoke
  },
  "node-pairing-canary-tokens": {
    description: "Print redacted canary token issue audit and delivery policy.",
    run: runNodePairingCanaryTokens
  },
  "node-pairing-canary-token-issue-smoke": {
    description: "Verify gated canary token issue without persisting raw token material.",
    run: runNodePairingCanaryTokenIssueSmoke
  },
  "node-device-sessions": {
    description: "Print redacted scoped device sessions and action policy.",
    run: runNodeDeviceSessions
  },
  "node-device-session-handshake-smoke": {
    description: "Verify scoped device session handshake without exposing token or session secret.",
    run: runNodeDeviceSessionHandshakeSmoke
  },
  "node-action-requests": {
    description: "Print session-bound node action request catalog without execution.",
    run: runNodeActionRequests
  },
  "node-action-approve": {
    description: "Record an operator approval audit for a queued node action without executing it.",
    run: runNodeActionApprove
  },
  "node-action-result-preview": {
    description: "Create a bounded read-only result preview for an approved node action.",
    run: runNodeActionResultPreview
  },
  "node-transport": {
    description: "Print poll-only dispatch envelopes for approved read-only node actions.",
    run: runNodeTransport
  },
  "node-file-write-smoke": {
    description:
      "Exercise the gated remote file.write against an isolated temp allowlist root. Default-off: blocked unless NEON_NODE_FILE_WRITE_ENABLED + approval + file.write scope; proves a contained write succeeds and a ../ path-escape is hard-blocked.",
    run: runNodeFileWriteSmoke
  },
  "node-transport-result-ingest": {
    description: "Record a bounded remote result for a ready node transport dispatch.",
    run: runNodeTransportResultIngest
  },
  "node-action-request-smoke": {
    description: "Verify heartbeat, file, and browser action request catalog policy.",
    run: runNodeActionRequestSmoke
  },
  "node-action-approval-smoke": {
    description: "Verify node action approval audit records without executing actions.",
    run: runNodeActionApprovalSmoke
  },
  "node-action-result-preview-smoke": {
    description: "Verify approved file and browser result previews without writes or mutations.",
    run: runNodeActionResultPreviewSmoke
  },
  "node-transport-smoke": {
    description: "Verify poll-only remote node dispatch envelopes without exposing secrets.",
    run: runNodeTransportSmoke
  },
  "node-transport-poll-smoke": {
    description: "Verify authenticated remote node polling with cursor heartbeat audit.",
    run: runNodeTransportPollSmoke
  },
  "node-transport-result-ingest-smoke": {
    description: "Verify bounded node transport result ingestion without raw output or secrets.",
    run: runNodeTransportResultIngestSmoke
  },
  "node-transport-result-submit-smoke": {
    description: "Verify authenticated HTTP node transport result submission without exposing secrets.",
    run: runNodeTransportResultSubmitSmoke
  },
  "node-runner-once": {
    description: "Poll once as a paired Neon node and submit bounded read-only results.",
    run: runNodeRunnerOnce
  },
  "node-runner-once-smoke": {
    description: "Verify the paired-node runner poll -> execute -> submit loop.",
    run: runNodeRunnerOnceSmoke
  },
  "node-runner-status": {
    description: "Print persisted Neonika Node Runner control and health state.",
    run: runNodeRunnerStatus
  },
  "node-runner-start": {
    description: "Set the Neonika Node Runner desired state to running without storing secrets.",
    run: runNodeRunnerStart
  },
  "node-runner-stop": {
    description: "Set the Neonika Node Runner desired state to stopped.",
    run: runNodeRunnerStop
  },
  "node-runner-loop": {
    description: "Run the supervised Neonika Node Runner loop until stopped.",
    run: runNodeRunnerLoop
  },
  "node-runner-loop-smoke": {
    description: "Verify supervised runner loop health, cursor, and stop control.",
    run: runNodeRunnerLoopSmoke
  },
  "node-runner-service": {
    description: "Print the Neonika Node Runner operator service plan.",
    run: runNodeRunnerService
  },
  "node-runner-service-plist": {
    description: "Print the Neonika Node Runner LaunchAgent plist preview.",
    run: runNodeRunnerServicePlist
  },
  "node-runner-service-smoke": {
    description: "Verify Neonika Node Runner service plan without installing it.",
    run: runNodeRunnerServiceSmoke
  },
  "node-runner-service-actions": {
    description: "Print approval-gated Neonika Node Runner service action audit.",
    run: runNodeRunnerServiceActions
  },
  "node-runner-service-canary": {
    description: "Print Neonika Node Runner service canary readiness gates.",
    run: runNodeRunnerServiceCanary
  },
  "node-runner-service-action-request": {
    description: "Record a Neonika Node Runner service action request without executing it.",
    run: runNodeRunnerServiceActionRequest
  },
  "node-runner-service-action-approve": {
    description: "Record a Neonika Node Runner service action approval without executing it.",
    run: runNodeRunnerServiceActionApprove
  },
  "node-runner-service-action-execute": {
    description: "Execute an approved safe Neonika Node Runner service action through the gate.",
    run: runNodeRunnerServiceActionExecute
  },
  "node-runner-service-actions-smoke": {
    description: "Verify Neonika Node Runner service action approval audit without service mutation.",
    run: runNodeRunnerServiceActionsSmoke
  },
  "node-runner-service-canary-smoke": {
    description: "Verify Neonika Node Runner service canary readiness without service mutation.",
    run: runNodeRunnerServiceCanarySmoke
  },
  "node-pairing-smoke": {
    description: "Verify node pairing request persistence and approval audit.",
    run: runNodePairingSmoke
  },
  "nodes-smoke": {
    description: "Start a local API server and verify Neonika Nodes inventory.",
    run: runNodesSmoke
  },
  doctor: {
    description: "Run Neonika Doctor against local Gateway state. Use doctor --explain for read-only repair steps.",
    run: runDoctorSmoke
  },
  "doctor-smoke": {
    description: "Run Neonika Doctor against local Gateway state.",
    run: runDoctorSmoke
  },
  "doctor-fix-smoke": {
    description:
      "Exercise the gated doctor --fix permission tightening against an isolated temp file. Default-off: blocked unless NEON_DOCTOR_FIX_ENABLED; when armed, chmod 0644 -> 0600 (content untouched) and roll back to the captured mode.",
    run: runDoctorFixSmoke
  },
  "secret-resolution-smoke": {
    description:
      "Exercise the gated op:// secret resolution with a fake op runner. Default-off: blocked unless NEON_SECRET_RESOLUTION_ENABLED; when armed, resolves a fake value and proves it never appears in the result (length + fingerprint only).",
    run: runSecretResolutionSmoke
  },
  "mirror-run-smoke": {
    description:
      "Exercise the gated mirror comparison against a temp project. Default-off: blocked unless NEON_MIRROR_RUN_ENABLED; when armed, drives a fake Neon side, takes v3 as input, computes a verdict and writes redacted evidence.",
    run: runMirrorRunSmoke
  },
  onboard: {
    description:
      "Run the first-use wizard or update private setup state. Use --yes for non-interactive defaults; channel flags configure Discord/WhatsApp explicitly.",
    run: runOnboard
  },
  "onboarding-smoke": {
    description: "Render a no-secret Neon setup preview.",
    run: runOnboardingSmoke
  },
  "mission-control-snapshot-smoke": {
    description: "Fetch a Mission Control Gateway snapshot from the local API.",
    run: runMissionControlSnapshotSmoke
  },
  "mission-control-ui-smoke": {
    description: "Fetch the local Mission Control Gateway HTML surface.",
    run: runMissionControlUiSmoke
  },
  "mission-control-serve": {
    description: "Serve the local Mission Control Gateway UI until stopped.",
    run: runMissionControlServe
  },
  tui: {
    description: "Open the read-only Neonika Operator Shell (interactive terminal dashboard).",
    run: runOperatorShell
  },
  interactive: {
    description: "Alias for tui: open the read-only Neonika Operator Shell.",
    run: runOperatorShell
  },
  "tui-smoke": {
    description: "Render the Neonika Operator Shell dashboard once and verify every panel loaded read-only.",
    run: runOperatorShellSmoke
  },
  help: {
    description: "Print available commands.",
    run: renderHelp
  }
};

// Load ./.env before any command reads process.env. Values already present in
// the environment win — loadEnvFile never overwrites them — so shell exports and
// launchd plists keep precedence over the file. All env reads in src/ are lazy
// (inside functions), so loading here is early enough for every command.
function loadNeonEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env present. That is the expected case for a fresh clone: every
    // setting has a safe default, so there is nothing to report or recover.
  }
}

const cliArgs = process.argv.slice(2);
loadNeonEnvFile();

const commandName = cliArgs[0] ?? "status";

if (cliArgs.includes("-h") || cliArgs.includes("--help")) {
  console.log(renderHelp());
} else if (cliArgs.includes("--version")) {
  console.log(await readNeonikaPackageVersion());
} else {
  const command = commands[commandName];

  if (!command) {
    console.error(`Unknown command: ${commandName}`);
    console.error(renderHelp());
    process.exitCode = 1;
  } else {
    await loadNeonSetupEnvironment(readFlagValue(cliArgs, "--config-root"));
    const output = await command.run();

    if (output !== undefined) {
      console.log(output);
    }
  }
}

async function loadNeonSetupEnvironment(configRoot?: string): Promise<void> {
  const config = await readNeonSetupConfig(configRoot);
  if (config === undefined) {
    return;
  }
  applyNeonSetupEnvironment(config, resolveNeonSetupPaths(configRoot));
}

async function runAppServerSmoke(): Promise<string> {
  const client = await createLocalAppServerClient();

  try {
    await client.initialize();

    return "Codex app-server stdio initialize: ok";
  } finally {
    await client.close();
  }
}

async function runThreadSmoke(): Promise<string> {
  const client = await createLocalAppServerClient();

  try {
    await client.initialize();
    const thread = await startOrResumeCodexThread({
      client,
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions: "Neonika runtime smoke. Do not start a model turn."
    });
    const unsubscribe = await unsubscribeCodexThread(client, thread.threadId);

    return [
      "Codex app-server thread/start: ok",
      `Thread: ${thread.threadId}`,
      `Source: ${thread.source}`,
      `Unsubscribe: ${JSON.stringify(unsubscribe ?? null)}`
    ].join("\n");
  } finally {
    await client.close();
  }
}

interface ILocalAppServerClientOptions {
  readonly defaultRequestTimeoutMs?: number;
}

async function createLocalAppServerClient(
  options: ILocalAppServerClientOptions = {}
): Promise<CodexJsonRpcClient> {
  const startOptions = await createLocalAppServerStartOptions();
  const transport = createCodexStdioTransport(startOptions);
  const client = new CodexJsonRpcClient(transport, {
    defaultRequestTimeoutMs: options.defaultRequestTimeoutMs ?? 5_000,
    serverRequestHandler: createNeonPeekabooAppServerRequestHandler({
      projectRoot: process.cwd()
    })
  });

  return client;
}

async function createLocalAppServerStartOptions(): Promise<ICodexAppServerStartOptions> {
  const peekabooProxySocketPath = resolveNeonPeekabooProxySocketPath(process.cwd());
  const peekabooProxyTcpUrl = resolveNeonPeekabooProxyTcpUrl();
  const peekabooShim = await ensurePeekabooProxyShim(peekabooProxySocketPath, peekabooProxyTcpUrl);
  const peekabooEnv = createNeonPeekabooAppServerEnv({
    env: {
      ...process.env,
      PEEKABOO_BIN: peekabooShim.shimPath
    },
    pathPrefix: [peekabooShim.dir],
    basePath: process.env["PATH"] ?? "/usr/bin:/bin"
  });
  const opServiceAccountToken = await resolveOpServiceAccountTokenForCodexAppServer(process.env);
  const opAccount = process.env["OP_ACCOUNT"];

  return {
    transport: "stdio",
    command: "codex",
    args: createNeonCodexAppServerArgs(),
    headers: {},
    env: {
      PATH: peekabooEnv.PATH,
      OP_BIN: "/opt/homebrew/bin/op",
      PEEKABOO_BIN: peekabooShim.shimPath,
      NEON_PEEKABOO_PROXY_URL: peekabooProxyTcpUrl,
      NEON_PEEKABOO_PROXY_SOCKET: peekabooProxySocketPath,
      ...(opServiceAccountToken ? { OP_SERVICE_ACCOUNT_TOKEN: opServiceAccountToken } : {}),
      ...(opAccount ? { OP_ACCOUNT: opAccount } : {}),
      ...(peekabooEnv.PEEKABOO_BRIDGE_SOCKET
        ? { PEEKABOO_BRIDGE_SOCKET: peekabooEnv.PEEKABOO_BRIDGE_SOCKET }
        : {})
    },
    clearEnv: [
      "ANTHROPIC_API_KEY",
      "BRAVE_API_KEY",
      "ELEVENLABS_API_KEY",
      "GOOGLE_PLACES_API_KEY",
      "OPENAI_API_KEY"
    ]
  };
}

async function resolveOpServiceAccountTokenForCodexAppServer(
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const tokenFromEnv = env["OP_SERVICE_ACCOUNT_TOKEN"]?.trim();
  if (tokenFromEnv) return tokenFromEnv;

  const home = env["HOME"]?.trim() || homedir();
  const tokenFilePath = join(home, ".config", "neon", "automation-op.env");
  try {
    const raw = await readFile(tokenFilePath, "utf8");
    return parseExportedEnvFileValue(raw, "OP_SERVICE_ACCOUNT_TOKEN");
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

function parseExportedEnvFileValue(raw: string, name: string): string | undefined {
  const exportPrefix = `export ${name}=`;
  const plainPrefix = `${name}=`;
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const rawValue = trimmed.startsWith(exportPrefix)
      ? trimmed.slice(exportPrefix.length)
      : trimmed.startsWith(plainPrefix)
        ? trimmed.slice(plainPrefix.length)
        : undefined;
    const value = rawValue ? unquoteEnvFileValue(rawValue.trim()).trim() : undefined;
    if (value) return value;
  }
  return undefined;
}

function unquoteEnvFileValue(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function createNeonCodexAppServerArgs(): readonly string[] {
  return [
    "app-server",
    "-c",
    "shell_environment_policy.inherit=all",
    "-c",
    "mcp_servers={}",
    "--listen",
    "stdio://"
  ];
}

interface IPeekabooProxyShim {
  readonly dir: string;
  readonly shimPath: string;
}

async function ensurePeekabooProxyShim(socketPath: string, tcpUrl: string): Promise<IPeekabooProxyShim> {
  const dir = join(process.cwd(), "state", "gateway", "peekaboo-bin");
  const shimPath = join(dir, "peekaboo");
  const script = renderNeonPeekabooProxyShimScript({
    projectRoot: process.cwd(),
    socketPath,
    tcpUrl,
    nodePath: process.execPath,
    targetBin: "/opt/homebrew/bin/peekaboo"
  });

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(shimPath, script, { encoding: "utf8", mode: 0o700 });
  await chmod(shimPath, 0o700);

  return { dir, shimPath };
}

function getDiscordTapClientPool(): CodexAppServerClientPool {
  discordTapClientPool ??= new CodexAppServerClientPool((startOptions) => {
    const transport = createCodexStdioTransport(startOptions);
    return new CodexJsonRpcClient(transport, {
      defaultRequestTimeoutMs: readCodexAppServerRequestTimeoutMsEnv(),
      serverRequestHandler: createNeonPeekabooAppServerRequestHandler({
        projectRoot: process.cwd()
      })
    });
  });

  return discordTapClientPool;
}

function renderHelp(): string {
  const commandLines = Object.entries(commands)
    .map(([name, currentCommand]) => `- ${name}: ${currentCommand.description}`)
    .join("\n");

  return [
    "Usage: neonika <command> [options]",
    "",
    "Global options:",
    "- -h, --help: Print this help and exit.",
    "- --version: Print the installed Neonika version and exit.",
    "",
    "Quick start:",
    "- neonika onboard",
    "- neonika onboarding-smoke",
    "- neonika status",
    "- neonika doctor",
    "",
    "Onboard options:",
    "- --yes: Use safe non-interactive defaults.",
    "- --interactive: Require the terminal wizard.",
    "- --config-root <path>: Override the private config root.",
    "- --owner-id <id>, --name <display name>: Set the local owner identity.",
    "- --discord, --discord-owner <id>, --discord-guilds <csv>, --discord-channels <csv>.",
    "- --whatsapp, --whatsapp-owner <E.164>, --whatsapp-mode <dedicated|personal>.",
    "",
    "Commands:",
    commandLines
  ].join("\n");
}

async function readNeonikaPackageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")
  ) as unknown;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    manifest.version.trim().length === 0
  ) {
    throw new Error("Neonika package metadata is missing a version");
  }
  return manifest.version;
}

async function runHarnessSmoke(): Promise<string> {
  const harness = createDryRunHarness();
  const result = await harness.run({
    prompt: "Local Neonika harness smoke",
    binding: {
      channel: "cli",
      accountId: "local",
      channelId: "terminal",
      agentId: "chaty",
      workspaceRoot: process.cwd(),
      mode: "read-only"
    },
    memory: {
      state: "skipped",
      hitCount: 0,
      note: "CLI smoke does not attach memory."
    }
  });

  return [
    `Harness: ${harness.id}`,
    `Session: ${result.sessionKey}`,
    `Memory: ${result.memoryState}`,
    `Events: ${result.events.length}`,
    result.finalText
  ].join("\n");
}

async function runClaudeHarnessSmoke(): Promise<string> {
  const transport = createScriptedClaudeSmokeTransport();
  const harness = createClaudeCliHarness({
    acquireTransport: () => ({
      transport,
      release: async () => undefined
    }),
    turnCompletionTimeoutMs: 1000
  });
  const result = await harness.run({
    prompt: "Local Neonika Claude harness smoke",
    binding: {
      channel: "cli",
      accountId: "local",
      channelId: "terminal",
      agentId: "chaty",
      workspaceRoot: process.cwd(),
      mode: "read-only"
    },
    memory: {
      state: "skipped",
      hitCount: 0,
      note: "CLI smoke does not attach memory."
    }
  });

  return [
    `Harness: ${harness.id}`,
    `Session: ${result.sessionKey}`,
    `Memory: ${result.memoryState}`,
    `Events: ${result.events.map((event) => event.kind).join(", ")}`,
    result.finalText
  ].join("\n");
}

/**
 * In-memory stream-json transport that replays a fixed Claude turn (init ->
 * assistant text -> success result) so the smoke verifies the harness wiring
 * without spawning the real `claude` binary.
 */
function createScriptedClaudeSmokeTransport(): IClaudeStreamTransport {
  const messageHandlers = new Set<(message: unknown) => void>();
  const closeHandlers = new Set<(error?: Error) => void>();
  const script: readonly unknown[] = [
    { type: "system", subtype: "init", session_id: "smoke" },
    {
      type: "assistant",
      session_id: "smoke",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Neonika Claude harness ready, Sir." }]
      }
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Neonika Claude harness ready, Sir.",
      session_id: "smoke",
      usage: { input_tokens: 6, output_tokens: 7 }
    }
  ];

  return {
    send: async (line: string) => {
      const parsed = JSON.parse(line.trim()) as Record<string, unknown>;

      if (parsed["type"] !== "user") {
        return;
      }

      queueMicrotask(() => {
        for (const message of script) {
          for (const handler of messageHandlers) {
            handler(message);
          }
        }
      });
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);

      return () => {
        messageHandlers.delete(handler);
      };
    },
    onClose: (handler) => {
      closeHandlers.add(handler);

      return () => {
        closeHandlers.delete(handler);
      };
    },
    close: async () => {
      messageHandlers.clear();
      closeHandlers.clear();
    }
  };
}

async function runClaudeHarnessLiveSmoke(): Promise<string> {
  if (!isReadyLike(process.env["NEON_CLAUDE_HARNESS_LIVE_SMOKE"])) {
    return [
      "Neonika Claude harness live smoke: not-run",
      "Set NEON_CLAUDE_HARNESS_LIVE_SMOKE=ready to spawn the real `claude` binary for one read-only stream-json turn.",
      "Safety: read-only mode; native tool execution is denied; no outbound delivery; no secrets printed."
    ].join("\n");
  }

  const claudeBin = process.env["NEON_CLAUDE_BIN"]?.trim() || "claude";
  const harness = createClaudeCliHarness({
    acquireTransport: (spec) => {
      const transport = createClaudeProcessTransport({
        command: claudeBin,
        args: spec.args,
        cwd: spec.cwd,
        inheritEnv: true
      });

      return {
        transport,
        release: async () => {
          await transport.close();
        }
      };
    },
    turnCompletionTimeoutMs: 120_000
  });

  const result = await harness.run({
    prompt: "Reply with exactly one short sentence confirming the Neonika Claude harness reached you.",
    binding: {
      channel: "cli",
      accountId: "local",
      channelId: "terminal",
      agentId: "chaty",
      workspaceRoot: process.cwd(),
      mode: "read-only"
    },
    memory: {
      state: "skipped",
      hitCount: 0,
      note: "Live smoke does not attach memory."
    }
  });

  return [
    "Neonika Claude harness live smoke: ok",
    `Binary: ${claudeBin}`,
    `Harness: ${harness.id}`,
    `Session: ${result.sessionKey}`,
    `Events: ${result.events.map((event) => event.kind).join(", ")}`,
    `Final: ${result.finalText}`
  ].join("\n");
}

function runAgentsSmoke(): string {
  const requestedAgentId = readTrailingArgument("chaty");
  const snapshot = createNeonAgentsSnapshot();
  const agent = resolveNeonAgentAttachment(requestedAgentId);

  if (!agent) {
    throw new Error(`Unknown Neon agent: ${requestedAgentId}`);
  }

  return [
    `Neonika Agents: ${snapshot.state}`,
    `Count: ${snapshot.agents.length}`,
    `Default: ${snapshot.defaultAgentId}`,
    renderNeonAgentIdentity(agent)
  ].join("\n");
}

async function runGatewayShadowSmoke(): Promise<string> {
  const result = await runNeonGatewayShadow(
    {
      message: {
        channel: "discord",
        accountId: "local",
        channelId: "terminal",
        userId: "operator",
        userDisplayName: "Operator",
        agentId: "chaty",
        workspaceRoot: process.cwd(),
        mode: "read-only",
        content: "Local Neonika Gateway shadow smoke",
        createdAt: new Date(0).toISOString()
      },
      memory: {
        state: "skipped",
        hitCount: 0,
        note: "Gateway shadow smoke does not attach memory."
      }
    },
    {
      harness: createDryRunHarness()
    }
  );

  await writeNeonGatewayRun(process.cwd(), result.run);

  return [
    `Gateway run: ${result.run.runId}`,
    `Mode: ${result.run.mode}`,
    `Status: ${result.run.status}`,
    `Delivery: ${result.run.delivery.state}`,
    `Harness session: ${result.run.harnessSessionKey}`,
    result.run.finalText
  ].join("\n");
}

async function runShadowRun(): Promise<string> {
  const prompt = readTrailingArgument("Describe the task to run as a Neon shadow turn.");
  if (!isReadyLike(process.env["NEON_SHADOW_RUN_ENABLED"])) {
    return [
      "Neon shadow-run: not-run",
      "Set NEON_SHADOW_RUN_ENABLED=ready to drive one real Codex turn (read-only, delivery stays suppressed).",
      `Prompt: ${prompt}`
    ].join("\n");
  }

  const lifecycleGate = resolveNeonInFlightRunGate();
  const harness = await createDiscordTapHarness("codex", lifecycleGate);
  const result = await runNeonGatewayShadow(
    {
      message: {
        channel: "discord",
        accountId: "local",
        channelId: "terminal",
        userId: "operator",
        userDisplayName: "Operator",
        agentId: process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty",
        workspaceRoot: process.cwd(),
        mode: "read-only",
        content: prompt,
        createdAt: new Date(0).toISOString()
      },
      memory: {
        state: "skipped",
        hitCount: 0,
        note: "Shadow-run does not attach memory."
      }
    },
    { harness }
  );

  await writeNeonGatewayRun(process.cwd(), result.run);

  return [
    `Gateway run: ${result.run.runId}`,
    `Mode: ${result.run.mode}`,
    `Status: ${result.run.status}`,
    `Delivery: ${result.run.delivery.state}`,
    `Harness session: ${result.run.harnessSessionKey}`,
    "--- finalText ---",
    result.run.finalText
  ].join("\n");
}

async function runMemoryWriteDryRun(): Promise<string> {
  const content = readTrailingArgument("Neonika memory-write dry-run probe");
  // No productive command is wired, so this stays a planned dry-run with no side effect.
  const writer = createNeonMemoryCliWriter();
  const result = await writer.write({ content }, { mode: "dry-run" });

  return [
    `Memory write: ${result.mode} / ${result.state}`,
    `Planned content: ${result.redactedContent}`,
    `Command: ${result.command ?? "none (productive blocked)"}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

async function runMemoryFlushPlanSmoke(): Promise<string> {
  // Read-only planner: builds the flush plan + reports the gate. No write happens
  // here regardless of the gate; the real flush is a separate gated executor.
  const result = planNeonMemoryFlush();

  return [
    `Memory flush plan (dry-run): gate ${result.gate.envVar}=${result.gate.enabled ? "on" : "off"}`,
    `Would write: ${result.wouldWrite ? "yes (executor gated separately)" : "no (default-off)"}`,
    `Target: ${result.plan.relativePath}`,
    `Soft threshold: ${result.plan.softThresholdTokens} tokens`,
    `Force flush at: ${result.plan.forceFlushTranscriptBytes} bytes`,
    `Prompt: ${result.plan.prompt}`
  ].join("\n");
}

async function runRecallTrackingSmoke(): Promise<string> {
  // Read-only smoke: resolves the gate and shows that a recall append is blocked
  // by default (no NEON_MEMORY_WRITE_ENABLED + no isolated storePath). No file write.
  const gate = resolveNeonRecallTrackingGate(process.env);
  const result = await appendNeonRecallEvent({
    request: { query: "recall-tracking probe", hits: ["memory:example", "run:example"] },
    gate
  });

  return renderNeonRecallTrackingReport(result);
}

async function runMemoryEventLogSmoke(): Promise<string> {
  // Read-only smoke: resolves the gate and shows that a memory-event append is
  // blocked by default (no NEON_MEMORY_WRITE_ENABLED + no isolated storePath).
  const gate = resolveNeonMemoryEventLogGate(process.env);
  const result = await appendNeonMemoryEvent({
    event: buildNeonDreamCompletedEvent({ phase: "deep", lineCount: 0, storageMode: "inline" }),
    gate
  });

  return renderNeonMemoryEventLogReport(result);
}

async function runMemoryWriteProductiveSmoke(): Promise<string> {
  const content = readTrailingArgument("Neonika productive memory-write probe");
  const gate = resolveNeonMemoryWriteGate(process.env);
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-memory-write-smoke-"));
  const storePath = join(projectRoot, "isolated-memory-store.json");

  try {
    const result = await writeNeonMemoryEntry({
      request: { content, source: "memory-write-productive-smoke" },
      gate,
      mode: gate.enabled ? "productive" : "dry-run",
      storePath
    });
    const roundtrip = await readNeonMemoryStore(storePath);

    return [
      renderNeonMemoryWriteRuntimeReport(result),
      `Roundtrip entries in isolated store: ${roundtrip.length}`,
      result.entryId
        ? `Roundtrip match: ${roundtrip.some((entry) => entry.id === result.entryId) ? "yes" : "no"}`
        : "Roundtrip match: n/a (no productive write)"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runMemoryDbWriteSmoke(): Promise<string> {
  const content = readTrailingArgument("Neonika SQLite memory-write probe about fleet telemetry");
  const gate = resolveNeonMemoryDbWriteGate(process.env);
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-memory-db-write-smoke-"));
  const dbPath = join(projectRoot, "isolated-semantic-memory.db");
  // Deterministic local embedder (no Ollama dependency) so the smoke also proves the
  // vector BLOB write + hybrid roundtrip. Gate stays default-off unless armed.
  const embedder = createNeonLocalEmbeddingProvider();

  try {
    const result = await writeNeonMemoryDbEntry({
      dbPath,
      gate,
      embedder,
      input: {
        sourceFile: "memory-db-write-smoke",
        content,
        agent: "neo",
        category: "discoveries"
      }
    });
    const ftsRoundtrip = result.state === "written" ? searchNeonMemoryDb(content, { dbPath, limit: 3 }) : [];

    return [
      renderNeonMemoryDbWriteReport(result),
      `FTS roundtrip hits in isolated DB: ${ftsRoundtrip.length}`,
      result.entryId
        ? `Roundtrip match: ${ftsRoundtrip.length > 0 ? "yes" : "no"}`
        : "Roundtrip match: n/a (gated, no write)"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runMemoryMaintainSmoke(): Promise<string> {
  const envGate = resolveNeonMemoryDbWriteGate(process.env);
  // Seeding always runs against the isolated temp DB (it's test setup, not the
  // maintenance op under demo). The maintenance pipeline below uses the real ENV
  // gate, so the smoke shows plan-vs-armed depending on NEON_MEMORY_WRITE_ENABLED.
  const seedGate = { enabled: true, reason: "write-enabled", envKey: "NEON_MEMORY_WRITE_ENABLED" } as const;
  const root = await mkdtemp(join(tmpdir(), "neonika-memory-maintain-smoke-"));
  const dbPath = join(root, "isolated-semantic-memory.db");
  const backupDir = join(root, "backups");
  const embedder = createNeonLocalEmbeddingProvider();

  try {
    const seeds = [
      { sourceFile: "alpha.md", content: "fleet telemetry ingestion across DACH markets", agent: "neo", category: "discoveries", importanceScore: 80 },
      { sourceFile: "beta.md", content: "fleet telemetry ingestion in DACH territory", agent: "neo", category: "discoveries", importanceScore: 75 },
      { sourceFile: "noise.md", content: "low value never recalled note", agent: "neo", category: "discoveries", importanceScore: 20 }
    ];
    for (const input of seeds) {
      await writeNeonMemoryDbEntry({ dbPath, gate: seedGate, embedder, input });
    }

    const recalc = recalcNeonMemoryImportance({ dbPath, gate: envGate, now: () => new Date() });
    const relations = discoverNeonMemoryRelations({ dbPath, gate: envGate, dimensions: embedder.dimensions, threshold: 0.5 });
    const prune = pruneNeonMemory({ dbPath, gate: envGate, maxScore: 35 });
    const backup = await createNeonMemoryBackup({ dbPath, backupDir, keep: 3 });

    return [
      `Neonika Memory Maintenance (isolated temp DB) — gate: ${envGate.reason}`,
      renderNeonImportanceRecalcReport(recalc),
      renderNeonRelationDiscoveryReport(relations),
      renderNeonPruneReport(prune),
      renderNeonMemoryBackupReport(backup)
    ].join("\n\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// Memory cutover Slice K5: the productive maintenance facade. Runs against the
// neonika DB (NEON_MEMORY_DB_PATH); the real v2 archive is hard-refused by
// every step's guard, so a misconfigured env degrades to plans, not mutations.
async function runMemoryMaintain(): Promise<string> {
  const dbPath = resolveNeonMemoryRecallDbPath(process.env);
  if (targetsRealNeonDb(dbPath)) {
    return [
      "Neonika Memory Maintenance: refused",
      "NEON_MEMORY_DB_PATH points at the real v2 archive DB - maintenance only runs against the neonika DB.",
      "Set NEON_MEMORY_DB_PATH to the neonika DB (e.g. <checkout>/data/semantic-memory.db)."
    ].join("\n");
  }

  const result = await runNeonMemoryMaintenance({
    dbPath,
    backupDir: join(process.cwd(), "state", "memory-backups"),
    gate: resolveNeonMemoryDbWriteGate(process.env),
    applyPrune: process.argv.includes("--prune-apply")
  });

  return renderNeonMemoryMaintenanceReport(result);
}

async function runMemoryImportExportSmoke(): Promise<string> {
  // Hermetic in-memory entries: the dry-run import/export logic is exercised
  // without any file I/O, gate, or real semantic-memory DB connection.
  const entries = [
    {
      id: "mem-smoke-1",
      content: "isolated note for the import/export dry-run smoke",
      writtenAt: "2026-06-02T00:00:00.000Z",
      category: "project"
    },
    {
      id: "mem-smoke-2",
      content: "second isolated note",
      writtenAt: "2026-06-02T00:01:00.000Z"
    }
  ];
  const storePath = "(in-memory smoke entries — no file, no real DB)";
  const plan = await createNeonMemoryImportPlan(storePath, { entries });
  const manifest = await createNeonMemoryExportManifest(storePath, { entries });

  return [renderNeonMemoryImportPlanReport(plan), "---", renderNeonMemoryExportManifest(manifest)].join("\n");
}

async function runMemorySmoke(): Promise<string> {
  const query = readTrailingArgument("neon core memory");
  const attachment = await createNeonMemoryAttachment(createNeonMemoryCliProvider(), query, {
    maxHits: 5
  });
  const excerpts = attachment.excerpts?.map((excerpt, index) => {
    return `${index + 1}. [${excerpt.source}] ${excerpt.text}`;
  }) ?? ["No excerpts attached."];

  return [
    `Memory: ${attachment.state}`,
    `Hits: ${attachment.hitCount}`,
    `Note: ${attachment.note}`,
    ...excerpts
  ].join("\n");
}

async function runGatewayMemoryShadowSmoke(): Promise<string> {
  const query = readTrailingArgument("neon core memory");
  const memory = await createNeonMemoryAttachment(createNeonMemoryCliProvider(), query, {
    maxHits: 5
  });
  const result = await runNeonGatewayShadow(
    {
      message: {
        channel: "discord",
        accountId: "local",
        channelId: "terminal",
        userId: "operator",
        userDisplayName: "Operator",
        agentId: "chaty",
        workspaceRoot: process.cwd(),
        mode: "read-only",
        content: "Local Neonika Gateway memory shadow smoke",
        createdAt: new Date(0).toISOString()
      },
      memory
    },
    {
      harness: createDryRunHarness()
    }
  );

  await writeNeonGatewayRun(process.cwd(), result.run);

  return [
    `Gateway run: ${result.run.runId}`,
    `Mode: ${result.run.mode}`,
    `Status: ${result.run.status}`,
    `Memory: ${result.run.memoryState}`,
    `Memory hits: ${memory.hitCount}`,
    `Delivery: ${result.run.delivery.state}`,
    `Harness session: ${result.run.harnessSessionKey}`,
    result.run.finalText
  ].join("\n");
}

async function runAgentRecallSmoke(): Promise<string> {
  const { agentId, query } = readAgentRecallArguments();
  const provider = createNeonMemoryCliProvider();
  // Scoped, read-only recall: folds the agent's profile seeds into the query and
  // tags the result with the resolved agent id. The provider only searches — no
  // write, no mutation, no side effect.
  const recall = await recallNeonAgentMemory(provider, agentId, query, { maxHits: 5 });
  // Reuse the shared redaction/excerpt builder via the agent-scoped attachment so
  // the printed excerpts are leak-safe and carry the `[agent <id>]` note tag.
  const attachment = await createNeonAgentMemoryAttachment(provider, agentId, query, {
    maxHits: 5
  });

  return buildNeonAgentRecallReport(recall, attachment).join("\n");
}

function readAgentRecallArguments(): { agentId: string; query: string } {
  const args = process.argv.slice(3);
  const agentId = args[0]?.trim() ?? "";
  const query = args.slice(1).join(" ").trim();

  return {
    agentId: agentId.length > 0 ? agentId : "chaty",
    query: query.length > 0 ? query : "neon core memory"
  };
}

function buildNeonAgentRecallReport(
  recall: INeonAgentScopedRecall,
  attachment: INeonAgentMemoryAttachment
): readonly string[] {
  const agentLabel = recall.resolvedAgentId ?? `${recall.agentId} (unknown agent)`;
  const scopeTerms = recall.scopeTerms.length > 0 ? recall.scopeTerms.join(", ") : "none";
  const excerpts =
    attachment.excerpts && attachment.excerpts.length > 0
      ? attachment.excerpts.map(
          (excerpt, index) => `${index + 1}. [${excerpt.source}] ${excerpt.text}`
        )
      : ["No excerpts attached."];

  return [
    `Agent: ${agentLabel} (requested "${recall.agentId}")`,
    `Memory: ${attachment.state}`,
    `Hits: ${attachment.hitCount}`,
    `Scoped query: ${recall.scopedQuery}`,
    `Scope terms: ${scopeTerms}`,
    `Note: ${attachment.note}`,
    ...excerpts
  ];
}

async function runDiscordShadowSmoke(): Promise<string> {
  const resolveMemory = createDiscordMemoryResolver();
  const result = await runNeonDiscordShadowIngress(
    {
      message: {
        accountId: "local",
        guildId: "900000000000000001",
        channelId: "900000000000000005",
        threadId: "local-shadow-thread",
        messageId: `local-discord-${Date.now()}`,
        author: {
          id: "operator",
          username: "operator",
          displayName: "Operator"
        },
        content: "<@900000000000000010> Local Discord shadow smoke",
        createdAt: new Date().toISOString(),
        mentionedUserIds: ["900000000000000010"]
      },
      policy: {
        agentId: "chaty",
        workspaceRoot: process.cwd(),
        mode: "read-only",
        botUserId: "900000000000000010",
        mentionPolicy: "guild",
        allowedGuildIds: ["900000000000000001"],
        allowedChannelIds: ["900000000000000005"]
      },
      resolveMemory
    },
    {
      projectRoot: process.cwd(),
      harness: createDryRunHarness()
    }
  );

  if (result.state === "dropped") {
    throw new Error(`Discord shadow smoke dropped: ${result.reason}`);
  }

  return [
    `Discord shadow: ${result.result.run.status}`,
    `Run: ${result.result.run.runId}`,
    `Mentioned: ${result.wasMentioned ? "yes" : "no"}`,
    `Memory: ${result.result.run.memoryState}`,
    `Delivery: ${result.result.run.delivery.state}`,
    `Preview: ${result.result.run.request.contentPreview}`
  ].join("\n");
}

async function runSlashInteractionShadowSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-slash-shadow-smoke-"));
  const guildId = "900000000000000001";
  const channelId = "900000000000000005";
  const interaction = {
    accountId: "local",
    guildId,
    channelId,
    interactionId: `local-slash-${Date.now()}`,
    commandName: "skill",
    subcommandName: "run",
    author: { id: "operator", username: "operator", displayName: "Operator" },
    options: [{ name: "query", value: "memory search" }],
    createdAt: new Date().toISOString()
  } as const;

  try {
    // Default policy: slash interaction admitted as a no-send shadow run.
    const admitted = await runNeonDiscordSlashInteractionShadow(
      {
        interaction,
        policy: {
          agentId: "chaty",
          workspaceRoot: projectRoot,
          mode: "read-only",
          mentionPolicy: "never",
          allowedGuildIds: [guildId],
          allowedChannelIds: [channelId]
        },
        memory: { state: "skipped", hitCount: 0, note: "Slash dispatch smoke" }
      },
      { projectRoot, harness: createDryRunHarness() }
    );

    // Gated policy: text commands on, no command authorizer configured ->
    // access groups on by default -> the control command is not authorized.
    const blocked = await runNeonDiscordSlashInteractionShadow(
      {
        interaction: { ...interaction, author: { id: "stranger", username: "stranger" } },
        policy: {
          agentId: "chaty",
          workspaceRoot: projectRoot,
          mode: "read-only",
          mentionPolicy: "never",
          allowedGuildIds: [guildId],
          allowedChannelIds: [channelId],
          allowTextCommands: true
        },
        memory: { state: "skipped", hitCount: 0, note: "Slash dispatch smoke" }
      },
      { projectRoot, harness: createDryRunHarness() }
    );

    const guildPlan = resolveNeonSlashCommandRegistrationPlan({
      requestedScope: "guild",
      guildIds: [guildId]
    });
    const globalPlan = resolveNeonSlashCommandRegistrationPlan({ requestedScope: "global" });

    return [
      "### Admitted slash interaction (no-send shadow run)",
      admitted.state === "accepted"
        ? `state=accepted run=${admitted.result.run.runId} delivery=${admitted.result.run.delivery.state} command=${admitted.commandText}`
        : `state=dropped reason=${admitted.reason}`,
      "",
      "### Gated slash interaction (text commands on, no authorizer -> command-not-authorized)",
      blocked.state === "dropped"
        ? `state=dropped reason=${blocked.reason}`
        : `state=accepted run=${blocked.result.run.runId}`,
      "",
      "### Registration plan (guild-scoped preferred, global blocked)",
      renderNeonSlashCommandRegistrationPlanReport(guildPlan),
      "",
      renderNeonSlashCommandRegistrationPlanReport(globalPlan)
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runChatSendSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-chat-send-smoke-"));

  try {
    const result = await submitNeonChatSend(
      projectRoot,
      {
        channel: "discord",
        channelId: "dashboard-thread",
        agentId: "chaty",
        text: "Operator dashboard reply — shadow dry-run, never sent."
      },
      { harness: createDryRunHarness() }
    );

    return [
      renderNeonChatSendReport(result),
      "",
      "Note: promoting to a real send is the separate, gated /api/neon-delivery/approval path."
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runDeliveryQueueReport(): Promise<string> {
  const snapshot = await createNeonDeliveryQueueSnapshot(process.cwd(), {
    maxCandidates: 50
  });

  return renderNeonDeliveryQueueReport(snapshot);
}

async function runDeliveryDrainPlanReport(): Promise<string> {
  const snapshot = await createNeonDeliveryQueueSnapshot(process.cwd(), {
    maxCandidates: 100
  });
  const plan = planNeonDeliveryDrain(snapshot, {
    gate: resolveNeonDeliveryDrainGate(process.env)
  });

  return renderNeonDeliveryDrainPlanReport(plan);
}

function buildPendingDrainSeed(nowMs: number): readonly INeonDeliveryQueueCandidate[] {
  const seed = (
    id: string,
    ageMs: number,
    ackState: INeonDeliveryQueueCandidate["ackState"]
  ): INeonDeliveryQueueCandidate => ({
    id,
    runId: `run-${id}`,
    state: "queued-dry-run",
    reason: "primary-dry-run",
    target: { channel: "discord", accountId: "acc-1", channelId: "chan-1" },
    agentId: "chaty",
    sourceRunStatus: "completed",
    finalTextPreview: "Reconnect drain seed candidate",
    safety: { outboundSent: false, requiresApproval: true, cutoverStage: "shadow" },
    ackState,
    recoveryState: "pending-drain",
    createdAt: new Date(nowMs - ageMs).toISOString()
  });

  return [
    seed("eligible-1", 60_000, "queued"),
    seed("expired-1", 2 * 60 * 60 * 1000, "queued"),
    seed("acked-1", 60_000, "done")
  ];
}

async function runDeliveryDrainPlanSmoke(): Promise<string> {
  const nowMs = Date.now();
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-drain-smoke-"));

  try {
    const paths = resolveNeonDeliveryQueuePaths(projectRoot);
    await mkdir(dirname(paths.queuePath), { recursive: true });
    const jsonl = buildPendingDrainSeed(nowMs)
      .map((candidate) => JSON.stringify(candidate))
      .join("\n");
    await writeFile(paths.queuePath, `${jsonl}\n`, "utf8");

    const snapshot = await createNeonDeliveryQueueSnapshot(projectRoot, { maxCandidates: 100 });
    const ttlMs = 60 * 60 * 1000;
    const now = (): Date => new Date(nowMs);

    const blocked = planNeonDeliveryDrain(snapshot, {
      gate: resolveNeonDeliveryDrainGate({}),
      now,
      ttlMs
    });
    const dryRun = planNeonDeliveryDrain(snapshot, {
      gate: resolveNeonDeliveryDrainGate({ NEON_DELIVERY_DRAIN_ENABLED: "1" }),
      now,
      ttlMs
    });

    return [
      "### Default gate (closed)",
      renderNeonDeliveryDrainPlanReport(blocked),
      "",
      "### Armed gate (dry-run, still no send)",
      renderNeonDeliveryDrainPlanReport(dryRun)
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runRunLifecycleSmoke(): Promise<string> {
  const nowMs = Date.now();
  let tick = 0;
  const now = (): Date => new Date(nowMs + tick++ * 1000);

  // Closed gate: terminal-only view, onRunStart is a no-op (shadow posture).
  const closed = createNeonInFlightRunRegistry({ gate: resolveNeonInFlightRunGate({}), now });
  const closedStart = closed.onRunStart({
    runId: "run-a",
    threadId: "thread-a",
    turnId: "turn-a",
    sessionKey: "session-a",
    agentId: "chaty",
    channel: "discord"
  });

  // Armed gate: track two in-flight runs in memory (the run store stays untouched).
  const armed = createNeonInFlightRunRegistry({
    gate: resolveNeonInFlightRunGate({ NEON_LIVE_RUN_LIFECYCLE_ENABLED: "1" }),
    now
  });
  for (const id of ["run-a", "run-b"]) {
    armed.onRunStart({
      runId: id,
      threadId: `thread-${id}`,
      turnId: `turn-${id}`,
      sessionKey: `session-${id}`,
      agentId: "chaty",
      channel: "discord"
    });
  }

  const busy = armed.snapshot();
  const record = busy.running.find((entry) => entry.runId === "run-a");
  const stop = planNeonRunLifecycleAction({ action: "stop", runId: "run-a", gate: armed.gate, record });
  armed.markInterrupting("run-a");
  armed.onRunEnd("run-a");

  return [
    "### Default gate (closed)",
    `onRunStart tracked: ${closedStart === null ? "no (terminal-only)" : "yes"}`,
    renderNeonInFlightRunReport(closed.snapshot()),
    "",
    "### Armed gate (in-memory, run store untouched)",
    renderNeonInFlightRunReport(busy),
    "",
    "### Stop decision (maps to interruptCodexTurn, never executes here)",
    renderNeonRunLifecycleDecisionReport(stop),
    "",
    "### After interrupt + end",
    renderNeonInFlightRunReport(armed.snapshot())
  ].join("\n");
}

async function runRunLifecycleHarnessSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-run-lifecycle-harness-"));
  const client = createDelayedTurnCodexClient();
  const registry = createNeonInFlightRunRegistry({
    gate: resolveNeonInFlightRunGate({ NEON_LIVE_RUN_LIFECYCLE_ENABLED: "ready" })
  });
  const harness = createCodexAppServerHarness({
    projectRoot,
    inFlightRuns: registry,
    acquireClient: () => ({
      client,
      release: async () => {
        await client.close();
      }
    }),
    turnCompletionTimeoutMs: 1000
  });
  const runId = "run-harness-lifecycle-smoke";
  const runPromise = harness.run({
    runId,
    prompt: "Hold the turn until the smoke interrupts it.",
    binding: {
      channel: "discord",
      accountId: "smoke",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      threadId: "lifecycle-harness-smoke",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "read-only"
    },
    memory: {
      state: "skipped",
      hitCount: 0,
      note: "run lifecycle harness smoke"
    }
  });

  try {
    const activeRecord = await waitForInFlightRecord(registry, runId, 500);
    const stop = planNeonRunLifecycleAction({
      action: "stop",
      runId,
      gate: registry.gate,
      record: activeRecord
    });
    const interruptResult = stop.interruptThreadId && stop.interruptTurnId
      ? await interruptCodexTurn(client, {
          threadId: stop.interruptThreadId,
          turnId: stop.interruptTurnId
        })
      : undefined;
    const result = await runPromise;
    const finalSnapshot = registry.snapshot();

    return [
      "Neon run lifecycle harness smoke: ok",
      `Active during turn: ${activeRecord.runId}/${activeRecord.turnId}`,
      `Stop decision: ${stop.state} (${stop.reason})`,
      `Interrupt thread: ${stop.interruptThreadId ?? "none"}`,
      `Interrupt turn: ${stop.interruptTurnId ?? "none"}`,
      `Interrupt request: ${JSON.stringify(interruptResult ?? null)}`,
      `Final text: ${result.finalText}`,
      `Final active runs: ${finalSnapshot.activeRuns}`,
      `Client interrupts: ${client.interruptTurnIds.length}`,
      "Safety: fake app-server only, no model call, no outbound send"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runRunLifecycleCodexLiveSmoke(): Promise<string> {
  if (!isReadyLike(process.env["NEON_RUN_LIFECYCLE_CODEX_LIVE_SMOKE"])) {
    return [
      "Neon run lifecycle codex live smoke: not-run",
      "Set NEON_RUN_LIFECYCLE_CODEX_LIVE_SMOKE=ready to start one real codex app-server turn.",
      "Safety: no Discord send, no run-store write, temp projectRoot only."
    ].join("\n");
  }

  const attempts: readonly IRunLifecycleCodexLiveAttempt[] = [
    {
      label: "long-text",
      prompt: [
        "Neonika lifecycle live smoke.",
        "Do not use tools. Start a deliberately long plain-text response by counting upward.",
        "This turn may be interrupted immediately by the operator."
      ].join("\n"),
      turnCompletionTimeoutMs: 20_000
    },
    {
      label: "blocking-read-only-command",
      prompt: [
        "Neonika lifecycle live smoke.",
        "Use the shell to run exactly: sleep 10",
        "Do not write files, do not access secrets, and do not produce the final answer until the command completes.",
        "This is a read-only interrupt test inside a temporary project directory and may be interrupted immediately."
      ].join("\n"),
      turnCompletionTimeoutMs: 30_000
    }
  ];
  const reports: string[] = [];

  for (const attempt of attempts) {
    const result = await runRunLifecycleCodexLiveAttempt(attempt);
    reports.push(result.report);

    if (result.ok) {
      return result.report;
    }
  }

  process.exitCode = 1;
  return [
    "Neon run lifecycle codex live smoke: failed",
    "No attempt produced a controlled real Codex interruption.",
    ...reports.map((report, index) => [`attempt ${index + 1} report`, report].join("\n"))
  ].join("\n\n");
}

interface IRunLifecycleCodexLiveAttempt {
  readonly label: string;
  readonly prompt: string;
  readonly turnCompletionTimeoutMs: number;
}

interface IRunLifecycleCodexLiveAttemptResult {
  readonly ok: boolean;
  readonly report: string;
}

async function runRunLifecycleCodexLiveAttempt(
  attempt: IRunLifecycleCodexLiveAttempt
): Promise<IRunLifecycleCodexLiveAttemptResult> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-run-lifecycle-codex-live-"));
  const client = await createLocalAppServerClient({ defaultRequestTimeoutMs: attempt.turnCompletionTimeoutMs });
  const registry = createNeonInFlightRunRegistry({
    gate: resolveNeonInFlightRunGate({ NEON_LIVE_RUN_LIFECYCLE_ENABLED: "ready" })
  });
  const harness = createCodexAppServerHarness({
    projectRoot,
    inFlightRuns: registry,
    acquireClient: () => ({
      client,
      release: async () => {
        await client.close();
      }
    }),
    turnCompletionTimeoutMs: attempt.turnCompletionTimeoutMs
  });
  const runId = `run-codex-live-smoke-${attempt.label}-${Date.now()}`;
  const abortController = new AbortController();
  const runPromise = harness.run({
    abortSignal: abortController.signal,
    runId,
    prompt: attempt.prompt,
    binding: {
      channel: "cli",
      accountId: "local",
      channelId: "run-lifecycle-codex-live-smoke",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "read-only"
    },
    memory: {
      state: "skipped",
      hitCount: 0,
      note: "codex live lifecycle smoke"
    }
  });

  try {
    const activeRecord = await waitForInFlightRecord(registry, runId, 10_000);
    const stop = planNeonRunLifecycleAction({
      action: "stop",
      runId,
      gate: registry.gate,
      record: activeRecord
    });
    let interruptResult: TJsonValue | undefined;
    let interruptError: string | undefined;
    const interruptPromise =
      stop.interruptThreadId && stop.interruptTurnId
        ? interruptCodexTurn(client, {
            threadId: stop.interruptThreadId,
            turnId: stop.interruptTurnId
          })
            .then((value) => {
              interruptResult = value;
            })
            .catch((error: unknown) => {
              interruptError = redactText(error instanceof Error ? error.message : String(error));
            })
        : Promise.resolve();

    abortController.abort("neon_lifecycle_smoke_stop");

    const result = await runPromise;
    await interruptPromise;
    const finalSnapshot = registry.snapshot();
    const interrupted = /interrupted/i.test(result.finalText) && finalSnapshot.activeRuns === 0;

    return {
      ok: interrupted,
      report: [
        `Neon run lifecycle codex live smoke: ${interrupted ? "ok" : "not-interrupted"}`,
        `Attempt: ${attempt.label}`,
        `Active during turn: ${activeRecord.runId}/${activeRecord.turnId}`,
        `Stop decision: ${stop.state} (${stop.reason})`,
        `Interrupt thread: ${stop.interruptThreadId ?? "none"}`,
        `Interrupt turn: ${stop.interruptTurnId ?? "none"}`,
        `Interrupt request: ${JSON.stringify(interruptResult ?? null)}`,
        ...(interruptError ? [`Interrupt error: ${interruptError}`] : []),
        `Local abort: ${abortController.signal.aborted ? "sent" : "not-sent"}`,
        `Final text: ${result.finalText}`,
        `Final active runs: ${finalSnapshot.activeRuns}`,
        "Safety: real codex app-server, no Discord send, no run-store write"
      ].join("\n")
    };
  } catch (error) {
    const result = await runPromise;

    return {
      ok: false,
      report: [
        "Neon run lifecycle codex live smoke: not-interrupted",
        `Attempt: ${attempt.label}`,
        `Error: ${redactText(error instanceof Error ? error.message : String(error))}`,
        `Final text: ${result.finalText}`,
        "Safety: real codex app-server, no Discord send, no run-store write"
      ].join("\n")
    };
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function waitForInFlightRecord(
  registry: INeonInFlightRunRegistry,
  runId: string,
  timeoutMs: number
): Promise<INeonInFlightRunRecord> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const record = registry.snapshot().running.find((entry) => entry.runId === runId);

    if (record) {
      return record;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error(`Run lifecycle harness smoke did not observe active run ${runId}`);
}

async function waitForGatewayRun(
  projectRoot: string,
  predicate: (run: INeonGatewayShadowRun) => boolean,
  timeoutMs: number
): Promise<INeonGatewayShadowRun> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = (await readNeonGatewayRuns(projectRoot, { maxRuns: 100 })).find(predicate);

    if (run) {
      return run;
    }

    await sleepMs(250);
  }

  throw new Error("Timed out waiting for Gateway run");
}

async function waitForActivitySseRun(
  streamUrl: string,
  runId: string,
  timeoutMs: number
): Promise<{ readonly runId: string; readonly entries: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort("activity_sse_timeout");
  }, timeoutMs);

  try {
    const response = await fetch(streamUrl, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`Activity SSE failed with HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) {
            continue;
          }

          const frame = readActivitySseRunFrame(JSON.parse(dataLine.slice("data: ".length)));
          if (frame?.runId === runId) {
            return frame;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timeout);
    controller.abort("activity_sse_done");
  }

  throw new Error(`Timed out waiting for Activity SSE frame for ${runId}`);
}

function readActivitySseRunFrame(value: unknown): { readonly runId: string; readonly entries: number } | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const frame = value as { readonly type?: unknown; readonly runId?: unknown; readonly entries?: unknown };
  if (frame.type !== "activity-run" || typeof frame.runId !== "string" || !Array.isArray(frame.entries)) {
    return undefined;
  }

  return { runId: frame.runId, entries: frame.entries.length };
}

async function waitForHttpLiveSessionReadiness(
  baseUrl: string,
  runId: string,
  timeoutMs: number
): Promise<{
  readonly liveRuntimeReady: true;
  readonly runtime: { readonly activeRuns: number; readonly busy: boolean; readonly runningRunIds: readonly string[] };
}> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/neon-live-session-readiness`);
    const snapshot = (await response.json()) as {
      readonly liveRuntimeReady?: unknown;
      readonly runtime?: {
        readonly activeRuns?: unknown;
        readonly busy?: unknown;
        readonly runningRunIds?: unknown;
      };
    };
    const runningRunIds = Array.isArray(snapshot.runtime?.runningRunIds)
      ? snapshot.runtime.runningRunIds.filter((id): id is string => typeof id === "string")
      : [];

    if (
      response.ok &&
      snapshot.liveRuntimeReady === true &&
      typeof snapshot.runtime?.activeRuns === "number" &&
      typeof snapshot.runtime.busy === "boolean" &&
      runningRunIds.includes(runId)
    ) {
      return {
        liveRuntimeReady: true,
        runtime: {
          activeRuns: snapshot.runtime.activeRuns,
          busy: snapshot.runtime.busy,
          runningRunIds
        }
      };
    }

    await sleepMs(250);
  }

  throw new Error("Timed out waiting for HTTP live-session readiness");
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface IOneShotSignal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createOneShotSignal<T>(): IOneShotSignal<T> {
  let settled = false;
  let resolveSignal: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveSignal = resolve;
  });

  if (!resolveSignal) {
    throw new Error("Expected signal resolver to be initialized");
  }
  const resolveReadySignal = resolveSignal;

  return {
    promise,
    resolve: (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveReadySignal(value);
    }
  };
}

function readPrivateNeonCanaryId(envKey: string, expected: string): string {
  const value = process.env[envKey]?.trim() || expected;

  if (value !== expected) {
    throw new Error(`Refusing private Discord live smoke outside the allowlisted target (${envKey})`);
  }

  return value;
}

function isReadyLike(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();

  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "ready";
}

function readDiscordMentionPolicyEnv(): "always" | "guild" | "never" {
  const raw = process.env["NEON_DISCORD_MENTION_POLICY"] ?? process.env["NEON_DISCORD_REQUIRE_MENTION"];

  if (!raw) {
    return "guild";
  }

  const normalized = raw.trim().toLowerCase();

  if (normalized === "always" || normalized === "guild" || normalized === "never") {
    return normalized;
  }

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return "always";
  }

  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return "never";
  }

  return "guild";
}

function readDiscordCanaryReplyModeEnv(): "reply" | "channel" {
  const normalized = (process.env["NEON_DISCORD_REPLY_MODE"] ?? "reply").trim().toLowerCase();

  return normalized === "channel" ? "channel" : "reply";
}

function readDiscordTapRunModeEnv(): "read-only" | "write" {
  const normalized = (process.env["NEON_DISCORD_TAP_RUN_MODE"] ?? "read-only").trim().toLowerCase();

  return normalized === "write" ? "write" : "read-only";
}

function readCodexApprovalPolicyEnv(): "never" | "on-request" | "on-failure" | "untrusted" {
  const normalized = (process.env["NEON_CODEX_APP_SERVER_APPROVAL_POLICY"] ?? "never").trim().toLowerCase();

  if (
    normalized === "never" ||
    normalized === "on-request" ||
    normalized === "on-failure" ||
    normalized === "untrusted"
  ) {
    return normalized;
  }

  return "never";
}

function readCodexSandboxEnv(): "read-only" | "workspace-write" | "danger-full-access" {
  const normalized = (process.env["NEON_CODEX_APP_SERVER_SANDBOX"] ?? "read-only").trim().toLowerCase();

  if (normalized === "read-only" || normalized === "workspace-write" || normalized === "danger-full-access") {
    return normalized;
  }

  return "read-only";
}

function readCodexAppServerRequestTimeoutMsEnv(): number {
  return readPositiveIntegerEnv("NEON_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS", 300_000);
}

function readCodexAppServerTurnCompletionTimeoutMsEnv(): number {
  return readPositiveIntegerEnv("NEON_CODEX_APP_SERVER_TURN_COMPLETION_TIMEOUT_MS", 600_000);
}

function readPositiveIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeIntegerEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface IRecordedAppServerRequest {
  readonly method: TCodexAppServerMethod;
  readonly params: TJsonValue | undefined;
}

interface IDelayedTurnCodexClient extends ICodexAppServerClient {
  readonly requests: readonly IRecordedAppServerRequest[];
  readonly interruptTurnIds: readonly string[];
}

function createDelayedTurnCodexClient(): IDelayedTurnCodexClient {
  const requests: IRecordedAppServerRequest[] = [];
  const interruptTurnIds: string[] = [];
  const handlers = new Set<TCodexAppServerNotificationHandler>();
  let completionTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let initialized = false;

  const emitTurnCompleted = (status: "completed" | "interrupted"): void => {
    const notification: ICodexAppServerNotification = {
      method: "turn/completed",
      params: {
        threadId: "thread-harness-smoke",
        turn: {
          id: "turn-harness-smoke",
          status
        }
      }
    };

    for (const handler of handlers) {
      void handler(notification);
    }
  };

  return {
    requests,
    interruptTurnIds,
    async initialize(): Promise<void> {
      initialized = true;
    },
    async request(method: TCodexAppServerMethod, params?: TJsonValue): Promise<TJsonValue | undefined> {
      if (closed) {
        throw new Error("Delayed turn Codex client is closed");
      }

      requests.push({ method, params });

      switch (method) {
        case "thread/start":
          return { thread: { id: "thread-harness-smoke" } };
        case "thread/resume":
          return { thread: { id: "thread-harness-smoke" } };
        case "turn/start":
          if (!initialized) {
            throw new Error("Delayed turn Codex client was not initialized");
          }
          completionTimer = setTimeout(() => {
            emitTurnCompleted("completed");
          }, 250);
          return { turn: { id: "turn-harness-smoke", status: "inProgress" } };
        case "turn/interrupt":
          interruptTurnIds.push(readTurnInterruptId(params));
          if (completionTimer) {
            clearTimeout(completionTimer);
            completionTimer = undefined;
          }
          queueMicrotask(() => {
            emitTurnCompleted("interrupted");
          });
          return { status: "ok" };
        case "thread/unsubscribe":
          return { status: "ok" };
        case "initialize":
          initialized = true;
          return { status: "ok" };
        default: {
          const exhaustive: never = method;
          return exhaustive;
        }
      }
    },
    subscribe(handler: TCodexAppServerNotificationHandler): () => void {
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
      };
    },
    async close(): Promise<void> {
      closed = true;
      if (completionTimer) {
        clearTimeout(completionTimer);
        completionTimer = undefined;
      }
      handlers.clear();
    }
  };
}

function readTurnInterruptId(params: TJsonValue | undefined): string {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const turnId = params["turnId"];
    if (typeof turnId === "string" && turnId.trim()) {
      return turnId;
    }
  }

  return "unknown";
}

function runBlockedReadinessReport(): string {
  return renderNeonBlockedRowReadinessReport(
    createNeonBlockedRowReadinessSnapshot({ env: process.env })
  );
}

async function runCanaryStabilityReport(): Promise<string> {
  return renderNeonCanaryStabilityReport(await readNeonCanaryStabilityEvidence(process.cwd()));
}

function runLiveSessionReadinessReport(): string {
  return renderNeonLiveSessionReadinessReport(
    createNeonLiveSessionReadinessSnapshot({ env: process.env })
  );
}

function runGatesPostureReport(): string {
  return renderNeonGatedSideEffectPostureReport(resolveNeonGatedSideEffectPosture(process.env));
}

function runDeliveryRetryPolicyReport(): string {
  return renderNeonDeliveryRetryScheduleReport(Date.now());
}

function runInboundMentionSmoke(): string {
  const skip = resolveNeonInboundMentionDecision({
    facts: { canDetectMention: true, wasMentioned: false },
    policy: {
      isGroup: true,
      requireMention: true,
      allowTextCommands: true,
      hasControlCommand: false,
      commandAuthorized: false
    }
  });
  const implicit = resolveNeonInboundMentionDecision({
    facts: { canDetectMention: true, wasMentioned: false, implicitMentionKinds: ["reply_to_bot"] },
    policy: {
      isGroup: true,
      requireMention: true,
      allowedImplicitMentionKinds: ["reply_to_bot"],
      allowTextCommands: true,
      hasControlCommand: false,
      commandAuthorized: false
    }
  });
  const bypass = resolveNeonInboundMentionDecision({
    facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
    policy: {
      isGroup: true,
      requireMention: true,
      allowTextCommands: true,
      hasControlCommand: true,
      commandAuthorized: true
    }
  });

  return [
    "### Require mention, none -> skip",
    renderNeonInboundMentionDecisionReport(skip),
    "",
    "### Implicit mention (reply-to-bot) -> no skip",
    renderNeonInboundMentionDecisionReport(implicit),
    "",
    "### Authorized control command -> bypass, no skip",
    renderNeonInboundMentionDecisionReport(bypass)
  ].join("\n");
}

function runInboundAllowlistSmoke(): string {
  const empty = resolveNeonAllowlistMatchSimple({ allowFrom: [], senderId: "user-1" });
  const wildcard = resolveNeonAllowlistMatchSimple({ allowFrom: ["*"], senderId: "user-1" });
  const byId = resolveNeonAllowlistMatchSimple({ allowFrom: ["User-7"], senderId: "user-7" });
  const nameOff = resolveNeonAllowlistMatchSimple({
    allowFrom: ["operator"],
    senderId: "user-7",
    senderName: "Operator"
  });
  const nameOn = resolveNeonAllowlistMatchSimple({
    allowFrom: ["operator"],
    senderId: "user-7",
    senderName: "Operator",
    allowNameMatching: true
  });

  return [
    "### Empty allowlist -> deny",
    `Allowed: ${empty.allowed} (${formatNeonAllowlistMatchMeta(empty)})`,
    "### Wildcard -> allow",
    `Allowed: ${wildcard.allowed} (${formatNeonAllowlistMatchMeta(wildcard)})`,
    "### Id match (case-insensitive) -> allow, leak-safe meta",
    `Allowed: ${byId.allowed} (${formatNeonAllowlistMatchMeta(byId)})`,
    "### Name matching off -> deny",
    `Allowed: ${nameOff.allowed} (${formatNeonAllowlistMatchMeta(nameOff)})`,
    "### Name matching on -> allow",
    `Allowed: ${nameOn.allowed} (${formatNeonAllowlistMatchMeta(nameOn)})`
  ].join("\n");
}

function runInboundAllowFromSmoke(): string {
  const dmMerged = mergeNeonDmAllowFromSources({
    allowFrom: ["owner"],
    storeAllowFrom: ["guest"],
    dmPolicy: "closed"
  });
  const dmAllowlist = mergeNeonDmAllowFromSources({
    allowFrom: ["owner"],
    storeAllowFrom: ["guest"],
    dmPolicy: "allowlist"
  });
  const groupExplicit = resolveNeonGroupAllowFromSources({
    allowFrom: ["owner"],
    groupAllowFrom: ["mod"]
  });
  const groupClosed = resolveNeonGroupAllowFromSources({
    allowFrom: ["owner"],
    fallbackToAllowFrom: false
  });

  return [
    `### DM merge (closed policy keeps store): [${dmMerged.join(", ")}]`,
    `### DM merge (allowlist policy drops store): [${dmAllowlist.join(", ")}]`,
    `### Group explicit wins: [${groupExplicit.join(", ")}]`,
    `### Group closed (no fallback): [${groupClosed.join(", ")}]`,
    renderNeonAllowFromPolicyReport({
      label: "Empty allow-from, default-open",
      allow: compileNeonAllowFrom([]),
      senderId: "user-7",
      allowWhenEmpty: true
    }),
    renderNeonAllowFromPolicyReport({
      label: "Scoped allow-from, sender on list",
      allow: compileNeonAllowFrom(["user-7"]),
      senderId: "user-7",
      allowWhenEmpty: false
    }),
    renderNeonAllowFromPolicyReport({
      label: "Scoped allow-from, sender off list",
      allow: compileNeonAllowFrom(["user-7"]),
      senderId: "user-9",
      allowWhenEmpty: false
    })
  ].join("\n");
}

async function runTypingStartGuardSmoke(): Promise<string> {
  // In-process guard only; the start thunk is a no-op (or a deliberate throw) —
  // nothing is actually sent, matching the shadow contract.
  const sealedGuard = createNeonTypingStartGuard({ isSealed: () => true });
  const sealed = await sealedGuard.run(() => {});

  const liveGuard = createNeonTypingStartGuard({ isSealed: () => false, maxConsecutiveFailures: 2 });
  const started = await liveGuard.run(() => {});
  const failOnce = await liveGuard.run(() => {
    throw new Error("typing endpoint down");
  });
  const tripped = await liveGuard.run(() => {
    throw new Error("typing endpoint down");
  });
  const afterTrip = await liveGuard.run(() => {});

  return renderNeonTypingStartGuardReport([
    { label: "Sealed -> skip", outcome: sealed },
    { label: "Healthy -> start", outcome: started },
    { label: "First failure -> failed", outcome: failOnce },
    { label: "Second failure -> tripped", outcome: tripped },
    { label: "After trip -> skip", outcome: afterTrip }
  ]);
}

function runInboundAccessSmoke(): string {
  const opsGroup: Record<string, TNeonAccessGroup> = {
    ops: { type: "message.senders", members: { discord: ["chaty"] } }
  };

  const allowedByGroup = resolveNeonInboundAccessDecision({
    channel: "discord",
    isGroup: true,
    senderId: "chaty",
    allowFrom: ["accessGroup:ops"],
    accessGroups: opsGroup,
    hasControlCommand: false,
    requireMention: false,
    canDetectMention: true,
    wasMentioned: true
  });

  const blockedSender = resolveNeonInboundAccessDecision({
    channel: "discord",
    isGroup: true,
    senderId: "stranger",
    allowFrom: ["operator"],
    hasControlCommand: false,
    requireMention: false,
    canDetectMention: true,
    wasMentioned: true
  });

  const dmPairing = resolveNeonInboundAccessDecision({
    channel: "discord",
    isGroup: false,
    senderId: "stranger",
    allowFrom: ["operator"],
    dmPolicy: "pairing",
    hasControlCommand: false,
    requireMention: false,
    canDetectMention: true,
    wasMentioned: false
  });

  const unauthorizedCommand = resolveNeonInboundAccessDecision({
    channel: "discord",
    isGroup: true,
    senderId: "stranger",
    allowTextCommands: true,
    hasControlCommand: true,
    requireMention: false,
    canDetectMention: true,
    wasMentioned: true
  });

  return [
    "### Allowed via access group (sender folded into effective allow-from)",
    renderNeonInboundAccessDecisionReport(allowedByGroup),
    "",
    "### Blocked: sender not in allow-from",
    renderNeonInboundAccessDecisionReport(blockedSender),
    "",
    "### DM pairing required (unknown sender under pairing policy)",
    renderNeonInboundAccessDecisionReport(dmPairing),
    "",
    "### Blocked: unauthorized control command (text commands on)",
    renderNeonInboundAccessDecisionReport(unauthorizedCommand)
  ].join("\n");
}

function runInboundDebounceSmoke(): string {
  const text = shouldDebounceNeonTextInbound({ text: "hey neo", isControlCommand: false });
  const command = shouldDebounceNeonTextInbound({ text: "/status", isControlCommand: true });
  const media = shouldDebounceNeonTextInbound({ text: "look", isControlCommand: false, hasMedia: true });
  const window = resolveNeonInboundDebounceMs({ baseDebounceMs: 100, byChannelMs: 250 });

  return [
    "### Ordinary text (debounced)",
    renderNeonInboundDebounceReport({ decision: text, debounceMs: window }),
    "",
    "### Control command (not debounced)",
    renderNeonInboundDebounceReport({ decision: command, debounceMs: window }),
    "",
    "### Media message (not debounced)",
    renderNeonInboundDebounceReport({ decision: media, debounceMs: window })
  ].join("\n");
}

function runSlashCommandGateSmoke(): string {
  const authorized = resolveNeonControlCommandGate({
    useAccessGroups: true,
    authorizers: [{ configured: true, allowed: true }],
    allowTextCommands: true,
    hasControlCommand: true
  });
  const blocked = resolveNeonControlCommandGate({
    useAccessGroups: true,
    authorizers: [{ configured: true, allowed: false }],
    allowTextCommands: true,
    hasControlCommand: true
  });
  const accessGroupsOff = resolveNeonControlCommandGate({
    useAccessGroups: false,
    authorizers: [{ configured: true, allowed: false }],
    allowTextCommands: true,
    hasControlCommand: true,
    modeWhenAccessGroupsOff: "allow"
  });

  return [
    "### Authorized user (access groups on)",
    renderNeonControlCommandGateReport(authorized),
    "",
    "### Unauthorized control command (blocked)",
    renderNeonControlCommandGateReport(blocked),
    "",
    "### Access groups off, mode=allow",
    renderNeonControlCommandGateReport(accessGroupsOff)
  ].join("\n");
}

function runDeliveryReconcileSmoke(): string {
  const now = Date.now();
  const permanent = reconcileNeonDeliveryRecovery({
    error: "chat not found",
    retryCount: 0,
    enqueuedAtMs: now,
    now
  });
  const transient = reconcileNeonDeliveryRecovery({
    error: "socket hang up",
    retryCount: 0,
    enqueuedAtMs: now,
    now
  });
  const exhausted = reconcileNeonDeliveryRecovery({
    retryCount: 5,
    enqueuedAtMs: now,
    now
  });

  return [
    "### Permanent error (give up, no retry)",
    renderNeonDeliveryReconcileReport(permanent),
    "",
    "### Transient error (backoff retry)",
    renderNeonDeliveryReconcileReport(transient),
    "",
    "### Retries exhausted",
    renderNeonDeliveryReconcileReport(exhausted)
  ].join("\n");
}

async function runDeliveryDryRunSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-smoke-"));

  try {
    const shadow = await runNeonGatewayShadow(
      {
        message: {
          channel: "discord",
          accountId: "local",
          guildId: "900000000000000001",
          channelId: "900000000000000005",
          threadId: "local-shadow-thread",
          messageId: "local-discord-delivery-smoke",
          userId: "operator",
          userDisplayName: "Operator",
          agentId: "chaty",
          workspaceRoot: projectRoot,
          mode: "read-only",
          content: "Local Neon delivery dry-run smoke",
          createdAt: "2026-05-31T20:00:00.000Z"
        },
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Delivery dry-run smoke"
        }
      },
      {
        harness: createDryRunHarness(),
        now: () => new Date("2026-05-31T20:00:01.000Z"),
        createRunId: () => "neon-delivery-shadow-smoke"
      }
    );

    await writeNeonGatewayRun(projectRoot, shadow.run);
    const candidate = await enqueueNeonDeliveryDryRunCandidate(projectRoot, shadow.run, {
      now: () => new Date("2026-05-31T20:00:02.000Z")
    });
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-delivery/queue`);
      const snapshot = (await response.json()) as INeonDeliveryQueueSnapshot;

      if (
        !response.ok ||
        snapshot.totals.queuedDryRuns !== 1 ||
        snapshot.candidates[0]?.safety.outboundSent !== false
      ) {
        throw new Error(`Delivery dry-run smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Delivery dry-run: ok",
        `URL: ${handle.url}/api/neon-delivery/queue`,
        `Candidate: ${candidate.id}`,
        `State: ${candidate.state}`,
        `Outbound sent: ${candidate.safety.outboundSent}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runDeliveryDryRunSendSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-send-smoke-"));

  try {
    const shadow = await runNeonGatewayShadow(
      {
        message: {
          channel: "discord",
          accountId: "local",
          guildId: "900000000000000001",
          channelId: "900000000000000005",
          threadId: "local-shadow-thread",
          messageId: "local-discord-delivery-send-smoke",
          userId: "operator",
          userDisplayName: "Operator",
          agentId: "chaty",
          workspaceRoot: projectRoot,
          mode: "read-only",
          content: "Local Neon delivery dry-run send smoke",
          createdAt: "2026-05-31T20:00:00.000Z"
        },
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Delivery dry-run send smoke"
        }
      },
      {
        harness: createDryRunHarness(),
        now: () => new Date("2026-05-31T20:00:01.000Z"),
        createRunId: () => "neon-delivery-send-shadow-smoke"
      }
    );

    const candidate = createNeonDeliveryDryRunCandidate(shadow.run, {
      now: () => new Date("2026-05-31T20:00:02.000Z")
    });
    const sender = createNeonDryRunOutboundSender({
      now: () => new Date("2026-05-31T20:00:03.000Z")
    });
    const result = await deliverNeonDeliveryDryRunCandidate(sender, candidate);

    if (result.outboundSent !== false || result.reason !== "dry-run-no-send") {
      throw new Error("Delivery dry-run send smoke produced a non-dry-run result");
    }

    return [
      "Neonika Delivery dry-run send: ok",
      `Candidate: ${candidate.id}`,
      `Target: ${result.target.channel}/${result.target.channelId}`,
      `Reason: ${result.reason}`,
      `Cutover stage: ${result.cutoverStage}`,
      `Body preview: ${result.bodyPreview || "empty"}`,
      `Outbound sent: ${result.outboundSent}`
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runCanaryOutboundSmoke(): Promise<string> {
  // Default no-send proof: no transport, no flags, empty env. The gated canary
  // sender must keep outboundSent:false with reason canary-gate-closed. We pass
  // an empty env explicitly so the smoke does not depend on the host process
  // env and never accidentally opens the gate.
  const sender = createNeonCanaryOutboundSender({
    env: {},
    now: () => new Date("2026-05-31T20:00:04.000Z")
  });
  const result = await sender.sendText(
    {
      channel: "discord",
      accountId: "local",
      channelId: "900000000000000005"
    },
    "Local Neon canary outbound smoke without flags or transport"
  );

  if (result.outboundSent !== false || result.reason !== "canary-gate-closed") {
    throw new Error("Canary outbound smoke produced a non-suppressed result");
  }

  return [
    "Neonika Canary outbound: ok",
    `Target: ${result.target.channel}/${result.target.channelId}`,
    `Reason: ${result.reason}`,
    `Cutover stage: ${result.cutoverStage}`,
    `Body preview: ${result.bodyPreview || "empty"}`,
    `Outbound sent: ${result.outboundSent}`
  ].join("\n");
}

async function runReactionDryRunSmoke(): Promise<string> {
  // Default no-send proof for the reaction seam: no transport, no flags, empty
  // env. The gated canary reaction sender must keep reactionSent:false with
  // reason canary-gate-closed. Empty env is passed explicitly so the smoke never
  // depends on the host process env and never accidentally opens the gate.
  const sender = createNeonCanaryReactionSender({
    env: {},
    now: () => new Date("2026-06-03T01:00:00.000Z")
  });
  const result = await sender.setReaction(
    {
      channel: "discord",
      accountId: "local",
      channelId: "900000000000000005"
    },
    "900000000000000006",
    "✅"
  );

  if (result.reactionSent !== false || result.reason !== "canary-gate-closed") {
    throw new Error("Reaction dry-run smoke produced a non-suppressed result");
  }

  return [
    "Neon reaction dry-run: ok",
    `Target: ${result.target.channel}/${result.target.channelId}`,
    `Message: ${result.messageId}`,
    `Emoji: ${result.emoji}`,
    `Reason: ${result.reason}`,
    `Cutover stage: ${result.cutoverStage}`,
    `Reaction sent: ${result.reactionSent}`
  ].join("\n");
}

async function runStatusReactionSmoke(): Promise<string> {
  // No-send proof for the status-reaction policy: scope gate -> debounce
  // decision -> dry-run reaction sender. The dry-run sender guarantees
  // reactionSent:false; nothing is sent to Discord. Deterministic clock keeps
  // the debounce decisions stable.
  const sender = createNeonDryRunReactionSender({
    now: () => new Date("2026-06-03T01:00:00.000Z")
  });
  const target = {
    channel: "discord" as const,
    accountId: "local",
    channelId: "900000000000000005"
  };
  const messageId = "900000000000000006";

  const gateOpen = shouldEmitNeonStatusReaction({
    channelSupportsReactions: true,
    statusReactionsEnabled: true
  });

  const thinking = planNeonStatusReactionEmit({
    nextState: "thinking",
    currentEmoji: "",
    finished: false,
    lastIntermediateEmitAt: null,
    now: 0
  });
  const toolHeld = planNeonStatusReactionEmit({
    nextState: "tool",
    currentEmoji: thinking.emoji,
    finished: false,
    lastIntermediateEmitAt: 0,
    now: 300
  });
  const done = planNeonStatusReactionEmit({
    nextState: "done",
    currentEmoji: thinking.emoji,
    finished: false,
    lastIntermediateEmitAt: 0,
    now: 300
  });

  const sent = await applyNeonStatusReaction({ sender, target, messageId, plan: done });
  const held = await applyNeonStatusReaction({ sender, target, messageId, plan: toolHeld });

  if (!gateOpen) {
    throw new Error("Status-reaction scope gate unexpectedly closed");
  }
  if (thinking.action !== "emit") {
    throw new Error("First status transition should emit");
  }
  if (toolHeld.action !== "hold") {
    throw new Error("Debounced status transition should hold");
  }
  if (done.action !== "emit") {
    throw new Error("Terminal status transition should emit");
  }
  if (held !== null) {
    throw new Error("Held status plan must not send");
  }
  if (sent === null || sent.reactionSent !== false) {
    throw new Error("Emit plan must route as no-send via the dry-run sender");
  }

  return [
    "Neon status reaction: ok",
    `Scope gate: ${gateOpen ? "open" : "closed"}`,
    `thinking -> ${thinking.action} (${thinking.emoji})`,
    `tool     -> ${toolHeld.action} (hold ${toolHeld.holdRemainingMs ?? 0}ms)`,
    `done     -> ${done.action} (${done.emoji})`,
    `Reaction sent: ${sent.reactionSent}`
  ].join("\n");
}

async function runMessageEditDryRunSmoke(): Promise<string> {
  // No-send proof for the message edit/delete seam: dry-run sender, no transport.
  // Both editSent and deleteSent must stay false; nothing reaches Discord.
  const sender = createNeonDryRunMessageEditSender({
    now: () => new Date("2026-06-03T01:00:00.000Z")
  });
  const target = {
    channel: "discord" as const,
    accountId: "local",
    channelId: "900000000000000005"
  };
  const messageId = "900000000000000006";

  const edited = await sender.editMessage(target, messageId, "Edited Neon shadow message");
  const deleted = await sender.deleteMessage(target, messageId);

  if (edited.editSent !== false || edited.reason !== "dry-run-no-send") {
    throw new Error("Message edit dry-run produced a non-suppressed result");
  }
  if (deleted.deleteSent !== false || deleted.reason !== "dry-run-no-send") {
    throw new Error("Message delete dry-run produced a non-suppressed result");
  }

  return [
    "Neon message edit/delete dry-run: ok",
    `Target: ${edited.target.channel}/${edited.target.channelId}`,
    `Message: ${messageId}`,
    `Edit body preview: ${edited.bodyPreview || "empty"}`,
    `Edit sent: ${edited.editSent}`,
    `Delete sent: ${deleted.deleteSent}`,
    `Cutover stage: ${edited.cutoverStage}`
  ].join("\n");
}

async function runSecretsAuditSmoke(): Promise<string> {
  // Read-only demo of the secrets audit against a FIXTURE env (not process.env),
  // so the smoke is deterministic and never touches real credentials. No `op`
  // resolve, no secret values in the output. Demonstrates all three outcomes:
  // a resolvable op:// ref (clean), a plaintext value (PLAINTEXT), and an
  // incomplete op:// ref (REF_UNRESOLVED).
  const fixtureEnv = {
    NEON_DISCORD_BOT_TOKEN: "op://Automation/Neonika Discord/token",
    NEON_GATEWAY_HTTP_MUTATION_TOKEN: "plaintext-example-not-a-real-secret",
    NEON_SECRET: "op://incomplete"
  };
  const report = runNeonSecretsAudit({ fields: collectNeonSecretAuditFields(fixtureEnv) });

  if (report.exitCode !== 2) {
    throw new Error("Secrets audit smoke expected exit code 2 (unresolved ref present)");
  }
  if (!report.findings.some((finding) => finding.code === "PLAINTEXT")) {
    throw new Error("Secrets audit smoke expected a PLAINTEXT finding");
  }

  return renderNeonSecretsAuditReport(report);
}

async function runSecurityAuditSmoke(): Promise<string> {
  // Read-only demo against a FIXTURE env (not process.env) -> deterministic.
  // canary stage without approval is a critical footgun (exit 2); the bare
  // mutation-auth + ws-origin hints surface as info. No side effects.
  const fixtureEnv = { NEON_CUTOVER_STAGE: "canary" } as NodeJS.ProcessEnv;
  const report = runNeonSecurityAudit(fixtureEnv);

  if (report.exitCode !== 2) {
    throw new Error("Security audit smoke expected exit code 2 (canary without approval)");
  }
  if (!report.findings.some((finding) => finding.axis === "cutover-stage")) {
    throw new Error("Security audit smoke expected a cutover-stage finding");
  }

  return renderNeonSecurityAuditReport(report);
}

function resolveCanarySmokeChannelId(
  pre: ReturnType<typeof evaluateNeonCanaryLivePreconditions>,
  allowlist: ReturnType<typeof resolveNeonCanaryChannelAllowlist>
): string {
  return pre.channelId ?? [...allowlist.channels][0] ?? "<unset>";
}

async function runCanaryOutboundLiveSmoke(): Promise<string> {
  // DP-1 + DP-2: a real Discord canary send behind the full env
  // gate. Reads the channel id and bot token ONLY from the environment; the
  // token value is never printed, returned, or persisted (only its presence is
  // reported). If any precondition is missing, we run the suppressed path with
  // NO transport so the default stays no-send.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const message = "Neonika canary live smoke — DP-1/DP-2, allowlisted channel.";

  // Leak-safe precondition report: booleans + channel id only, never the token.
  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  if (!pre.ready) {
    const sender = createNeonCanaryOutboundSender({ env, channelAllowlist: allowlist });
    const result = await sender.sendText(
      { channel: "discord", accountId: "local", channelId },
      message
    );
    const reason = result.outboundSent ? "sent" : result.reason;

    return [
      "Neonika Canary live outbound: SUPPRESSED (preconditions not met)",
      ...preconditionLines,
      `Target: ${result.target.channel}/${result.target.channelId}`,
      `Reason: ${reason}`,
      `Outbound sent: ${result.outboundSent}`,
      `Body preview: ${result.bodyPreview || "empty"}`
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordOutboundTransport({ token });
  try {
    const sender = createNeonCanaryOutboundSender({
      env,
      transport,
      channelAllowlist: allowlist
    });
    const result = await sender.sendText(
      { channel: "discord", accountId: "local", channelId },
      message
    );

    if (!result.outboundSent) {
      return [
        "Neonika Canary live outbound: gate closed at send time",
        ...preconditionLines,
        `Reason: ${result.reason}`,
        `Outbound sent: ${result.outboundSent}`
      ].join("\n");
    }
    // result is now narrowed to the sent variant (outboundSent: true).

    return [
      "Neonika Canary live outbound: SENT",
      ...preconditionLines,
      `Target: ${result.target.channel}/${result.target.channelId}`,
      `Message id: ${result.messageId}`,
      `Outbound sent: ${result.outboundSent}`,
      `Body preview: ${result.bodyPreview || "empty"}`
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runCanaryEmbedLiveSmoke(): Promise<string> {
  // Embed sibling of the canary live outbound smoke. The embed payload is always
  // validated (pure, no side effect); the SEND only happens behind the full canary
  // gate. Token read from env only, never printed or returned.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const embed: INeonDiscordEmbed = {
    title: "Neonika canary embed smoke",
    description: "Allowlisted channel, gated embed send.",
    color: 0x2eab73,
    fields: [{ name: "stage", value: "canary", inline: true }]
  };
  const built = buildNeonDiscordEmbedPayload([embed]);

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  if (!built.ok) {
    return [
      "Neonika Canary embed: INVALID PAYLOAD (refusing to send)",
      ...preconditionLines,
      `Errors: ${built.errors.join("; ")}`
    ].join("\n");
  }
  const payloadLine = `Embed payload: valid (1 embed, title="${embed.title ?? ""}")`;

  if (!pre.ready) {
    return [
      "Neonika Canary embed: SUPPRESSED (preconditions not met, no transport constructed)",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      "Outbound sent: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordOutboundTransport({ token });
  try {
    const result = await transport.postEmbed(
      { channel: "discord", accountId: "local", channelId },
      [embed]
    );
    return [
      "Neonika Canary embed: SENT",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      `Message id: ${result.messageId}`,
      "Outbound sent: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runComponentsCanaryLiveSmoke(): Promise<string> {
  // Components sibling of the canary live outbound smoke. The component payload is
  // always validated (pure, no side effect); the SEND only happens behind the full
  // canary gate. Token read from env only, never printed or returned.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const content = "Neonika canary component smoke — gated approve/reject prompt.";
  const rows: readonly TNeonDiscordActionRow[] = [
    {
      buttons: [
        { label: "Approve", style: "success", customId: "neon-canary-approve" },
        { label: "Reject", style: "danger", customId: "neon-canary-reject" }
      ]
    }
  ];
  const built = buildNeonDiscordComponentPayload(rows);

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  if (!built.ok) {
    return [
      "Neonika Canary components: INVALID PAYLOAD (refusing to send)",
      ...preconditionLines,
      `Errors: ${built.errors.join("; ")}`
    ].join("\n");
  }
  const payloadLine = `Component payload: valid (${built.components.length} action row, 2 buttons)`;

  if (!pre.ready) {
    return [
      "Neonika Canary components: SUPPRESSED (preconditions not met, no transport constructed)",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      "Outbound sent: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordOutboundTransport({ token });
  try {
    const result = await transport.postComponents(
      { channel: "discord", accountId: "local", channelId },
      content,
      rows
    );
    return [
      "Neonika Canary components: SENT",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      `Message id: ${result.messageId}`,
      "Outbound sent: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runMediaCanaryLiveSmoke(): Promise<string> {
  // Media sibling of the canary live outbound smoke. The attachment payload is
  // always validated (pure, no side effect); the upload only happens behind the
  // full canary gate. Token read from env only, never printed or returned.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const content = "Neonika canary media smoke — gated inline attachment.";
  const attachments: readonly TNeonDiscordMediaAttachment[] = [
    {
      name: "neon-canary-smoke.txt",
      data: new TextEncoder().encode("neonika canary media smoke\n"),
      contentType: "text/plain"
    }
  ];
  const built = buildNeonDiscordMediaPayload(attachments);

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  if (!built.ok) {
    return [
      "Neonika Canary media: INVALID PAYLOAD (refusing to upload)",
      ...preconditionLines,
      `Errors: ${built.errors.join("; ")}`
    ].join("\n");
  }
  const payloadLine = `Media payload: valid (${built.attachments.length} inline attachment)`;

  if (!pre.ready) {
    return [
      "Neonika Canary media: SUPPRESSED (preconditions not met, no transport constructed)",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      "Outbound sent: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordOutboundTransport({ token });
  try {
    const result = await transport.postMedia(
      { channel: "discord", accountId: "local", channelId },
      content,
      attachments
    );
    return [
      "Neonika Canary media: SENT",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      `Message id: ${result.messageId}`,
      "Outbound sent: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

function runTikTokDiscordPlanSmoke(): string {
  return renderNeonTikTokDiscordVideoWorkflow(
    createNeonDiscordTikTokVideoWorkflow({
      attachment: {
        id: "discord-video-smoke",
        name: "neon-launch.mp4",
        url: "https://cdn.discordapp.com/attachments/channel/message/neon-launch.mp4",
        contentType: "video/mp4",
        sizeBytes: 8_000_000,
        kind: "video"
      },
      caption: "Neon launch clip #neon",
      mode: "direct-post",
      privacyLevel: "SELF_ONLY",
      explicitConsent: false,
      edit: {
        trimStartSeconds: 1,
        trimEndSeconds: 29,
        targetAspectRatio: "9:16",
        burnCaptions: true
      },
      env: process.env
    })
  );
}

async function runPresenceCanaryLiveSmoke(): Promise<string> {
  // Presence sibling of the canary live smoke. Presence is client-global (no
  // channel), so it has its own transport. The payload is always validated; the
  // live setPresence only happens behind the full canary gate. Token env-only.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const presence: INeonDiscordPresence = {
    status: "idle",
    activity: { type: "watching", name: "the canary channel" }
  };
  const built = buildNeonDiscordPresencePayload(presence);

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  if (!built.ok) {
    return [
      "Neonika Canary presence: INVALID PAYLOAD (refusing to set)",
      ...preconditionLines,
      `Errors: ${built.errors.join("; ")}`
    ].join("\n");
  }
  const payloadLine = `Presence payload: valid (status=${presence.status}, activity=watching "${presence.activity?.name ?? ""}")`;

  if (!pre.ready) {
    return [
      "Neonika Canary presence: SUPPRESSED (preconditions not met, no transport constructed)",
      ...preconditionLines,
      payloadLine,
      "Presence set: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordPresenceTransport({ token });
  try {
    await transport.setPresence(presence);
    return [
      "Neonika Canary presence: SET",
      ...preconditionLines,
      payloadLine,
      "Presence set: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runSlashDeployCanaryLiveSmoke(): Promise<string> {
  // Slash-command deploy sibling of the canary live smoke. Two gates apply: the
  // pure registration plan (guild-scoped only, global blocked) AND the full
  // canary gate. The command set is always validated; the live guild bulk
  // overwrite only happens when both are satisfied. Token read from env only.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const guildId = (env["NEON_CANARY_GUILD_ID"] ?? "").trim();
  const plan = resolveNeonSlashCommandRegistrationPlan({
    requestedScope: "guild",
    guildIds: guildId.length > 0 ? [guildId] : []
  });
  const commands = createNeonDiscordOperatorSlashCommands();
  const built = buildNeonSlashCommandPayload(commands);

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`,
    `  planScope=${plan.scope}`,
    `  planBlocked=${plan.blocked}`
  ];

  if (!built.ok) {
    return [
      "Neonika Canary slash-deploy: INVALID PAYLOAD (refusing to deploy)",
      ...preconditionLines,
      `Errors: ${built.errors.join("; ")}`
    ].join("\n");
  }
  const payloadLine = `Command payload: valid (${built.commands.length} commands, guild=${guildId || "<unset>"})`;

  // Suppressed unless BOTH the canary gate is open AND the plan permits a guild deploy.
  if (!pre.ready || plan.blocked) {
    return [
      "Neonika Canary slash-deploy: SUPPRESSED (gate sealed or plan blocked, no transport constructed)",
      ...preconditionLines,
      payloadLine,
      `Plan reason: ${plan.reason}`,
      "Commands deployed: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordSlashDeployTransport({ token });
  try {
    const result = await transport.deployGuildCommands(guildId, commands);
    return [
      "Neonika Canary slash-deploy: DEPLOYED",
      ...preconditionLines,
      payloadLine,
      `Commands deployed: ${result.deployedCount}`
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runDeliveryRetryClassifySmoke(): Promise<string> {
  // Pure demonstration of the durable-delivery classification: no env, no gate,
  // no send. A fixed clock keeps the schedule deterministic. Exercises the three
  // representative outcomes — rate-limited (retry-after wins), transient 5xx
  // (backoff), and permanent 4xx (give up).
  const now = 1_000_000;
  const cases: { readonly label: string; readonly error: unknown; readonly retryCount: number }[] = [
    { label: "429 rate limit (retry-after 4200ms)", error: { status: 429, retryAfter: 4200 }, retryCount: 1 },
    { label: "503 transient", error: { status: 503 }, retryCount: 1 },
    { label: "403 permanent", error: { status: 403 }, retryCount: 0 }
  ];

  const lines = ["Neon durable-delivery retry classification (pure, no send):"];
  for (const testCase of cases) {
    const plan = planNeonDeliveryRetryAfterSendError({
      error: testCase.error,
      retry: { retryCount: testCase.retryCount, enqueuedAtMs: now - 30_000, lastAttemptAtMs: now - 30_000, now }
    });
    lines.push(
      `  ${testCase.label}: action=${plan.action} retryable=${plan.classification.retryable} ` +
        `waitMs=${plan.waitMs} (${plan.reason})`
    );
  }
  lines.push("Outbound sent: false (classification only)");
  return lines.join("\n");
}

async function runStickersPollCanaryLiveSmoke(): Promise<string> {
  // Stickers + poll sibling of the canary live smoke. Both payloads are always
  // validated (pure); the SEND only happens behind the full canary gate. Token
  // read from env only, never printed.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const stickerIds = ["112233445566778899"];
  const poll: INeonDiscordPoll = {
    question: "Ship the canary?",
    answers: [{ text: "Yes" }, { text: "Not yet" }],
    durationHours: 24,
    allowMultiselect: false
  };
  const stickerBuilt = buildNeonDiscordStickerPayload(stickerIds);
  const pollBuilt = buildNeonDiscordPollPayload(poll);

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  const payloadLine =
    `Payloads: stickers=${stickerBuilt.ok ? "valid" : "INVALID"} ` +
    `poll=${pollBuilt.ok ? "valid" : "INVALID"} (${poll.answers.length} answers)`;

  if (!stickerBuilt.ok || !pollBuilt.ok) {
    const errors = [
      ...(stickerBuilt.ok ? [] : stickerBuilt.errors),
      ...(pollBuilt.ok ? [] : pollBuilt.errors)
    ];
    return ["Neonika Canary stickers/poll: INVALID PAYLOAD", ...preconditionLines, `Errors: ${errors.join("; ")}`].join("\n");
  }

  if (!pre.ready) {
    return [
      "Neonika Canary stickers/poll: SUPPRESSED (preconditions not met, no transport constructed)",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      "Outbound sent: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordOutboundTransport({ token });
  try {
    const target = { channel: "discord" as const, accountId: "local", channelId };
    const pollResult = await transport.postPoll(target, poll);
    return [
      "Neonika Canary stickers/poll: SENT (poll)",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      payloadLine,
      `Poll message id: ${pollResult.messageId}`,
      "Outbound sent: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runWebhookCanaryLiveSmoke(): Promise<string> {
  // Webhook sibling of the canary live smoke, with its OWN identity gate. The
  // payload is always validated; a real proxy-identity send only happens when the
  // webhook url + enable flag + canary stage/approval all hold. URL/token env-only.
  const env = process.env;
  const pre = evaluateNeonWebhookLivePreconditions(env);
  const payload: INeonWebhookPayload = {
    content: "Neonika canary webhook smoke — gated proxy identity.",
    username: "Neonika Canary"
  };
  const built = buildNeonWebhookPayload(payload);

  const preconditionLines = [
    `Preconditions:`,
    `  webhookUrlPresent=${pre.webhookUrlPresent}`,
    `  webhookEnabled=${pre.webhookEnabled}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  ready=${pre.ready}`
  ];

  if (!built.ok) {
    return [
      "Neonika Canary webhook: INVALID PAYLOAD (refusing to send)",
      ...preconditionLines,
      `Errors: ${built.errors.join("; ")}`
    ].join("\n");
  }
  const payloadLine = `Webhook payload: valid (username="${payload.username ?? ""}", proxy identity)`;

  if (!pre.ready) {
    return [
      "Neonika Canary webhook: SUPPRESSED (identity gate sealed, no client constructed)",
      ...preconditionLines,
      payloadLine,
      "Webhook sent: false"
    ].join("\n");
  }

  const webhookUrl = (env["NEON_DISCORD_WEBHOOK_URL"] ?? "").trim();
  const transport = createNeonDiscordWebhookTransport({ webhookUrl });
  try {
    const result = await transport.send(payload);
    return [
      "Neonika Canary webhook: SENT",
      ...preconditionLines,
      payloadLine,
      `Message id: ${result.messageId}`,
      "Webhook sent: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runAutoReplyDispatchSmoke(): Promise<string> {
  // Drives the real auto-reply dispatcher over representative inbound envelopes.
  // No env, no gate, no send: every path stays outboundSent:false. A fixed clock
  // keeps the report deterministic.
  const now = () => new Date("2026-06-03T12:00:00.000Z");
  const policy: INeonDiscordIngressPolicy = {
    agentId: "neon-canary",
    workspaceRoot: "/tmp/neon-canary",
    mode: "read-only",
    botUserId: "bot-1",
    mentionPolicy: "always"
  };
  const autoReplyPolicy: INeonAutoReplyPolicy = { replyWhenMentioned: true };

  const baseEnvelope = (overrides: Partial<INeonDiscordMessageEnvelope> = {}): INeonDiscordMessageEnvelope => ({
    accountId: "acct-1",
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "msg-1",
    author: { id: "user-1", username: "alice" },
    content: "hey <@bot-1> can you help?",
    createdAt: "2026-06-03T11:59:59.000Z",
    mentionedUserIds: ["bot-1"],
    ...overrides
  });

  const replayGuard = createNeonDiscordInboundReplayGuard();

  // 1. Accepted + dispatched (mentioned, real reply text).
  const dispatched = await dispatchNeonAutoReply({
    envelope: baseEnvelope(),
    ingressPolicy: policy,
    autoReplyPolicy,
    payload: { text: "Sure — here is the answer.", ackReaction: "👀" },
    replayGuard,
    now
  });

  // 2. Duplicate inbound (same message id claimed again).
  const duplicate = await dispatchNeonAutoReply({
    envelope: baseEnvelope(),
    ingressPolicy: policy,
    autoReplyPolicy,
    payload: { text: "Sure — here is the answer." },
    replayGuard,
    now
  });

  // 3. Not mentioned -> auto-reply policy skip. ingress mentionPolicy "never"
  // admits the message (access layer); the auto-reply layer skips the reply.
  const notMentioned = await dispatchNeonAutoReply({
    envelope: baseEnvelope({ messageId: "msg-2", content: "just chatting", mentionedUserIds: [] }),
    ingressPolicy: { ...policy, mentionPolicy: "never" },
    autoReplyPolicy,
    payload: { text: "unsolicited" },
    now
  });

  // 4. Ingress drop (bot author).
  const dropped = await dispatchNeonAutoReply({
    envelope: baseEnvelope({
      messageId: "msg-3",
      author: { id: "bot-2", username: "otherbot", bot: true }
    }),
    ingressPolicy: policy,
    autoReplyPolicy,
    payload: { text: "should never plan" },
    now
  });

  return [
    "=== accepted + dispatched ===",
    renderNeonAutoReplyDispatchReport(dispatched),
    "",
    `=== duplicate inbound === state=${duplicate.state} reason=${duplicate.reason}`,
    `=== not mentioned === state=${notMentioned.state} reason=${notMentioned.reason}`,
    `=== ingress drop (bot) === state=${dropped.state} reason=${dropped.reason}`,
    "",
    `Shadow invariant: all outboundSent=false (dispatched=${dispatched.safety.outboundSent}, ` +
      `duplicate=${duplicate.safety.outboundSent}, notMentioned=${notMentioned.safety.outboundSent}, ` +
      `dropped=${dropped.safety.outboundSent})`
  ].join("\n");
}

async function runReactionCanaryLiveSmoke(): Promise<string> {
  // Reaction sibling of the canary live outbound smoke. Default suppressed with
  // NO transport; a live message.react only happens behind the full canary gate
  // AND with an explicit message id to react to. Token read from env only.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const messageId = (env["NEON_CANARY_REACTION_MESSAGE_ID"] ?? "").trim() || "<unset>";
  const emoji = "👀";
  const target = { channel: "discord" as const, accountId: "local", channelId };

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`,
    `  messageIdSet=${messageId !== "<unset>"}`
  ];

  if (!pre.ready) {
    const sender = createNeonCanaryReactionSender({ env, channelAllowlist: allowlist });
    const result = await sender.setReaction(target, messageId, emoji);
    return [
      "Neonika Canary reaction: SUPPRESSED (preconditions not met, no transport constructed)",
      ...preconditionLines,
      `Target: discord/${channelId} message=${messageId}`,
      `Emoji: ${result.emoji}`,
      `Reason: ${result.reactionSent ? "sent" : result.reason}`,
      `Reaction sent: ${result.reactionSent}`
    ].join("\n");
  }

  if (messageId === "<unset>") {
    return [
      "Neonika Canary reaction: READY but NEON_CANARY_REACTION_MESSAGE_ID unset (nothing to react to)",
      ...preconditionLines,
      "Reaction sent: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordReactionTransport({ token });
  try {
    const sender = createNeonCanaryReactionSender({ env, transport, channelAllowlist: allowlist });
    const result = await sender.setReaction(target, messageId, emoji);
    if (!result.reactionSent) {
      return [
        "Neonika Canary reaction: gate closed at send time",
        ...preconditionLines,
        `Reason: ${result.reason}`,
        "Reaction sent: false"
      ].join("\n");
    }
    return [
      "Neonika Canary reaction: SENT",
      ...preconditionLines,
      `Target: discord/${channelId} message=${messageId}`,
      `Emoji: ${result.emoji}`,
      "Reaction sent: true"
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runTypingCanaryLiveSmoke(): Promise<string> {
  // Typing sibling of the canary live smokes. The typing start guard is sealed
  // unless the full canary gate is open, so the default path is "skipped" with
  // NO transport. A live channel.sendTyping only fires when ready. Token from env.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const target = { channel: "discord" as const, accountId: "local", channelId };
  const guard = createNeonTypingStartGuard({ isSealed: () => !pre.ready });

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];

  if (!pre.ready) {
    const outcome = await guard.run(() => {
      throw new Error("typing start must not run while the canary gate is sealed");
    });
    return [
      "Neonika Canary typing: SKIPPED (sealed, preconditions not met, no transport constructed)",
      ...preconditionLines,
      `Target: discord/${channelId}`,
      `Outcome: ${outcome}`,
      "Typing sent: false"
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordTypingTransport({ token });
  try {
    const outcome = await guard.run(() => transport.sendTyping(target));
    return [
      `Neonika Canary typing: ${outcome === "started" ? "SENT" : outcome.toUpperCase()}`,
      ...preconditionLines,
      `Target: discord/${channelId}`,
      `Outcome: ${outcome}`,
      `Typing sent: ${outcome === "started"}`
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runStatusReactionCanaryLiveSmoke(): Promise<string> {
  // Wires the status-reaction controller (planNeonStatusReactionEmit) to the gated
  // reaction transport: the controller decides the lifecycle emoji, the canary gate
  // decides whether it is actually sent. Default suppressed with NO transport.
  const env = process.env;
  const pre = evaluateNeonCanaryLivePreconditions(env);
  const allowlist = resolveNeonCanaryChannelAllowlist(env);
  const channelId = resolveCanarySmokeChannelId(pre, allowlist);
  const messageId = (env["NEON_CANARY_REACTION_MESSAGE_ID"] ?? "").trim() || "<unset>";
  const target = { channel: "discord" as const, accountId: "local", channelId };

  const plan = planNeonStatusReactionEmit({
    nextState: "thinking",
    currentEmoji: "",
    finished: false,
    lastIntermediateEmitAt: null,
    now: 0
  });

  const preconditionLines = [
    `Preconditions:`,
    `  tokenPresent=${pre.tokenPresent}`,
    `  channelConfigured=${pre.channelConfigured}`,
    `  singleChannel=${pre.singleChannel}`,
    `  stageIsCanary=${pre.stageIsCanary}`,
    `  canaryApproved=${pre.canaryApproved}`,
    `  outboundEnabled=${pre.outboundEnabled}`,
    `  ready=${pre.ready}`
  ];
  const planLine = `Status plan: state=${plan.state} emoji=${plan.emoji} action=${plan.action}`;

  if (plan.action !== "emit") {
    return [
      "Neonika Canary status-reaction: NO EMIT (status controller plan says skip)",
      ...preconditionLines,
      planLine,
      "Reaction sent: false"
    ].join("\n");
  }

  if (!pre.ready || messageId === "<unset>") {
    const sender = createNeonCanaryReactionSender({ env, channelAllowlist: allowlist });
    const result = await sender.setReaction(target, messageId, plan.emoji);
    return [
      "Neonika Canary status-reaction: SUPPRESSED (gate sealed or message id unset, no transport constructed)",
      ...preconditionLines,
      planLine,
      `Reason: ${result.reactionSent ? "sent" : result.reason}`,
      `Reaction sent: ${result.reactionSent}`
    ].join("\n");
  }

  const token = (env["NEON_DISCORD_BOT_TOKEN"] ?? "").trim();
  const transport = createNeonDiscordReactionTransport({ token });
  try {
    const sender = createNeonCanaryReactionSender({ env, transport, channelAllowlist: allowlist });
    const result = await sender.setReaction(target, messageId, plan.emoji);
    return [
      `Neonika Canary status-reaction: ${result.reactionSent ? "SENT" : "gate closed at send time"}`,
      ...preconditionLines,
      planLine,
      `Reaction sent: ${result.reactionSent}`
    ].join("\n");
  } finally {
    await transport.close();
  }
}

async function runDeliveryDispatchSmoke(): Promise<string> {
  // Full path proof: shadow run -> dry-run candidate -> approve-canary approval
  // -> dispatch through the canary sender. No transport is injected, so the gate
  // is constructively closed and the candidate stays suppressed with ack=queued.
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-delivery-dispatch-smoke-"));

  try {
    const shadow = await runNeonGatewayShadow(
      {
        message: {
          channel: "discord",
          accountId: "local",
          guildId: "900000000000000001",
          channelId: "900000000000000005",
          threadId: "local-dispatch-thread",
          messageId: "local-discord-delivery-dispatch-smoke",
          userId: "operator",
          userDisplayName: "Operator",
          agentId: "chaty",
          workspaceRoot: projectRoot,
          mode: "read-only",
          content: "Local Neon delivery dispatch smoke",
          createdAt: "2026-06-02T11:00:00.000Z"
        },
        memory: { state: "skipped", hitCount: 0, note: "Delivery dispatch smoke" }
      },
      {
        harness: createDryRunHarness(),
        now: () => new Date("2026-06-02T11:00:01.000Z"),
        createRunId: () => "neon-delivery-dispatch-shadow-smoke"
      }
    );

    const candidate = createNeonDeliveryDryRunCandidate(shadow.run, {
      now: () => new Date("2026-06-02T11:00:02.000Z")
    });
    const sender = createNeonCanaryOutboundSender({
      env: {},
      now: () => new Date("2026-06-02T11:00:03.000Z")
    });

    const result = await deliverAndRecordNeonApprovedCandidate({
      projectRoot,
      sender,
      candidate,
      approval: {
        id: `approval-${candidate.id}`,
        candidateId: candidate.id,
        runId: candidate.runId,
        decision: "approve-canary",
        operatorId: "operator",
        safety: { outboundSent: false, requiresCanaryGate: true, cutoverStage: "shadow" },
        createdAt: "2026-06-02T11:00:02.500Z"
      },
      now: () => new Date("2026-06-02T11:00:03.000Z")
    });

    if (result.outboundSent !== false || result.outcome !== "suppressed") {
      throw new Error(`Delivery dispatch smoke produced a non-suppressed result: ${result.outcome}`);
    }

    return [
      "Neonika Delivery dispatch smoke: ok (approved + suppressed, no transport)",
      renderNeonDeliveryDispatchReport(result)
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runDiscordShadowTap(): Promise<undefined> {
  const configRoot = readFlagValue(process.argv.slice(3), "--config-root");
  const setupConfig = await readNeonSetupConfig(configRoot);
  const token = readRequiredEnv(["NEON_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  setRuntimeEnv("NEON_DISCORD_BOT_TOKEN", token);
  const botUserId = readRequiredEnv(["NEON_DISCORD_BOT_USER_ID"]);
  const allowedGuildIds = readRequiredCsvEnv("NEON_DISCORD_ALLOWED_GUILDS");
  const allowedChannelIds = readRequiredCsvEnv("NEON_DISCORD_ALLOWED_CHANNELS");
  const ignoredMentionedUserIds = readOptionalCsvEnv("NEON_DISCORD_IGNORED_MENTIONED_USER_IDS");
  const planApprovalDisabledChannelIds =
    readOptionalCsvEnv("NEON_DISCORD_PLAN_APPROVAL_DISABLED_CHANNELS") ?? [];
  const threadWorkspaceDisabledChannelIds =
    readOptionalCsvEnv("NEON_DISCORD_THREAD_WORKSPACES_DISABLED_CHANNELS") ?? [];
  // No built-in mention list: an unconfigured deployment routes nothing.
  const neoMentionUserIds = readOptionalCsvEnv("NEON_DISCORD_NEO_MENTION_USER_IDS") ?? [];
  const agentId = process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty";
  const agentMentionRoutes =
    agentId === "neo"
      ? [
          {
            agentId: "neo",
            aliases: ["neo"],
            mentionedUserIds: neoMentionUserIds
          }
        ]
      : undefined;
  const ignoredMentionAliases = agentId === "neo" ? undefined : ["neo"];
  const accountId = process.env["NEON_DISCORD_ACCOUNT_ID"] ?? "default";
  const discordOwnerLink = setupConfig?.identity.links.find(
    (link) => link.channel === "discord" && link.accountId === accountId
  );
  const ownerSession =
    setupConfig && discordOwnerLink
      ? {
          userId: discordOwnerLink.peerId,
          sessionPeerKey: resolveNeonCanonicalPeer(setupConfig, {
            channel: "discord",
            accountId,
            peerId: discordOwnerLink.peerId
          }).sessionPeerKey
        }
      : undefined;
  const harnessMode = process.env["NEON_DISCORD_TAP_HARNESS"] ?? "dry";
  const tapRunMode = readDiscordTapRunModeEnv();
  const inboundDebounceMs = readNonNegativeIntegerEnv("NEON_DISCORD_INBOUND_DEBOUNCE_MS", 1500);
  const lifecycleGate = resolveNeonInFlightRunGate();
  const inFlightRuns = createNeonInFlightRunRegistry({ gate: lifecycleGate });
  const sessionQueue = createNeonSessionActorQueue();
  const runControl = createNeonDiscordRunControl({
    inFlightRuns,
    sessionQueue,
    interruptRun: async (record) => {
      const startOptions = await createLocalAppServerStartOptions();
      const lease = await getDiscordTapClientPool().acquire(startOptions);
      try {
        await interruptCodexTurn(lease.client, {
          threadId: record.threadId,
          turnId: record.turnId
        });
      } finally {
        await lease.release();
      }
    }
  });
  const harness = await createDiscordTapHarness(harnessMode, lifecycleGate, inFlightRuns);
  const harnessRegistry = await createDiscordTapHarnessRegistry(harness, lifecycleGate, inFlightRuns);
  const writeLiveRun = harnessMode === "codex" && lifecycleGate.enabled ? writeNeonGatewayRunLatest : undefined;
  const resolveMemory = createDiscordMemoryResolver();
  const workboardAutopilotEnabled = isReadyLike(process.env["NEON_WORKBOARD_AUTOPILOT_ENABLED"]);
  const workboardAutopilotOptions = workboardAutopilotEnabled
    ? await createWorkboardAutopilotDispatchOptions()
    : undefined;
  const cronDaemonEnabled = isReadyLike(process.env["NEON_CRON_DAEMON_ENABLED"]);
  const cronDaemonIntervalMs = readPositiveIntegerEnv("NEON_CRON_DAEMON_INTERVAL_MS", 60_000);
  const cronDaemonGate = resolveNeonCronTimerGate(process.env);
  const heartbeatDaemonEnabled = isReadyLike(process.env["NEON_HEARTBEAT_DAEMON_ENABLED"]);
  const heartbeatDaemonAgents = heartbeatDaemonEnabled ? resolveNeonHeartbeatAgentsFromEnv(process.env) : [];
  const heartbeatDaemonIntervalMs = readPositiveIntegerEnv("NEON_HEARTBEAT_DAEMON_INTERVAL_MS", 60_000);
  const heartbeatDaemonGate = resolveNeonHeartbeatTimerGate(process.env);
  const canaryReplyRequested = isReadyLike(process.env["NEON_DISCORD_TAP_CANARY_REPLY"]);
  const progressCardsRequested = isReadyLike(process.env["NEON_DISCORD_PROGRESS_CARD"]);
  const runtimePickerRequested = isReadyLike(process.env["NEON_DISCORD_RUNTIME_PICKER"]);
  const capacityRouterRequested = isReadyLike(process.env["NEON_DISCORD_CAPACITY_ROUTER"]);
  const recoveryCardsRequested = isReadyLike(process.env["NEON_DISCORD_RECOVERY_CARDS"]);
  const canaryReplyPreconditions = evaluateNeonCanaryLivePreconditions(process.env);
  const canaryReplyAllowlist = resolveNeonCanaryChannelAllowlist(process.env);
  const progressCardsEnabled = progressCardsRequested && canaryReplyPreconditions.ready;
  const canaryTypingRequested = isReadyLike(process.env["NEON_DISCORD_TAP_TYPING"]);
  const canaryTypingEnabled =
    canaryTypingRequested && canaryReplyPreconditions.ready;
  const canaryReactionsRequested = isReadyLike(process.env["NEON_DISCORD_TAP_REACTIONS"]);
  const canaryReactionsEnabled =
    canaryReactionsRequested && canaryReplyPreconditions.ready;
  const canaryReactionEmojiOverrides: Partial<Record<string, string | undefined>> = {
    queued: readOptionalEnv("NEON_DISCORD_TAP_REACTION_QUEUED"),
    done: readOptionalEnv("NEON_DISCORD_TAP_REACTION_DONE"),
    error: readOptionalEnv("NEON_DISCORD_TAP_REACTION_ERROR")
  };
  const canaryVoiceReply = resolveNeonDiscordVoiceReplyOptionsFromEnv(process.env);
  const voiceTranscription = resolveNeonDiscordVoiceTranscriptionOptionsFromEnv(process.env);
  const tapPolicy: INeonDiscordIngressPolicy = {
    agentId,
    workspaceRoot: process.cwd(),
    mode: tapRunMode,
    botUserId,
    mentionPolicy: readDiscordMentionPolicyEnv(),
    allowedGuildIds,
    allowedChannelIds,
    ...(agentMentionRoutes ? { agentMentionRoutes } : {}),
    ...(ignoredMentionAliases ? { ignoredMentionAliases } : {}),
    ...(ignoredMentionedUserIds ? { ignoredMentionedUserIds } : {}),
    ...(ownerSession ? { ownerSession } : {})
  };
  const canaryReplyTransport =
    (canaryReplyRequested ||
      progressCardsEnabled ||
      runtimePickerRequested ||
      capacityRouterRequested ||
      recoveryCardsRequested) &&
    canaryReplyPreconditions.ready
      ? createNeonDiscordOutboundTransport({ token, suppressEmbeds: true })
      : undefined;
  const canaryReplySender = canaryReplyRequested
    ? createNeonCanaryOutboundSender({
        env: process.env,
        ...(canaryReplyTransport ? { transport: canaryReplyTransport } : {}),
        channelAllowlist: canaryReplyAllowlist
      })
    : undefined;
  const adapter = createDiscordJsShadowTapAdapter();
  let pdfReviewRuntime: INeonPdfReviewRuntime | undefined;
  let runtimePicker: INeonDiscordSessionRuntimePicker | undefined;
  let capacityGate: INeonDiscordCapacityGate | undefined;
  let recoveryRuntime: INeonDiscordRecoveryRuntime | undefined;
  let agentButtonsRuntime: INeonDiscordAgentButtonsRuntime | undefined;
  let planApprovalRuntime: INeonDiscordPlanApprovalRuntime | undefined;
  const presentPlanApprovalFromReply = async (
    run: INeonGatewayShadowRun,
    reply: Awaited<ReturnType<typeof deliverNeonCanaryReplyForRun>>
  ): Promise<void> => {
    if (reply.state === "delivered" && reply.planApproval && reply.target && planApprovalRuntime) {
      await planApprovalRuntime.present(run, reply.target, reply.planApproval.planText);
    }
  };
  const componentActionRegistry = createNeonDiscordComponentActionRegistry({
    statePath: resolveNeonDiscordComponentActionStatePath(process.cwd()),
    resolveHandler: (actionType) => {
      if (actionType === "run-control:stop") {
        return async (context) => {
          const result = await runControl.stopSession(context.sessionKey);
          return { message: result.message };
        };
      }
      if (isNeonPdfReviewActionType(actionType)) {
        return async (context) => {
          if (!pdfReviewRuntime) {
            throw new Error("PDF review runtime is unavailable");
          }
          return await pdfReviewRuntime.handleAction(context);
        };
      }
      if (isNeonDiscordSessionRuntimeActionType(actionType)) {
        return async (context) => {
          if (!runtimePicker) {
            throw new Error("Discord runtime picker is unavailable");
          }
          return await runtimePicker.handleAction(context);
        };
      }
      if (isNeonDiscordCapacityActionType(actionType)) {
        return async (context) => {
          if (!capacityGate) {
            throw new Error("Discord capacity router is unavailable");
          }
          return await capacityGate.handleAction(context);
        };
      }
      if (isNeonDiscordRecoveryActionType(actionType)) {
        return async (context) => {
          if (!recoveryRuntime) {
            throw new Error("Discord recovery runtime is unavailable");
          }
          return await recoveryRuntime.handleAction(context);
        };
      }
      if (isNeonDiscordAgentButtonsActionType(actionType)) {
        return async (context) => {
          if (!agentButtonsRuntime) {
            throw new Error("Discord agent buttons runtime is unavailable");
          }
          return await agentButtonsRuntime.handleAction(context);
        };
      }
      if (isNeonDiscordPlanApprovalActionType(actionType)) {
        return async (context) => {
          if (!planApprovalRuntime) {
            throw new Error("Discord plan approval runtime is unavailable");
          }
          return await planApprovalRuntime.handleAction(context);
        };
      }
      return undefined;
    }
  });
  if (runtimePickerRequested && canaryReplyTransport) {
    runtimePicker = createNeonDiscordSessionRuntimePicker({
      projectRoot: process.cwd(),
      registry: componentActionRegistry,
      catalog: createDiscordRuntimePickerCatalog(),
      transport: {
        postComponents: async (target, content, rows) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("Runtime picker target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postComponents(target, content, rows);
        }
      }
    });
  }
  const resolveTapHarness = (message: INeonGatewayInboundMessage): ICodexHarness => {
    const sessionKey = deriveCodexSessionKey(createSessionBindingFromGatewayMessage(message));
    const selected = runtimePicker?.resolve(sessionKey, message.userId);
    if (selected) {
      return createDiscordHarnessForRuntimeSelection(selected, inFlightRuns);
    }
    const agent = resolveNeonAgentAttachment(message.agentId);
    if (capacityGate && (agent?.runtime ?? "codex") === "codex") {
      const decision = resolveNeonDiscordCapacityDecision(message);
      return createDiscordCodexTapHarness(
        inFlightRuns,
        neonDiscordCapacityRuntimes[decision.tier],
        decision.tier !== "sol"
      );
    }
    return selectNeonHarness(agent?.runtime ?? "codex", harnessRegistry).harness;
  };
  if (recoveryCardsRequested && canaryReplyTransport) {
    recoveryRuntime = createNeonDiscordRecoveryRuntime({
      projectRoot: process.cwd(),
      registry: componentActionRegistry,
      transport: {
        postComponents: async (target, content, rows, embeds) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("Recovery card target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postComponents(target, content, rows, embeds);
        }
      },
      canContinue: async (run) => {
        const binding = await readCodexThreadBinding(process.cwd(), run.harnessSessionKey);
        const activeRuntime = runtimePicker?.resolve(run.harnessSessionKey, run.request.userId) ?? harnessRegistry.codex.runtime;
        return binding !== undefined &&
          binding.model === run.runtime?.model &&
          activeRuntime !== undefined &&
          run.runtime !== undefined &&
          sameHarnessRuntime(activeRuntime, run.runtime);
      },
      execute: async ({ action, run }) => {
        const timestamp = new Date().toISOString();
        let recoveryEnvelope: INeonDiscordMessageEnvelope;
        if (action === "retry") {
          if (!run.request.messageId || !adapter.fetchMessage) {
            throw new Error("Original Discord message is unavailable for retry");
          }
          const original = await adapter.fetchMessage({
            channelId: run.request.channelId,
            ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
            messageId: run.request.messageId
          });
          if (!original) {
            throw new Error("Original Discord message could not be fetched");
          }
          const mapped = mapDiscordJsMessageToEnvelope(original, run.request.accountId);
          if (mapped.author.id !== run.request.userId || mapped.author.bot) {
            throw new Error("Original Discord message owner changed");
          }
          recoveryEnvelope = { ...mapped, createdAt: timestamp };
        } else {
          recoveryEnvelope = {
            accountId: run.request.accountId,
            channelId: run.request.channelId,
            ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
            ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
            messageId: `recovery-continue:${run.runId}:${Date.now()}`,
            author: {
              id: run.request.userId,
              username: run.request.userDisplayName ?? "the operator",
              displayName: run.request.userDisplayName ?? "the operator",
              bot: false
            },
            content: "Setze den fehlgeschlagenen Auftrag in dieser Session fort. Prüfe den bisherigen Stand und liefere das Ergebnis vollständig.",
            createdAt: timestamp,
            mentionedUserIds: []
          };
        }
        const ingress = await runNeonDiscordShadowIngress(
          { message: recoveryEnvelope, policy: tapPolicy, resolveMemory },
          {
            projectRoot: process.cwd(),
            harness,
            resolveHarness: resolveTapHarness,
            resolveContext: resolveDiscordGatewayContext,
            sessionQueue,
            ...(writeLiveRun ? { writeRun: writeLiveRun, writeRunningRun: writeLiveRun } : {}),
            workboardIngestion: false,
            cronCommand: false,
            commitmentCapture: false
          }
        );
        if (ingress.state !== "accepted") {
          throw new Error("Discord recovery run was rejected");
        }
        if (ingress.result.run.status === "failed") {
          await recoveryRuntime?.start(ingress.result.run);
        } else if (canaryReplySender) {
          const reply = await deliverNeonCanaryReplyForRun({
            run: ingress.result.run,
            sender: canaryReplySender,
            replyMode: readDiscordCanaryReplyModeEnv(),
            projectRoot: process.cwd(),
            ...(pdfReviewRuntime ? { pdfReview: pdfReviewRuntime } : {}),
            ...(canaryVoiceReply ? { voiceReply: canaryVoiceReply } : {})
          });
          await presentPlanApprovalFromReply(ingress.result.run, reply);
        }
        return { runId: ingress.result.run.runId, status: ingress.result.run.status };
      }
    });
  }
  const pdfReviewEnabled =
    isReadyLike(process.env["NEON_DISCORD_PDF_REVIEW"]) &&
    canaryReplySender !== undefined &&
    canaryReplyTransport !== undefined;
  if (pdfReviewEnabled && canaryReplySender && canaryReplyTransport) {
    pdfReviewRuntime = createNeonPdfReviewRuntime({
      projectRoot: process.cwd(),
      registry: componentActionRegistry,
      sender: canaryReplySender,
      transport: {
        postComponents: async (target, content, rows) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("PDF review target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postComponents(target, content, rows);
        }
      },
      requestRevision: async ({ reviewId, run, request }) => {
        const createdAt = new Date().toISOString();
        const revisionIngress = await runNeonDiscordShadowIngress(
          {
            message: {
              accountId: run.request.accountId,
              ...(run.request.guildId ? { guildId: run.request.guildId } : {}),
              channelId: run.request.channelId,
              ...(run.request.threadId ? { threadId: run.request.threadId } : {}),
              messageId: `pdf-revision:${reviewId}:${Date.now()}`,
              author: {
                id: run.request.userId,
                username: run.request.userDisplayName ?? "the operator",
                displayName: run.request.userDisplayName ?? "the operator",
                bot: false
              },
              content: `Überarbeite den zuletzt erstellten PDF-Entwurf. Änderungswunsch: ${request}`,
              createdAt,
              mentionedUserIds: []
            },
            policy: tapPolicy,
            resolveMemory
          },
          {
            projectRoot: process.cwd(),
            harness,
            resolveHarness: resolveTapHarness,
            resolveContext: resolveDiscordGatewayContext,
            sessionQueue,
            ...(writeLiveRun ? { writeRun: writeLiveRun, writeRunningRun: writeLiveRun } : {}),
            workboardIngestion: false,
            cronCommand: false,
            commitmentCapture: false
          }
        );
        if (revisionIngress.state !== "accepted") {
          throw new Error("PDF revision run was rejected");
        }
        const reply = await deliverNeonCanaryReplyForRun({
          run: revisionIngress.result.run,
          sender: canaryReplySender,
          replyMode: readDiscordCanaryReplyModeEnv(),
          projectRoot: process.cwd(),
          ...(pdfReviewRuntime ? { pdfReview: pdfReviewRuntime } : {}),
          ...(canaryVoiceReply ? { voiceReply: canaryVoiceReply } : {})
        });
        if (reply.state === "transport-error") {
          throw new Error("PDF revision reply failed");
        }
        await presentPlanApprovalFromReply(revisionIngress.result.run, reply);
        return { runId: revisionIngress.result.run.runId };
      }
    });
  }
  const progressCards =
    progressCardsEnabled && canaryReplyTransport
      ? createNeonDiscordProgressCardRuntime({
          registry: componentActionRegistry,
          runControl,
          transport: {
            // Card body rides in a Neon-orange embed (left accent bar) so every
            // progress card reads as branded Neon output.
            post: async (target, body, rows) => {
              if (!canaryReplyAllowlist.channels.has(target.channelId)) {
                throw new Error("Progress card target is outside the Canary allowlist");
              }
              return await canaryReplyTransport.postComponents(target, "", rows, [
                { description: body, color: NEON_DISCORD_ACCENT_COLOR }
              ]);
            },
            edit: async (target, messageId, body, rows) => {
              if (!canaryReplyAllowlist.channels.has(target.channelId)) {
                throw new Error("Progress card target is outside the Canary allowlist");
              }
              await canaryReplyTransport.editComponents(target, messageId, "", rows, [
                { description: body, color: NEON_DISCORD_ACCENT_COLOR }
              ]);
            }
          }
        })
      : undefined;
  if (
    capacityRouterRequested &&
    harnessMode === "codex" &&
    canaryReplyTransport &&
    canaryReplySender
  ) {
    capacityGate = createNeonDiscordCapacityGate({
      registry: componentActionRegistry,
      transport: {
        postComponents: async (target, content, rows) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("Capacity prompt target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postComponents(target, content, rows);
        }
      },
      execute: async (input) => {
        if (!adapter.fetchMessage) {
          throw new Error("Original Discord message lookup is unavailable");
        }
        const original = await adapter.fetchMessage({
          channelId: input.context.interaction.channelId,
          messageId: input.messageId
        });
        if (!original) {
          throw new Error("Original Discord message is unavailable");
        }
        const envelope = mapDiscordJsMessageToEnvelope(original, accountId);
        if (envelope.author.bot || envelope.author.id !== input.context.interaction.userId) {
          throw new Error("Original Discord message owner changed");
        }
        if (createNeonDiscordCapacityFingerprint(envelope) !== input.fingerprint) {
          throw new Error("Original Discord message changed after the capacity prompt");
        }
        const selectedHarness = createDiscordCodexTapHarness(inFlightRuns, input.runtime, false);
        const deliveryTarget = {
          channel: "discord" as const,
          accountId: envelope.accountId,
          ...(envelope.guildId ? { guildId: envelope.guildId } : {}),
          channelId: envelope.channelId,
          ...(envelope.threadId ? { threadId: envelope.threadId } : {}),
          replyToMessageId: envelope.messageId
        };
        const authorization = createNeonDiscordIngressDecision(envelope, tapPolicy);
        if (authorization.state !== "accepted") {
          throw new Error("Original Discord message is no longer authorized");
        }
        const sessionKey = deriveCodexSessionKey(
          createSessionBindingFromGatewayMessage(authorization.message)
        );
        const capacityProgress = progressCards
          ? await progressCards.start({
              target: deliveryTarget,
              ownerUserId: envelope.author.id,
              ...(envelope.guildId ? { guildId: envelope.guildId } : {}),
              channelId: envelope.threadId ?? envelope.channelId,
              sessionKey
            }).catch(() => undefined)
          : undefined;
        const ingress = await runNeonDiscordShadowIngress(
          { message: envelope, policy: tapPolicy, resolveMemory },
          {
            projectRoot: process.cwd(),
            harness: selectedHarness,
            resolveContext: resolveDiscordGatewayContext,
            sessionQueue,
            workboardAssumeActionRequest: true,
            ...(capacityProgress ? { onHarnessEvent: (event) => capacityProgress.observe(event) } : {}),
            ...(writeLiveRun ? { writeRun: writeLiveRun, writeRunningRun: writeLiveRun } : {}),
            resolveAbortSignal: (runId, acceptedMessage) =>
              runControl.resolveAbortSignal(
                runId,
                deriveCodexSessionKey(createSessionBindingFromGatewayMessage(acceptedMessage)),
                acceptedMessage.createdAt
              )
          }
        );
        if (ingress.state !== "accepted") {
          throw new Error("Capacity-approved Discord run was rejected");
        }
        await capacityProgress?.finish(ingress.result.run.status);
        if (ingress.result.run.status === "failed") {
          await recoveryRuntime?.start(ingress.result.run);
        }
        const reply = await deliverNeonCanaryReplyForRun({
          run: ingress.result.run,
          sender: canaryReplySender,
          replyMode: readDiscordCanaryReplyModeEnv(),
          projectRoot: process.cwd(),
          ...(pdfReviewRuntime ? { pdfReview: pdfReviewRuntime } : {}),
          ...(canaryVoiceReply ? { voiceReply: canaryVoiceReply } : {})
        });
        if (reply.state === "transport-error") {
          throw new Error("Capacity-approved Discord reply failed");
        }
        await presentPlanApprovalFromReply(ingress.result.run, reply);
        if (reply.outboundSent && reply.messageId) {
          await (writeLiveRun ?? writeNeonGatewayRun)(
            process.cwd(),
            markNeonGatewayRunDelivered(ingress.result.run, {
              messageId: reply.messageId,
              ...(reply.reason ? { reason: reply.reason } : {})
            })
          );
        }
        const status = ingress.result.run.status;
        return {
          runId: ingress.result.run.runId,
          status: status === "completed" || status === "failed" || status === "cancelled" ? status : "failed"
        };
      }
    });
  }
  if (canaryReplyTransport && canaryReplySender) {
    agentButtonsRuntime = createNeonDiscordAgentButtonsRuntime({
      registry: componentActionRegistry,
      transport: {
        postComponents: async (target, content, rows) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("Agent buttons target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postComponents(target, content, rows);
        }
      },
      execute: async ({ label, context }) => {
        const timestamp = new Date().toISOString();
        const envelope: INeonDiscordMessageEnvelope = {
          accountId,
          channelId: context.interaction.channelId,
          ...(context.interaction.guildId ? { guildId: context.interaction.guildId } : {}),
          messageId: `agent-button:${context.actionId}:${Date.now()}`,
          author: {
            id: context.interaction.userId,
            username: "button-auswahl",
            displayName: "Button-Auswahl",
            bot: false
          },
          content: label,
          createdAt: timestamp,
          mentionedUserIds: []
        };
        const authorization = createNeonDiscordIngressDecision(envelope, tapPolicy);
        if (authorization.state !== "accepted") {
          throw new Error("Agent button click is not authorized for this channel");
        }
        const ingress = await runNeonDiscordShadowIngress(
          { message: envelope, policy: tapPolicy, resolveMemory },
          {
            projectRoot: process.cwd(),
            harness,
            resolveHarness: resolveTapHarness,
            resolveContext: resolveDiscordGatewayContext,
            sessionQueue,
            ...(writeLiveRun ? { writeRun: writeLiveRun, writeRunningRun: writeLiveRun } : {}),
            workboardIngestion: false,
            cronCommand: false,
            commitmentCapture: false
          }
        );
        if (ingress.state !== "accepted") {
          throw new Error("Agent button follow-up run was rejected");
        }
        if (ingress.result.run.status === "failed") {
          await recoveryRuntime?.start(ingress.result.run);
          return "Der Folgeauftrag ist fehlgeschlagen — Recovery-Karte ist unterwegs.";
        }
        const reply = await deliverNeonCanaryReplyForRun({
          run: ingress.result.run,
          sender: canaryReplySender,
          replyMode: readDiscordCanaryReplyModeEnv(),
          projectRoot: process.cwd(),
          ...(pdfReviewRuntime ? { pdfReview: pdfReviewRuntime } : {}),
          ...(canaryVoiceReply ? { voiceReply: canaryVoiceReply } : {})
        });
        if (reply.state === "transport-error") {
          throw new Error("Agent button follow-up reply failed");
        }
        await presentPlanApprovalFromReply(ingress.result.run, reply);
        return `„${label}“ erledigt — die Antwort steht im Channel.`;
      }
    });
  }
  if (canaryReplyTransport && canaryReplySender) {
    const runPlanFollowUp = async (
      sourceRun: INeonGatewayShadowRun,
      messagePrefix: string,
      instruction: string
    ): Promise<{ readonly runId: string }> => {
      const timestamp = new Date().toISOString();
      const envelope: INeonDiscordMessageEnvelope = {
        accountId: sourceRun.request.accountId,
        channelId: sourceRun.request.channelId,
        ...(sourceRun.request.threadId ? { threadId: sourceRun.request.threadId } : {}),
        ...(sourceRun.request.guildId ? { guildId: sourceRun.request.guildId } : {}),
        messageId: `${messagePrefix}:${sourceRun.runId}:${Date.now()}`,
        author: {
          id: sourceRun.request.userId,
          username: sourceRun.request.userDisplayName ?? "the operator",
          displayName: sourceRun.request.userDisplayName ?? "the operator",
          bot: false
        },
        content: instruction,
        createdAt: timestamp,
        mentionedUserIds: []
      };
      const planActionPolicy: INeonDiscordIngressPolicy = {
        ...tapPolicy,
        agentId: sourceRun.request.agentId
      };
      const ingress = await runNeonDiscordShadowIngress(
        { message: envelope, policy: planActionPolicy, resolveMemory },
        {
          projectRoot: process.cwd(),
          harness,
          resolveHarness: resolveTapHarness,
          resolveContext: resolveDiscordGatewayContext,
          sessionQueue,
          ...(writeLiveRun ? { writeRun: writeLiveRun, writeRunningRun: writeLiveRun } : {}),
          workboardIngestion: false,
          cronCommand: false,
          commitmentCapture: false
        }
      );
      if (ingress.state !== "accepted" || ingress.result.run.status !== "completed") {
        throw new Error("Discord plan follow-up run did not complete");
      }
      const reply = await deliverNeonCanaryReplyForRun({
        run: ingress.result.run,
        sender: canaryReplySender,
        replyMode: readDiscordCanaryReplyModeEnv(),
        projectRoot: process.cwd(),
        ...(pdfReviewRuntime ? { pdfReview: pdfReviewRuntime } : {}),
        ...(canaryVoiceReply ? { voiceReply: canaryVoiceReply } : {})
      });
      if (reply.state === "transport-error" || reply.state === "skipped") {
        throw new Error("Discord plan follow-up reply failed");
      }
      await presentPlanApprovalFromReply(ingress.result.run, reply);
      return { runId: ingress.result.run.runId };
    };

    planApprovalRuntime = createNeonDiscordPlanApprovalRuntime({
      projectRoot: process.cwd(),
      registry: componentActionRegistry,
      disabledChannelIds: planApprovalDisabledChannelIds,
      transport: {
        postPublic: async (target, content) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("Plan approval target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postMessage(target, content);
        },
        postComponents: async (target, content, rows) => {
          if (!canaryReplyAllowlist.channels.has(target.channelId)) {
            throw new Error("Plan approval target is outside the Canary allowlist");
          }
          return await canaryReplyTransport.postComponents(target, content, rows);
        }
      },
      approve: async ({ approvalId, run, planText }) =>
        await runPlanFollowUp(
          run,
          `plan-approved:${approvalId}`,
          [
            "Neonika hat den folgenden Plan über den nutzergebundenen Genehmigen-Button freigegeben.",
            "Führe ihn jetzt vollständig aus. Stelle keine erneute Planfrage und erzeuge keinen neuen Plan-Approval-Marker, außer ein neues unauflösbares Produktziel entsteht.",
            "",
            "Genehmigter Plan:",
            planText
          ].join("\n")
        ),
      requestRevision: async ({ approvalId, run, planText, request }) =>
        await runPlanFollowUp(
          run,
          `plan-revision:${approvalId}`,
          [
            "Überarbeite ausschließlich den folgenden Plan anhand des Änderungswunsches.",
            "Führe noch nichts aus. Zeige danach genau einen neuen vollständigen Plan und hänge <NEON_PLAN_APPROVAL /> als letzte Zeile an.",
            "",
            "Bisheriger Plan:",
            planText,
            "",
            "Änderungswunsch:",
            request
          ].join("\n")
        )
    });
  }
  const threadWorkspaces = isReadyLike(process.env["NEON_DISCORD_THREAD_WORKSPACES"])
    ? createNeonDiscordThreadWorkspaceRuntime<Message>({
        projectRoot: process.cwd(),
        disabledChannelIds: threadWorkspaceDisabledChannelIds,
        transport: {
          createThread: async (message, input) => {
            const thread = await message.startThread({
              name: input.name,
              autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
              reason: input.reason
            });
            return { threadId: thread.id };
          }
        }
      })
    : undefined;

  const handle = await startNeonDiscordShadowTap<Message, ChatInputCommandInteraction>({
    token,
    projectRoot: process.cwd(),
    accountId,
    adapter,
    mapMessage: (message) => mapDiscordJsMessageToEnvelope(message, accountId),
    mapInteraction: (interaction) => mapDiscordJsInteractionToSlashEnvelope(interaction, accountId),
    componentActionRegistry,
    runControl,
    ...(progressCards ? { progressCards } : {}),
    ...(runtimePicker ? { runtimePicker } : {}),
    ...(capacityGate ? { capacityGate } : {}),
    ...(recoveryRuntime ? { recoveryCards: recoveryRuntime } : {}),
    ...(agentButtonsRuntime ? { agentButtons: agentButtonsRuntime } : {}),
    ...(planApprovalRuntime ? { planApproval: planApprovalRuntime } : {}),
    ...(pdfReviewRuntime ? { pdfReview: pdfReviewRuntime } : {}),
    ...(threadWorkspaces ? { threadWorkspaces } : {}),
    policy: tapPolicy,
    resolveMemory,
    resolveContext: resolveDiscordGatewayContext,
    resolveHarness: resolveTapHarness,
    harness,
    sessionQueue,
    ...(inboundDebounceMs > 0 ? { inboundDebounce: { debounceMs: inboundDebounceMs } } : {}),
    ...(voiceTranscription ? { voiceTranscription } : {}),
    ...(canaryReplySender
      ? {
          canaryReplyMode: readDiscordCanaryReplyModeEnv(),
          canaryReplySender,
          ...(canaryVoiceReply ? { canaryVoiceReply } : {})
        }
      : {}),
    ...(canaryTypingEnabled
      ? {
          startTyping: async (message) => {
            await adapter.sendTyping?.(message);
          }
        }
      : {}),
    ...(canaryReactionsEnabled
      ? {
          addStatusReaction: async (message, _envelope, _state, emoji) => {
            await adapter.addReaction?.(message, canaryReactionEmojiOverrides[_state] ?? emoji);
          },
          removeStatusReaction: async (message, _envelope, emoji) => {
            await adapter.removeReaction?.(message, emoji);
          },
          // History default: worked-through icons stay as a timeline. Opt out
          // with NEON_DISCORD_TAP_REACTION_HISTORY=off for replace mode.
          statusReactionHistory:
            (process.env["NEON_DISCORD_TAP_REACTION_HISTORY"] ?? "ready").trim().toLowerCase() !== "off"
        }
      : {}),
    ...(writeLiveRun ? { writeRun: writeLiveRun, writeRunningRun: writeLiveRun } : {}),
    onEvent: (event) => {
      if (event.kind === "accepted") {
        console.log(`discord-shadow-tap accepted ${event.runId}`);
        return;
      }

      if (event.kind === "dropped") {
        console.log(`discord-shadow-tap dropped ${event.reason}`);
        return;
      }

      if (event.kind === "interaction-accepted") {
        console.log(`discord-shadow-tap interaction accepted ${event.runId}`);
        return;
      }

      if (event.kind === "interaction-dropped") {
        console.log(`discord-shadow-tap interaction dropped ${event.reason}`);
        return;
      }

      if (event.kind === "component-interaction-accepted") {
        console.log(
          `discord-shadow-tap component accepted action=${event.actionType} id=${event.actionId}`
        );
        return;
      }

      if (event.kind === "component-interaction-dropped") {
        console.log(`discord-shadow-tap component dropped ${event.reason}`);
        return;
      }

      if (event.kind === "control-accepted") {
        console.log(
          `discord-shadow-tap control accepted state=${event.state} active=${event.activeRunsMatched} queued=${event.pendingTasksCancelled} ack=${event.acknowledgementSent}`
        );
        return;
      }

      if (event.kind === "control-dropped") {
        console.log(`discord-shadow-tap control dropped ${event.reason}`);
        return;
      }

      if (event.kind === "progress-card") {
        console.log(
          `discord-shadow-tap progress ${event.state} message=${event.messageId ?? "none"} updates=${event.updates ?? 0}`
        );
        return;
      }

      if (event.kind === "capacity-prompt") {
        console.log(
          `discord-shadow-tap capacity ${event.state} message=${event.messageId ?? "none"}`
        );
        return;
      }

      if (event.kind === "reply") {
        console.log(
          `discord-shadow-tap reply ${event.state} run=${event.runId} sent=${event.outboundSent} message=${event.messageId ?? "none"} reason=${event.reason ?? "none"}`
        );
        return;
      }

      if (event.kind === "typing") {
        console.log(`discord-shadow-tap typing ${event.state}`);
        return;
      }

      if (event.kind === "reaction") {
        console.log(`discord-shadow-tap reaction ${event.outcome} ${event.state} ${event.emoji}`);
        return;
      }

      console.error(`discord-shadow-tap error ${event.message}`);
    }
  });
  const workboardAutopilot = workboardAutopilotOptions
    ? startWorkboardAutopilotPoller(
        workboardAutopilotOptions,
        readPositiveIntegerEnv("NEON_WORKBOARD_AUTOPILOT_INTERVAL_MS", 15_000)
      )
    : undefined;
  const cronDaemon = cronDaemonEnabled
    ? createNeonCronDaemonService({
        projectRoot: process.cwd(),
        intervalMs: cronDaemonIntervalMs,
        gate: cronDaemonGate,
        agentId: process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty",
        unrefTimer: false
      })
    : undefined;
  const heartbeatDaemon = heartbeatDaemonEnabled
    ? createNeonHeartbeatDaemonService({
        projectRoot: process.cwd(),
        schedulerSeed: "neonika",
        agents: heartbeatDaemonAgents,
        intervalMs: heartbeatDaemonIntervalMs,
        gate: heartbeatDaemonGate,
        unrefTimer: false
      })
    : undefined;

  try {
    await cronDaemon?.start();
    await heartbeatDaemon?.start();

    console.log(
      [
        "Discord shadow tap: ready",
        `Harness: ${harnessMode}`,
        `Guilds: ${allowedGuildIds.length}`,
        `Channels: ${allowedChannelIds.length}`,
        `Mention policy: ${readDiscordMentionPolicyEnv()}`,
        `Ignored mentioned users: ${ignoredMentionedUserIds?.length ?? 0}`,
        `Reply mode: ${readDiscordCanaryReplyModeEnv()}`,
        `Run mode: ${tapRunMode}`,
        `Inbound debounce: ${inboundDebounceMs > 0 ? `${inboundDebounceMs}ms` : "off"}`,
        `Codex policy: ${readCodexApprovalPolicyEnv()}/${readCodexSandboxEnv()}`,
        `Codex timeouts: request=${readCodexAppServerRequestTimeoutMsEnv()}ms turn=${readCodexAppServerTurnCompletionTimeoutMsEnv()}ms`,
        `Delivery: ${canaryReplySender ? "canary-reply-gated" : "suppressed"}`,
        "Component ingress: enabled (owner/TTL/single-use registry)",
        `Run controls: ${lifecycleGate.enabled ? "enabled (/stop fast-path)" : "blocked"}`,
        `Progress cards: ${progressCards ? "enabled" : "off"}`,
        `Runtime picker: ${runtimePicker ? "enabled" : "off"}`,
        `Capacity router: ${capacityGate ? "enabled (Luna/Terra/Sol + self-escalation)" : "off"}`,
        `Recovery cards: ${recoveryRuntime ? "enabled" : "off"}`,
        `Plan approvals: enabled (disabled channels=${planApprovalDisabledChannelIds.length})`,
        `PDF review: ${pdfReviewRuntime ? "enabled" : "off"}`,
        `Thread workspaces: ${
          threadWorkspaces ? `enabled (disabled channels=${threadWorkspaceDisabledChannelIds.length})` : "off"
        }`,
        `Workboard autopilot: ${workboardAutopilot ? "enabled" : "off"}`,
        `Cron daemon: ${
          cronDaemon ? `enabled (interval=${cronDaemonIntervalMs}ms, gate=${cronDaemonGate.reason})` : "off"
        }`,
        `Heartbeat daemon: ${
          heartbeatDaemon
            ? `enabled (${heartbeatDaemonAgents.length} agent(s), interval=${heartbeatDaemonIntervalMs}ms, gate=${heartbeatDaemonGate.reason})`
            : "off"
        }`,
        `Canary reply ready: ${canaryReplyPreconditions.ready}`,
        `Typing: ${canaryTypingEnabled ? "enabled" : canaryTypingRequested ? "suppressed" : "off"}`,
        `Reactions: ${canaryReactionsEnabled ? "enabled" : canaryReactionsRequested ? "suppressed" : "off"}`,
        "Stop: Ctrl+C"
      ].join("\n")
    );

    await waitForShutdownSignal(handle);

    console.log(
      [
        "Discord shadow tap: stopped",
        `Accepted: ${handle.stats.accepted}`,
        `Dropped: ${handle.stats.dropped}`,
        `Errors: ${handle.stats.errors}`,
        `Replies delivered: ${handle.stats.repliesDelivered}`,
        `Replies suppressed: ${handle.stats.repliesSuppressed}`,
        `Reply errors: ${handle.stats.replyErrors}`,
        `Typing started: ${handle.stats.typingStarted}`,
        `Typing errors: ${handle.stats.typingErrors}`,
        `Reactions sent: ${handle.stats.reactionsSent}`,
        `Reaction errors: ${handle.stats.reactionErrors}`,
        `Component interactions accepted: ${handle.stats.componentInteractionsAccepted}`,
        `Component interactions dropped: ${handle.stats.componentInteractionsDropped}`,
        `Controls accepted: ${handle.stats.controlsAccepted}`,
        `Controls dropped: ${handle.stats.controlsDropped}`,
        `Progress cards: ${handle.stats.progressCardsStarted}`,
        `Progress updates: ${handle.stats.progressCardUpdates}`,
        `Progress errors: ${handle.stats.progressCardErrors}`,
        `Runtime pickers opened: ${handle.stats.runtimePickersOpened}`,
        `Runtime picker errors: ${handle.stats.runtimePickerErrors}`,
        `Capacity prompts opened: ${handle.stats.capacityPromptsOpened}`,
        `Capacity prompt errors: ${handle.stats.capacityPromptErrors}`,
        `Recovery cards: ${handle.stats.recoveryCardsStarted}`,
        `Recovery errors: ${handle.stats.recoveryCardErrors}`
      ].join("\n")
    );
  } finally {
    await heartbeatDaemon?.stop();
    await cronDaemon?.stop();
    await workboardAutopilot?.close();
    await canaryReplyTransport?.close();
  }

  return undefined;
}

async function runDiscordTapCanaryReplyLiveSmoke(): Promise<string> {
  if (!isReadyLike(process.env["NEON_DISCORD_TAP_CANARY_REPLY_LIVE_SMOKE"])) {
    return [
      "Neonika Discord tap canary reply live smoke: not-run",
      "Set NEON_DISCORD_TAP_CANARY_REPLY_LIVE_SMOKE=ready, NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready, and the Canary outbound gate to run one private reply-loop smoke.",
      "Safety: only the allowlisted the allowlisted private channel is accepted; no primary cutover; no secrets printed."
    ].join("\n");
  }

  const lifecycleGate = resolveNeonInFlightRunGate();
  if (!lifecycleGate.enabled) {
    throw new Error("Refusing canary reply live smoke: set NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready first");
  }

  const preconditions = evaluateNeonCanaryLivePreconditions(process.env);
  if (!preconditions.ready) {
    throw new Error("Refusing canary reply live smoke: Canary outbound preconditions are not ready");
  }

  const token = readRequiredEnv(["NEON_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  const botUserId = readRequiredEnv(["NEON_DISCORD_BOT_USER_ID"]);
  const guildId = readPrivateNeonCanaryId("NEON_DISCORD_INGRESS_SMOKE_GUILD_ID", "900000000000000001");
  const channelId = readPrivateNeonCanaryId("NEON_DISCORD_INGRESS_SMOKE_CHANNEL_ID", "900000000000000005");
  const nonce = `neon-tap-canary-reply-${Date.now()}`;
  const baseAccountId = process.env["NEON_DISCORD_ACCOUNT_ID"] ?? "default";
  const accountId = `${baseAccountId}-canary-reply-${nonce}`;
  const runningSignal = createOneShotSignal<string>();
  const replySignal = createOneShotSignal<{
    readonly runId: string;
    readonly messageId: string;
  }>();
  let observedRunId: string | undefined;
  let runningStatus: INeonGatewayStatus | undefined;
  const writeLiveRun: (root: string, run: INeonGatewayShadowRun) => Promise<void> = async (root, run) => {
    await writeNeonGatewayRunLatest(root, run);

    if (run.status === "running" && run.request.contentPreview.includes(nonce)) {
      observedRunId = run.runId;
      runningStatus = await readNeonGatewayStatus(root);
      runningSignal.resolve(run.runId);
    }
  };

  const allowlist = resolveNeonCanaryChannelAllowlist(process.env);
  const outbound = createNeonDiscordOutboundTransport({ token });
  const sender = createNeonCanaryOutboundSender({
    env: process.env,
    transport: outbound,
    channelAllowlist: allowlist
  });
  const errors: string[] = [];
  const adapter = createDiscordJsShadowTapAdapter();
  const harness = await createDiscordTapHarness("codex", lifecycleGate);
  const handle = await startNeonDiscordShadowTap({
    token,
    projectRoot: process.cwd(),
    accountId,
    adapter,
    mapMessage: (message) => {
      const envelope = mapDiscordJsMessageToEnvelope(message, accountId);
      return envelope.content.includes(nonce) ? envelope : undefined;
    },
    mapInteraction: (interaction) => mapDiscordJsInteractionToSlashEnvelope(interaction, accountId),
    policy: {
      agentId: process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty",
      workspaceRoot: process.cwd(),
      mode: "read-only",
      botUserId,
      mentionPolicy: "guild",
      allowedGuildIds: [guildId],
      allowedChannelIds: [channelId],
      allowBotAuthors: true
    },
    resolveMemory: createDiscordMemoryResolver(),
    harness,
    canaryReplySender: sender,
    writeRun: writeLiveRun,
    writeRunningRun: writeLiveRun,
    onEvent: (event) => {
      if (event.kind === "error") {
        errors.push(event.message);
        return;
      }

      if (
        event.kind === "reply" &&
        event.outboundSent &&
        event.messageId &&
        event.runId === observedRunId
      ) {
        replySignal.resolve({ runId: event.runId, messageId: event.messageId });
      }
    }
  });

  try {
    await sleepMs(1_000);
    const sent = await outbound.postMessage(
      {
        channel: "discord",
        accountId,
        guildId,
        channelId
      },
      [
        `<@${botUserId}> Neonika canary reply loop smoke ${nonce}.`,
        "Answer exactly: Neon canary reply loop complete.",
        "Do not mention any user or bot."
      ].join("\n")
    );
    const runningRunId = await waitWithTimeout(
      runningSignal.promise,
      45_000,
      "Canary reply live smoke did not observe a running RunStore row"
    );
    const reply = await waitWithTimeout(
      replySignal.promise,
      180_000,
      "Canary reply live smoke did not observe a delivered reply event"
    );
    const terminalRun = await waitForGatewayRun(
      process.cwd(),
      (run) => run.runId === runningRunId && run.status !== "running",
      30_000
    );
    const finalStatus = await readNeonGatewayStatus(process.cwd());

    if (errors.length > 0) {
      throw new Error(`Canary reply live smoke tap error: ${errors[0]}`);
    }

    return [
      "Neonika Discord tap canary reply live smoke: ok",
      `Channel: ${channelId}`,
      `Sent trigger message: ${sent.messageId}`,
      `Running run: ${runningRunId}`,
      `Running count observed: ${runningStatus?.runningCount ?? 0}`,
      `Terminal run: ${terminalRun.runId}/${terminalRun.status}`,
      `Reply message: ${reply.messageId}`,
      `Replies delivered: ${handle.stats.repliesDelivered}`,
      `Replies suppressed: ${handle.stats.repliesSuppressed}`,
      `Final running count: ${finalStatus.runningCount}`,
      "Delivery: canary-reply",
      "Safety: private allowlisted channel, bot-author accepted only for the nonce trigger, no primary cutover, no secrets printed"
    ].join("\n");
  } finally {
    await handle.close();
    await outbound.close();
  }
}

function setRuntimeEnv(key: string, value: string): void {
  process.env[key] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runPeekabooProxy(): Promise<string | undefined> {
  const socketPath = process.env["NEON_PEEKABOO_PROXY_SOCKET"]?.trim() || resolveNeonPeekabooProxySocketPath(process.cwd());
  const handle = await listenNeonPeekabooProxy({
    projectRoot: process.cwd(),
    socketPath,
    env: process.env
  });

  console.log(
    [
      "Neonika Peekaboo proxy: ready",
      `Socket: ${handle.socketPath}`,
      `TCP: ${handle.tcpUrl}`,
      "Target: fixed peekaboo binary",
      "Stop: Ctrl+C"
    ].join("\n")
  );

  await waitForShutdownSignal(handle);

  return undefined;
}

async function runPeekabooProxyClient(): Promise<undefined> {
  const socketPath = process.env["NEON_PEEKABOO_PROXY_SOCKET"]?.trim() || resolveNeonPeekabooProxySocketPath(process.cwd());
  const tcpUrl = process.env["NEON_PEEKABOO_PROXY_URL"]?.trim();
  const response = await requestNeonPeekabooProxy({
    ...(tcpUrl ? { tcpUrl } : { socketPath }),
    socketPath,
    args: process.argv.slice(3)
  });

  if (response.stdout.length > 0) {
    process.stdout.write(response.stdout);
  }

  if (response.stderr.length > 0) {
    process.stderr.write(response.stderr);
  }

  if (response.error) {
    process.stderr.write(`${response.error}\n`);
  }

  process.exitCode = response.exitCode;
  return undefined;
}

async function runDiscordIngressCodexLiveSmoke(): Promise<string> {
  if (!isReadyLike(process.env["NEON_DISCORD_INGRESS_CODEX_LIVE_SMOKE"])) {
    return [
      "Neonika Discord ingress codex live smoke: not-run",
      "Set NEON_DISCORD_INGRESS_CODEX_LIVE_SMOKE=ready and NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready to run one private canary ingress turn.",
      "Safety: only the allowlisted the allowlisted private channel is accepted; no primary cutover; no secrets printed."
    ].join("\n");
  }

  const lifecycleGate = resolveNeonInFlightRunGate();
  if (!lifecycleGate.enabled) {
    throw new Error("Refusing live ingress smoke: set NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready first");
  }

  const token = readRequiredEnv(["NEON_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  const botUserId = readRequiredEnv(["NEON_DISCORD_BOT_USER_ID"]);
  const accountId = process.env["NEON_DISCORD_ACCOUNT_ID"] ?? "default";
  const guildId = readPrivateNeonCanaryId("NEON_DISCORD_INGRESS_SMOKE_GUILD_ID", "900000000000000001");
  const channelId = readPrivateNeonCanaryId("NEON_DISCORD_INGRESS_SMOKE_CHANNEL_ID", "900000000000000005");
  const nonce = `neon-ingress-codex-live-${Date.now()}`;
  const runningSignal = createOneShotSignal<string>();
  let runningStatus: INeonGatewayStatus | undefined;
  const writeLiveRun: (root: string, run: INeonGatewayShadowRun) => Promise<void> = async (root, run) => {
    await writeNeonGatewayRunLatest(root, run);

    if (run.status === "running" && run.request.contentPreview.includes(nonce)) {
      runningStatus = await readNeonGatewayStatus(root);
      runningSignal.resolve(run.runId);
    }
  };
  const errors: string[] = [];
  const adapter = createDiscordJsShadowTapAdapter();
  const harness = await createDiscordTapHarness("codex", lifecycleGate);
  const outbound = createNeonDiscordOutboundTransport({ token });
  const handle = await startNeonDiscordShadowTap({
    token,
    projectRoot: process.cwd(),
    accountId,
    adapter,
    mapMessage: (message) => mapDiscordJsMessageToEnvelope(message, accountId),
    mapInteraction: (interaction) => mapDiscordJsInteractionToSlashEnvelope(interaction, accountId),
    policy: {
      agentId: process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty",
      workspaceRoot: process.cwd(),
      mode: "read-only",
      botUserId,
      mentionPolicy: "guild",
      allowedGuildIds: [guildId],
      allowedChannelIds: [channelId],
      allowBotAuthors: true
    },
    resolveMemory: createDiscordMemoryResolver(),
    harness,
    writeRun: writeLiveRun,
    writeRunningRun: writeLiveRun,
    onEvent: (event) => {
      if (event.kind === "error") {
        errors.push(event.message);
      }
    }
  });

  try {
    await sleepMs(1_000);
    const sent = await outbound.postMessage(
      {
        channel: "discord",
        accountId,
        guildId,
        channelId
      },
      [
        `<@${botUserId}> Neonika ingress codex live smoke ${nonce}.`,
        "Use the shell to run exactly: sleep 5",
        "Then answer with exactly: Neon ingress live smoke complete."
      ].join("\n")
    );

    const runningRunId = await waitWithTimeout(
      runningSignal.promise,
      45_000,
      "Discord ingress live smoke did not observe a running RunStore row"
    );
    const terminalRun = await waitForGatewayRun(
      process.cwd(),
      (run) => run.runId === runningRunId && run.status !== "running",
      120_000
    );

    if (terminalRun.status !== "completed") {
      throw new Error(`Discord ingress live smoke run ended ${terminalRun.status}`);
    }

    const finalStatus = await readNeonGatewayStatus(process.cwd());
    const activity = await createNeonActivitySnapshot(process.cwd(), { maxRuns: 20, maxEntries: 100 });
    const activityCount = activity.entries.filter((entry) => entry.runId === terminalRun.runId).length;

    if (activityCount === 0) {
      throw new Error(`Discord ingress live smoke produced no activity entries for ${terminalRun.runId}`);
    }

    if (errors.length > 0) {
      throw new Error(`Discord ingress live smoke tap error: ${errors[0]}`);
    }

    return [
      "Neonika Discord ingress codex live smoke: ok",
      `Channel: ${channelId}`,
      `Sent message: ${sent.messageId}`,
      `Running run: ${runningRunId}`,
      `Running count observed: ${runningStatus?.runningCount ?? 0}`,
      `Terminal run: ${terminalRun.runId}/${terminalRun.status}`,
      `Activity entries: ${activityCount}`,
      `Tap accepted: ${handle.stats.accepted}`,
      `Final running count: ${finalStatus.runningCount}`,
      `Delivery: ${terminalRun.delivery.state}`,
      "Safety: private allowlisted channel, bot-author allowed only inside this smoke, no primary cutover, no secrets printed"
    ].join("\n");
  } finally {
    await outbound.close();
    await handle.close();
  }
}

async function runDiscordIngressControlLiveSmoke(): Promise<string> {
  if (!isReadyLike(process.env["NEON_DISCORD_INGRESS_CONTROL_LIVE_SMOKE"])) {
    return [
      "Neonika Discord ingress control live smoke: not-run",
      "Set NEON_DISCORD_INGRESS_CONTROL_LIVE_SMOKE=ready and NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready to run one private canary ingress turn and stop it via HTTP control.",
      "Safety: only the allowlisted the allowlisted private channel is accepted; no primary cutover; no secrets printed."
    ].join("\n");
  }

  const lifecycleGate = resolveNeonInFlightRunGate();
  if (!lifecycleGate.enabled) {
    throw new Error("Refusing control live smoke: set NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready first");
  }

  const token = readRequiredEnv(["NEON_DISCORD_BOT_TOKEN", "DISCORD_BOT_TOKEN"]);
  const botUserId = readRequiredEnv(["NEON_DISCORD_BOT_USER_ID"]);
  const accountId = process.env["NEON_DISCORD_ACCOUNT_ID"] ?? "default";
  const guildId = readPrivateNeonCanaryId("NEON_DISCORD_INGRESS_SMOKE_GUILD_ID", "900000000000000001");
  const channelId = readPrivateNeonCanaryId("NEON_DISCORD_INGRESS_SMOKE_CHANNEL_ID", "900000000000000005");
  const nonce = `neon-ingress-control-live-${Date.now()}`;
  const registry = createNeonInFlightRunRegistry({ gate: lifecycleGate });
  const abortControllers = new Map<string, AbortController>();
  const runningSignal = createOneShotSignal<string>();
  let runningStatus: INeonGatewayStatus | undefined;
  let activeClient: ICodexAppServerClient | undefined;
  let observedRunId: string | undefined;

  const runControl: INeonGatewayRunControlRuntime = {
    registry,
    control: async (request) => {
      const snapshot = registry.snapshot();
      const record = snapshot.running.find((run) => run.runId === request.runId);

      if (!record) {
        return {
          state: "not-found",
          action: request.action,
          runId: request.runId,
          reason: "run-not-active",
          interruptSent: false,
          localAbortSent: false,
          activeRuns: snapshot.activeRuns,
          safety: { outboundSent: false, primaryCutover: false }
        };
      }

      const decision = planNeonRunLifecycleAction({
        action: request.action,
        runId: request.runId,
        gate: lifecycleGate,
        record
      });
      let interruptSent = false;
      let interruptError: string | undefined;

      if (decision.state === "interrupt-ready" && activeClient && decision.interruptThreadId && decision.interruptTurnId) {
        try {
          await interruptCodexTurn(activeClient, {
            threadId: decision.interruptThreadId,
            turnId: decision.interruptTurnId
          });
          interruptSent = true;
        } catch (error) {
          interruptError = redactText(error instanceof Error ? error.message : String(error));
        }
      }

      const controller = abortControllers.get(request.runId);
      const localAbortSent = controller !== undefined && !controller.signal.aborted;

      if (localAbortSent) {
        controller.abort("neon_http_control_stop");
      }

      if (decision.state === "interrupt-ready") {
        registry.markInterrupting(request.runId);
      }

      const after = registry.snapshot();
      const accepted = decision.state === "interrupt-ready" && (interruptSent || localAbortSent);
      return {
        state: accepted ? "accepted" : decision.state === "blocked" ? "blocked" : "plan-only",
        action: request.action,
        runId: request.runId,
        reason: interruptError ? `${decision.reason}; interrupt-error=${interruptError}` : decision.reason,
        interruptSent,
        localAbortSent,
        activeRuns: after.activeRuns,
        safety: { outboundSent: false, primaryCutover: false }
      };
    }
  };

  const writeLiveRun: (root: string, run: INeonGatewayShadowRun) => Promise<void> = async (root, run) => {
    await writeNeonGatewayRunLatest(root, run);

    if (run.status === "running" && run.request.contentPreview.includes(nonce)) {
      runningStatus = await readNeonGatewayStatus(root);
      runningSignal.resolve(run.runId);
    }
  };
  const adapter = createDiscordJsShadowTapAdapter();
  const harness = createCodexAppServerHarness({
    projectRoot: process.cwd(),
    inFlightRuns: registry,
    acquireClient: async () => {
      const client = await createLocalAppServerClient();
      await client.initialize();
      activeClient = client;

      return {
        client,
        release: async () => {
          if (activeClient === client) {
            activeClient = undefined;
          }
          await client.close();
        }
      };
    },
    approvalPolicy: "never",
    sandbox: "read-only",
    turnCompletionTimeoutMs: 120_000
  });
  const outbound = createNeonDiscordOutboundTransport({ token });
  const httpHandle = await listenNeonGatewayHttpServer(
    { projectRoot: process.cwd(), runControl },
    { host: "127.0.0.1", port: 0 }
  );
  const tapHandle = await startNeonDiscordShadowTap({
    token,
    projectRoot: process.cwd(),
    accountId,
    adapter,
    mapMessage: (message) => mapDiscordJsMessageToEnvelope(message, accountId),
    mapInteraction: (interaction) => mapDiscordJsInteractionToSlashEnvelope(interaction, accountId),
    policy: {
      agentId: process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty",
      workspaceRoot: process.cwd(),
      mode: "read-only",
      botUserId,
      mentionPolicy: "guild",
      allowedGuildIds: [guildId],
      allowedChannelIds: [channelId],
      allowBotAuthors: true
    },
    resolveMemory: createDiscordMemoryResolver(),
    harness,
    writeRun: writeLiveRun,
    writeRunningRun: writeLiveRun,
    resolveAbortSignal: (runId, message) => {
      if (!message.content.includes(nonce)) {
        return undefined;
      }
      const controller = new AbortController();
      abortControllers.set(runId, controller);
      return controller.signal;
    }
  });

  try {
    await sleepMs(1_000);
    const sent = await outbound.postMessage(
      {
        channel: "discord",
        accountId,
        guildId,
        channelId
      },
      [
        `<@${botUserId}> Neonika ingress control live smoke ${nonce}.`,
        "Use the shell to run exactly: sleep 30",
        "If not interrupted, answer with exactly: Neon ingress control live smoke unexpectedly completed."
      ].join("\n")
    );
    const runningRunId = await waitWithTimeout(
      runningSignal.promise,
      45_000,
      "Discord ingress control live smoke did not observe a running RunStore row"
    );
    observedRunId = runningRunId;
    const readiness = await waitForHttpLiveSessionReadiness(httpHandle.url, runningRunId, 20_000);

    const sseFrame = await waitForActivitySseRun(`${httpHandle.url}/api/neon-activity/stream`, runningRunId, 10_000);
    const controlResponse = await fetch(`${httpHandle.url}/api/neon-runs/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop", runId: runningRunId, operatorId: "chaty" })
    });
    const controlPayload = (await controlResponse.json()) as {
      readonly state?: string;
      readonly control?: INeonGatewayRunControlHttpResult;
    };

    if (controlResponse.status !== 202 || controlPayload.control?.state !== "accepted") {
      throw new Error(`Discord ingress control live smoke stop failed with HTTP ${controlResponse.status}`);
    }

    const terminalRun = await waitForGatewayRun(
      process.cwd(),
      (run) => run.runId === runningRunId && run.status !== "running",
      120_000
    );
    const finalStatus = await readNeonGatewayStatus(process.cwd());

    if (finalStatus.runningCount !== 0) {
      throw new Error(`Discord ingress control live smoke left ${finalStatus.runningCount} running run(s)`);
    }

    return [
      "Neonika Discord ingress control live smoke: ok",
      `Channel: ${channelId}`,
      `Sent message: ${sent.messageId}`,
      `Running run: ${runningRunId}`,
      `Running count observed: ${runningStatus?.runningCount ?? 0}`,
      `HTTP readiness active runs: ${readiness.runtime.activeRuns}`,
      `HTTP readiness busy: ${readiness.runtime.busy === true}`,
      `SSE running frame: ${sseFrame.runId}/${sseFrame.entries}`,
      `HTTP stop state: ${controlPayload.control.state}`,
      `HTTP stop interrupt sent: ${controlPayload.control.interruptSent}`,
      `HTTP stop local abort sent: ${controlPayload.control.localAbortSent}`,
      `Terminal run: ${terminalRun.runId}/${terminalRun.status}`,
      `Final running count: ${finalStatus.runningCount}`,
      `Tap accepted: ${tapHandle.stats.accepted}`,
      `Delivery: ${terminalRun.delivery.state}`,
      "Safety: private allowlisted channel, HTTP loopback control only, no primary cutover, no secrets printed"
    ].join("\n");
  } finally {
    for (const controller of abortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort("neon_control_smoke_cleanup");
      }
    }
    if (observedRunId) {
      await waitForGatewayRun(
        process.cwd(),
        (run) => run.runId === observedRunId && run.status !== "running",
        10_000
      ).catch(() => undefined);
    }
    await outbound.close();
    await tapHandle.close();
    await httpHandle.close();
  }
}

function createDiscordMemoryResolver(): (message: INeonGatewayInboundMessage) => ReturnType<typeof createNeonMemoryAttachment> {
  const provider = createMergedNeonMemoryProvider();

  return async (message) => {
    return await createNeonMemoryAttachment(provider, createDiscordMemoryQuery(message), {
      maxHits: 12
    });
  };
}

function createDiscordMemoryQuery(message: INeonGatewayInboundMessage): string {
  const agent = resolveNeonAgentAttachment(message.agentId);
  const prompt = [
    message.userDisplayName ?? message.userId,
    message.agentId,
    message.content
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return agent ? buildNeonAgentMemoryQuery(agent, prompt) : prompt.slice(0, 240);
}

async function resolveDiscordGatewayContext(
  message: INeonGatewayInboundMessage
): Promise<INeonGatewayInboundMessage["context"]> {
  const snapshot = await createNeonChatSnapshot(process.cwd(), {
    channelId: message.channelId,
    maxRuns: 8
  });
  const conversation = snapshot.conversations.find((entry) => {
    return (
      entry.accountId === message.accountId &&
      entry.channelId === message.channelId &&
      (entry.guildId ?? "") === (message.guildId ?? "") &&
      (entry.threadId ?? "") === (message.threadId ?? "")
    );
  });

  if (!conversation) {
    return undefined;
  }

  return conversation.messages
    .filter((entry) => entry.messageId !== message.messageId)
    .slice(-10)
    .map((entry) => ({
      direction: entry.direction,
      agentId: entry.agentId,
      text: entry.textPreview,
      createdAt: entry.createdAt,
      ...(entry.userDisplayName ? { userDisplayName: entry.userDisplayName } : {})
    }));
}

async function createDiscordTapHarness(
  mode: string,
  lifecycleGate: ReturnType<typeof resolveNeonInFlightRunGate>,
  inFlightRuns: INeonInFlightRunRegistry = createNeonInFlightRunRegistry({ gate: lifecycleGate })
): Promise<ICodexHarness> {
  if (mode === "dry") {
    return createDryRunHarness();
  }

  if (mode === "claude") {
    return createDiscordClaudeTapHarness();
  }

  if (mode !== "codex") {
    throw new Error(`Invalid NEON_DISCORD_TAP_HARNESS: ${mode}`);
  }

  return createDiscordCodexTapHarness(inFlightRuns);
}

async function createDiscordTapHarnessRegistry(
  baseHarness: ICodexHarness,
  lifecycleGate: ReturnType<typeof resolveNeonInFlightRunGate>,
  inFlightRuns: INeonInFlightRunRegistry
): Promise<{ readonly codex: ICodexHarness; readonly claude: ICodexHarness }> {
  return {
    codex:
      baseHarness.id === "codex-app-server"
        ? baseHarness
        : createDiscordCodexTapHarness(inFlightRuns),
    claude: baseHarness.id === "claude-cli" ? baseHarness : createDiscordClaudeTapHarness()
  };
}

function createDiscordCodexTapHarness(
  inFlightRuns: INeonInFlightRunRegistry,
  override: Pick<INeonDiscordCapacityRuntime, "model" | "effort"> | undefined = undefined,
  enableCapacityUpgradeRequests = false
): ICodexHarness {
  const model = override?.model ?? readOptionalEnv("NEON_CODEX_MODEL");
  const effort = override?.effort ?? readCodexReasoningEffortEnv();
  const harness = createCodexAppServerHarness({
    projectRoot: process.cwd(),
    inFlightRuns,
    acquireClient: async () => {
      const startOptions = await createLocalAppServerStartOptions();
      return await getDiscordTapClientPool().acquire(startOptions);
    },
    approvalPolicy: readCodexApprovalPolicyEnv(),
    sandbox: readCodexSandboxEnv(),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    enableCapacityUpgradeRequests,
    turnCompletionTimeoutMs: readCodexAppServerTurnCompletionTimeoutMsEnv()
  });
  return model && effort
    ? {
        ...harness,
        runtime: {
          provider: "openai",
          runtime: "codex",
          lane: "codex-app-server",
          model,
          effort
        }
      }
    : harness;
}

function createDiscordClaudeTapHarness(
  override: { readonly model?: string; readonly effort?: TClaudeCliEffort } = {}
): ICodexHarness {
  const claudeBin = process.env["NEON_CLAUDE_BIN"]?.trim() || "claude";
  const model = override.model ?? readOptionalEnv("NEON_CLAUDE_MODEL");
  const effort = override.effort ?? readClaudeEffortEnv();
  const permissionMode = readClaudePermissionModeEnv();
  const addDirs = readOptionalCsvEnv("NEON_CLAUDE_ADD_DIRS");
  const tools = readOptionalEnv("NEON_CLAUDE_TOOLS");
  const turnCompletionTimeoutMs = readPositiveIntegerEnv("NEON_CLAUDE_TURN_COMPLETION_TIMEOUT_MS", 3_600_000);

  const harness = createClaudeCliHarness({
    acquireTransport: (spec) => {
      const transport = createClaudeProcessTransport({
        command: claudeBin,
        args: spec.args,
        cwd: spec.cwd,
        inheritEnv: true
      });

      return {
        transport,
        release: async () => {
          await transport.close();
        }
      };
    },
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(addDirs ? { addDirs } : {}),
    ...(tools ? { tools } : {}),
    turnCompletionTimeoutMs,
    firstEventTimeoutMs: readPositiveIntegerEnv(
      "NEON_CLAUDE_FIRST_EVENT_TIMEOUT_MS",
      Math.min(120_000, turnCompletionTimeoutMs)
    )
  });
  return model && effort
    ? {
        ...harness,
        runtime: {
          provider: "anthropic",
          runtime: "claude",
          lane: "claude-cli",
          model,
          effort
        }
      }
    : harness;
}

function createDiscordRuntimePickerCatalog(): readonly INeonDiscordRuntimeOption[] {
  const catalog: INeonDiscordRuntimeOption[] = Object.entries(neonDiscordCapacityRuntimes).map(
    ([tier, runtime]) => ({
      id: `codex-${tier}`,
      label: `Codex · ${runtime.model} · ${runtime.effort}`,
      description: `OpenAI · ${tier === "sol" ? "schwere" : tier === "terra" ? "normale" : "kurze"} Aufgaben`,
      ...runtime
    })
  );
  const claudeModel = readOptionalEnv("NEON_CLAUDE_MODEL");
  const claudeEffort = readClaudeEffortEnv();
  if (claudeModel && claudeEffort) {
    catalog.push({
      id: "claude-primary",
      label: `Claude · ${claudeModel} · ${claudeEffort}`,
      description: "Anthropic · Claude CLI (Session-Standard)",
      provider: "anthropic",
      runtime: "claude",
      lane: "claude-cli",
      model: claudeModel,
      effort: claudeEffort
    });
  }
  for (const preset of neonDiscordClaudeRuntimePresets) {
    const duplicate = catalog.some(
      (entry) => entry.model === preset.model && entry.effort === preset.effort
    );
    if (!duplicate) {
      catalog.push(preset);
    }
  }
  return catalog;
}

function createDiscordHarnessForRuntimeSelection(
  selection: INeonDiscordSessionRuntimeSelection,
  inFlightRuns: INeonInFlightRunRegistry
): ICodexHarness {
  if (selection.runtime === "codex") {
    const runtime = Object.values(neonDiscordCapacityRuntimes).find(
      (candidate) => candidate.model === selection.model && candidate.effort === selection.effort
    );
    if (!runtime) {
      throw new Error("Selected Codex runtime is no longer present in the live catalog");
    }
    return createDiscordCodexTapHarness(inFlightRuns, runtime, false);
  }
  return createDiscordClaudeTapHarness({
    model: selection.model,
    effort: parseClaudeEffort(selection.effort)
  });
}

function sameHarnessRuntime(
  left: INeonHarnessRuntimeMetadata,
  right: INeonHarnessRuntimeMetadata
): boolean {
  return left.provider === right.provider &&
    left.runtime === right.runtime &&
    left.lane === right.lane &&
    left.model === right.model &&
    left.effort === right.effort;
}

function readClaudePermissionModeEnv(): TClaudeCliPermissionMode | undefined {
  const raw = process.env["NEON_CLAUDE_PERMISSION_MODE"]?.trim();
  if (!raw) {
    return undefined;
  }

  if (raw === "default" || raw === "acceptEdits" || raw === "dontAsk" || raw === "bypassPermissions") {
    return raw;
  }

  throw new Error(`Invalid NEON_CLAUDE_PERMISSION_MODE: ${raw}`);
}

function readClaudeEffortEnv(): TClaudeCliEffort | undefined {
  const raw = process.env["NEON_CLAUDE_EFFORT"]?.trim();
  if (!raw) {
    return undefined;
  }

  if (raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh" || raw === "max") {
    return raw;
  }

  throw new Error(`Invalid NEON_CLAUDE_EFFORT: ${raw}`);
}

type TNeonCodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

function readCodexReasoningEffortEnv(): TNeonCodexReasoningEffort | undefined {
  const raw = process.env["NEON_CODEX_REASONING_EFFORT"]?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high" || raw === "xhigh") {
    return raw;
  }
  throw new Error(`Invalid NEON_CODEX_REASONING_EFFORT: ${raw}`);
}

function parseClaudeEffort(value: string): TClaudeCliEffort {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  throw new Error("Selected Claude effort is no longer supported");
}

async function runGatewayStatus(): Promise<string> {
  return renderGatewayStatus(await readNeonGatewayStatus(process.cwd()));
}

async function runGatewayRunStoreRescue(): Promise<string> {
  const result = await rescueNeonGatewayRunStore(process.cwd());
  return renderNeonRunStoreRescueReport(result);
}

async function runCutoverPromote(): Promise<string> {
  const projectRoot = process.cwd();
  const path = resolveNeonCutoverPromotionPath(projectRoot);
  const candidate = sanitizeNeonCutoverPromotionEnv(process.env);
  const stage = candidate["NEON_CUTOVER_STAGE"] ?? "shadow";
  const persistKeys = Object.keys(candidate).sort();
  const enabled = process.env["NEON_CUTOVER_PROMOTE_ENABLED"]?.trim() === "ready";

  if (!enabled) {
    const existing = await readNeonCutoverPromotion(projectRoot);
    return [
      "Cutover promote: DRY RUN (set NEON_CUTOVER_PROMOTE_ENABLED=ready to persist).",
      `Would persist stage: ${stage}`,
      `Would persist keys (no secrets): ${persistKeys.length > 0 ? persistKeys.join(", ") : "none"}`,
      `Promotion file: ${path}`,
      `Currently persisted: ${existing ? existing.env["NEON_CUTOVER_STAGE"] ?? "shadow" : "none"}`
    ].join("\n");
  }

  const promotion = await writeNeonCutoverPromotion(projectRoot, process.env);
  return [renderNeonCutoverPromotionReport(promotion), `Promotion file: ${path}`].join("\n");
}

function renderGatewayStatus(status: INeonGatewayStatus): string {
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
    `Running: ${status.runningCount}`,
    `Delivery suppressed: ${status.deliverySuppressedCount}`,
    `Runs path: ${status.runsPath}`,
    ...latest
  ].join("\n");
}

async function runGatewayApiSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-gateway/status`);
    const payload = (await response.json()) as INeonGatewayStatus;

    return [
      `Gateway API: ${response.ok ? "ok" : "failed"}`,
      `URL: ${handle.url}/api/neon-gateway/status`,
      `Runs: ${payload.runCount}`,
      `Latest: ${payload.latestRun?.runId ?? "none"}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runLifecycleSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );
  const abort = new AbortController();

  try {
    const lifecycleResponse = await fetch(`${handle.url}/api/neon-gateway/lifecycle`);
    const lifecycle = (await lifecycleResponse.json()) as INeonGatewayRuntimeSnapshot;
    const eventsResponse = await fetch(`${handle.url}/api/neon-gateway/events`, {
      signal: abort.signal
    });
    const reader = eventsResponse.body?.getReader();

    if (!reader) {
      throw new Error("Lifecycle smoke could not open the event stream reader");
    }

    const eventText = await readFirstEventStreamChunk(reader);
    const frame = parseEventStreamFrame(eventText);
    await reader.cancel();
    abort.abort();

    if (!lifecycleResponse.ok || lifecycle.state !== "ready") {
      throw new Error(`Lifecycle smoke failed with HTTP ${lifecycleResponse.status}`);
    }

    if (!eventsResponse.ok || frame.event !== "neon.gateway.snapshot") {
      throw new Error(`Lifecycle event smoke failed with HTTP ${eventsResponse.status}`);
    }

    return [
      "Neonika Gateway lifecycle: ok",
      `Snapshot: ${handle.url}/api/neon-gateway/lifecycle`,
      `Events: ${handle.url}/api/neon-gateway/events`,
      `State: ${lifecycle.state}`,
      `Event: ${frame.event}#${frame.seq}`
    ].join("\n");
  } finally {
    abort.abort();
    await handle.close();
  }
}

async function runGatewayProtocolReport(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-gateway/protocol`);
    const snapshot = (await response.json()) as INeonGatewayProtocolSnapshot;

    if (!response.ok) {
      throw new Error(`Gateway protocol report failed with HTTP ${response.status}`);
    }

    return renderNeonGatewayProtocolReport(snapshot);
  } finally {
    await handle.close();
  }
}

async function runGatewayProtocolSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-gateway/protocol`);
    const snapshot = (await response.json()) as INeonGatewayProtocolSnapshot;
    const parsedRequest = parseNeonGatewayFrameJson(
      JSON.stringify({
        type: "req",
        id: "gateway-protocol-smoke",
        method: "gateway.status"
      })
    );

    if (!response.ok) {
      throw new Error(`Gateway protocol smoke failed with HTTP ${response.status}`);
    }

    if (
      snapshot.hello.type !== "hello-ok" ||
      snapshot.hello.protocol !== snapshot.protocol.version ||
      !snapshot.features.methods.includes("connect") ||
      parsedRequest.type !== "req"
    ) {
      throw new Error("Gateway protocol smoke received an invalid contract");
    }

    return [
      "Neonika Gateway protocol: ok",
      `Protocol: ${handle.url}/api/neon-gateway/protocol`,
      `WebSocket path: ${snapshot.endpoints.webSocketPath}`,
      `Hello: ${snapshot.hello.type} protocol=${snapshot.hello.protocol}`,
      `Methods: ${snapshot.features.methods.length}`,
      `Events: ${snapshot.features.events.length}`,
      `Parsed request: ${parsedRequest.method}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runGatewayWebSocketSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );
  const socket = new WebSocket(`${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`);
  const reader = createGatewayWebSocketFrameReader(socket);

  try {
    await waitForWebSocketOpen(socket);
    const challenge = await reader.read();
    const nonce = readGatewayConnectChallengeNonce(challenge);
    socket.send(
      JSON.stringify({
        type: "req",
        id: "connect-smoke",
        method: "connect",
        params: {
          nonce
        }
      })
    );
    const hello = await reader.read();
    const snapshot = await reader.read();
    socket.send(
      JSON.stringify({
        type: "req",
        id: "status-smoke",
        method: "gateway.status"
      })
    );
    const status = await reader.read();

    if (hello.type !== "res" || hello.id !== "connect-smoke" || hello.ok !== true) {
      throw new Error("Gateway WebSocket smoke did not receive hello-ok response");
    }

    if (snapshot.type !== "event" || snapshot.event !== "neon.gateway.snapshot") {
      throw new Error("Gateway WebSocket smoke did not receive snapshot event");
    }

    if (status.type !== "res" || status.id !== "status-smoke" || status.ok !== true) {
      throw new Error("Gateway WebSocket smoke did not receive status response");
    }

    return [
      "Neonika Gateway WebSocket: ok",
      `URL: ${handle.url.replace(/^http:/, "ws:")}/api/neon-gateway/ws`,
      "Challenge: connect.challenge",
      `Hello response: ${hello.id}`,
      `Snapshot: ${snapshot.event}`,
      `Status response: ${status.id}`
    ].join("\n");
  } finally {
    reader.close();
    socket.close(1000, "smoke complete");
    await handle.close();
  }
}

function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function readGatewayConnectChallengeNonce(frame: TNeonGatewayFrame): string {
  if (frame.type !== "event" || frame.event !== "connect.challenge") {
    throw new Error("Gateway WebSocket smoke did not receive connect.challenge");
  }

  const payload = frame.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Gateway WebSocket connect.challenge did not include an object payload");
  }

  const nonce = (payload as { readonly nonce?: unknown }).nonce;
  if (typeof nonce !== "string" || nonce.trim().length === 0) {
    throw new Error("Gateway WebSocket connect.challenge did not include a nonce");
  }

  return nonce;
}

interface IGatewayWebSocketFrameReader {
  read(): Promise<TNeonGatewayFrame>;
  close(): void;
}

interface IPendingGatewayWebSocketFrame {
  readonly resolve: (frame: TNeonGatewayFrame) => void;
  readonly reject: (error: unknown) => void;
}

function createGatewayWebSocketFrameReader(socket: WebSocket): IGatewayWebSocketFrameReader {
  const queue: TNeonGatewayFrame[] = [];
  const pending: IPendingGatewayWebSocketFrame[] = [];

  const onMessage = (data: WsRawData): void => {
    try {
      const frame = parseNeonGatewayFrameJson(rawDataToString(data));
      const waiter = pending.shift();

      if (waiter) {
        waiter.resolve(frame);
        return;
      }

      queue.push(frame);
    } catch (error) {
      const waiter = pending.shift();

      if (waiter) {
        waiter.reject(error);
      }
    }
  };
  const onError = (error: Error): void => {
    for (const waiter of pending.splice(0)) {
      waiter.reject(error);
    }
  };

  socket.on("message", onMessage);
  socket.on("error", onError);

  return {
    read: () => {
      const frame = queue.shift();

      if (frame) {
        return Promise.resolve(frame);
      }

      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    close: () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      for (const waiter of pending.splice(0)) {
        waiter.reject(new Error("Gateway WebSocket reader closed"));
      }
    }
  };
}

function rawDataToString(data: WsRawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return data.toString("utf8");
}

async function readFirstEventStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for (let index = 0; index < 10; index += 1) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    buffer += decoder.decode(result.value, { stream: true });

    if (hasCompleteEventStreamDataBlock(buffer)) {
      return buffer;
    }
  }

  throw new Error("Lifecycle event stream did not emit an event frame");
}

function hasCompleteEventStreamDataBlock(raw: string): boolean {
  return raw.split("\n\n").some((block) => block.split("\n").some((line) => line.startsWith("data: ")));
}

function parseEventStreamFrame(raw: string): INeonGatewayRuntimeEventFrame {
  const dataLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data: "));

  if (!dataLine) {
    throw new Error("Lifecycle event stream did not include a data frame");
  }

  const parsed = JSON.parse(dataLine.slice("data: ".length)) as unknown;

  if (!isRuntimeEventFrame(parsed)) {
    throw new Error("Lifecycle event stream returned a malformed event frame");
  }

  return parsed;
}

function isRuntimeEventFrame(value: unknown): value is INeonGatewayRuntimeEventFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const frame = value as {
    readonly type?: unknown;
    readonly event?: unknown;
    readonly seq?: unknown;
    readonly payload?: unknown;
  };

  return (
    frame.type === "event" &&
    typeof frame.event === "string" &&
    typeof frame.seq === "number" &&
    Boolean(frame.payload)
  );
}

async function runRouteInspect(): Promise<string> {
  const snapshot = await createNeonGatewayRouteInspectionSnapshot(process.cwd());

  return renderNeonGatewayRouteInspectionReport(snapshot);
}

async function runRoutesSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-gateway/routes`);
    const payload = (await response.json()) as INeonGatewayRouteInspectionSnapshot;
    const token = process.env["NEON_DISCORD_BOT_TOKEN"]?.trim();
    const serialized = JSON.stringify(payload);

    if (!response.ok || payload.routes.length === 0) {
      throw new Error(`Routes smoke failed with HTTP ${response.status}`);
    }

    if (token && serialized.includes(token)) {
      throw new Error("Routes smoke detected a secret value in the API payload");
    }

    return [
      "Routes API: ok",
      `URL: ${handle.url}/api/neon-gateway/routes`,
      `State: ${payload.state}`,
      `Routes: ${payload.routes.length}`,
      `Allowlist: guilds=${payload.allowlist.guilds.count} channels=${payload.allowlist.channels.count}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runChannelRegistry(): Promise<string> {
  const snapshot = await createNeonChannelRegistrySnapshot(process.cwd());

  return renderNeonChannelRegistryReport(snapshot);
}

async function runChannelRegistrySmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-channels`);
    const payload = (await response.json()) as INeonChannelRegistrySnapshot;
    const token = process.env["NEON_DISCORD_BOT_TOKEN"]?.trim();
    const serialized = JSON.stringify(payload);

    if (!response.ok || payload.entries.length === 0) {
      throw new Error(`Channel registry smoke failed with HTTP ${response.status}`);
    }

    const discord = payload.entries.find((entry) => entry.manifest.id === "discord");

    if (!discord || discord.runtime.liveStatus !== "live") {
      throw new Error("Channel registry smoke missing the live Discord channel");
    }

    if (payload.entries.some((entry) => entry.runtime.delivery !== "suppressed")) {
      throw new Error("Channel registry smoke found a non-suppressed outbound posture");
    }

    if (token && serialized.includes(token)) {
      throw new Error("Channel registry smoke detected a secret value in the API payload");
    }

    return [
      "Channels API: ok",
      `URL: ${handle.url}/api/neon-channels`,
      `State: ${payload.state}`,
      `Channels: total=${payload.totals.total} live=${payload.totals.live} gated=${payload.totals.gated}`,
      `Discord: ${discord.runtime.liveStatus} delivery=${discord.runtime.delivery}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runChatReport(): Promise<string> {
  const snapshot = await createNeonChatSnapshot(process.cwd(), {
    maxRuns: 20
  });

  return renderNeonChatReport(snapshot);
}

async function runChatSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-chat-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-chat/conversations?limit=5`);
      const payload = (await response.json()) as INeonChatSnapshot;

      if (!response.ok || payload.state !== "ready" || payload.totals.conversations !== 1) {
        throw new Error(`Chat smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Chat API: ok",
        `URL: ${handle.url}/api/neon-chat/conversations`,
        `Conversations: ${payload.totals.conversations}`,
        `Messages: ${payload.totals.messages}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runSessionsReport(): Promise<string> {
  const snapshot = await createNeonSessionsSnapshot(process.cwd(), {
    maxRuns: 50
  });

  return renderNeonSessionsReport(snapshot);
}

async function runSessionsSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-sessions-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-sessions?limit=5`);
      const payload = (await response.json()) as INeonSessionsSnapshot;

      if (!response.ok || payload.state !== "ready" || payload.totals.sessions !== 1) {
        throw new Error(`Sessions smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Sessions API: ok",
        `URL: ${handle.url}/api/neon-sessions`,
        `Sessions: ${payload.totals.sessions}`,
        `Runs: ${payload.totals.runs}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runIndexerReport(): Promise<string> {
  const snapshot = await createNeonIndexerSnapshot(process.cwd(), {
    maxRuns: 50
  });

  return renderNeonIndexerReport(snapshot);
}

async function runIndexerSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-indexer-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-indexer?limit=5`);
      const payload = (await response.json()) as Awaited<ReturnType<typeof createNeonIndexerSnapshot>>;

      if (
        !response.ok ||
        payload.state !== "ready" ||
        payload.totals.sessions !== 1 ||
        payload.totals.candidates !== 1 ||
        payload.totals.decisionSignals !== 1
      ) {
        throw new Error(`Indexer smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Indexer API: ok",
        `URL: ${handle.url}/api/neon-indexer`,
        `Sessions: ${payload.totals.sessions}`,
        `Runs: ${payload.totals.runs}`,
        `Decision candidates: ${payload.totals.candidates} (${payload.totals.decisionSignals} signal(s))`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runTranscriptReport(): Promise<string> {
  const snapshot = await createNeonTranscriptSnapshot({
    maxSessions: 50
  });

  return renderNeonTranscriptReport(snapshot);
}

async function runTranscriptSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-transcript-smoke-"));
  const projectsDir = await mkdtemp(join(tmpdir(), "neonika-transcript-projects-"));

  try {
    // A controlled fixture session carrying a secret + a path, so the smoke
    // proves redaction over the real HTTP boundary, not just the unit path.
    const sessionDir = join(projectsDir, "-Users-smoke-neon-projects-demo");
    await mkdir(sessionDir, { recursive: true });
    const padding = "Body padded above the 200-byte floor for the scanner. ".repeat(4);
    const lines = [
      JSON.stringify({ type: "user", message: `Kick off the deploy. ${padding}` }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: `Deployed with ghp_aBcD1234567890aBcD1234567890aBcD12 to /Users/smoke/app done. ${padding}`
            }
          ]
        }
      })
    ];
    await writeFile(join(sessionDir, "smoke-session.jsonl"), lines.join("\n") + "\n", "utf8");

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot,
        transcriptProjectsDir: projectsDir
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-transcript?limit=5`);
      const payload = (await response.json()) as Awaited<ReturnType<typeof createNeonTranscriptSnapshot>>;
      const serialized = JSON.stringify(payload);

      if (
        !response.ok ||
        payload.state !== "ready" ||
        payload.totals.sessions !== 1 ||
        payload.totals.messages !== 2 ||
        /ghp_aBcD/u.test(serialized) ||
        /Users\/smoke\/app/u.test(serialized)
      ) {
        throw new Error(`Transcript smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Transcript API: ok",
        `URL: ${handle.url}/api/neon-transcript`,
        `Sessions: ${payload.totals.sessions}`,
        `Messages: ${payload.totals.messages}`,
        `Projects: ${payload.totals.projects} (subagent sessions: ${payload.totals.subagentSessions})`,
        "Redaction: secret + path stripped over the HTTP boundary"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
    await rm(projectsDir, { force: true, recursive: true });
  }
}

async function runLlmGateReport(): Promise<string> {
  return renderNeonLlmGateReport(resolveNeonLlmGate());
}

async function runLlmGateSmoke(): Promise<string> {
  // The default invoker must be constructively no-call. Prove it: dry-run invoker
  // returns called=false even with the env flag armed in this process.
  const invoker = createNeonDryRunLlmInvoker();
  const result = await invoker.invoke({ prompt: "smoke", model: "haiku" });

  if (result.called) {
    throw new Error("LLM gate smoke failed: default invoker reported a model call");
  }

  const gate = resolveNeonLlmGate();
  return [
    "Neonika LLM gate smoke: ok",
    `Default invoker called: ${result.called}`,
    `Gate: ${gate.reason} (env ${gate.envKey})`,
    "Transport: claude -p Max-Plan CLI only (never api.anthropic.com)"
  ].join("\n");
}

async function buildTranscriptProposals(forceDryRun = false): Promise<INeonTranscriptProposal[]> {
  // includeMessages arms the voice-detector path: proposals see the redacted
  // per-turn chat log instead of only the latest preview.
  const snapshot = await createNeonTranscriptSnapshot({ maxSessions: 5, includeMessages: true });
  const gate = resolveNeonLlmGate();
  // Armed gate -> real claude -p runner (Max-Plan CLI, never HTTP). Smokes and
  // the default env stay constructively no-call. forceDryRun keeps the smokes
  // deterministic even in an armed shell.
  const invoker =
    !forceDryRun && gate.enabled
      ? createNeonClaudeCliLlmInvoker({ gate, runner: createNeonClaudeCliProcessRunner() })
      : createNeonDryRunLlmInvoker();

  const proposals: INeonTranscriptProposal[] = [];
  for (const session of snapshot.sessions) {
    proposals.push(await runNeonTranscriptSummaryProposal({ session, invoker, gate }));
    proposals.push(...(await runNeonTranscriptDecisionProposals({ session, invoker, gate })));
  }
  return proposals;
}

async function runTranscriptProposalsReport(): Promise<string> {
  return renderNeonTranscriptProposalReport(await buildTranscriptProposals());
}

async function runTranscriptProposalsSmoke(): Promise<string> {
  const proposals = await buildTranscriptProposals(true);

  const wrote = proposals.some((proposal) => proposal.safety.memoryWritten);
  const called = proposals.some((proposal) => proposal.state === "proposed");
  if (wrote || called) {
    throw new Error("Transcript proposals smoke failed: a proposal called a model or wrote memory by default");
  }

  return [
    "Neonika Transcript proposals smoke: ok",
    `Proposals: ${proposals.length} (all planned, default dry-run)`,
    "Memory written: false · Model called: false",
    "Arming requires NEON_TRANSCRIPT_LLM_ENABLED + an injected runner"
  ].join("\n");
}

async function buildTranscriptPersistResults(
  forceDryRun = false
): Promise<INeonTranscriptPersistResult[]> {
  const proposals = await buildTranscriptProposals(forceDryRun);
  const arming = resolveNeonTranscriptArming();
  const productive = !forceDryRun && arming.persistArmed && arming.storePath !== null;

  const results: INeonTranscriptPersistResult[] = [];
  for (const proposal of proposals) {
    // Default dry-run: prints what WOULD persist, writes nothing. Productive
    // needs NEON_MEMORY_WRITE_ENABLED + NEON_TRANSCRIPT_STORE_PATH (isolated
    // JSON store — the real semantic DB is unreachable by construction).
    results.push(
      await promoteNeonTranscriptProposal({
        proposal,
        memoryGate: arming.memoryGate,
        ...(productive && arming.storePath !== null
          ? { mode: "productive" as const, storePath: arming.storePath }
          : {})
      })
    );
  }
  return results;
}

async function runTranscriptPersistReport(): Promise<string> {
  return renderNeonTranscriptPersistReport(await buildTranscriptPersistResults());
}

async function runTranscriptPersistSmoke(): Promise<string> {
  const results = await buildTranscriptPersistResults(true);

  const wrote = results.some((result) => result.state === "written" || result.entryId !== undefined);
  if (wrote) {
    throw new Error("Transcript persist smoke failed: an entry was written without the memory-write gate");
  }

  return [
    "Neonika Transcript persist smoke: ok",
    `Results: ${results.length} (nothing written)`,
    "Productive write requires NEON_MEMORY_WRITE_ENABLED + an explicit isolated storePath",
    "Idempotent: content-hash dedupe skips re-runs"
  ].join("\n");
}

async function runTranscriptScheduleReport(): Promise<string> {
  return renderNeonTranscriptScheduleIntentReport(buildNeonTranscriptScheduleIntent());
}

async function runTranscriptScheduleSmoke(): Promise<string> {
  const intent = buildNeonTranscriptScheduleIntent();

  if (intent.safety.executed || intent.safety.timerStarted || intent.safety.outboundSent) {
    throw new Error("Transcript schedule smoke failed: a side effect was marked active");
  }

  return [
    "Neonika Transcript schedule smoke: ok",
    `Job: ${intent.jobId} every ${intent.cadenceMinutes} min`,
    `Gate: ${intent.gateReason}, would-emit: ${intent.wouldEmit}`,
    "Executed: false · Timer started: false (intent is descriptive only)"
  ].join("\n");
}

async function runLiveIndexSyncReport(): Promise<string> {
  const dbPath = process.env["NEON_LIVE_INDEX_MEMORY_DB_PATH"]?.trim();
  const gate = resolveNeonMemoryDbWriteGate(process.env);
  const result = await runNeonLiveIndexMemorySync({
    projectRoot: process.cwd(),
    gate,
    allowRealDb: isReadyLike(process.env["NEON_LIVE_INDEX_ALLOW_REAL_DB"]),
    ...(dbPath ? { dbPath } : {}),
    // Canonical embedder (768d) - hash-local vectors are dimension-incompatible
    // with the Ollama query embedding and would silently disable hybrid recall.
    ...(dbPath && gate.enabled ? { embedder: createNeonOllamaEmbeddingProvider({ model: "nomic-embed-text" }) } : {})
  });

  return renderNeonLiveIndexMemorySyncReport(result);
}

async function runLiveIndexSyncSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-live-index-sync-"));
  const transcriptProjectsDir = join(projectRoot, "claude-projects");
  const codexSessionsDir = join(projectRoot, "codex-sessions");
  const dbPath = join(projectRoot, "isolated-semantic-memory.db");
  const now = (): Date => new Date("2026-06-08T12:00:00.000Z");

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));
    await writeLiveIndexTranscriptFixture(transcriptProjectsDir);
    await writeLiveIndexCodexFixture(codexSessionsDir);

    const result = await runNeonLiveIndexMemorySync({
      projectRoot,
      transcriptProjectsDir,
      codexSessionsDir,
      dbPath,
      gate: resolveNeonMemoryDbWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
      embedder: createNeonLocalEmbeddingProvider(),
      now
    });
    const written = result.writes.filter((write) => write.state === "written").length;
    const roundtrip = searchNeonMemoryDb("Codex", { dbPath, category: "live-index", limit: 5 });

    if (
      result.collection.totals.discord !== 1 ||
      result.collection.totals.claude !== 1 ||
      result.collection.totals.codex !== 1 ||
      written !== 3 ||
      roundtrip.length === 0 ||
      result.safety.targetedRealMemoryDb
    ) {
      throw new Error("Live-index sync smoke failed");
    }

    return [
      "Neonika Live Index Sync smoke: ok",
      `Sources: discord=${result.collection.totals.discord} claude=${result.collection.totals.claude} codex=${result.collection.totals.codex}`,
      `Written: ${written} record(s) to isolated DB`,
      `FTS roundtrip hits: ${roundtrip.length}`,
      "Real semantic-memory DB touched: false"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runLiveIndexDaemonReport(): Promise<string> {
  const dbPath = process.env["NEON_LIVE_INDEX_MEMORY_DB_PATH"]?.trim();
  const gate = resolveNeonMemoryDbWriteGate(process.env);
  const snapshot = await scanNeonLiveIndexDaemon({
    ...resolveNeonLiveIndexDaemonOptionsFromEnv(process.cwd()),
    ...(dbPath ? { memoryDbPath: dbPath, memoryGate: gate } : {}),
    ...(dbPath && gate.enabled ? { embedder: createNeonOllamaEmbeddingProvider({ model: "nomic-embed-text" }) } : {}),
    allowRealMemoryDb: isReadyLike(process.env["NEON_LIVE_INDEX_ALLOW_REAL_DB"]),
    reason: "cli"
  });

  return renderNeonLiveIndexDaemonReport(snapshot);
}

async function runLiveIndexProductionCheck(): Promise<string> {
  const dbPath = process.env["NEON_LIVE_INDEX_MEMORY_DB_PATH"]?.trim();
  const daemonEnabled = isReadyLike(process.env["NEON_LIVE_INDEX_DAEMON_ENABLED"]);
  const memoryGate = resolveNeonMemoryDbWriteGate(process.env);
  const allowRealDb = isReadyLike(process.env["NEON_LIVE_INDEX_ALLOW_REAL_DB"]);
  const ready = daemonEnabled && Boolean(dbPath) && memoryGate.enabled;

  return [
    `Neonika Live Index Production: ${ready ? "ready" : "blocked"}`,
    `Daemon interval: ${daemonEnabled ? "enabled" : "disabled"}`,
    `Memory DB path: ${dbPath ? "configured" : "missing"}`,
    `Memory write gate: ${memoryGate.enabled ? "enabled" : "disabled"} (${memoryGate.reason})`,
    `Real memory DB allowed: ${allowRealDb}`,
    "Required env:",
    "- NEON_LIVE_INDEX_DAEMON_ENABLED=ready",
    "- NEON_MEMORY_WRITE_ENABLED=ready",
    "- NEON_LIVE_INDEX_MEMORY_DB_PATH=/path/to/semantic-memory.db",
    "- NEON_LIVE_INDEX_ALLOW_REAL_DB=ready only when the target is the real semantic-memory.db"
  ].join("\n");
}

async function runLiveIndexDaemonSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-live-index-daemon-"));
  const transcriptProjectsDir = join(projectRoot, "claude-projects");
  const codexSessionsDir = join(projectRoot, "codex-sessions");
  const now = (): Date => new Date("2026-06-08T12:00:00.000Z");

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));
    await writeLiveIndexTranscriptFixture(transcriptProjectsDir);
    await writeLiveIndexCodexFixture(codexSessionsDir);

    const first = await scanNeonLiveIndexDaemon({
      projectRoot,
      transcriptProjectsDir,
      codexSessionsDir,
      now,
      reason: "smoke"
    });
    const second = await scanNeonLiveIndexDaemon({
      projectRoot,
      transcriptProjectsDir,
      codexSessionsDir,
      now,
      reason: "smoke"
    });

    if (
      first.collection?.totals.discord !== 1 ||
      first.collection.totals.claude !== 1 ||
      first.collection.totals.codex !== 1 ||
      first.state?.sources.discord.changed !== 1 ||
      first.state.sources.claude.changed !== 1 ||
      first.state.sources.codex.changed !== 1 ||
      second.state?.sources.discord.unchanged !== 1 ||
      second.state.sources.claude.unchanged !== 1 ||
      second.state.sources.codex.unchanged !== 1
    ) {
      throw new Error("Live-index daemon smoke failed");
    }

    return [
      "Neonika Live Index Daemon smoke: ok",
      `Sources: discord=${first.collection.totals.discord} claude=${first.collection.totals.claude} codex=${first.collection.totals.codex}`,
      `First scan changed: ${first.state.sources.discord.changed + first.state.sources.claude.changed + first.state.sources.codex.changed}`,
      `Second scan unchanged: ${second.state.sources.discord.unchanged + second.state.sources.claude.unchanged + second.state.sources.codex.unchanged}`,
      `State: ${first.statePath}`,
      `Metrics: ${first.metricsPath}`
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function writeLiveIndexTranscriptFixture(projectsDir: string): Promise<void> {
  const sessionDir = join(projectsDir, "-Users-smoke-neon-projects-live-index");
  await mkdir(sessionDir, { recursive: true });
  const padding = "Transcript fixture text above scanner byte floor. ".repeat(6);
  const lines = [
    JSON.stringify({ type: "user", message: `Bitte merke die Cloud-Session. ${padding}` }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: `Cloud digest ready with secret sk-liveindex1234567890abcdef and path /Users/smoke/secret.txt. ${padding}`
          }
        ]
      }
    })
  ];
  await writeFile(join(sessionDir, "claude-live-index.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function writeLiveIndexCodexFixture(sessionsDir: string): Promise<void> {
  const sessionDir = join(sessionsDir, "2026", "06", "08");
  await mkdir(sessionDir, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-06-08T12:00:00.000Z",
      payload: {
        id: "codex-live-index-session",
        cwd: "/Users/smoke/neonika"
      }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-08T12:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Bitte sammle diese Codex-Session für Memory." }]
      }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-06-08T12:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Codex summary ready without touching real memory." }]
      }
    })
  ];
  await writeFile(join(sessionDir, "codex-live-index-session.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

async function runActivityReport(): Promise<string> {
  const snapshot = await createNeonActivitySnapshot(process.cwd(), {
    maxEntries: 50,
    maxRuns: 50
  });

  return renderNeonActivityReport(snapshot);
}

async function runActivitySmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-activity-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-activity?limit=20`);
      const payload = (await response.json()) as INeonActivitySnapshot;

      if (!response.ok || payload.state !== "ready" || payload.totals.entries < 4) {
        throw new Error(`Activity smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Activity API: ok",
        `URL: ${handle.url}/api/neon-activity`,
        `Entries: ${payload.totals.entries}`,
        `Runs: ${payload.totals.runs}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function isNeonActivityStatus(value: string | undefined): value is TNeonActivityStatus {
  return value === "running" || value === "done" || value === "error";
}

function isNeonActivityKind(value: string | undefined): value is TNeonActivityEntryKind {
  switch (value) {
    case "inbound":
    case "run":
    case "assistant":
    case "tool":
    case "file":
    case "command":
    case "usage":
    case "delivery":
    case "memory":
      return true;
    default:
      return false;
  }
}

function readMissionControlFilterArguments(): INeonMissionControlFilterCriteria {
  const args = process.argv.slice(3);
  const flags = new Map<string, string>();
  for (let index = 0; index + 1 < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key?.startsWith("--") && value !== undefined && !value.startsWith("--")) {
      flags.set(key.slice(2), value);
    }
  }

  const search = flags.get("search");
  const agentId = flags.get("agent");
  const tool = flags.get("tool");
  const status = flags.get("status");
  const kind = flags.get("kind");

  return {
    ...(search ? { search } : {}),
    ...(agentId ? { agentId } : {}),
    ...(tool ? { tool } : {}),
    ...(isNeonActivityStatus(status) ? { status } : {}),
    ...(isNeonActivityKind(kind) ? { kind } : {})
  };
}

async function runMissionControlFilterReport(): Promise<string> {
  const criteria = readMissionControlFilterArguments();
  const snapshot = await createNeonActivitySnapshot(process.cwd(), {
    maxEntries: 100,
    maxRuns: 100
  });
  const result = filterNeonMissionControlActivity(snapshot.entries, criteria);

  return [
    `Source: gateway activity snapshot (${snapshot.state}, ${snapshot.totals.entries} entries)`,
    renderNeonMissionControlFilterReport(result)
  ].join("\n");
}

async function runMissionControlFilterSmoke(): Promise<string> {
  const criteria = readMissionControlFilterArguments();
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-mc-filter-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));
    const snapshot = await createNeonActivitySnapshot(projectRoot, {
      maxEntries: 100,
      maxRuns: 100
    });
    const result = filterNeonMissionControlActivity(snapshot.entries, criteria);

    return [
      `Source: seeded gateway run (${snapshot.state}, ${snapshot.totals.entries} entries)`,
      renderNeonMissionControlFilterReport(result)
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runReplayReport(): Promise<string> {
  const runId = readOptionalEnv("NEON_REPLAY_RUN_ID");
  const sessionKey = readOptionalEnv("NEON_REPLAY_SESSION_KEY");
  const conversationId = readOptionalEnv("NEON_REPLAY_CONVERSATION_ID");
  const channelId = readOptionalEnv("NEON_REPLAY_CHANNEL_ID");
  const snapshot = await createNeonReplaySnapshot(process.cwd(), {
    maxRuns: 50,
    maxEventsPerRun: 50,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(channelId ? { channelId } : {})
  });

  return renderNeonReplayReport(snapshot);
}

async function runReplaySmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-replay-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createReplaySmokeRun(projectRoot));

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-replay?runId=replay-smoke-run&events=10`);
      const payload = (await response.json()) as INeonReplaySnapshot;
      const serialized = JSON.stringify(payload);
      const latest = payload.runs[0];

      if (
        !response.ok ||
        payload.state !== "ready" ||
        latest?.runId !== "replay-smoke-run" ||
        !latest.events.some((event) => event.kind === "tool-output") ||
        /sk-replay-secret-value/u.test(serialized)
      ) {
        throw new Error(`Replay smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Replay API: ok",
        `URL: ${handle.url}/api/neon-replay`,
        `Run: ${latest.runId}`,
        `Events: ${latest.events.length}`,
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runSkillsReport(): Promise<string> {
  const snapshot = await createNeonSkillInventorySnapshot(process.cwd());

  return renderNeonSkillInventoryReport(snapshot);
}

async function runSkillCommandsReport(): Promise<string> {
  const snapshot = await createNeonSkillInventorySnapshot(process.cwd());
  const catalog = createNeonSkillCommandCatalog(snapshot.skills);

  return renderNeonSkillCommandCatalogReport(catalog);
}

async function runChatCompletionsSmoke(): Promise<string> {
  const prefix = readTrailingArgument("/skill:");
  const snapshot = await createNeonSkillInventorySnapshot(process.cwd());
  const catalog = createNeonSkillCommandCatalog(snapshot.skills);

  return renderNeonSlashCompletions(prefix, completeNeonSlashCommand(prefix, catalog));
}

function runCronNextRunSmoke(): string {
  const args = process.argv.slice(3);
  let nowIso: string | undefined;
  const scheduleParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--now") {
      nowIso = args[index + 1];
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      scheduleParts.push(arg);
    }
  }

  const schedule = scheduleParts.join(" ").trim() || "*/15 * * * *";
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  if (Number.isNaN(nowMs)) {
    throw new Error(`Invalid --now timestamp: ${nowIso ?? ""}`);
  }

  const runs: string[] = [];
  let cursor = nowMs;
  for (let index = 0; index < 3; index += 1) {
    const next = computeNeonNextRunAtMs(schedule, cursor);
    if (next === undefined) {
      break;
    }
    runs.push(new Date(next).toISOString());
    cursor = next;
  }

  return [
    `Cron schedule: ${describeNeonCronSchedule(schedule)}`,
    `Now (UTC): ${new Date(nowMs).toISOString()}`,
    runs.length > 0 ? "Next runs (UTC):" : "Next runs: none within look-ahead window",
    ...runs.map((run, index) => `  ${index + 1}. ${run}`)
  ].join("\n");
}

async function runSkillsSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-skills`);
    const payload = (await response.json()) as INeonSkillInventorySnapshot;

    if (!response.ok || payload.totals.roots === 0 || payload.totals.skills === 0) {
      throw new Error(`Skills smoke failed with HTTP ${response.status}`);
    }

    return [
      "Neonika Skills API: ok",
      `URL: ${handle.url}/api/neon-skills`,
      `Roots: ${payload.totals.readableRoots}/${payload.totals.roots}`,
      `Skills: ${payload.totals.skills}`,
      `Extensions: ${payload.totals.extensionManifests}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

function runToolsReport(): string {
  return renderNeonToolInventoryReport(createNeonToolInventorySnapshot({ env: process.env }));
}

function runWebSearchResolve(): string {
  const presentEnvRefs = collectPresentToolSecretRefs(process.env);
  return renderNeonWebSearchResolution(resolveNeonWebSearchProviders(presentEnvRefs));
}

async function runWebSearchSmoke(): Promise<string> {
  const args = process.argv.slice(3);
  const queryArg = args.find((arg) => !arg.startsWith("--"));
  const query = queryArg ?? "neon core open source agent runtime";
  const presentEnvRefs = collectPresentToolSecretRefs(process.env);
  const gate = resolveNeonToolsLiveGate(process.env);

  // Resolve the chosen provider + its env-ref, then read the secret VALUE at the
  // edge. The value only flows into the executor's Authorization header; it is
  // never logged or echoed here.
  const keyRef = resolveNeonWebSearchProviderKeyRef(presentEnvRefs);
  const providerKey = keyRef ? process.env[keyRef.envRef] : undefined;

  const result = await executeNeonWebSearch({
    query,
    gate,
    presentEnvRefs,
    providerKey,
    maxResults: 3
  });

  return [
    `Neonika Web-Search smoke (live gate ${gate.enabled ? "ARMED" : "closed"}, ${gate.envKey})`,
    "",
    `# "${query}"`,
    renderNeonWebSearchResult(result)
  ].join("\n");
}

function runBindingResumeSmoke(): string {
  const persisted: ICodexThreadBinding = {
    schemaVersion: 1,
    sessionKey: "neon:codex:chaty:discord:local:dm:terminal:main:demo:read-only",
    threadId: "thread-demo-abc123",
    cwd: "/Users/neon/project",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    memoryState: "attached",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    model: "gpt-5-codex"
  };
  const cases: readonly { readonly label: string; readonly spec: INeonBindingResumeSpec }[] = [
    {
      label: "same spec",
      spec: { cwd: "/Users/neon/project", approvalPolicy: "on-request", sandbox: "read-only", model: "gpt-5-codex" }
    },
    {
      label: "cwd drift",
      spec: { cwd: "/Users/neon/other", approvalPolicy: "on-request", sandbox: "read-only", model: "gpt-5-codex" }
    },
    {
      label: "sandbox drift",
      spec: { cwd: "/Users/neon/project", approvalPolicy: "on-request", sandbox: "workspace-write", model: "gpt-5-codex" }
    },
    {
      label: "approval drift",
      spec: { cwd: "/Users/neon/project", approvalPolicy: "never", sandbox: "read-only", model: "gpt-5-codex" }
    },
    {
      label: "model absent (falls back to persisted)",
      spec: { cwd: "/Users/neon/project", approvalPolicy: "on-request", sandbox: "read-only" }
    }
  ];
  const lines = [
    "Neon binding-resume decision smoke (pure; no Codex run)",
    `Persisted thread: ${persisted.threadId} (cwd ${persisted.cwd}, ${persisted.approvalPolicy}/${persisted.sandbox})`
  ];
  for (const testCase of cases) {
    const decision = evaluateNeonBindingResume(persisted, testCase.spec);
    lines.push(
      `- ${testCase.label}: ${
        decision.matches ? "RESUME (binding matches)" : `RESTART (drift: ${decision.drift.join(", ")})`
      }`
    );
  }
  return lines.join("\n");
}

function runRouteProjectionSmoke(): string {
  const identities: readonly { readonly label: string; readonly identity: INeonChannelInboundIdentity }[] = [
    {
      label: "discord guild channel",
      identity: {
        platform: "discord",
        accountId: "acct-bot",
        workspaceId: "guild-123",
        channelId: "channel-456",
        threadId: "thread-789",
        userId: "user-1",
        agentId: "chaty",
        content: "hello"
      }
    },
    {
      label: "discord direct message",
      identity: {
        platform: "discord",
        accountId: "acct-bot",
        channelId: "dm-987",
        userId: "user-2",
        agentId: "chaty",
        content: "ping"
      }
    },
    {
      label: "telegram group",
      identity: {
        platform: "telegram",
        accountId: "tg-acct",
        workspaceId: "tg-chat",
        channelId: "tg-channel",
        userId: "user-3",
        agentId: "neo",
        content: "hi"
      }
    }
  ];

  const lines = ["Neon route-projection smoke (pure; no send, target ids redacted)", "", "From accepted inbound identity:"];
  for (const entry of identities) {
    const route = neonChannelRouteFromInboundIdentity(entry.identity);
    lines.push(`- ${entry.label}: ${route ? describeNeonChannelRoute(route) : "(not routable)"}`);
  }

  const partials: readonly { readonly label: string; readonly input: INeonChannelRouteInput }[] = [
    { label: "explicit channel route", input: { channel: "discord", accountId: "a1", to: "c-explicit", chatType: "channel" } },
    { label: "unknown channel", input: { channel: "carrier-pigeon", to: "x" } },
    { label: "empty target", input: { channel: "discord", to: "   " } }
  ];
  lines.push("", "Normalize partial routes:");
  for (const entry of partials) {
    const route = normalizeNeonChannelRoute(entry.input);
    lines.push(`- ${entry.label}: ${route ? describeNeonChannelRoute(route) : "(not routable)"}`);
  }
  return lines.join("\n");
}

async function runCronStoreSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-cron-store-smoke-"));
  const now = 1_750_000_000_000;
  const lines = ["Neonika Cron-store smoke (isolated tmp store)"];

  // Default-off: gate closed -> blocked, no file written.
  const closedGate = resolveNeonCronStoreGate({});
  const blocked = await appendNeonCronStoreEvent(projectRoot, closedGate, {
    id: "demo",
    mutation: "add",
    atMs: now,
    schedule: "every-15m",
    label: "demo job"
  });
  lines.push(`== default-off == ${blocked.state} (${blocked.diagnostics[0] ?? "ok"})`);

  // Armed: CRUD against the isolated store, each validated against the projection.
  const armedGate = resolveNeonCronStoreGate({ NEON_CRON_STORE_ENABLED: "1" });
  const ops: readonly IResolveNeonCronMutationInput[] = [
    { id: "digest", mutation: "add", atMs: now, schedule: "every-60m", label: "morning digest" },
    { id: "heartbeat", mutation: "add", atMs: now + 1, schedule: "every-15m", label: "heartbeat review" },
    { id: "heartbeat", mutation: "disable", atMs: now + 2 },
    { id: "ghost", mutation: "remove", atMs: now + 3 },
    { id: "digest", mutation: "remove", atMs: now + 4 }
  ];
  for (const op of ops) {
    const current = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
    const resolved = resolveNeonCronMutation(current, op);
    if (!resolved.ok) {
      lines.push(`armed ${op.mutation} ${op.id}: rejected (${resolved.reason})`);
      continue;
    }
    const result = await appendNeonCronStoreEvent(projectRoot, armedGate, resolved.event);
    lines.push(`armed ${op.mutation} ${op.id}: ${result.state}`);
  }

  // Operator-supplied delivery target (demo ids), normalized + persisted; the
  // delivery preview below is read-only and always suppressed (no send).
  const targeted = resolveNeonCronMutation(projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot)), {
    id: "digest-discord",
    mutation: "add",
    atMs: now + 5,
    schedule: "every-60m",
    label: "digest to ops channel",
    deliveryTarget: { channel: "discord", accountId: "ops-bot", to: "demo-channel-001", chatType: "channel" }
  });
  if (targeted.ok) {
    await appendNeonCronStoreEvent(projectRoot, armedGate, targeted.event);
  }

  const finalJobs = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
  lines.push("", renderNeonCronStoreJobs(finalJobs));
  lines.push("", renderNeonCronDeliveryPreview(finalJobs));
  return lines.join("\n");
}

async function runCronCommandSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-cron-command-smoke-"));
  const now = () => new Date("2026-06-05T16:30:00.000Z");

  try {
    const off = await processNeonCronCommand(
      projectRoot,
      createCronCommandSmokeMessage("/cron add deploy-check every-15m Check deploy sk-live-SHOULD-REDACT"),
      { env: {}, now }
    );
    const armed = await processNeonCronCommand(
      projectRoot,
      createCronCommandSmokeMessage("/cron add deploy-check every-15m Check deploy sk-live-SHOULD-REDACT"),
      { env: { NEON_CRON_STORE_ENABLED: "ready" }, now }
    );
    const listed = await processNeonCronCommand(projectRoot, createCronCommandSmokeMessage("/cron list"), {
      env: { NEON_CRON_STORE_ENABLED: "ready" },
      now
    });
    const jobs = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
    const serialized = JSON.stringify({ off, armed, listed, jobs });

    if (off.state !== "blocked") {
      throw new Error(`Cron command smoke expected default-off blocked, got ${off.state}`);
    }
    if (armed.state !== "mutated") {
      throw new Error(`Cron command smoke expected armed mutation, got ${armed.state}`);
    }
    if (listed.state !== "listed") {
      throw new Error(`Cron command smoke expected list result, got ${listed.state}`);
    }
    if (jobs.length !== 1 || jobs[0]?.id !== "deploy-check") {
      throw new Error(`Cron command smoke expected one deploy-check job, got ${jobs.length}`);
    }
    if (serialized.includes("sk-live-SHOULD-REDACT")) {
      throw new Error("Cron command smoke leaked an unredacted secret-like label");
    }

    return [
      "Neonika Cron-command smoke: ok",
      `default-off: ${off.state} (${off.gate?.reason ?? "no-gate"})`,
      `armed add: ${armed.state} (${armed.appendState ?? "no-append"})`,
      `list: ${listed.state}, jobs=${listed.jobs.length}`,
      "",
      renderNeonCronStoreJobs(jobs),
      "",
      renderNeonCronDeliveryPreview(jobs),
      "safety: no harness run, no outbound send, isolated tmp store"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function createCronCommandSmokeMessage(content: string): INeonGatewayInboundMessage {
  return {
    channel: "discord",
    accountId: "default",
    channelId: "900000000000000005",
    messageId: "cron-command-smoke",
    userId: "operator",
    userDisplayName: "Operator",
    agentId: "chaty",
    workspaceRoot: "/workspace/neonika",
    mode: "read-only",
    content,
    createdAt: "2026-06-05T16:30:00.000Z",
    guildId: "900000000000000001"
  };
}

async function runWorkspaceNotesReport(): Promise<string> {
  return renderNeonWorkspaceSnapshotReport(await createNeonWorkspaceSnapshot(process.cwd()));
}

async function runWorkspaceNotesSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-workspace-notes-"));
  const now = new Date("2026-06-05T14:30:00.000Z");

  try {
    const off = await appendNeonWorkspaceNote({
      projectRoot,
      gate: resolveNeonWorkspaceNotesGate({}),
      now: () => now,
      note: {
        kind: "cron",
        title: "memory digest",
        source: "cron:memory-digest",
        body: "Would summarize local memory. Secret sk-test-1234567890 stays redacted."
      }
    });
    const armed = await appendNeonWorkspaceNote({
      projectRoot,
      gate: resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" }),
      now: () => now,
      note: {
        kind: "heartbeat",
        title: "heartbeat review",
        source: "cron:heartbeat-review",
        body: "Heartbeat review emitted a terminal shadow run-record. Delivery stayed suppressed."
      }
    });
    const snapshot = await createNeonWorkspaceSnapshot(projectRoot, { now: () => now });

    return [
      `== default-off == ${off.state} (${off.gate.reason}), paths=${off.writtenPaths.length}`,
      `== armed == ${armed.state} (${armed.gate.reason}), paths=${armed.writtenPaths.length}`,
      "",
      renderNeonWorkspaceSnapshotReport(snapshot)
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runWebFetchSmoke(): Promise<string> {
  const args = process.argv.slice(3);
  const urlArg = args.find((arg) => !arg.startsWith("--"));
  const gate = resolveNeonToolsLiveGate(process.env);
  // Default samples: one public (dry-run when gate closed), two that the SSRF
  // guard blocks before any network (cloud metadata link-local + loopback).
  const samples = urlArg
    ? [urlArg]
    : ["https://example.com/", "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8797/"];

  const lines = [`Neonika Web-Fetch smoke (live gate ${gate.enabled ? "ARMED" : "closed"}, ${gate.envKey})`];
  for (const sample of samples) {
    const result = await executeNeonWebFetch({ url: sample, gate });
    lines.push("", `# ${sample}`, renderNeonWebFetchResult(result));
  }
  return lines.join("\n");
}

async function runToolsSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-tools`);
    const payload = (await response.json()) as INeonToolInventorySnapshot;

    if (!response.ok || payload.totals.tools === 0) {
      throw new Error(`Tools smoke failed with HTTP ${response.status}`);
    }

    // Safety invariant: no tool may sit in "live" mode unless the gate is armed.
    const liveWithoutGate = payload.tools.filter(
      (tool) => tool.mode === "live" && !payload.gate.enabled
    );
    if (liveWithoutGate.length > 0) {
      throw new Error(`Tools smoke: ${liveWithoutGate.length} live tool(s) without an armed gate`);
    }

    // Leak invariant (runtime truth): no resolved secret VALUE may appear in the
    // snapshot. For every present env ref, assert its value is absent from the
    // serialized payload (the snapshot must carry ref names + counts only).
    const serialized = JSON.stringify(payload);
    const leakedRefs = payload.providers
      .flatMap((provider) => provider.envRefs)
      .filter((ref) => {
        const value = (process.env[ref] ?? "").trim();
        return value.length > 0 && serialized.includes(value);
      });
    if (leakedRefs.length > 0) {
      throw new Error(`Tools smoke: secret value leaked for ${leakedRefs.length} ref(s)`);
    }

    const liveModeTools = payload.tools.filter((tool) => tool.mode === "live").length;

    return [
      "Neonika Tools API: ok",
      `URL: ${handle.url}/api/neon-tools`,
      `Live gate: ${payload.gate.enabled ? "ARMED" : "closed"} (${payload.gate.envKey})`,
      `Tools: ${payload.totals.available}/${payload.totals.tools} available`,
      `Providers ready: ${payload.totals.providersReady}/${payload.totals.providers}`,
      `Live-mode tools: ${liveModeTools}`,
      "Leak check: no secret values in snapshot"
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runExtensionsReport(): Promise<string> {
  const snapshot = await createNeonExtensionInventorySnapshot(process.cwd());

  return renderNeonExtensionsReport(snapshot);
}

async function runExtensionsSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-extensions`);
    const payload = (await response.json()) as INeonExtensionInventorySnapshot;

    if (!response.ok || payload.totals.extensionManifests === 0) {
      throw new Error(`Extensions smoke failed with HTTP ${response.status}`);
    }

    return [
      "Neonika Extensions API: ok",
      `URL: ${handle.url}/api/neon-extensions`,
      `Extensions: ${payload.totals.extensionManifests}`,
      `Reference-only: ${payload.totals.referenceExtensions}`,
      `Invalid: ${payload.totals.invalidExtensionManifests}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

function readPluginAllowlist(): readonly string[] {
  const raw = readOptionalEnv("NEON_PLUGIN_ALLOW");
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runPluginsReport(): Promise<string> {
  const allowlist = readPluginAllowlist();
  const snapshot = await createNeonPluginInventorySnapshot(process.cwd(), {
    ...(allowlist.length > 0 ? { allowlist } : {})
  });

  return renderNeonPluginsReport(snapshot);
}

async function runPluginsSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-plugins`);
    const payload = (await response.json()) as INeonPluginInventorySnapshot;

    if (!response.ok || payload.totals.plugins === 0) {
      throw new Error(`Plugins smoke failed with HTTP ${response.status}`);
    }
    if (payload.totals.autoLoadHonored !== 0 || payload.plugins.some((plugin) => plugin.autoLoadHonored !== false)) {
      throw new Error("Plugins smoke failed: auto-load invariant violated");
    }

    return [
      "Neonika Plugins API: ok",
      `URL: ${handle.url}/api/neon-plugins`,
      `Plugins: ${payload.totals.plugins}`,
      `Install gate: ${payload.installGate.enabled ? "enabled" : "disabled"} (${payload.installGate.flag})`,
      `Trust: ${payload.totals.referenceOnly} reference-only / ${payload.totals.allowlisted} allowlisted / ${payload.totals.blocked} blocked`,
      `Auto-load declared: ${payload.totals.autoLoadDeclared} / honored: ${payload.totals.autoLoadHonored}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runPluginInstallPlan(): Promise<string> {
  const pluginId = readOptionalEnv("NEON_PLUGIN_ID") ?? "discord";
  const rawAction = readOptionalEnv("NEON_PLUGIN_ACTION");
  const action = rawAction === "enable" || rawAction === "load" || rawAction === "install" ? rawAction : undefined;
  const allowlist = readPluginAllowlist();

  const result: INeonPluginInstallPlanResult = await resolveNeonPluginInstallPlan({
    pluginId,
    ...(action ? { action } : {}),
    ...(allowlist.length > 0 ? { allowlist } : {})
  });

  return renderNeonPluginInstallPlanReport(result);
}

async function runSkillPolicySmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-skills/policy`);
    const payload = (await response.json()) as {
      readonly policy: INeonAgentSkillPolicyResult;
    };
    const policy = payload.policy;

    if (
      !response.ok ||
      !policy ||
      policy.decisions.length === 0 ||
      policy.denied.length > 0 ||
      policy.allowed.length !== policy.decisions.length
    ) {
      throw new Error(`Skill policy smoke failed with HTTP ${response.status}`);
    }

    return [
      "Neonika Skill Policy API: ok",
      `URL: ${handle.url}/api/neon-skills/policy`,
      `Agent: ${policy.agentId} (resolved=${policy.agentResolved})`,
      `Policy enabled: ${policy.policyEnabled}`,
      `Default-allow: ${policy.allowed.length}/${policy.decisions.length} skills allowed`,
      `Denied: ${policy.denied.length}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runCutoverGate(): Promise<string> {
  const snapshot = await createNeonCutoverGateSnapshot(process.cwd());

  return renderNeonCutoverGateReport(snapshot);
}

async function runCutoverRetireSmoke(): Promise<string> {
  const runs = await readNeonGatewayRuns(process.cwd(), { maxRuns: 500 });
  const result = verifyNeonRetireRoundTrip(runs, new Date().toISOString());

  return renderNeonRetireRoundTripReport(result);
}

function createChatSmokeRun(projectRoot: string): INeonGatewayShadowRun {
  return {
    runId: "chat-smoke-run",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      threadId: "chat-smoke-thread",
      messageId: "chat-smoke-message",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "read-only",
      contentPreview: "Zeig mir den Discord Chat in Mission Control",
      receivedAt: "2026-05-31T21:40:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:900000000000000001:900000000000000005:chat-smoke:hash:read-only",
    memoryState: "attached",
    events: [
      {
        kind: "final",
        text: "Chat ist als Operator-View sichtbar."
      }
    ],
    finalText: "Chat ist als Operator-View sichtbar.",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "Chat ist als Operator-View sichtbar."
    },
    startedAt: "2026-05-31T21:40:00.000Z",
    completedAt: "2026-05-31T21:40:01.000Z"
  };
}

function createReplaySmokeRun(projectRoot: string): INeonGatewayShadowRun {
  const run = createChatSmokeRun(projectRoot);

  return {
    ...run,
    runId: "replay-smoke-run",
    events: [
      {
        kind: "tool-start",
        toolName: "codex"
      },
      {
        kind: "tool-output",
        toolName: "codex",
        output: "finished with token sk-replay-secret-value"
      },
      {
        command: "node dist/src/cli.js activity-smoke",
        exitCode: 0,
        kind: "command-exit"
      },
      {
        kind: "final",
        text: "Replay detail is visible with sk-replay-secret-value redacted."
      }
    ],
    finalText: "Replay detail is visible with sk-replay-secret-value redacted.",
    delivery: {
      ...run.delivery,
      finalText: "Replay detail is visible with sk-replay-secret-value redacted."
    }
  };
}

async function runCutoverSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-cutover`);
    const payload = (await response.json()) as INeonCutoverGateSnapshot;
    const token = process.env["NEON_DISCORD_BOT_TOKEN"]?.trim();
    const serialized = JSON.stringify(payload);

    if (!response.ok || payload.gates.length !== 5) {
      throw new Error(`Cutover smoke failed with HTTP ${response.status}`);
    }

    if (token && serialized.includes(token)) {
      throw new Error("Cutover smoke detected a secret value in the API payload");
    }

    return [
      "Cutover API: ok",
      `URL: ${handle.url}/api/neon-cutover`,
      `State: ${payload.state}`,
      `Current: ${payload.currentStage}`,
      `Gates: ${payload.gates.length}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runMirrorEvidence(): Promise<string> {
  const snapshot = await createNeonMirrorEvidenceSnapshot(process.cwd(), {
    maxRecords: 10
  });

  return renderNeonMirrorEvidenceReport(snapshot);
}

async function runMirrorRecord(): Promise<string> {
  const verdict = readMirrorVerdict(readRequiredEnv(["NEON_MIRROR_VERDICT"]));
  let input: INeonMirrorEvidenceInput = {
    prompt: readRequiredEnv(["NEON_MIRROR_PROMPT"]),
    legacyOutput: readRequiredEnv(["NEON_MIRROR_LEGACY_OUTPUT"]),
    neonOutput: readRequiredEnv(["NEON_MIRROR_NEON_OUTPUT"]),
    verdict
  };
  const legacyLatencyMs = readOptionalNumberEnv("NEON_MIRROR_LEGACY_LATENCY_MS");
  const neonLatencyMs = readOptionalNumberEnv("NEON_MIRROR_NEON_LATENCY_MS");
  const legacyRunId = readOptionalEnv("NEON_MIRROR_LEGACY_RUN_ID");
  const neonRunId = readOptionalEnv("NEON_MIRROR_NEON_RUN_ID");
  const reviewer = readOptionalEnv("NEON_MIRROR_REVIEWER");
  const notes = readOptionalEnv("NEON_MIRROR_NOTES");

  if (legacyLatencyMs !== undefined) {
    input = { ...input, legacyLatencyMs };
  }

  if (neonLatencyMs !== undefined) {
    input = { ...input, neonLatencyMs };
  }

  if (legacyRunId !== undefined) {
    input = { ...input, legacyRunId };
  }

  if (neonRunId !== undefined) {
    input = { ...input, neonRunId };
  }

  if (reviewer !== undefined) {
    input = { ...input, reviewer };
  }

  if (notes !== undefined) {
    input = { ...input, notes };
  }

  const record = await writeNeonMirrorEvidence(process.cwd(), input);

  return [
    "Mirror evidence recorded: ok",
    `Evidence: ${record.evidenceId}`,
    `Verdict: ${record.verdict}`,
    `Prompt hash: ${record.promptHash}`
  ].join("\n");
}

async function runMirrorSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-mirror-smoke-"));

  try {
    await writeNeonMirrorEvidence(projectRoot, {
      evidenceId: "mirror-smoke-evidence",
      prompt: "Compare Neonika shadow response against legacy response.",
      legacyOutput: "Legacy path confirms the task and keeps delivery controlled.",
      neonOutput: "Neon path confirms the task and keeps delivery controlled.",
      verdict: "acceptable",
      legacyLatencyMs: 1200,
      neonLatencyMs: 900,
      reviewer: "chaty",
      now: () => new Date("2026-05-31T21:20:00.000Z")
    });

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-mirror/evidence`);
      const payload = (await response.json()) as INeonMirrorEvidenceSnapshot;

      if (!response.ok || payload.state !== "ready" || payload.totals.accepted !== 1) {
        throw new Error(`Mirror smoke failed with HTTP ${response.status}`);
      }

      return [
        "Mirror evidence API: ok",
        `URL: ${handle.url}/api/neon-mirror/evidence`,
        `State: ${payload.state}`,
        `Records: ${payload.totals.records}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runAutomationReport(): Promise<string> {
  return renderNeonAutomationReport(await createNeonCronStoreAutomationSnapshot(process.cwd()));
}

async function runCronList(): Promise<string> {
  return renderNeonAutomationCronListReport(await createNeonCronStoreAutomationSnapshot(process.cwd()));
}

async function runCronGet(): Promise<string> {
  const args = process.argv.slice(3);
  const force = args.includes("--force");
  const jobId = args.filter((arg) => arg !== "--force").join(" ").trim();

  if (!jobId) {
    return "Usage: cron-get <jobId> [--force]";
  }

  return renderNeonAutomationCronJobReport(
    await createNeonCronStoreAutomationSnapshot(process.cwd(), {
      evaluateCronJobId: jobId,
      ...(force ? { forceCronJobId: jobId } : {})
    }),
    jobId
  );
}

async function runCronTimerSmoke(): Promise<string> {
  const args = process.argv.slice(3);
  const forceIndex = args.indexOf("--force");
  const forceJobId = forceIndex >= 0 ? args[forceIndex + 1]?.trim() : undefined;
  const gate = resolveNeonCronTimerGate(process.env);
  const snapshot = await createNeonCronStoreAutomationSnapshot(process.cwd(), {
    ...(forceJobId ? { evaluateCronJobId: forceJobId } : {})
  });

  const result = evaluateNeonCronTick({
    gate,
    snapshot,
    ...(forceJobId ? { forceJobIds: [forceJobId] } : {})
  });

  return renderNeonCronTickReport(result);
}

async function runCronDaemonSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-cron-daemon-smoke-"));
  const cursorPath = join(dir, "cron-daemon-cursor.json");
  const now = new Date("2026-06-02T12:00:00.000Z");
  const window = now.toISOString();
  const base = createNeonAutomationSnapshot({ generatedAt: now });
  const readyJob: INeonAutomationJob = {
    id: "heartbeat-review",
    kind: "cron",
    label: "Heartbeat Review",
    state: "ready",
    policy: "operator-approval-required",
    schedule: "every-15m",
    intervalMinutes: 15,
    nextRunAt: window,
    source: "cron-daemon-smoke",
    summary: "ready interval cron job for the daemon smoke"
  };
  const snapshot = { ...base, jobs: [readyJob] };

  try {
    // 1) Default-off: gate resolved from process.env (NEON_CRON_TIMER_ENABLED unset) -> nothing, no write.
    const offGate = resolveNeonCronTimerGate(process.env);
    const off = await runNeonCronDaemonTick({ cursorPath, gate: offGate, now: () => now, snapshot });

    // 2) Armed with a cursor 100m behind -> bounded catch-up + current window, cursor persisted.
    const behind = new Date(now.getTime() - 100 * 60_000).toISOString();
    await writeNeonCronDaemonCursor(cursorPath, {
      version: 1,
      emitted: { "heartbeat-review": behind },
      lastTickAt: behind,
      ticks: 3
    });
    const armedGate: INeonCronTimerGate = {
      enabled: true,
      reason: "timer-enabled",
      envKey: "NEON_CRON_TIMER_ENABLED"
    };
    const armed = await runNeonCronDaemonTick({
      cursorPath,
      gate: armedGate,
      now: () => now,
      snapshot,
      maxCatchupPerJob: 5
    });

    return [
      "== default-off tick ==",
      renderNeonCronDaemonTickReport(off),
      "",
      "== armed tick (seeded 100m-behind cursor) ==",
      renderNeonCronDaemonTickReport(armed)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runCronIntentLogSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-cron-intent-smoke-"));
  const cursorPath = join(dir, "cron-daemon-cursor.json");
  const storePath = join(dir, "cron-intents.jsonl");
  const now = new Date("2026-06-02T12:00:00.000Z");
  const window = now.toISOString();
  const base = createNeonAutomationSnapshot({ generatedAt: now });
  const readyJob: INeonAutomationJob = {
    id: "heartbeat-review",
    kind: "cron",
    label: "Heartbeat Review",
    state: "ready",
    policy: "operator-approval-required",
    schedule: "every-15m",
    intervalMinutes: 15,
    nextRunAt: window,
    source: "cron-intent-log-smoke",
    summary: "ready interval cron job for the intent-log smoke"
  };
  const snapshot = { ...base, jobs: [readyJob] };

  try {
    // Default-off: tick is blocked, so the intent append is blocked too. No write.
    const offGate = resolveNeonCronTimerGate(process.env);
    const offTick = await runNeonCronDaemonTick({ cursorPath, gate: offGate, now: () => now, snapshot });
    const offEntries = buildNeonCronIntentEntries(offTick, () => now);
    const offAppend = await appendNeonCronIntentLog({ entries: offEntries, gate: offGate, storePath });

    // Armed: seed the cursor 100m behind -> current + catch-up windows feed the log.
    const behind = new Date(now.getTime() - 100 * 60_000).toISOString();
    await writeNeonCronDaemonCursor(cursorPath, {
      version: 1,
      emitted: { "heartbeat-review": behind },
      lastTickAt: behind,
      ticks: 3
    });
    const armedGate: INeonCronTimerGate = {
      enabled: true,
      reason: "timer-enabled",
      envKey: "NEON_CRON_TIMER_ENABLED"
    };
    const armedTick = await runNeonCronDaemonTick({
      cursorPath,
      gate: armedGate,
      now: () => now,
      snapshot,
      maxCatchupPerJob: 5
    });
    const armedEntries = buildNeonCronIntentEntries(armedTick, () => now);
    const armedAppend = await appendNeonCronIntentLog({ entries: armedEntries, gate: armedGate, storePath });
    const log = await readNeonCronIntentLog({ storePath, limit: 10 });

    return [
      `== default-off == append: ${offAppend.state} (${offGate.reason}), ${offEntries.length} would-be entr${offEntries.length === 1 ? "y" : "ies"}`,
      `== armed == built ${armedEntries.length} entr${armedEntries.length === 1 ? "y" : "ies"}, append: ${armedAppend.state} (${armedAppend.count} written)`,
      "",
      renderNeonCronIntentLog(log)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runCronDaemonStatus(): Promise<string> {
  const snapshot = await createNeonCronDaemonStatusSnapshot(process.cwd());
  return renderNeonCronDaemonStatusReport(snapshot);
}

async function runCronDaemonServiceSmoke(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "neonika-cron-service-smoke-"));
  let clockMs = Date.parse("2026-06-02T12:00:00.000Z");
  const now = (): Date => new Date(clockMs);

  try {
    const storeGate = resolveNeonCronStoreGate({ NEON_CRON_STORE_ENABLED: "ready" });
    const add = resolveNeonCronMutation([], {
      id: "demo",
      mutation: "add",
      atMs: clockMs,
      schedule: "every-15m",
      label: "demo cron"
    });
    if (!add.ok) {
      throw new Error(add.reason);
    }
    await appendNeonCronStoreEvent(root, storeGate, add.event);

    const offService = createNeonCronDaemonService({
      projectRoot: root,
      intervalMs: 900_000,
      gate: resolveNeonCronTimerGate({}),
      now
    });
    const off = await offService.tickOnce();

    const armed = createNeonCronDaemonService({
      projectRoot: root,
      intervalMs: 900_000,
      gate: resolveNeonCronTimerGate({ NEON_CRON_TIMER_ENABLED: "ready" }),
      now
    });
    const createdRunIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const outcome = await armed.tickOnce();
      createdRunIds.push(...outcome.execution.createdRunIds);
      clockMs += 16 * 60_000;
    }

    const storedRuns = await readNeonGatewayRuns(root);
    const live = armed.getState();
    const cronRuns = storedRuns.filter((run) => run.runId.startsWith("cron-"));
    const allSuppressed = cronRuns.every((run) => run.delivery.state === "suppressed");
    const allShadow = cronRuns.every((run) => run.mode === "shadow");
    const jobs = projectNeonCronStoreJobs(await readNeonCronStoreEvents(root));

    return [
      `== off tick == created ${off.execution.createdRunCount} run(s) (gate ${off.tick.gate.reason}), wroteRunStore=${off.execution.safety.wroteRunStore}`,
      `== armed: 3 ticks == created ${createdRunIds.length} run-record(s): ${createdRunIds.join(", ")}`,
      `liveness: alive=${live.alive} ticks=${live.tickCount} due(lastTick)=${live.dueIntentsLastTick} catchup(lastTick)=${live.catchupIntentsLastTick} createdRunsTotal=${live.createdRunsTotal} lastTick=${live.lastTickAt ?? "none"} nextTick=${live.nextTickAt ?? "none"}`,
      `run-store: ${storedRuns.length} record(s), ${cronRuns.length} cron run(s), allShadow=${allShadow}, allSuppressed=${allSuppressed}`,
      renderNeonCronStoreJobs(jobs),
      "safety: agentExecuted=false outboundSent=false (literal), stage UNCHANGED (no cutover write)"
    ].join("\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function runCronDaemonRun(): Promise<string> {
  const args = process.argv.slice(3);
  const intervalIdx = args.indexOf("--interval");
  const ticksIdx = args.indexOf("--ticks");
  const defaultIntervalMs = readPositiveIntegerEnv("NEON_CRON_DAEMON_INTERVAL_MS", 60_000);
  const intervalMs = Math.max(
    1000,
    Number.parseInt((intervalIdx >= 0 ? args[intervalIdx + 1] : "") ?? "", 10) || defaultIntervalMs
  );
  const maxTicks = ticksIdx >= 0 ? Math.max(1, Number.parseInt(args[ticksIdx + 1] ?? "", 10) || 1) : undefined;
  const projectRoot = process.cwd();
  const gate = resolveNeonCronTimerGate(process.env);
  const service = createNeonCronDaemonService({
    projectRoot,
    intervalMs,
    gate,
    agentId: process.env["NEON_DISCORD_AGENT_ID"] ?? "chaty",
    unrefTimer: maxTicks !== undefined
  });

  process.stdout.write(
    `Neonika Cron Daemon: starting (interval ${intervalMs}ms, gate ${gate.reason})\n` +
      (gate.enabled
        ? "Gate armed: ticks read cron-store jobs and write terminal shadow run-records (delivery suppressed, stage unchanged).\n"
        : "Gate closed: daemon ticks but emits/writes nothing. Set NEON_CRON_TIMER_ENABLED to arm.\n") +
      (maxTicks ? `Will stop after ${maxTicks} tick(s).\n` : "Press Ctrl+C to stop.\n")
  );

  await service.start();

  if (maxTicks !== undefined) {
    let created = 0;
    for (let i = 0; i < maxTicks; i += 1) {
      const outcome = await service.tickOnce();
      created += outcome.execution.createdRunCount;
      process.stdout.write(
        `tick ${outcome.state.tickCount}: due=${outcome.tick.tick.emitted.length} catchup=${outcome.tick.catchup.length} created=${outcome.execution.createdRunCount} (total ${outcome.state.createdRunsTotal})\n`
      );
    }
    await service.stop();
    return `Cron daemon stopped after ${maxTicks} tick(s); ${created} run-record(s) written this run.`;
  }

  await new Promise<void>((resolveRun) => {
    const onSignal = (): void => {
      void service.stop().finally(() => resolveRun());
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  return "Cron daemon stopped.";
}

async function runCronStoreList(): Promise<string> {
  const jobs = projectNeonCronStoreJobs(await readNeonCronStoreEvents(process.cwd()));
  return [renderNeonCronStoreJobs(jobs), "", renderNeonCronDeliveryPreview(jobs)].join("\n");
}

async function runCronAdd(): Promise<string> {
  const args = process.argv.slice(3);
  const id = args[0]?.trim();
  const schedule = args[1]?.trim();
  const label = args.slice(2).join(" ").trim();
  if (!id || !schedule || !label) {
    return "Usage: cron-add <id> <schedule> <label...>";
  }
  return runCronStoreMutation({
    id,
    mutation: "add",
    atMs: Date.now(),
    schedule,
    label
  });
}

async function runCronEdit(): Promise<string> {
  const args = process.argv.slice(3);
  const id = args[0]?.trim();
  const schedule = readFlagValue(args, "--schedule");
  const label = readFlagRest(args, "--label");
  if (!id || (!schedule && !label)) {
    return "Usage: cron-edit <id> [--schedule <schedule>] [--label <label...>]";
  }
  return runCronStoreMutation({
    id,
    mutation: "update",
    atMs: Date.now(),
    ...(schedule ? { schedule } : {}),
    ...(label ? { label } : {})
  });
}

async function runCronEnable(): Promise<string> {
  return runCronStoreStateMutation("enable");
}

async function runCronDisable(): Promise<string> {
  return runCronStoreStateMutation("disable");
}

async function runCronRemove(): Promise<string> {
  return runCronStoreStateMutation("remove");
}

async function runCronStoreStateMutation(mutation: TNeonCronJobMutation): Promise<string> {
  const id = process.argv.slice(3)[0]?.trim();
  if (!id) {
    return `Usage: cron-${mutation === "remove" ? "rm" : mutation} <id>`;
  }
  return runCronStoreMutation({
    id,
    mutation,
    atMs: Date.now()
  });
}

async function runCronStoreMutation(input: IResolveNeonCronMutationInput): Promise<string> {
  const projectRoot = process.cwd();
  const before = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
  const resolved = resolveNeonCronMutation(before, input);
  if (!resolved.ok) {
    return [`Cron store ${input.mutation} ${input.id}: rejected`, resolved.reason, "", renderNeonCronStoreJobs(before)].join("\n");
  }

  const gate = resolveNeonCronStoreGate(process.env);
  const result = await appendNeonCronStoreEvent(projectRoot, gate, resolved.event);
  const after = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
  return [
    `Cron store ${input.mutation} ${input.id}: ${result.state} (${result.gate.reason}, env ${result.gate.envKey})`,
    ...result.diagnostics,
    result.storePath ? `Store: ${result.storePath}` : "Store: unchanged",
    "",
    renderNeonCronStoreJobs(after),
    "",
    renderNeonCronDeliveryPreview(after)
  ].join("\n");
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = args[index + 1]?.trim();
  return value && !value.startsWith("--") ? value : undefined;
}

function readCsvFlag(args: readonly string[], flag: string): readonly string[] {
  const value = readFlagValue(args, flag);
  return value === undefined
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function readFlagRest(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const arg of args.slice(index + 1)) {
    if (arg.startsWith("--")) {
      break;
    }
    parts.push(arg);
  }
  const value = parts.join(" ").trim();
  return value.length > 0 ? value : undefined;
}

function heartbeatSmokeAgents(): readonly INeonHeartbeatAgentState[] {
  return [
    { agentId: "neo", intervalMs: 900_000 },
    { agentId: "chaty", intervalMs: 900_000 }
  ];
}

function runHeartbeatTimerSmoke(): string {
  const now = new Date("2026-06-02T12:00:00.000Z");
  const agents = heartbeatSmokeAgents();

  const off = evaluateNeonHeartbeatTick({
    gate: resolveNeonHeartbeatTimerGate(process.env),
    schedulerSeed: "neonika",
    agents,
    now: () => now
  });
  const armed = evaluateNeonHeartbeatTick({
    gate: resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "ready" }),
    schedulerSeed: "neonika",
    agents,
    now: () => now
  });

  return [
    "== default-off tick ==",
    renderNeonHeartbeatTickReport(off),
    "",
    "== armed tick ==",
    renderNeonHeartbeatTickReport(armed)
  ].join("\n");
}

async function runHeartbeatDaemonSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-heartbeat-daemon-smoke-"));
  const cursorPath = join(dir, "heartbeat-daemon-cursor.json");
  const now = new Date("2026-06-02T12:00:00.000Z");
  const agents = heartbeatSmokeAgents();

  try {
    // 1) Default-off: gate from process.env (unset) -> nothing, no cursor write.
    const off = await runNeonHeartbeatDaemonTick({
      cursorPath,
      schedulerSeed: "neonika",
      agents,
      gate: resolveNeonHeartbeatTimerGate(process.env),
      now: () => now
    });

    // 2) Armed once to learn the current window, then rewind the cursor 8
    //    intervals back so bounded catch-up back-fills the missed windows.
    const armedGate = resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "ready" });
    const seed = await runNeonHeartbeatDaemonTick({
      cursorPath,
      schedulerSeed: "neonika",
      agents,
      gate: armedGate,
      now: () => now
    });
    const neoWindow = seed.cursor.emitted["neo"];
    if (neoWindow) {
      const behind = new Date(Date.parse(neoWindow) - 8 * 900_000).toISOString();
      await writeNeonHeartbeatDaemonCursor(cursorPath, {
        version: 1,
        emitted: { neo: behind, chaty: behind },
        lastTickAt: behind,
        ticks: seed.cursor.ticks
      });
    }
    const armed = await runNeonHeartbeatDaemonTick({
      cursorPath,
      schedulerSeed: "neonika",
      agents,
      gate: armedGate,
      now: () => now,
      maxCatchupPerJob: 5
    });

    return [
      "== default-off tick ==",
      renderNeonHeartbeatDaemonTickReport(off),
      "",
      "== armed tick (seeded behind cursor) ==",
      renderNeonHeartbeatDaemonTickReport(armed)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runHeartbeatDaemonStatus(): Promise<string> {
  const snapshot = await createNeonHeartbeatDaemonStatusSnapshot(process.cwd(), {
    agents: resolveNeonHeartbeatAgentsFromEnv(process.env)
  });
  return renderNeonHeartbeatDaemonStatusReport(snapshot);
}

async function runHeartbeatIntentLogSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-heartbeat-intent-smoke-"));
  const cursorPath = join(dir, "heartbeat-daemon-cursor.json");
  const storePath = join(dir, "heartbeat-intents.jsonl");
  const now = new Date("2026-06-02T12:00:00.000Z");
  const agents = heartbeatSmokeAgents();

  try {
    // Default-off: tick is blocked, so the intent append is blocked too. No write.
    const offGate = resolveNeonHeartbeatTimerGate(process.env);
    const offTick = await runNeonHeartbeatDaemonTick({
      cursorPath,
      schedulerSeed: "neonika",
      agents,
      gate: offGate,
      now: () => now
    });
    const offEntries = buildNeonHeartbeatIntentEntries(offTick, () => now);
    const offAppend = await appendNeonHeartbeatIntentLog({ entries: offEntries, gate: offGate, storePath });

    // Armed: a real tick feeds the gated intent history.
    const armedGate = resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "ready" });
    const armedTick = await runNeonHeartbeatDaemonTick({
      cursorPath,
      schedulerSeed: "neonika",
      agents,
      gate: armedGate,
      now: () => now
    });
    const armedEntries = buildNeonHeartbeatIntentEntries(armedTick, () => now);
    const armedAppend = await appendNeonHeartbeatIntentLog({ entries: armedEntries, gate: armedGate, storePath });
    const log = await readNeonHeartbeatIntentLog({ storePath, limit: 10 });

    return [
      `== default-off == append: ${offAppend.state} (${offGate.reason}), ${offEntries.length} would-be entr${offEntries.length === 1 ? "y" : "ies"}`,
      `== armed == built ${armedEntries.length} entr${armedEntries.length === 1 ? "y" : "ies"}, append: ${armedAppend.state} (${armedAppend.count} written)`,
      "",
      renderNeonHeartbeatIntentLog(log)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runHeartbeatDaemonServiceSmoke(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "neonika-heartbeat-service-smoke-"));
  const agents = heartbeatSmokeAgents();
  let clockMs = Date.parse("2026-06-02T12:00:00.000Z");
  const now = (): Date => new Date(clockMs);

  try {
    // OFF: explicit empty env -> ticks but emits/writes nothing.
    const offService = createNeonHeartbeatDaemonService({
      projectRoot: root,
      schedulerSeed: "neonika",
      agents,
      intervalMs: 900_000,
      gate: resolveNeonHeartbeatTimerGate({}),
      now
    });
    const off = await offService.tickOnce();

    // ARMED: 3 ticks, clock +16min each so every tick reaches a new phase window.
    const armed = createNeonHeartbeatDaemonService({
      projectRoot: root,
      schedulerSeed: "neonika",
      agents,
      intervalMs: 900_000,
      gate: resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "ready" }),
      now
    });
    const createdRunIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      clockMs += 16 * 60_000;
      const outcome = await armed.tickOnce();
      createdRunIds.push(...outcome.execution.createdRunIds);
    }

    const storedRuns = await readNeonGatewayRuns(root);
    const live = armed.getState();
    const heartbeatRuns = storedRuns.filter((run) => run.request.agentId !== undefined && run.runId.startsWith("heartbeat-"));
    const allSuppressed = heartbeatRuns.every((run) => run.delivery.state === "suppressed");
    const allShadow = heartbeatRuns.every((run) => run.mode === "shadow");

    return [
      `== off tick == created ${off.execution.createdRunCount} run(s) (gate ${off.tick.gate.reason}), wroteRunStore=${off.execution.safety.wroteRunStore}`,
      `== armed: 3 ticks == created ${createdRunIds.length} run-record(s): ${createdRunIds.join(", ")}`,
      `liveness: alive=${live.alive} ticks=${live.tickCount} due(lastTick)=${live.dueIntentsLastTick} dueCommitments(lastTick)=${live.dueCommitmentsLastTick} lifecycleCommitments(lastTick)=${live.lifecycleCommitmentsLastTick} createdRunsTotal=${live.createdRunsTotal} lastTick=${live.lastTickAt ?? "none"} nextTick=${live.nextTickAt ?? "none"}`,
      `run-store: ${storedRuns.length} record(s), ${heartbeatRuns.length} heartbeat run(s), allShadow=${allShadow}, allSuppressed=${allSuppressed}`,
      `safety: outboundSent=false (literal), stage UNCHANGED (no cutover write)`
    ].join("\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function runHeartbeatDaemonRun(): Promise<string> {
  const args = process.argv.slice(3);
  const intervalIdx = args.indexOf("--interval");
  const ticksIdx = args.indexOf("--ticks");
  const defaultIntervalMs = readPositiveIntegerEnv("NEON_HEARTBEAT_DAEMON_INTERVAL_MS", 60_000);
  const intervalMs = Math.max(
    1000,
    Number.parseInt((intervalIdx >= 0 ? args[intervalIdx + 1] : "") ?? "", 10) || defaultIntervalMs
  );
  const maxTicks = ticksIdx >= 0 ? Math.max(1, Number.parseInt(args[ticksIdx + 1] ?? "", 10) || 1) : undefined;

  const projectRoot = process.cwd();
  const gate = resolveNeonHeartbeatTimerGate(process.env);
  const agents = resolveNeonHeartbeatAgentsFromEnv(process.env);
  const service = createNeonHeartbeatDaemonService({
    projectRoot,
    schedulerSeed: "neonika",
    agents,
    intervalMs,
    gate,
    unrefTimer: maxTicks !== undefined
  });

  process.stdout.write(
    `Neonika Heartbeat Daemon: starting (interval ${intervalMs}ms, agents ${agents.length}, gate ${gate.reason})\n` +
      (gate.enabled
        ? "Gate armed: ticks will write terminal shadow run-records (delivery suppressed, stage unchanged).\n"
        : "Gate closed: daemon ticks but emits/writes nothing. Set NEON_HEARTBEAT_TIMER_ENABLED to arm.\n") +
      (maxTicks ? `Will stop after ${maxTicks} tick(s).\n` : "Press Ctrl+C to stop.\n")
  );

  await service.start();

  // Bounded demo/smoke mode: tick maxTicks times directly, then stop.
  if (maxTicks !== undefined) {
    let created = 0;
    for (let i = 0; i < maxTicks; i += 1) {
      const outcome = await service.tickOnce();
      created += outcome.execution.createdRunCount;
      process.stdout.write(
        `tick ${outcome.state.tickCount}: due=${outcome.tick.tick.emitted.length} commitments=${outcome.state.dueCommitmentsLastTick} lifecycle=${outcome.state.lifecycleCommitmentsLastTick} created=${outcome.execution.createdRunCount} (total ${outcome.state.createdRunsTotal})\n`
      );
    }
    await service.stop();
    return `Heartbeat daemon stopped after ${maxTicks} tick(s); ${created} run-record(s) written this run.`;
  }

  // Long-running mode: keep alive until SIGINT, the real setInterval drives ticks.
  await new Promise<void>((resolveRun) => {
    const onSignal = (): void => {
      void service.stop().finally(() => resolveRun());
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  return "Heartbeat daemon stopped.";
}

function runHookDispatchSmoke(): string {
  const args = process.argv.slice(3);
  const eventIndex = args.indexOf("--event");
  const event = (eventIndex >= 0 ? args[eventIndex + 1]?.trim() : undefined) ?? "gateway:startup";
  const payloadIndex = args.indexOf("--payload");
  const payload = payloadIndex >= 0 ? args[payloadIndex + 1] : undefined;
  const gate = resolveNeonHookDispatchGate(process.env);

  const result = dispatchNeonInternalHook({
    event,
    gate,
    ...(payload !== undefined ? { payload } : {})
  });

  return renderNeonHookDispatchReport(result);
}

async function runDreamTickSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-dream-tick-smoke-"));
  const cursorPath = join(dir, "dream-phase-cursor.json");
  const now = new Date("2026-06-03T12:00:00.000Z");
  const candidates = [
    { id: "mem-hot", content: "frequently recalled architecture decision", accessCount: 6 },
    { id: "mem-cold", content: "one-off note never recalled", accessCount: 0 }
  ];

  try {
    const offGate = resolveNeonDreamingGate(process.env);
    const off = await runNeonDreamPhaseTick({
      gate: offGate,
      candidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: resolveNeonWorkspaceNotesGate({}),
      now: () => now
    });

    const armedGate: INeonDreamingGate = {
      enabled: true,
      reason: "dreaming-enabled",
      envKey: "NEON_DREAMING_ENABLED"
    };
    const workspaceGate = resolveNeonWorkspaceNotesGate({ NEON_WORKSPACE_NOTES_ENABLED: "ready" });
    const first = await runNeonDreamPhaseTick({
      gate: armedGate,
      candidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: workspaceGate,
      now: () => now
    });
    const second = await runNeonDreamPhaseTick({
      gate: armedGate,
      candidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: workspaceGate,
      now: () => now
    });
    const third = await runNeonDreamPhaseTick({
      gate: armedGate,
      candidates,
      cursorPath,
      projectRoot: dir,
      workspaceNotesGate: workspaceGate,
      now: () => now
    });
    const workspace = await createNeonWorkspaceSnapshot(dir, { now: () => now });

    return [
      "== default-off ==",
      renderNeonDreamTickReport(off),
      "",
      "== armed tick #1 ==",
      renderNeonDreamTickReport(first),
      "",
      "== armed tick #2 (phase advanced via persisted cursor) ==",
      renderNeonDreamTickReport(second),
      "",
      "== armed tick #3 (REM workspace artifact) ==",
      renderNeonDreamTickReport(third),
      "",
      renderNeonWorkspaceSnapshotReport(workspace)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runDreamTickRun(): Promise<string> {
  const projectRoot = process.cwd();
  const runs = await readNeonGatewayRuns(projectRoot, { maxRuns: 20 });
  const candidates = buildDreamCandidatesFromRuns(runs);
  const result = await runNeonDreamPhaseTick({
    gate: resolveNeonDreamingGate(process.env),
    candidates,
    cursorPath: resolveNeonDreamPhaseCursorPath(projectRoot),
    projectRoot,
    workspaceNotesGate: resolveNeonWorkspaceNotesGate(process.env)
  });
  const workspace = await createNeonWorkspaceSnapshot(projectRoot);

  return [
    renderNeonDreamTickReport(result),
    `Candidates: ${candidates.length} recent gateway run(s)`,
    "",
    renderNeonWorkspaceSnapshotReport(workspace)
  ].join("\n");
}

function buildDreamCandidatesFromRuns(runs: readonly INeonGatewayShadowRun[]): readonly INeonDreamCandidate[] {
  return runs
    .map((run): INeonDreamCandidate | undefined => {
      const content = [run.request.goal, run.finalText, run.request.contentPreview]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .join(" · ");
      if (content.length === 0) {
        return undefined;
      }
      return {
        id: run.runId,
        content,
        accessCount: run.status === "completed" ? 3 : 0
      };
    })
    .filter((candidate): candidate is INeonDreamCandidate => candidate !== undefined);
}

function runDreamingReflectSmoke(): string {
  const args = process.argv.slice(3);
  const phaseIndex = args.indexOf("--phase");
  const phaseArg = phaseIndex >= 0 ? args[phaseIndex + 1]?.trim() : undefined;
  const phase = phaseArg === "deep" || phaseArg === "rem" ? phaseArg : "light";
  const conceptMerge = args.includes("--concept-merge");
  const gate = resolveNeonDreamingGate(process.env);

  const result = runNeonDreamingReflection({
    gate,
    phase,
    ...(conceptMerge ? { conceptMerge: true } : {}),
    candidates: [
      { id: "mem-1", content: "operator prefers metric units", accessCount: 5 },
      { id: "mem-2", content: "operator prefers metric units in all output", accessCount: 4 },
      { id: "mem-3", content: "One-off note never recalled again", accessCount: 0 }
    ]
  });

  return renderNeonDreamingReflectionReport(result);
}

async function runAutomationSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-automation`);
    const payload = (await response.json()) as ReturnType<typeof createNeonAutomationSnapshot>;

    if (
      !response.ok ||
      payload.policy !== "shadow-read-only" ||
      payload.totals.enabled !== 0 ||
      payload.runIntent.action !== "none" ||
      payload.runIntent.reason !== "scheduler-disabled" ||
      payload.hookRegistry.handlerCount !== 0 ||
      payload.hookRegistry.dispatchEnabled !== false
    ) {
      throw new Error(`Neonika Automation smoke failed with HTTP ${response.status}`);
    }

    return [
      "Neonika Automation API: ok",
      `URL: ${handle.url}/api/neon-automation`,
      `Jobs: ${payload.totals.jobs}`,
      `Hooks: ${payload.totals.hooks}`,
      `Dreams: ${payload.totals.dreams}`,
      `Run Intent: ${payload.runIntent.jobId} / ${payload.runIntent.state} / ${payload.runIntent.reason}`,
      `Hook Registry: ${payload.hookRegistry.eventKeys.length} event(s) / dispatch=${payload.hookRegistry.dispatchEnabled ? "on" : "off"}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runNodesReport(): Promise<string> {
  const snapshot = await createNeonNodesSnapshot(process.cwd());

  return renderNeonNodesReport(snapshot);
}

async function runNodePairingReport(): Promise<string> {
  return renderNeonNodePairingReport(await createNeonNodePairingSnapshot(process.cwd()));
}

async function runNodePairingRequest(): Promise<string> {
  const record = await createNeonNodePairingRequest(process.cwd(), {
    deviceId: readRequiredEnv(["NEON_PAIR_DEVICE_ID"]),
    publicKey: readRequiredEnv(["NEON_PAIR_PUBLIC_KEY"]),
    displayName: readOptionalEnv("NEON_PAIR_DISPLAY_NAME"),
    platform: readOptionalEnv("NEON_PAIR_PLATFORM"),
    requestedRole: readOptionalEnv("NEON_PAIR_ROLE"),
    requestedScopes: readOptionalCsvEnv("NEON_PAIR_SCOPES")
  });

  return [
    "Neon node pairing request recorded: ok",
    `Request: ${record.requestId}`,
    `Device: ${record.deviceId}`,
    `Expires: ${record.expiresAt}`,
    "Token issued: false"
  ].join("\n");
}

async function runNodePairingApprove(): Promise<string> {
  const record = await recordNeonNodePairingApproval(process.cwd(), {
    requestId: readRequiredEnv(["NEON_PAIR_REQUEST_ID"]),
    decision: readOptionalEnv("NEON_PAIR_DECISION") === "deny" ? "deny" : "approve",
    decidedBy: readOptionalEnv("NEON_PAIR_DECIDED_BY") ?? "chaty",
    reason: readOptionalEnv("NEON_PAIR_REASON")
  });

  return [
    "Neon node pairing approval recorded: ok",
    `Approval: ${record.approvalId}`,
    `Request: ${record.requestId}`,
    `Decision: ${record.decision}`,
    "Token issued: false"
  ].join("\n");
}

async function runNodePairingTokenGate(): Promise<string> {
  return renderNeonNodePairingTokenGateReport(await createNeonNodePairingTokenGateSnapshot(process.cwd()));
}

async function runNodePairingTokenGateSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-token-gate-smoke-"));

  try {
    const request = await createNeonNodePairingRequest(
      projectRoot,
      {
        requestId: "pair-token-gate-smoke-request",
        deviceId: "operator-phone",
        publicKey: "smoke-public-key",
        displayName: "Operator Phone",
        platform: "ios",
        requestedScopes: ["operator.pairing"]
      },
      {
        now: () => new Date("2026-06-01T00:00:00.000Z")
      }
    );
    await recordNeonNodePairingApproval(
      projectRoot,
      {
        requestId: request.requestId,
        decision: "approve",
        decidedBy: "chaty",
        reason: "token gate smoke"
      },
      {
        now: () => new Date("2026-06-01T00:01:00.000Z")
      }
    );

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/pairing/token-gate`);
      const payload = (await response.json()) as INeonNodePairingTokenGateSnapshot;
      const hasCanaryBlocker = payload.blockers.some((blocker) => blocker.id === "cutover-stage-before-canary");

      if (
        !response.ok ||
        payload.state !== "locked" ||
        payload.totals.eligibleApprovals !== 1 ||
        payload.eligibleApprovals[0]?.tokenIssued !== false ||
        !hasCanaryBlocker
      ) {
        throw new Error(`Node pairing token gate smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Pairing Token Gate API: ok",
        `URL: ${handle.url}/api/neon-nodes/pairing/token-gate`,
        `State: ${payload.state}`,
        `Eligible approvals: ${payload.totals.eligibleApprovals}`,
        `Blockers: ${payload.totals.blockers}`,
        "Token issued: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodePairingCanaryTokens(): Promise<string> {
  return renderNeonNodePairingCanaryTokenReport(await createNeonNodePairingCanaryTokenSnapshot(process.cwd()));
}

async function runNodePairingCanaryTokenIssueSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-canary-token-smoke-"));

  try {
    const request = await createNeonNodePairingRequest(
      projectRoot,
      {
        requestId: "pair-canary-token-smoke-request",
        deviceId: "operator-phone",
        publicKey: "smoke-public-key",
        displayName: "Operator Phone",
        platform: "ios",
        requestedScopes: ["operator.pairing"]
      },
      {
        now: () => new Date("2026-06-01T00:00:00.000Z")
      }
    );
    const approval = await recordNeonNodePairingApproval(
      projectRoot,
      {
        requestId: request.requestId,
        decision: "approve",
        decidedBy: "chaty",
        reason: "canary token smoke"
      },
      {
        now: () => new Date("2026-06-01T00:01:00.000Z")
      }
    );
    const pairingSnapshot = await createNeonNodePairingSnapshot(projectRoot, {
      now: () => new Date("2026-06-01T00:02:00.000Z")
    });
    const tokenGateSnapshot = await createNeonNodePairingTokenGateSnapshot(projectRoot, {
      pairingSnapshot,
      cutoverSnapshot: createCliSmokeCanaryCutoverSnapshot(projectRoot),
      now: () => new Date("2026-06-01T00:03:00.000Z")
    });
    const result = await issueNeonNodePairingCanaryToken(
      projectRoot,
      {
        requestId: request.requestId,
        approvalId: approval.approvalId,
        issuedBy: "chaty",
        deliveryMethod: "mission-control-once",
        deliveryNote: "canary token smoke",
        ttlMinutes: 15
      },
      {
        tokenGateSnapshot,
        createTokenMaterial: () => "neon_node_canary_smoke_secret",
        now: () => new Date("2026-06-01T00:04:00.000Z")
      }
    );
    const snapshot = await createNeonNodePairingCanaryTokenSnapshot(projectRoot, {
      tokenGateSnapshot,
      now: () => new Date("2026-06-01T00:05:00.000Z")
    });
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/pairing/canary-tokens`);
      const payload = (await response.json()) as INeonNodePairingCanaryTokenSnapshot;

      if (
        !response.ok ||
        result.oneTimeSecret.persisted !== false ||
        snapshot.totals.issued !== 1 ||
        payload.deliveryPolicy.rawTokenHttpExposure !== "disabled" ||
        payload.issues.some((issue) => issue.secretPersisted || issue.tokenMaterialPersisted)
      ) {
        throw new Error(`Canary token issue smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Canary Token Issue: ok",
        `URL: ${handle.url}/api/neon-nodes/pairing/canary-tokens`,
        `Issue: ${result.record.tokenIssueId}`,
        `Fingerprint: ${result.record.tokenFingerprint}`,
        `Raw secret persisted: ${String(result.oneTimeSecret.persisted)}`,
        "Raw token output: disabled"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeDeviceSessions(): Promise<string> {
  return renderNeonNodeDeviceSessionReport(await createNeonNodeDeviceSessionSnapshot(process.cwd()));
}

async function runNodeActionRequests(): Promise<string> {
  return renderNeonNodeActionRequestReport(await createNeonNodeActionRequestSnapshot(process.cwd()));
}

async function runNodeActionApprove(): Promise<string> {
  const requestId = readRequiredEnv(["NEON_NODE_ACTION_REQUEST_ID"]);
  const decision = readRequiredEnv(["NEON_NODE_ACTION_DECISION"]);
  const operatorId = readOptionalEnv("NEON_NODE_ACTION_OPERATOR_ID") ?? "operator";
  const reason = readOptionalEnv("NEON_NODE_ACTION_REASON");
  const record = await recordNeonNodeActionApproval(process.cwd(), {
    requestId,
    decision,
    operatorId,
    ...(reason ? { reason } : {})
  });

  return [
    "Neon node action approval recorded: ok",
    `Approval: ${record.approvalId}`,
    `Request: ${record.requestId}`,
    `Decision: ${record.decision}`,
    `Execution: ${record.safety.executionEnabled}`,
    `Side effect: ${record.safety.sideEffectExecuted}`
  ].join("\n");
}

async function runNodeActionResultPreview(): Promise<string> {
  const approvalId = readRequiredEnv(["NEON_NODE_ACTION_APPROVAL_ID"]);
  const preview = await createNeonNodeActionResultPreview(process.cwd(), {
    approvalId
  });

  return [
    "Neon node action result preview: ok",
    `Preview: ${preview.resultPreviewId}`,
    `Approval: ${preview.approvalId}`,
    `Request: ${preview.requestId}`,
    `State: ${preview.state}`,
    `Kind: ${preview.resultKind ?? preview.kind}`,
    `Mutation: ${preview.safety.mutationExecuted}`,
    `Raw output persisted: ${preview.safety.rawOutputPersisted}`,
    `Summary: ${preview.summary}`
  ].join("\n");
}

async function runNodeTransport(): Promise<string> {
  return renderNeonNodeTransportReport(await createNeonNodeTransportSnapshot(process.cwd()));
}

async function runNodeFileWriteSmoke(): Promise<string> {
  const content = readTrailingArgument("Neonika gated file.write probe");
  const gate = resolveNeonNodeFileWriteGate(process.env);
  const allowlistRoot = await mkdtemp(join(tmpdir(), "neonika-file-write-allowlist-"));

  try {
    const contained = await writeNeonNodeFile({
      allowlistRoot,
      requestedPath: "reports/note.txt",
      content,
      gate,
      approved: gate.enabled,
      scopes: gate.enabled ? ["file.read", "file.write"] : ["file.read"]
    });
    const escape = await writeNeonNodeFile({
      allowlistRoot,
      requestedPath: "../escape.txt",
      content,
      gate,
      approved: true,
      scopes: ["file.read", "file.write"]
    });

    return [
      "== contained write ==",
      renderNeonNodeFileWriteReport(contained),
      "",
      "== path-escape attempt (must block) ==",
      renderNeonNodeFileWriteReport(escape),
      "",
      `Escape blocked: ${escape.state === "blocked" && escape.blockReason === "path-escape" ? "yes" : "no"}`
    ].join("\n");
  } finally {
    await rm(allowlistRoot, { force: true, recursive: true });
  }
}

async function runNodeTransportResultIngest(): Promise<string> {
  const dispatchId = readRequiredEnv(["NEON_NODE_TRANSPORT_DISPATCH_ID"]);
  const summary = readOptionalEnv("NEON_NODE_TRANSPORT_RESULT_SUMMARY");
  const textPreview = readOptionalEnv("NEON_NODE_TRANSPORT_RESULT_TEXT");
  const result = await recordNeonNodeTransportResult(process.cwd(), {
    dispatchId,
    ...(summary ? { summary } : {}),
    ...(textPreview ? { textPreview } : {})
  });

  return renderNodeTransportResultIngest(result);
}

async function runNodeDeviceSessionHandshakeSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-session-smoke-"));

  try {
    const smoke = await createCliSmokeNodeDeviceSession(projectRoot);
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/device-sessions`);
      const payload = (await response.json()) as INeonNodeDeviceSessionSnapshot;

      if (
        !response.ok ||
        smoke.sessionResult.oneTimeSessionSecret.persisted !== false ||
        smoke.snapshot.totals.active !== 1 ||
        smoke.snapshot.totals.blockedScopes !== 2 ||
        payload.policy.rawTokenHttpExposure !== "disabled" ||
        payload.policy.sessionSecretHttpExposure !== "disabled" ||
        payload.sessions.some((session) => session.rawTokenPersisted || session.sessionSecretPersisted)
      ) {
        throw new Error(`Device session handshake smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Device Session Handshake: ok",
        `URL: ${handle.url}/api/neon-nodes/device-sessions`,
        `Session: ${smoke.sessionResult.record.sessionId}`,
        `Fingerprint: ${smoke.sessionResult.record.sessionFingerprint}`,
        `Blocked scopes: ${smoke.snapshot.totals.blockedScopes}`,
        `Session secret persisted: ${String(smoke.sessionResult.oneTimeSessionSecret.persisted)}`,
        "Raw token output: disabled",
        "Session secret output: disabled"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeActionRequestSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-action-smoke-"));

  try {
    const smoke = await createCliSmokeNodeDeviceSession(projectRoot);
    const session = smoke.snapshot.sessions[0];

    if (!session) {
      throw new Error("Node action request smoke failed: no active session");
    }

    await recordNeonNodeActionRequest(
      projectRoot,
      {
        sessionId: session.sessionId,
        kind: "heartbeat",
        requestedBy: "chaty",
        reason: "heartbeat catalog smoke"
      },
      {
        deviceSessionSnapshot: smoke.snapshot,
        now: () => new Date("2026-06-01T00:08:00.000Z")
      }
    );
    const fileList = await recordNeonNodeActionRequest(
      projectRoot,
      {
        sessionId: session.sessionId,
        kind: "file.list",
        requestedBy: "chaty",
        targetPath: projectRoot,
        reason: "file catalog smoke"
      },
      {
        deviceSessionSnapshot: smoke.snapshot,
        now: () => new Date("2026-06-01T00:09:00.000Z")
      }
    );
    await recordNeonNodeActionRequest(
      projectRoot,
      {
        sessionId: session.sessionId,
        kind: "browser.snapshot",
        requestedBy: "chaty",
        targetUrl: "http://127.0.0.1:8797/mission-control/nodes",
        reason: "browser catalog smoke"
      },
      {
        deviceSessionSnapshot: smoke.snapshot,
        now: () => new Date("2026-06-01T00:10:00.000Z")
      }
    );
    await recordNeonNodeActionRequest(
      projectRoot,
      {
        sessionId: session.sessionId,
        kind: "file.write",
        requestedBy: "chaty",
        targetPath: `${projectRoot}/blocked.txt`,
        reason: "high-risk block smoke"
      },
      {
        deviceSessionSnapshot: smoke.snapshot,
        now: () => new Date("2026-06-01T00:11:00.000Z")
      }
    );

    const actionSnapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
      deviceSessionSnapshot: smoke.snapshot,
      now: () => new Date("2026-06-01T00:12:00.000Z")
    });
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/action-requests`);
      const payload = (await response.json()) as INeonNodeActionRequestSnapshot;

      if (
        !response.ok ||
        actionSnapshot.totals.requests !== 4 ||
        actionSnapshot.totals.recorded !== 1 ||
        actionSnapshot.totals.approvalRequired !== 2 ||
        actionSnapshot.totals.pendingApproval !== 2 ||
        actionSnapshot.totals.approvalRecords !== 0 ||
        actionSnapshot.totals.blocked !== 1 ||
        fileList.state !== "approval-required" ||
        payload.policy.execution !== "disabled" ||
        payload.requests.some((request) => request.sideEffectExecuted || request.rawOutputPersisted)
      ) {
        throw new Error(`Node action request smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Action Request Catalog: ok",
        `URL: ${handle.url}/api/neon-nodes/action-requests`,
        `Requests: ${actionSnapshot.totals.requests}`,
        `Approval required: ${actionSnapshot.totals.approvalRequired}`,
        `Blocked: ${actionSnapshot.totals.blocked}`,
        "Execution: disabled"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeActionApprovalSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-action-approval-smoke-"));

  try {
    const smoke = await createCliSmokeNodeDeviceSession(projectRoot);
    const session = smoke.snapshot.sessions[0];

    if (!session) {
      throw new Error("Node action approval smoke failed: no active session");
    }

    const fileList = await recordNeonNodeActionRequest(
      projectRoot,
      {
        sessionId: session.sessionId,
        kind: "file.list",
        requestedBy: "chaty",
        targetPath: projectRoot,
        reason: "approval smoke sk-test-secret-value"
      },
      {
        deviceSessionSnapshot: smoke.snapshot,
        now: () => new Date("2026-06-01T00:09:00.000Z")
      }
    );
    await recordNeonNodeActionApproval(
      projectRoot,
      {
        requestId: fileList.requestId,
        decision: "approve",
        operatorId: "operator",
        reason: "approved for canary audit sk-test-secret-value"
      },
      {
        now: () => new Date("2026-06-01T00:10:00.000Z")
      }
    );
    const actionSnapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
      deviceSessionSnapshot: smoke.snapshot,
      now: () => new Date("2026-06-01T00:11:00.000Z")
    });
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/action-requests`);
      const payload = (await response.json()) as INeonNodeActionRequestSnapshot;

      if (
        !response.ok ||
        actionSnapshot.state !== "needs-preview" ||
        actionSnapshot.totals.approvalRecords !== 1 ||
        actionSnapshot.totals.pendingApproval !== 0 ||
        actionSnapshot.totals.pendingResultPreviews !== 1 ||
        actionSnapshot.approvals[0]?.safety.executionEnabled !== false ||
        actionSnapshot.approvals[0]?.safety.sideEffectExecuted !== false ||
        !actionSnapshot.approvals[0]?.reason?.includes("[REDACTED_SECRET]") ||
        payload.approvals.some((approval) => approval.safety.executionEnabled || approval.safety.sideEffectExecuted)
      ) {
        throw new Error(`Node action approval smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Action Approval Audit: ok",
        `URL: ${handle.url}/api/neon-nodes/action-requests`,
        `Approval records: ${actionSnapshot.totals.approvalRecords}`,
        `Pending approvals: ${actionSnapshot.totals.pendingApproval}`,
        `Pending result previews: ${actionSnapshot.totals.pendingResultPreviews}`,
        "Execution: disabled",
        "Side effects: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeActionResultPreviewSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-action-result-smoke-"));

  try {
    await mkdir(join(projectRoot, "preview-fixtures"), { recursive: true });
    await writeFile(
      join(projectRoot, "preview-fixtures", "sample.txt"),
      "Neon result preview smoke sk-test-secret-value\n",
      "utf8"
    );

    const smoke = await createCliSmokeNodeDeviceSession(projectRoot);
    const session = smoke.snapshot.sessions[0];

    if (!session) {
      throw new Error("Node action result preview smoke failed: no active session");
    }

    const fileListRequest = await recordNeonNodeActionRequest(
      projectRoot,
      {
        sessionId: session.sessionId,
        kind: "file.list",
        requestedBy: "chaty",
        targetPath: join(projectRoot, "preview-fixtures"),
        reason: "file result preview smoke"
      },
      {
        deviceSessionSnapshot: smoke.snapshot,
        now: () => new Date("2026-06-01T00:09:00.000Z")
      }
    );
    const fileListApproval = await recordNeonNodeActionApproval(
      projectRoot,
      {
        requestId: fileListRequest.requestId,
        decision: "approve",
        operatorId: "chaty",
        reason: "approve file list preview"
      },
      {
        now: () => new Date("2026-06-01T00:10:00.000Z")
      }
    );
    await createNeonNodeActionResultPreview(
      projectRoot,
      {
        approvalId: fileListApproval.approvalId
      },
      {
        now: () => new Date("2026-06-01T00:11:00.000Z")
      }
    );

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const browserRequest = await recordNeonNodeActionRequest(
        projectRoot,
        {
          sessionId: session.sessionId,
          kind: "browser.snapshot",
          requestedBy: "chaty",
          targetUrl: `${handle.url}/api/neon-nodes/action-requests`,
          reason: "browser result preview smoke"
        },
        {
          deviceSessionSnapshot: smoke.snapshot,
          now: () => new Date("2026-06-01T00:12:00.000Z")
        }
      );
      const browserApproval = await recordNeonNodeActionApproval(
        projectRoot,
        {
          requestId: browserRequest.requestId,
          decision: "approve",
          operatorId: "chaty",
          reason: "approve browser snapshot preview"
        },
        {
          now: () => new Date("2026-06-01T00:13:00.000Z")
        }
      );
      await createNeonNodeActionResultPreview(
        projectRoot,
        {
          approvalId: browserApproval.approvalId
        },
        {
          now: () => new Date("2026-06-01T00:14:00.000Z")
        }
      );

      const response = await fetch(`${handle.url}/api/neon-nodes/action-requests`);
      const payload = (await response.json()) as INeonNodeActionRequestSnapshot;
      const readyPreviews = payload.resultPreviews.filter((preview) => preview.state === "ready");

      if (
        !response.ok ||
        payload.totals.resultPreviews !== 2 ||
        payload.totals.readyResultPreviews !== 2 ||
        payload.totals.pendingResultPreviews !== 0 ||
        readyPreviews.some((preview) => preview.safety.mutationExecuted || preview.safety.rawOutputPersisted)
      ) {
        throw new Error(`Node action result preview smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Action Result Preview: ok",
        `URL: ${handle.url}/api/neon-nodes/action-requests`,
        `Result previews: ${payload.totals.resultPreviews}`,
        `Ready previews: ${payload.totals.readyResultPreviews}`,
        `Pending previews: ${payload.totals.pendingResultPreviews}`,
        "Mutation: false",
        "Raw output persisted: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeTransportSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-transport-smoke-"));

  try {
    await createCliSmokeNodeTransportDispatch(projectRoot);

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/transport`);
      const payload = (await response.json()) as INeonNodeTransportSnapshot;
      const serialized = JSON.stringify(payload);

      if (
        !response.ok ||
        payload.state !== "ready" ||
        payload.totals.dispatches !== 1 ||
        payload.dispatches[0]?.kind !== "dir.list" ||
        payload.totals.blockers !== 0 ||
        payload.totals.results !== 0 ||
        payload.policy.mode !== "poll-only" ||
        payload.policy.mutationAllowed !== false ||
        payload.dispatches.some(
          (dispatch) =>
            dispatch.safety.sideEffectExecuted ||
            dispatch.safety.rawOutputPersisted ||
            dispatch.safety.rawTokenExposed ||
            dispatch.safety.sessionSecretExposed
        ) ||
        serialized.includes("neon_node_session_smoke_secret") ||
        serialized.includes("neon_node_canary_session_smoke_secret")
      ) {
        throw new Error(`Node transport smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Transport: ok",
        `URL: ${handle.url}/api/neon-nodes/transport`,
        `Dispatches: ${payload.totals.dispatches}`,
        `Dispatch Kind: ${payload.dispatches[0]?.kind ?? "none"}`,
        `Blockers: ${payload.totals.blockers}`,
        `Results: ${payload.totals.results}`,
        `Policy: ${payload.policy.mode}`,
        "Mutation: false",
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeTransportResultIngestSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-transport-result-smoke-"));

  try {
    const setup = await createCliSmokeNodeTransportDispatch(projectRoot);
    await recordNeonNodeTransportResult(
      projectRoot,
      {
        dispatchId: setup.dispatchId,
        summary: "remote file list received sk-test-secret-value",
        entries: [
          {
            name: "sample.txt",
            kind: "file",
            relativePath: "transport-fixtures/sample.txt",
            sizeBytes: 21
          }
        ],
        totalEntries: 1,
        truncated: false
      },
      {
        now: () => new Date(Date.now() + 12 * 60_000)
      }
    );

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/transport`);
      const payload = (await response.json()) as INeonNodeTransportSnapshot;
      const serialized = JSON.stringify(payload);

      if (
        !response.ok ||
        payload.state !== "ready" ||
        payload.totals.dispatches !== 0 ||
        payload.totals.results !== 1 ||
        payload.totals.receivedResults !== 1 ||
        payload.totals.ingestedApprovals !== 1 ||
        payload.results.some(
          (result) =>
            result.safety.mutationExecuted ||
            result.safety.sideEffectExecuted ||
            result.safety.rawOutputPersisted ||
            result.safety.rawTokenPersisted ||
            result.safety.sessionSecretPersisted
        ) ||
        serialized.includes("sk-test-secret-value") ||
        serialized.includes("neon_node_session_smoke_secret") ||
        serialized.includes("neon_node_canary_session_smoke_secret")
      ) {
        throw new Error(`Node transport result ingest smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Transport Result Ingest: ok",
        `URL: ${handle.url}/api/neon-nodes/transport`,
        `Dispatches: ${payload.totals.dispatches}`,
        `Results: ${payload.totals.results}`,
        `Ingested approvals: ${payload.totals.ingestedApprovals}`,
        "Mutation: false",
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeTransportPollSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-transport-poll-smoke-"));

  try {
    const setup = await createCliSmokeNodeTransportDispatch(projectRoot);
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const missingAuth = await fetch(`${handle.url}/api/neon-nodes/transport/poll`);
      const wrongSecret = await fetch(`${handle.url}/api/neon-nodes/transport/poll`, {
        headers: {
          "x-neon-node-session-id": setup.sessionId,
          "x-neon-node-session-secret": "wrong-secret"
        }
      });
      const firstPoll = await fetch(`${handle.url}/api/neon-nodes/transport/poll`, {
        headers: {
          "x-neon-node-session-id": setup.sessionId,
          "x-neon-node-session-secret": setup.sessionSecret
        }
      });
      const firstPayload = (await firstPoll.json()) as {
        readonly replay?: string;
        readonly cursor?: string;
        readonly dispatches?: readonly INeonNodeTransportSnapshot["dispatches"][number][];
      };
      const firstCursor = typeof firstPayload.cursor === "string" ? firstPayload.cursor : "";
      const secondPoll = await fetch(
        `${handle.url}/api/neon-nodes/transport/poll?cursor=${encodeURIComponent(firstCursor)}`,
        {
          headers: {
            "x-neon-node-session-id": setup.sessionId,
            "x-neon-node-session-secret": setup.sessionSecret
          }
        }
      );
      const secondPayload = (await secondPoll.json()) as {
        readonly replay?: string;
        readonly dispatches?: readonly INeonNodeTransportSnapshot["dispatches"][number][];
      };
      const response = await fetch(`${handle.url}/api/neon-nodes/transport`);
      const payload = (await response.json()) as INeonNodeTransportSnapshot;
      const serialized = JSON.stringify(payload);

      if (
        missingAuth.status !== 401 ||
        wrongSecret.status !== 403 ||
        firstPoll.status !== 200 ||
        secondPoll.status !== 200 ||
        firstPayload.replay !== "replay" ||
        firstPayload.dispatches?.length !== 1 ||
        secondPayload.replay !== "cursor-hit" ||
        secondPayload.dispatches?.length !== 0 ||
        !response.ok ||
        payload.totals.dispatches !== 1 ||
        payload.totals.polls !== 2 ||
        payload.totals.activePollingSessions !== 1 ||
        payload.polls.some(
          (poll) =>
            poll.safety.mutationExecuted ||
            poll.safety.sideEffectExecuted ||
            poll.safety.rawTokenPersisted ||
            poll.safety.sessionSecretPersisted
        ) ||
        serialized.includes("neon_node_session_smoke_secret") ||
        serialized.includes("neon_node_canary_session_smoke_secret")
      ) {
        throw new Error(`Node transport poll smoke failed with HTTP ${firstPoll.status}`);
      }

      return [
        "Neonika Node Transport Poll: ok",
        `URL: ${handle.url}/api/neon-nodes/transport/poll`,
        `Dispatches: ${payload.totals.dispatches}`,
        `Polls: ${payload.totals.polls}`,
        `Polling sessions: ${payload.totals.activePollingSessions}`,
        "Replay: cursor-aware",
        "Mutation: false",
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeTransportResultSubmitSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-transport-submit-smoke-"));

  try {
    const setup = await createCliSmokeNodeTransportDispatch(projectRoot);
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );
    const body = JSON.stringify({
      dispatchId: setup.dispatchId,
      summary: "remote HTTP file list received sk-test-secret-value",
      entries: [
        {
          name: "sample.txt",
          kind: "file",
          relativePath: "transport-fixtures/sample.txt",
          sizeBytes: 21
        }
      ],
      totalEntries: 1,
      truncated: false
    });

    try {
      const missingAuth = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
        method: "POST",
        body
      });
      const wrongSecret = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-neon-node-session-id": setup.sessionId,
          "x-neon-node-session-secret": "wrong-secret"
        },
        body
      });
      const accepted = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-neon-node-session-id": setup.sessionId,
          "x-neon-node-session-secret": setup.sessionSecret
        },
        body
      });
      const duplicate = await fetch(`${handle.url}/api/neon-nodes/transport/results`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-neon-node-session-id": setup.sessionId,
          "x-neon-node-session-secret": setup.sessionSecret
        },
        body
      });
      const response = await fetch(`${handle.url}/api/neon-nodes/transport`);
      const payload = (await response.json()) as INeonNodeTransportSnapshot;
      const serialized = JSON.stringify(payload);

      if (
        missingAuth.status !== 401 ||
        wrongSecret.status !== 403 ||
        accepted.status !== 201 ||
        duplicate.status !== 409 ||
        !response.ok ||
        payload.totals.dispatches !== 0 ||
        payload.totals.results !== 1 ||
        payload.totals.ingestedApprovals !== 1 ||
        payload.results.some(
          (result) =>
            result.safety.mutationExecuted ||
            result.safety.sideEffectExecuted ||
            result.safety.rawOutputPersisted ||
            result.safety.rawTokenPersisted ||
            result.safety.sessionSecretPersisted
        ) ||
        serialized.includes("sk-test-secret-value") ||
        serialized.includes("neon_node_session_smoke_secret") ||
        serialized.includes("neon_node_canary_session_smoke_secret")
      ) {
        throw new Error(`Node transport result submit smoke failed with HTTP ${accepted.status}`);
      }

      return [
        "Neonika Node Transport Result Submit: ok",
        `URL: ${handle.url}/api/neon-nodes/transport/results`,
        `Dispatches: ${payload.totals.dispatches}`,
        `Results: ${payload.totals.results}`,
        `Ingested approvals: ${payload.totals.ingestedApprovals}`,
        "Auth: session-secret",
        "Mutation: false",
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeRunnerOnce(): Promise<string> {
  const gatewayUrl = readOptionalEnv("NEON_NODE_GATEWAY_URL") ?? readOptionalEnv("NEONIKA_GATEWAY_URL") ?? "http://127.0.0.1:8797";
  const projectRoot = readOptionalEnv("NEON_NODE_PROJECT_ROOT") ?? process.cwd();
  const cursor = readOptionalEnv("NEON_NODE_CURSOR");
  const result = await runNeonNodeRunnerOnce({
    gatewayUrl,
    projectRoot,
    sessionId: readRequiredEnv(["NEON_NODE_SESSION_ID"]),
    sessionSecret: readRequiredEnv(["NEON_NODE_SESSION_SECRET"]),
    ...(cursor ? { cursor } : {})
  });

  return renderNeonNodeRunnerReport(result);
}

async function runNodeRunnerOnceSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-runner-smoke-"));

  try {
    const setup = await createCliSmokeNodeTransportDispatch(projectRoot);
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const runnerResult = await runNeonNodeRunnerOnce({
        gatewayUrl: handle.url,
        projectRoot,
        sessionId: setup.sessionId,
        sessionSecret: setup.sessionSecret
      });
      const response = await fetch(`${handle.url}/api/neon-nodes/transport`);
      const payload = (await response.json()) as INeonNodeTransportSnapshot;
      const serialized = JSON.stringify(payload);

      if (
        runnerResult.state !== "submitted" ||
        runnerResult.pollStatus !== 200 ||
        runnerResult.dispatches !== 1 ||
        runnerResult.submitted !== 1 ||
        runnerResult.blocked !== 0 ||
        runnerResult.failed !== 0 ||
        !response.ok ||
        payload.totals.dispatches !== 0 ||
        payload.totals.results !== 1 ||
        payload.totals.polls !== 1 ||
        payload.totals.ingestedApprovals !== 1 ||
        payload.results[0]?.resultKind !== "file-list" ||
        payload.results.some(
          (result) =>
            result.safety.mutationExecuted ||
            result.safety.sideEffectExecuted ||
            result.safety.rawOutputPersisted ||
            result.safety.rawTokenPersisted ||
            result.safety.sessionSecretPersisted
        ) ||
        serialized.includes("neon_node_session_smoke_secret") ||
        serialized.includes("neon_node_canary_session_smoke_secret")
      ) {
        throw new Error("Node runner smoke failed");
      }

      return [
        "Neonika Node Runner: ok",
        `URL: ${handle.url}`,
        `Dispatches: ${runnerResult.dispatches}`,
        `Submitted: ${runnerResult.submitted}`,
        `Results: ${payload.totals.results}`,
        "Replay: poll-execute-submit",
        "Mutation: false",
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeRunnerStatus(): Promise<string> {
  return renderNeonNodeRunnerSnapshotReport(await createNeonNodeRunnerSnapshot(process.cwd()));
}

async function runNodeRunnerStart(): Promise<string> {
  const control = await writeNeonNodeRunnerControl(process.cwd(), {
    desiredState: "running",
    operatorId: readOptionalEnv("NEON_NODE_RUNNER_OPERATOR") ?? "chaty",
    reason: readTrailingArgument("operator requested runner loop")
  });

  return [
    "Neonika Node Runner control: ok",
    `Desired: ${control.desiredState}`,
    `Operator: ${control.operatorId}`,
    `Updated: ${control.updatedAt}`,
    `Secrets persisted: ${control.safety.sessionSecretPersisted || control.safety.rawTokenPersisted}`
  ].join("\n");
}

async function runNodeRunnerStop(): Promise<string> {
  const control = await writeNeonNodeRunnerControl(process.cwd(), {
    desiredState: "stopped",
    operatorId: readOptionalEnv("NEON_NODE_RUNNER_OPERATOR") ?? "chaty",
    reason: readTrailingArgument("operator stopped runner loop")
  });

  return [
    "Neonika Node Runner control: ok",
    `Desired: ${control.desiredState}`,
    `Operator: ${control.operatorId}`,
    `Updated: ${control.updatedAt}`,
    `Secrets persisted: ${control.safety.sessionSecretPersisted || control.safety.rawTokenPersisted}`
  ].join("\n");
}

async function runNodeRunnerLoop(): Promise<string> {
  const snapshot = await runNeonNodeRunnerLoop(createNodeRunnerLoopOptions(process.cwd()));
  return renderNeonNodeRunnerSnapshotReport(snapshot);
}

async function runNodeRunnerLoopSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-runner-loop-smoke-"));

  try {
    const setup = await createCliSmokeNodeTransportDispatch(projectRoot);
    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "running",
          operatorId: "chaty",
          reason: "runner loop smoke"
        },
        {
          now: () => new Date("2026-06-01T00:20:00.000Z")
        }
      );
      const snapshot = await runNeonNodeRunnerLoop({
        gatewayUrl: handle.url,
        projectRoot,
        sessionId: setup.sessionId,
        sessionSecret: setup.sessionSecret,
        intervalMs: 0,
        maxCycles: 2,
        now: () => new Date("2026-06-01T00:21:00.000Z"),
        wait: async () => undefined
      });
      const transportResponse = await fetch(`${handle.url}/api/neon-nodes/transport`);
      const transport = (await transportResponse.json()) as INeonNodeTransportSnapshot;
      const runnerResponse = await fetch(`${handle.url}/api/neon-nodes/runner`);
      const runnerSnapshot = (await runnerResponse.json()) as Awaited<ReturnType<typeof createNeonNodeRunnerSnapshot>>;

      await writeNeonNodeRunnerControl(
        projectRoot,
        {
          desiredState: "stopped",
          operatorId: "chaty",
          reason: "runner loop smoke complete"
        },
        {
          now: () => new Date("2026-06-01T00:22:00.000Z")
        }
      );
      const stoppedResponse = await fetch(`${handle.url}/api/neon-nodes/runner`);
      const stoppedSnapshot = (await stoppedResponse.json()) as Awaited<ReturnType<typeof createNeonNodeRunnerSnapshot>>;
      const runnerPaths = resolveNeonNodeRunnerPaths(projectRoot);
      const serialized = JSON.stringify({
        snapshot,
        runnerSnapshot,
        stoppedSnapshot
      });

      if (
        snapshot.state !== "running" ||
        snapshot.control.desiredState !== "running" ||
        snapshot.totals.cycles !== 2 ||
        snapshot.totals.pollRequests !== 2 ||
        snapshot.totals.dispatches !== 1 ||
        snapshot.totals.submitted !== 1 ||
        snapshot.totals.failed !== 0 ||
        !snapshot.cursor ||
        !transportResponse.ok ||
        transport.totals.results !== 1 ||
        transport.totals.polls !== 2 ||
        !runnerResponse.ok ||
        runnerSnapshot.totals.cycles !== 2 ||
        !stoppedResponse.ok ||
        stoppedSnapshot.state !== "stopped" ||
        stoppedSnapshot.control.desiredState !== "stopped" ||
        serialized.includes(setup.sessionSecret) ||
        serialized.includes("neon_node_session_smoke_secret") ||
        serialized.includes("neon_node_canary_session_smoke_secret")
      ) {
        throw new Error("Node runner loop smoke failed");
      }

      return [
        "Neonika Node Runner Loop: ok",
        `URL: ${handle.url}/api/neon-nodes/runner`,
        `Control: ${snapshot.control.desiredState} -> ${stoppedSnapshot.control.desiredState}`,
        `Cycles: ${snapshot.totals.cycles}`,
        `Polls: ${transport.totals.polls}`,
        `Results: ${transport.totals.results}`,
        `Health path: ${runnerPaths.healthPath}`,
        "Cursor: persisted",
        "Mutation: false",
        "Secrets exposed: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function createNodeRunnerLoopOptions(projectRoot: string): Parameters<typeof runNeonNodeRunnerLoop>[0] {
  const gatewayUrl = readOptionalEnv("NEON_NODE_GATEWAY_URL") ?? readOptionalEnv("NEONIKA_GATEWAY_URL") ?? "http://127.0.0.1:8797";
  const intervalMs = readOptionalNumberEnv("NEON_NODE_RUNNER_INTERVAL_MS");
  const maxCycles = readOptionalNumberEnv("NEON_NODE_RUNNER_MAX_CYCLES");
  const cursor = readOptionalEnv("NEON_NODE_CURSOR");

  return {
    gatewayUrl,
    projectRoot: readOptionalEnv("NEON_NODE_PROJECT_ROOT") ?? projectRoot,
    sessionId: readRequiredEnv(["NEON_NODE_SESSION_ID"]),
    sessionSecret: readRequiredEnv(["NEON_NODE_SESSION_SECRET"]),
    ...(cursor ? { cursor } : {}),
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(maxCycles === undefined ? {} : { maxCycles })
  };
}

async function runNodeRunnerService(): Promise<string> {
  return renderNeonNodeRunnerServiceReport(await createNeonNodeRunnerServiceSnapshot(process.cwd()));
}

async function runNodeRunnerServicePlist(): Promise<string> {
  const snapshot = await createNeonNodeRunnerServiceSnapshot(process.cwd());
  return renderNeonNodeRunnerServicePlist({
    projectRoot: snapshot.paths.projectRoot,
    paths: snapshot.paths
  });
}

async function runNodeRunnerServiceSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-runner-service-smoke-"));

  try {
    await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
    await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    await writeNeonNodeRunnerControl(
      projectRoot,
      {
        desiredState: "running",
        operatorId: "chaty",
        reason: "runner service smoke"
      },
      {
        now: () => new Date("2026-06-01T00:30:00.000Z")
      }
    );

    const snapshot = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
      now: () => new Date("2026-06-01T00:31:00.000Z"),
      env: {
        NEON_NODE_SESSION_ID: "service-session-unit",
        NEON_NODE_SESSION_SECRET: "service-session-secret-unit"
      },
      platform: "darwin",
      arch: "arm64",
      homeDir: join(projectRoot, "home"),
      userId: 501
    });
    const serialized = JSON.stringify(snapshot);

    if (
      snapshot.state !== "ready" ||
      snapshot.manager !== "launchd" ||
      snapshot.credentials.source !== "process-env" ||
      snapshot.blockers.length !== 0 ||
      snapshot.installState !== "not-installed" ||
      !snapshot.launchAgentPlist.includes("com.neon.core.node-runner") ||
      !snapshot.commands.some((command) => command.id === "restart" && command.requiresApproval) ||
      serialized.includes("service-session-secret-unit") ||
      snapshot.safety.installExecuted ||
      snapshot.safety.restartExecuted ||
      snapshot.safety.stopExecuted ||
      snapshot.safety.launchAgentWritten ||
      snapshot.safety.sessionSecretPersisted
    ) {
      throw new Error("Node runner service smoke failed");
    }

    return [
      "Neonika Node Runner Service: ok",
      `LaunchAgent: ${snapshot.paths.launchAgentPath}`,
      `Manager: ${snapshot.manager}`,
      `State: ${snapshot.state}`,
      `Commands: ${snapshot.commands.length}`,
      "Install executed: false",
      "Secrets exposed: false"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeRunnerServiceActions(): Promise<string> {
  const snapshot = await createNeonNodeRunnerServiceActionSnapshot(process.cwd());
  const requestLines =
    snapshot.requests.length > 0
      ? snapshot.requests.map((request) => `- ${request.actionRequestId}: ${request.action} / ${request.state}`)
      : ["- none"];

  return [
    `Neonika Node Runner Service Actions: ${snapshot.state}`,
    `Requests: ${snapshot.totals.requests}`,
    `Pending approvals: ${snapshot.totals.pendingApproval}`,
    `Blocked: ${snapshot.totals.blocked}`,
    `Approvals: ${snapshot.totals.approvals}`,
    `Execution enabled: false`,
    "Requests:",
    ...requestLines
  ].join("\n");
}

async function runNodeRunnerServiceCanary(): Promise<string> {
  return renderNeonNodeRunnerServiceCanaryReport(await createNeonNodeRunnerServiceCanarySnapshot(process.cwd()));
}

async function runNodeRunnerServiceActionRequest(): Promise<string> {
  const action = readOptionalEnv("NEON_NODE_SERVICE_ACTION") ?? readTrailingArgument("restart");
  const operatorId = readOptionalEnv("NEON_NODE_SERVICE_OPERATOR_ID") ?? "chaty";
  const reason = readOptionalEnv("NEON_NODE_SERVICE_ACTION_REASON");
  const request = await requestNeonNodeRunnerServiceAction(process.cwd(), {
    action,
    operatorId,
    ...(reason ? { reason } : {})
  });

  return [
    "Neonika Node Runner service action request recorded: ok",
    `Request: ${request.actionRequestId}`,
    `Action: ${request.action}`,
    `State: ${request.state}`,
    `Command: ${request.command}`,
    `Mutation executed: ${request.safety.serviceMutationExecuted}`,
    `Secrets persisted: ${request.safety.sessionSecretPersisted || request.safety.rawTokenPersisted}`
  ].join("\n");
}

async function runNodeRunnerServiceActionApprove(): Promise<string> {
  const actionRequestId = readRequiredEnv(["NEON_NODE_SERVICE_ACTION_REQUEST_ID"]);
  const decision = readOptionalEnv("NEON_NODE_SERVICE_ACTION_DECISION") ?? "approve";
  const operatorId = readOptionalEnv("NEON_NODE_SERVICE_OPERATOR_ID") ?? "chaty";
  const reason = readOptionalEnv("NEON_NODE_SERVICE_ACTION_REASON");
  const approval = await approveNeonNodeRunnerServiceAction(process.cwd(), {
    actionRequestId,
    decision,
    operatorId,
    ...(reason ? { reason } : {})
  });

  return [
    "Neonika Node Runner service action approval recorded: ok",
    `Approval: ${approval.approvalId}`,
    `Request: ${approval.actionRequestId}`,
    `Decision: ${approval.decision}`,
    `Execution: ${approval.safety.executionEnabled}`,
    `Mutation executed: ${approval.safety.serviceMutationExecuted}`
  ].join("\n");
}

async function runNodeRunnerServiceActionExecute(): Promise<string> {
  const approvalId = readRequiredEnv(["NEON_NODE_SERVICE_ACTION_APPROVAL_ID"]);
  const operatorId = readOptionalEnv("NEON_NODE_SERVICE_OPERATOR_ID") ?? "chaty";
  const reason = readOptionalEnv("NEON_NODE_SERVICE_ACTION_REASON");
  const execution = await executeNeonNodeRunnerServiceAction(process.cwd(), {
    approvalId,
    operatorId,
    ...(reason ? { reason } : {})
  });

  return [
    "Neonika Node Runner service action execution recorded: ok",
    `Execution: ${execution.executionId}`,
    `Approval: ${execution.approvalId}`,
    `Action: ${execution.action}`,
    `State: ${execution.state}`,
    `Runner control written: ${execution.safety.runnerControlWritten}`,
    `Service mutation: ${execution.safety.serviceMutationExecuted}`,
    `Secrets persisted: ${execution.safety.sessionSecretPersisted || execution.safety.rawTokenPersisted}`
  ].join("\n");
}

async function runNodeRunnerServiceActionsSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-runner-service-actions-smoke-"));

  try {
    await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
    await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    await writeNeonNodeRunnerControl(
      projectRoot,
      {
        desiredState: "running",
        operatorId: "chaty",
        reason: "runner service action smoke"
      },
      {
        now: () => new Date("2026-06-01T00:40:00.000Z")
      }
    );

    const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
      now: () => new Date("2026-06-01T00:41:00.000Z"),
      env: {
        NEON_NODE_SESSION_ID: "service-action-session-unit",
        NEON_NODE_SESSION_SECRET: "service-action-session-value"
      },
      platform: "darwin",
      arch: "arm64",
      homeDir: join(projectRoot, "home"),
      userId: 501
    });
    const request = await requestNeonNodeRunnerServiceAction(
      projectRoot,
      {
        action: "start-runner",
        operatorId: "chaty",
        reason: "service action smoke"
      },
      {
        now: () => new Date("2026-06-01T00:42:00.000Z"),
        serviceSnapshot: service
      }
    );
    const approval = await approveNeonNodeRunnerServiceAction(
      projectRoot,
      {
        actionRequestId: request.actionRequestId,
        decision: "approve",
        operatorId: "chaty",
        reason: "service action smoke approved"
      },
      {
        now: () => new Date("2026-06-01T00:43:00.000Z")
      }
    );
    const execution = await executeNeonNodeRunnerServiceAction(
      projectRoot,
      {
        approvalId: approval.approvalId,
        operatorId: "chaty",
        reason: "service action smoke execute"
      },
      {
        now: () => new Date("2026-06-01T00:43:30.000Z"),
        serviceSnapshot: service
      }
    );
    const snapshot = await createNeonNodeRunnerServiceActionSnapshot(projectRoot, {
      now: () => new Date("2026-06-01T00:44:00.000Z"),
      serviceSnapshot: service
    });
    const serialized = JSON.stringify(snapshot);

    if (
      request.state !== "approval-required" ||
      approval.decision !== "approve" ||
      execution.state !== "executed" ||
      !execution.safety.runnerControlWritten ||
      approval.safety.executionEnabled ||
      approval.safety.serviceMutationExecuted ||
      approval.safety.launchAgentWritten ||
      snapshot.state !== "ready" ||
      snapshot.totals.requests !== 1 ||
      snapshot.totals.pendingApproval !== 0 ||
      snapshot.totals.executed !== 1 ||
      serialized.includes("service-action-session-value")
    ) {
      throw new Error("Node runner service actions smoke failed");
    }

    return [
      "Neonika Node Runner Service Actions: ok",
      `Request: ${request.actionRequestId}`,
      `Approval: ${approval.approvalId}`,
      `Execution: ${execution.executionId}`,
      `State: ${snapshot.state}`,
      `Execution enabled: ${execution.safety.executionEnabled}`,
      `Runner control written: ${execution.safety.runnerControlWritten}`,
      "Service mutation executed: false",
      "Secrets exposed: false"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodeRunnerServiceCanarySmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-runner-service-canary-smoke-"));

  try {
    await mkdir(join(projectRoot, "dist", "src"), { recursive: true });
    await writeFile(join(projectRoot, "dist", "src", "cli.js"), "#!/usr/bin/env node\n", "utf8");
    await writeNeonNodeRunnerControl(
      projectRoot,
      {
        desiredState: "running",
        operatorId: "chaty",
        reason: "runner service canary smoke"
      },
      {
        now: () => new Date("2026-06-01T00:45:00.000Z")
      }
    );

    const env = {
      NEON_NODE_SESSION_ID: "service-canary-session-unit",
      NEON_NODE_SESSION_SECRET: "service-canary-session-value",
      NEON_NODE_SERVICE_EXECUTOR_MODE: "armed",
      NEON_CUTOVER_ROLLBACK_COMMAND: "node dist/src/cli.js node-runner-stop"
    };
    const service = await createNeonNodeRunnerServiceSnapshot(projectRoot, {
      now: () => new Date("2026-06-01T00:46:00.000Z"),
      env,
      platform: "darwin",
      arch: "arm64",
      homeDir: join(projectRoot, "home"),
      userId: 501
    });
    const snapshot = await createNeonNodeRunnerServiceCanarySnapshot(projectRoot, {
      now: () => new Date("2026-06-01T00:47:00.000Z"),
      env,
      cutoverSnapshot: createCliSmokeCanaryCutoverSnapshot(projectRoot),
      serviceSnapshot: service
    });
    const serialized = JSON.stringify(snapshot);

    if (
      snapshot.state !== "ready" ||
      snapshot.executorMode !== "armed" ||
      !snapshot.rollbackConfigured ||
      snapshot.cutoverStage !== "canary" ||
      snapshot.currentGateState !== "pass" ||
      !snapshot.safety.canaryMutationAllowed ||
      snapshot.safety.serviceMutationExecuted ||
      serialized.includes("service-canary-session-value")
    ) {
      throw new Error("Node runner service canary smoke failed");
    }

    return [
      "Neonika Node Runner Service Canary: ok",
      `State: ${snapshot.state}`,
      `Executor: ${snapshot.executorMode}`,
      `Rollback configured: ${snapshot.rollbackConfigured}`,
      `Cutover: ${snapshot.cutoverStage} / ${snapshot.currentGateState}`,
      `Canary mutation allowed: ${snapshot.safety.canaryMutationAllowed}`,
      "Service mutation executed: false",
      "Secrets exposed: false"
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function createCliSmokeNodeTransportDispatch(
  projectRoot: string
): Promise<ICliSmokeNodeTransportDispatch> {
  await mkdir(join(projectRoot, "transport-fixtures"), { recursive: true });
  await writeFile(join(projectRoot, "transport-fixtures", "sample.txt"), "Neon transport smoke\n", "utf8");

  const smoke = await createCliSmokeNodeDeviceSession(projectRoot);
  const session = smoke.snapshot.sessions[0];

  if (!session) {
    throw new Error("Node transport smoke failed: no active session");
  }

  const request = await recordNeonNodeActionRequest(
    projectRoot,
    {
      sessionId: session.sessionId,
      kind: "dir.list",
      requestedBy: "chaty",
      targetPath: join(projectRoot, "transport-fixtures"),
      reason: "directory transport smoke"
    },
    {
      deviceSessionSnapshot: smoke.snapshot,
      now: () => new Date(Date.now() + 9 * 60_000)
    }
  );
  await recordNeonNodeActionApproval(
    projectRoot,
    {
      requestId: request.requestId,
      decision: "approve",
      operatorId: "chaty",
      reason: "approve transport dispatch"
    },
    {
      now: () => new Date(Date.now() + 10 * 60_000)
    }
  );

  const snapshot = await createNeonNodeTransportSnapshot(projectRoot, {
    deviceSessionSnapshot: smoke.snapshot,
    now: () => new Date(Date.now() + 11 * 60_000)
  });
  const dispatch = snapshot.dispatches[0];

  if (!dispatch) {
    throw new Error("Node transport smoke failed: no ready dispatch");
  }

  return {
    dispatchId: dispatch.dispatchId,
    sessionId: session.sessionId,
    sessionSecret: smoke.sessionResult.oneTimeSessionSecret.sessionSecret,
    snapshot
  };
}

function renderNodeTransportResultIngest(result: INeonNodeTransportResultRecord): string {
  return [
    "Neon node transport result ingest: ok",
    `Result: ${result.transportResultId}`,
    `Dispatch: ${result.dispatchId}`,
    `Kind: ${result.resultKind}`,
    `State: ${result.state}`,
    `Mutation: ${result.safety.mutationExecuted}`,
    `Raw output persisted: ${result.safety.rawOutputPersisted}`,
    `Summary: ${result.summary}`
  ].join("\n");
}

interface ICliSmokeNodeTransportDispatch {
  readonly dispatchId: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly snapshot: INeonNodeTransportSnapshot;
}

interface ICliSmokeNodeDeviceSession {
  readonly sessionResult: Awaited<ReturnType<typeof openNeonNodeDeviceSession>>;
  readonly snapshot: INeonNodeDeviceSessionSnapshot;
}

async function createCliSmokeNodeDeviceSession(projectRoot: string): Promise<ICliSmokeNodeDeviceSession> {
  const baseTimeMs = Date.now();
  const at = (minutes: number): (() => Date) => () => new Date(baseTimeMs + minutes * 60_000);
  const request = await createNeonNodePairingRequest(
    projectRoot,
    {
      requestId: "pair-device-session-smoke-request",
      deviceId: "operator-phone",
      publicKey: "smoke-public-key",
      displayName: "Operator Phone",
      platform: "ios",
      requestedScopes: [
        "operator.pairing",
        "node.heartbeat",
        "file.read",
        "browser.read",
        "file.write",
        "browser.control"
      ]
    },
    {
      now: at(0)
    }
  );
  const approval = await recordNeonNodePairingApproval(
    projectRoot,
    {
      requestId: request.requestId,
      decision: "approve",
      decidedBy: "chaty",
      reason: "device session smoke"
    },
    {
      now: at(1)
    }
  );
  const pairingSnapshot = await createNeonNodePairingSnapshot(projectRoot, {
    now: at(2)
  });
  const tokenGateSnapshot = await createNeonNodePairingTokenGateSnapshot(projectRoot, {
    pairingSnapshot,
    cutoverSnapshot: createCliSmokeCanaryCutoverSnapshot(projectRoot),
    now: at(3)
  });
  const tokenResult = await issueNeonNodePairingCanaryToken(
    projectRoot,
    {
      requestId: request.requestId,
      approvalId: approval.approvalId,
      issuedBy: "chaty",
      deliveryMethod: "mission-control-once",
      deliveryNote: "device session smoke",
      ttlMinutes: 15
    },
    {
      tokenGateSnapshot,
      createTokenMaterial: () => "neon_node_canary_session_smoke_secret",
      now: at(4)
    }
  );
  const canaryTokenSnapshot = await createNeonNodePairingCanaryTokenSnapshot(projectRoot, {
    tokenGateSnapshot,
    now: at(5)
  });
  const sessionResult = await openNeonNodeDeviceSession(
    projectRoot,
    {
      tokenIssueId: tokenResult.record.tokenIssueId,
      token: tokenResult.oneTimeSecret.token,
      acceptedBy: "chaty",
      deviceNonce: "smoke-device-nonce",
      requestedScopes: [
        "operator.pairing",
        "node.status",
        "file.read",
        "browser.read",
        "file.write",
        "browser.control"
      ],
      ttlMinutes: 30
    },
    {
      canaryTokenSnapshot,
      createSessionSecret: () => "neon_node_session_smoke_secret",
      now: at(6)
    }
  );
  const snapshot = await createNeonNodeDeviceSessionSnapshot(projectRoot, {
    canaryTokenSnapshot,
    now: at(7)
  });

  return {
    sessionResult,
    snapshot
  };
}

function createCliSmokeCanaryCutoverSnapshot(projectRoot: string): INeonCutoverGateSnapshot {
  const gates: readonly INeonCutoverGate[] = [
    createCliSmokeCutoverGate("shadow", "Shadow", "pass"),
    createCliSmokeCutoverGate("mirror", "Mirror", "pass"),
    createCliSmokeCutoverGate("canary", "Canary", "pass"),
    createCliSmokeCutoverGate("primary", "Primary", "locked"),
    createCliSmokeCutoverGate("retire", "Retire", "locked")
  ];

  return {
    state: "ready",
    generatedAt: "2026-06-01T00:03:00.000Z",
    currentStage: "canary",
    nextStage: "primary",
    gates,
    source: {
      projectRoot,
      doctorState: "pass",
      routeState: "ready",
      mirrorEvidenceState: "ready",
      mirrorAcceptedCount: 2,
      gatewayRuns: 5,
      latestRunId: "run-canary-token-smoke",
      rollbackConfigured: true
    }
  };
}

function createCliSmokeCutoverGate(
  id: INeonCutoverGate["id"],
  label: string,
  state: INeonCutoverGate["state"]
): INeonCutoverGate {
  return {
    id,
    label,
    state,
    summary: `${label} gate ${state}`,
    requiredEvidence: ["operator evidence"],
    evidence: ["evidence present"],
    recovery: state === "pass" ? [] : ["keep previous stage active"],
    rollback: "Keep current route unchanged."
  };
}

async function runNodePairingSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-node-pairing-smoke-"));

  try {
    const request = await createNeonNodePairingRequest(
      projectRoot,
      {
        requestId: "pair-smoke-request",
        deviceId: "operator-phone",
        publicKey: "smoke-public-key",
        displayName: "Operator Phone",
        platform: "ios",
        requestedScopes: ["operator.pairing"]
      },
      {
        now: () => new Date("2026-06-01T00:00:00.000Z")
      }
    );
    await recordNeonNodePairingApproval(
      projectRoot,
      {
        requestId: request.requestId,
        decision: "approve",
        decidedBy: "chaty",
        reason: "smoke"
      },
      {
        now: () => new Date("2026-06-01T00:01:00.000Z")
      }
    );

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-nodes/pairing`);
      const payload = (await response.json()) as INeonNodePairingSnapshot;

      if (!response.ok || payload.totals.approvedShadow !== 1 || payload.approvals[0]?.tokenIssued !== false) {
        throw new Error(`Node pairing smoke failed with HTTP ${response.status}`);
      }

      return [
        "Neonika Node Pairing API: ok",
        `URL: ${handle.url}/api/neon-nodes/pairing`,
        `Requests: ${payload.totals.requests}`,
        `Approvals: ${payload.totals.approvals}`,
        "Token issued: false"
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runNodesSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/api/neon-nodes`);
    const payload = (await response.json()) as INeonNodesSnapshot;
    const fileCapability = payload.capabilities.find((capability) => capability.id === "file-transfer");

    if (!response.ok || payload.state !== "ready" || !payload.localNode.nodeId.startsWith("local-")) {
      throw new Error(`Neonika Nodes smoke failed with HTTP ${response.status}`);
    }

    if (!fileCapability || fileCapability.policy !== "read-only") {
      throw new Error("Neonika Nodes smoke failed: file-transfer is not read-only");
    }

    return [
      "Neonika Nodes API: ok",
      `URL: ${handle.url}/api/neon-nodes`,
      `Node: ${payload.localNode.nodeId}`,
      `Capabilities: ${payload.totals.capabilities}`,
      `Pairing requests: ${payload.totals.pairingRequests}`,
      `Device sessions: ${payload.totals.deviceSessions}`,
      `Action requests: ${payload.totals.actionRequests}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runDoctorSmoke(): Promise<string> {
  const snapshot = await createNeonDoctorSnapshot(process.cwd(), {
    includeMemoryStatus: true
  });

  return process.argv.includes("--explain")
    ? renderNeonDoctorExplainReport(snapshot)
    : renderNeonDoctorReport(snapshot);
}

async function runDoctorFixSmoke(): Promise<string> {
  const gate = resolveNeonDoctorFixGate(process.env);
  const dir = await mkdtemp(join(tmpdir(), "neonika-doctor-fix-smoke-"));
  const targetPath = join(dir, "config.json");

  try {
    await writeFile(targetPath, "{}\n", { encoding: "utf8", mode: 0o644 });

    const fixed = await applyNeonDoctorPermissionFix({
      targetPath,
      desiredMode: 0o600,
      gate
    });
    const lines = ["== fix attempt ==", renderNeonDoctorPermissionFixReport(fixed)];

    if (fixed.rollback) {
      const rollback = await rollbackNeonDoctorPermissionFix(fixed.rollback);
      lines.push("", `== rollback ==`, `restored mode: ${rollback.restoredModeOctal}`);
    }

    return lines.join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runSecretResolutionSmoke(): Promise<string> {
  const gate = resolveNeonSecretResolutionGate(process.env);
  const fakeSecret = "fake-secret-value-do-not-log-1234567890";
  // A fake op runner so the smoke never touches real 1Password credentials.
  const runOp: TNeonOpRunner = (_ref) =>
    Promise.resolve({ exitCode: 0, stdout: `${fakeSecret}\n`, stderr: "" });

  const result = await resolveNeonSecretRef({
    ref: "op://Automation/Neonika Discord Bot/credential",
    gate,
    runOp
  });

  const report = renderNeonSecretResolutionReport(result);
  const leaked = report.includes(fakeSecret) || JSON.stringify(result).includes(fakeSecret);

  return [report, "", `Fake secret value present in output: ${leaked ? "YES (LEAK)" : "no"}`].join("\n");
}

async function runMirrorRunSmoke(): Promise<string> {
  const gate = resolveNeonMirrorRunGate(process.env);
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-mirror-run-smoke-"));

  try {
    const result = await runNeonMirrorComparison({
      projectRoot,
      prompt: "ping",
      gate,
      runNeonSide: (_prompt) => Promise.resolve({ output: "pong", latencyMs: 120, runId: "neon-mirror-smoke" }),
      v3Side: { output: "pong", latencyMs: 180, runId: "v3-mirror-smoke" }
    });

    return renderNeonMirrorComparisonReport(result);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function runOnboardingSmoke(): Promise<string> {
  const configRoot = readFlagValue(process.argv.slice(3), "--config-root");
  const snapshot = await createNeonOnboardingSnapshot(process.cwd(), {
    ...(configRoot ? { configRoot } : {})
  });

  return renderNeonOnboardingReport(snapshot);
}

async function runOnboard(): Promise<string> {
  const args = process.argv.slice(3);
  assertOnboardingInvocation(args);
  const interactiveOptions = shouldPromptForOnboarding(args)
    ? await collectInteractiveSetupOptions()
    : {};
  const configRoot = readFlagValue(args, "--config-root");
  const ownerId = readFlagValue(args, "--owner-id");
  const displayName = readFlagRest(args, "--name");
  const discordOwner = readFlagValue(args, "--discord-owner");
  const whatsappOwner = readFlagValue(args, "--whatsapp-owner");
  const whatsappMode = readFlagValue(args, "--whatsapp-mode");
  if (whatsappMode !== undefined && whatsappMode !== "dedicated" && whatsappMode !== "personal") {
    throw new Error("--whatsapp-mode must be dedicated or personal");
  }
  const discordRequested = [
    "--discord",
    "--discord-owner",
    "--discord-guilds",
    "--discord-channels"
  ].some((flag) => args.includes(flag));
  const whatsappRequested = ["--whatsapp", "--whatsapp-owner", "--whatsapp-mode"].some(
    (flag) => args.includes(flag)
  );
  const result = await runNeonSetup({
    ...interactiveOptions,
    ...(configRoot ? { configRoot } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(discordRequested
      ? {
          discord: {
            enabled: true,
            ...(discordOwner ? { ownerPeerId: discordOwner } : {}),
            allowedGuilds: readCsvFlag(args, "--discord-guilds"),
            allowedChannels: readCsvFlag(args, "--discord-channels")
          }
        }
      : {}),
    ...(whatsappRequested
      ? {
          whatsapp: {
            enabled: true,
            ...(whatsappOwner ? { ownerPeerId: whatsappOwner } : {}),
            ...(whatsappMode ? { mode: whatsappMode } : {})
          }
        }
      : {})
  });

  return renderNeonSetupReport(result);
}

async function runWhatsAppLogin(): Promise<string> {
  const configRoot = readFlagValue(process.argv.slice(3), "--config-root");
  const result = await runNeonWhatsAppLogin({
    ...(configRoot ? { configRoot } : {})
  });
  return renderNeonWhatsAppLoginReport(result);
}

async function runWhatsAppStatus(): Promise<string> {
  const configRoot = readFlagValue(process.argv.slice(3), "--config-root");
  return renderNeonWhatsAppStatusReport(
    await createNeonWhatsAppStatusSnapshot(configRoot)
  );
}

async function runWhatsAppShadowTap(): Promise<undefined> {
  const configRoot = readFlagValue(process.argv.slice(3), "--config-root");
  const harnessMode = process.env["NEON_WHATSAPP_TAP_HARNESS"] ?? "codex";
  const lifecycleGate = resolveNeonInFlightRunGate();
  const inFlightRuns = createNeonInFlightRunRegistry({ gate: lifecycleGate });
  const harness = await createWhatsAppTapHarness(harnessMode, inFlightRuns);
  const handle = await startNeonWhatsAppShadowTap({
    ...(configRoot ? { configRoot } : {}),
    projectRoot: process.cwd(),
    harness,
    memoryProvider: createMergedNeonMemoryProvider(),
    agentId: process.env["NEON_WHATSAPP_AGENT_ID"] ?? "chaty",
    onEvent: (event) => {
      if (event.kind === "connection") {
        console.log(`whatsapp-shadow-tap connection ${event.state}`);
      } else if (event.kind === "accepted") {
        console.log(`whatsapp-shadow-tap accepted ${event.runId}`);
      } else if (event.kind === "dropped") {
        console.log(`whatsapp-shadow-tap dropped ${event.reason}`);
      } else if (event.kind === "duplicate") {
        console.log("whatsapp-shadow-tap duplicate");
      } else {
        console.error(`whatsapp-shadow-tap error ${event.message}`);
      }
    }
  });

  await handle.ready;
  console.log(
    [
      "WhatsApp shadow tap: ready",
      `Harness: ${harnessMode}`,
      "Owner policy: explicit link only",
      "Groups: disabled",
      "Memory: shared local provider",
      "Delivery: suppressed",
      "Stop: Ctrl+C"
    ].join("\n")
  );
  const closed = await waitForWhatsAppTapStop(handle);
  console.log(
    [
      `WhatsApp shadow tap: stopped (${closed.reason})`,
      `Accepted: ${handle.stats.accepted}`,
      `Dropped: ${handle.stats.dropped}`,
      `Duplicates: ${handle.stats.duplicates}`,
      `Errors: ${handle.stats.errors}`,
      "Replies sent: 0"
    ].join("\n")
  );
  if (closed.reason === "transport-closed") {
    process.exitCode = 1;
  }
  return undefined;
}

async function createWhatsAppTapHarness(
  mode: string,
  inFlightRuns: INeonInFlightRunRegistry
): Promise<ICodexHarness> {
  if (mode === "dry") {
    return createDryRunHarness();
  }
  if (mode === "claude") {
    return createDiscordClaudeTapHarness();
  }
  if (mode === "codex") {
    return createDiscordCodexTapHarness(inFlightRuns);
  }
  throw new Error(`Invalid NEON_WHATSAPP_TAP_HARNESS: ${mode}`);
}

async function waitForWhatsAppTapStop(
  handle: Awaited<ReturnType<typeof startNeonWhatsAppShadowTap>>
): Promise<Awaited<typeof handle.closed>> {
  return await new Promise((resolveStop) => {
    const cleanup = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    const stop = (): void => {
      void handle.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void handle.closed.then((result) => {
      cleanup();
      resolveStop(result);
    });
  });
}

function shouldPromptForOnboarding(args: readonly string[]): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    !args.includes("--yes") &&
    (args.length === 0 || args.includes("--interactive"))
  );
}

function assertOnboardingInvocation(args: readonly string[]): void {
  const interactiveTerminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const booleanFlags = new Set(["--yes", "--interactive", "--discord", "--whatsapp"]);
  const singleValueFlags = new Set([
    "--config-root",
    "--owner-id",
    "--discord-owner",
    "--discord-guilds",
    "--discord-channels",
    "--whatsapp-owner",
    "--whatsapp-mode"
  ]);
  const consumed = new Set<number>();

  if (args.includes("--yes") && args.includes("--interactive")) {
    throw new Error("--yes and --interactive are mutually exclusive");
  }
  for (let index = 0; index < args.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (booleanFlags.has(arg)) {
      continue;
    }
    if (arg === "--name") {
      let valueCount = 0;
      for (let valueIndex = index + 1; valueIndex < args.length; valueIndex += 1) {
        const value = args[valueIndex];
        if (!value || value.startsWith("--")) {
          break;
        }
        consumed.add(valueIndex);
        valueCount += 1;
      }
      if (valueCount === 0) {
        throw new Error("--name requires a value");
      }
      continue;
    }
    if (singleValueFlags.has(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      consumed.add(index + 1);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown onboard option: ${arg}`);
    }
    throw new Error(`Unexpected onboard argument: ${arg}`);
  }
  if (args.includes("--interactive") && !interactiveTerminal) {
    throw new Error("Interactive onboarding requires a terminal; use neonika onboard --yes for headless setup");
  }
  const explicitSetupFlags = [
    "--owner-id",
    "--name",
    "--discord",
    "--discord-owner",
    "--discord-guilds",
    "--discord-channels",
    "--whatsapp",
    "--whatsapp-owner",
    "--whatsapp-mode"
  ];
  if (
    !interactiveTerminal &&
    !args.includes("--yes") &&
    !explicitSetupFlags.some((flag) => args.includes(flag))
  ) {
    throw new Error("Headless onboarding requires --yes or explicit channel settings");
  }
}

async function collectInteractiveSetupOptions(): Promise<IRunNeonSetupOptions> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  console.log("Neonika first-use setup");
  console.log("Shadow mode stays on. No outbound message is sent during setup.");
  console.log("Secrets stay in environment variables and are never written to config.");

  try {
    const displayName = (await prompt.question("Operator name [Operator]: ")).trim() || "Operator";
    const configureDiscord = await askYesNo(prompt, "Configure Discord as the primary hub? [Y/n]: ", true);
    const discord = configureDiscord
      ? {
          enabled: true,
          ownerPeerId: (await prompt.question("Your Discord user id (optional): ")).trim(),
          allowedGuilds: splitCsv(await prompt.question("Allowed Discord guild ids (comma-separated): ")),
          allowedChannels: splitCsv(await prompt.question("Allowed Discord channel ids (comma-separated): "))
        }
      : { enabled: false };
    const configureWhatsApp = await askYesNo(
      prompt,
      "Configure WhatsApp as a linked companion? [Y/n]: ",
      true
    );
    let whatsapp: IRunNeonSetupOptions["whatsapp"] = { enabled: false };
    if (configureWhatsApp) {
      const personal = await askYesNo(prompt, "Use your personal number/self-chat? [y/N]: ", false);
      whatsapp = {
        enabled: true,
        mode: personal ? "personal" : "dedicated",
        ownerPeerId: (await prompt.question("Your WhatsApp number in E.164 form (for example +15551234567): ")).trim()
      };
    }

    return {
      displayName,
      discord,
      whatsapp
    };
  } finally {
    prompt.close();
  }
}

async function askYesNo(
  prompt: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: boolean
): Promise<boolean> {
  const answer = (await prompt.question(question)).trim().toLowerCase();
  if (answer === "") {
    return defaultValue;
  }
  if (answer === "y" || answer === "yes" || answer === "j" || answer === "ja") {
    return true;
  }
  if (answer === "n" || answer === "no" || answer === "nein") {
    return false;
  }
  throw new Error("Please answer yes or no");
}

function splitCsv(value: string): readonly string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function runMissionControlSnapshotSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd()
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const snapshot = await fetchNeonMissionControlGatewaySnapshot(handle.url, {
      recentRunsLimit: 5
    });

    return renderMissionControlSnapshot(snapshot);
  } finally {
    await handle.close();
  }
}

function renderMissionControlSnapshot(snapshot: INeonMissionControlGatewaySnapshot): string {
  return [
    `Mission Control: ${snapshot.title}`,
    `State: ${snapshot.state}`,
    `Runs: ${snapshot.totals.runs}`,
    `Recent: ${snapshot.recentRuns.length}`,
    `Latest: ${snapshot.latestRun?.runId ?? "none"}`,
    `Source: ${snapshot.source.gatewayStatusPath}`
  ].join("\n");
}

async function runMissionControlUiSmoke(): Promise<string> {
  const handle = await listenNeonGatewayHttpServer(
    {
      projectRoot: process.cwd(),
      controlUiDir: PACKAGED_CONTROL_UI_DIR
    },
    {
      host: "127.0.0.1",
      port: 0
    }
  );

  try {
    const response = await fetch(`${handle.url}/mission-control/gateway`);
    const html = await response.text();
    const fallbackMarkers = [
      "Neonika Mission Control",
      "NEONIKA",
      "data-view=\"chat\"",
      "data-view=\"overview\"",
      "data-view=\"activity\"",
      "data-view=\"workboard\"",
      "data-view=\"instances\"",
      "data-view=\"sessions\"",
      "data-view=\"usage\"",
      "data-view=\"cron\"",
      "data-view=\"skills\"",
      "data-view=\"nodes\"",
      "data-view=\"dreams\"",
      "data-view=\"config\"",
      "id=\"view-overview\" data-view=\"overview\" hidden",
      "id=\"view-activity\" data-view=\"activity\" hidden",
      "New session",
      "Chaty Lab",
      "Gateway Zugang",
      "Neonika Chat",
      "WebSocket URL",
      "Event Stream",
      "Gateway Snapshot",
      "Neonika Aktivität",
      "Neonika Instanzen",
      "Neonika Nutzung",
      "Neonika Agents",
      "Cron-Aufgaben",
      "Neonika Skills",
      "Neonika Plugins",
      "Neonika Geräte",
      "Neonika Träume",
      "Neonika Einstellungen",
      "/api/neon-plugins",
      "/api/neon-cutover",
      "/api/neon-gateway/lifecycle",
      "/api/neon-gateway/events",
      "/api/neon-chat/conversations",
      "/api/neon-delivery/queue",
      "/api/neon-sessions",
      "/api/neon-activity",
      "/api/neon-replay",
      "sessionSearchInput",
      "sessionStatusFilter",
      "sessionAgentFilter",
      "sessionClearFilters",
      "sessionVisibleCount",
      "readSessionFiltersFromLocation",
      "writeSessionFiltersToLocation",
      "updateSessionFilters",
      "activitySearchInput",
      "activityStatusFilter",
      "activityAgentFilter",
      "activityClearFilters",
      "activityVisibleCount",
      "readActivityFiltersFromLocation",
      "writeActivityFiltersToLocation",
      "updateActivityFilters",
      "replayRows",
      "replayDetail",
      "loadReplay",
      "replayUrl",
      "activeReplayFilters",
      "readReplayFiltersFromLocation",
      "writeReplayFiltersToLocation",
      "data-replay-run-id",
      "data-replay-session-key",
      "data-replay-conversation-id",
      "/api/neon-mirror/evidence",
      "/api/neon-gateway/routes",
      "/api/neon-skills",
      "/api/neon-extensions",
      "/api/neon-nodes",
      "nodesTokenGate",
      "nodesTokenGateBlockers",
      "nodesCanaryTokens",
      "nodesSecretDelivery",
      "nodesDeviceSessions",
      "nodesDeviceSessionScopes",
      "nodesActionRequests",
      "nodesActionApprovals",
      "nodesActionResultPreviews",
      "nodesTransport",
      "nodesTransportResults",
      "nodesTransportPolls",
      "nodesRunner",
      "nodesRunnerLoop",
      "nodesRunnerService",
      "nodesRunnerServiceInstall",
      "nodesRunnerServiceCredentials",
      "nodesRunnerServiceCanary",
      "nodesRunnerServiceExecutor",
      "nodesRunnerServiceRollback",
      "nodesRunnerServiceCutover",
      "nodesRunnerServiceActions",
      "nodesRunnerServiceApprovals",
      "nodesRunnerServiceExecutions",
      "nodesActionPolicy",
      "/api/neon-doctor",
      "/api/neon-onboarding",
      "/api/neon-automation",
      "initialSnapshot"
    ];
    if (!response.ok) {
      throw new Error(`Mission Control UI smoke failed with HTTP ${response.status}`);
    }

    // The control UI SPA is served under /mission-control/<view> once ui:build
    // has produced dist/control-ui; otherwise the same server-rendered HTML is
    // the fallback. Probe /mission-control/overview and, when the SPA is built,
    // verify a hashed asset actually serves from /control-ui/* end-to-end.
    const overviewResponse = await fetch(`${handle.url}/mission-control/overview`);
    const overviewHtml = await overviewResponse.text();

    if (!overviewResponse.ok) {
      throw new Error(`Mission Control overview smoke failed with HTTP ${overviewResponse.status}`);
    }

    const gatewayAssetMatch = html.match(/\/control-ui\/assets\/[A-Za-z0-9._-]+\.js/u);
    const overviewAssetMatch = overviewHtml.match(/\/control-ui\/assets\/[A-Za-z0-9._-]+\.js/u);
    let uiMode: string;

    if (gatewayAssetMatch && overviewAssetMatch) {
      if (!html.includes("<neon-control-app></neon-control-app>") || !html.includes("Neonika Mission Control")) {
        throw new Error("Mission Control SPA is missing the Neonika shell markers");
      }

      const assetPath = gatewayAssetMatch[0];
      const assetResponse = await fetch(`${handle.url}${assetPath}`);
      const assetContentType = assetResponse.headers.get("content-type") ?? "";

      await assetResponse.arrayBuffer();

      if (!assetResponse.ok || !assetContentType.includes("javascript")) {
        throw new Error(`Control UI asset smoke failed for ${assetPath} (HTTP ${assetResponse.status})`);
      }

      uiMode = `spa (asset ${assetPath})`;
    } else if (
      gatewayAssetMatch === null &&
      overviewAssetMatch === null &&
      fallbackMarkers.every((marker) => html.includes(marker)) &&
      overviewHtml.includes('data-view="overview"')
    ) {
      uiMode = "server-rendered fallback (run npm run ui:build for the SPA)";
    } else {
      throw new Error("Mission Control routes returned neither one shared SPA nor the server-rendered fallback");
    }

    return [
      "Mission Control UI: ok",
      `Dashboard URL: ${handle.url}/mission-control`,
      `Gateway alias: ${handle.url}/mission-control/gateway`,
      `Overview URL: ${handle.url}/mission-control/overview`,
      `UI: ${uiMode}`,
      `Bytes: ${html.length}`
    ].join("\n");
  } finally {
    await handle.close();
  }
}

async function runMissionControlServe(): Promise<undefined> {
  const handle = await listenMissionControlServer();

  console.log(
    [
      "Mission Control server: ready",
      `URL: ${handle.url}/mission-control`,
      `API: ${handle.url}/api/neon-mission-control/gateway`,
      "Stop: Ctrl+C"
    ].join("\n")
  );

  await waitForShutdownSignal(handle);

  return undefined;
}

async function runOperatorShell(): Promise<undefined> {
  await runNeonOperatorShell({ projectRoot: process.cwd() });

  return undefined;
}

async function runOperatorShellSmoke(): Promise<string> {
  const dashboard = await loadNeonTuiDashboard(process.cwd());
  verifyOperatorShellDashboard(dashboard);

  return renderNeonTuiDashboard(dashboard);
}

function verifyOperatorShellDashboard(dashboard: INeonTuiDashboard): void {
  const expectedPanels = ["status", "gateway", "routes", "sessions", "delivery", "cutover", "doctor"];
  const renderedPanels = dashboard.panels.map((panel) => panel.command);

  for (const expected of expectedPanels) {
    if (!renderedPanels.includes(expected as (typeof renderedPanels)[number])) {
      throw new Error(`Operator shell smoke is missing the ${expected} panel`);
    }
  }

  const emptyPanel = dashboard.panels.find((panel) => panel.lines.length === 0);
  if (emptyPanel) {
    throw new Error(`Operator shell smoke produced an empty ${emptyPanel.command} panel`);
  }

  const token = readOptionalEnv("NEON_DISCORD_BOT_TOKEN")?.trim();
  if (token) {
    const serialized = renderNeonTuiDashboard(dashboard);

    if (serialized.includes(token)) {
      throw new Error("Operator shell smoke detected a secret value in the rendered dashboard");
    }
  }
}

async function listenMissionControlServer(): Promise<INeonGatewayHttpServerHandle> {
  const host = process.env["NEONIKA_HOST"] ?? "127.0.0.1";
  const preferredPort = readOptionalPort(process.env["NEONIKA_PORT"]) ?? 8788;

  try {
    return await listenNeonGatewayHttpServer(
      {
        projectRoot: process.cwd(),
        controlUiDir: PACKAGED_CONTROL_UI_DIR
      },
      {
        host,
        port: preferredPort
      }
    );
  } catch (error) {
    if (preferredPort === 0) {
      throw error;
    }

    return await listenNeonGatewayHttpServer(
      {
        projectRoot: process.cwd(),
        controlUiDir: PACKAGED_CONTROL_UI_DIR
      },
      {
        host,
        port: 0
      }
    );
  }
}

function readOptionalPort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid NEONIKA_PORT: ${value}`);
  }

  return port;
}

function readRequiredEnv(names: readonly string[]): string {
  for (const name of names) {
    const value = process.env[name];

    if (value && value.trim() !== "") {
      return value;
    }
  }

  throw new Error(`Missing required env: ${names.join(" or ")}`);
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];

  return value && value.trim() !== "" ? value : undefined;
}

function readMirrorVerdict(value: string): TNeonMirrorEvidenceVerdict {
  const normalized = value.trim().toLowerCase();

  if (normalized === "match" || normalized === "acceptable" || normalized === "drift" || normalized === "failed") {
    return normalized;
  }

  throw new Error(`Invalid NEON_MIRROR_VERDICT: ${value}`);
}

function readOptionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return numberValue;
}

function readRequiredCsvEnv(name: string): readonly string[] {
  const value = readRequiredEnv([name]);
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    throw new Error(`Missing required env entries: ${name}`);
  }

  return entries;
}

function readOptionalCsvEnv(name: string): readonly string[] | undefined {
  const value = readOptionalEnv(name);

  if (!value) {
    return undefined;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.length > 0 ? entries : undefined;
}

function readTrailingArgument(fallback: string): string {
  const value = process.argv.slice(3).join(" ").trim();

  return value.length > 0 ? value : fallback;
}

async function waitForShutdownSignal(handle: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  await handle.close();
}

async function runWorkboardReport(): Promise<string> {
  const snapshot = await createNeonWorkboardSnapshot(process.cwd(), {
    maxRecords: 500
  });

  return renderNeonWorkboardReport(snapshot);
}

async function runWorkboardSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-workboard-smoke-"));

  try {
    for (const task of createWorkboardSmokeTasks()) {
      await writeNeonTask(projectRoot, task);
    }

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const response = await fetch(`${handle.url}/api/neon-workboard?limit=50`);
      const payload = (await response.json()) as INeonWorkboardSnapshot;
      const inProgress = payload.columns.find((column) => column.status === "in-progress");

      if (
        !response.ok ||
        payload.state !== "ready" ||
        payload.totals.tasks !== 3 ||
        payload.totals.blocked !== 1 ||
        inProgress?.count !== 1
      ) {
        throw new Error(`Workboard smoke failed with HTTP ${response.status}`);
      }

      const leaks = JSON.stringify(payload).includes("sk-live-") ? "leak" : "redacted";
      const cardCreateResponse = await fetch(`${handle.url}/api/workboard/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "workboard.cards.create",
          params: {
            title: "card sk-live-SHOULD-REDACT",
            status: "ready",
            priority: "urgent",
            agentId: "chaty"
          }
        })
      });
      const createdCardPayload = readJsonRecord(await cardCreateResponse.json());
      const createdCard = readJsonRecordField(createdCardPayload, "card");
      const cardId = readStringField(createdCard, "id");
      const claimResponse = await fetch(`${handle.url}/api/workboard/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "workboard.cards.claim",
          params: { id: cardId, ownerId: "chaty", ttlSeconds: 60 }
        })
      });
      const claimPayload = readJsonRecord(await claimResponse.json());
      const token = readStringField(claimPayload, "token");

      await fetch(`${handle.url}/api/workboard/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "workboard.cards.heartbeat",
          params: { id: cardId, token, note: "working" }
        })
      });

      const completeResponse = await fetch(`${handle.url}/api/workboard/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "workboard.cards.complete",
          params: {
            id: cardId,
            token,
            summary: "Card lifecycle verified",
            proof: { status: "passed", command: "workboard-smoke" }
          }
        })
      });
      const listResponse = await fetch(`${handle.url}/api/workboard/cards`);
      const cardListPayload = (await listResponse.json()) as INeonWorkboardListResult;
      const cardListText = JSON.stringify(cardListPayload);
      const cardDone = cardListPayload.cards.some((card) => card.id === cardId && card.status === "done");

      if (
        !cardCreateResponse.ok ||
        !claimResponse.ok ||
        !completeResponse.ok ||
        !listResponse.ok ||
        !cardDone ||
        !cardListPayload.statuses.includes("triage") ||
        cardListText.includes(token) ||
        cardListText.includes("sk-live-")
      ) {
        throw new Error("Workboard card lifecycle smoke failed");
      }

      const discordIngress = await runNeonDiscordShadowIngress(
        {
          message: {
            accountId: "default",
            guildId: "900000000000000001",
            channelId: "900000000000000005",
            messageId: "workboard-smoke-discord-message",
            author: {
              id: "operator",
              username: "operator",
              displayName: "Operator"
            },
            content: "<@900000000000000010> /workboard add Discord Workboard producer urgent sk-live-SHOULD-REDACT",
            createdAt: "2026-06-05T12:00:00.000Z",
            mentionedUserIds: ["900000000000000010"]
          },
          policy: {
            agentId: "chaty",
            workspaceRoot: projectRoot,
            mode: "read-only",
            botUserId: "900000000000000010",
            mentionPolicy: "guild",
            allowedGuildIds: ["900000000000000001"],
            allowedChannelIds: ["900000000000000005"]
          },
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "workboard-smoke discord ingress"
          }
        },
        {
          projectRoot,
          harness: createDryRunHarness(),
          now: () => new Date("2026-06-05T12:00:00.000Z")
        }
      );
      const discordListResponse = await fetch(`${handle.url}/api/workboard/cards`);
      const discordListPayload = (await discordListResponse.json()) as INeonWorkboardListResult;
      const discordListText = JSON.stringify(discordListPayload);
      const discordCard = discordListPayload.cards.find(
        (card) => card.metadata?.source?.messageId === "workboard-smoke-discord-message"
      );

      if (
        discordIngress.state !== "accepted" ||
        discordIngress.workboard.state !== "created" ||
        !discordListResponse.ok ||
        discordCard?.status !== "done" ||
        discordCard?.priority !== "urgent" ||
        discordCard.metadata?.proof?.at(-1)?.label !== "discord-ingress-run" ||
        discordListText.includes("sk-live-")
      ) {
        throw new Error("Discord Workboard producer smoke failed");
      }

      return [
        "Neonika Workboard API: ok",
        `URL: ${handle.url}/api/neon-workboard`,
        `Tasks: ${payload.totals.tasks} (open ${payload.totals.open} / blocked ${payload.totals.blocked})`,
        `In Progress column: ${inProgress.count}`,
        `Secret in payload: ${leaks}`,
        "cards: ok",
        `Cards URL: ${handle.url}/api/workboard/cards`,
        `Card lifecycle: ${cardId} done`,
        `Claim token in list: ${cardListText.includes(token) ? "leak" : "redacted"}`,
        `Discord producer: ${discordCard.metadata?.source?.messageId ?? "missing"} -> ${discordCard.status}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

interface IWorkboardAutopilotPoller {
  close(): Promise<void>;
}

function startWorkboardAutopilotPoller(
  options: INeonWorkboardAutoDispatchOptions,
  intervalMs: number
): IWorkboardAutopilotPoller {
  let closed = false;
  let activeTick: Promise<void> | undefined;

  const scheduleTick = (): void => {
    if (closed || activeTick) {
      return;
    }

    activeTick = runWorkboardAutopilotPoll(options).finally(() => {
      activeTick = undefined;
    });
  };
  const timer = setInterval(scheduleTick, intervalMs);

  scheduleTick();

  return {
    close: async () => {
      closed = true;
      clearInterval(timer);
      await activeTick;
    }
  };
}

async function runWorkboardAutopilotPoll(options: INeonWorkboardAutoDispatchOptions): Promise<void> {
  try {
    const result = await runNeonWorkboardAutoDispatchOnce(process.cwd(), options);
    if (result.processed > 0 || result.skipped > 0) {
      console.log(renderNeonWorkboardAutoDispatchReport(result));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`workboard-autopilot error ${redactText(message)}`);
  }
}

async function runWorkboardAutopilotOnce(): Promise<string> {
  if (!isReadyLike(process.env["NEON_WORKBOARD_AUTOPILOT_ENABLED"])) {
    return [
      "Neonika Workboard autopilot: not-run",
      "Set NEON_WORKBOARD_AUTOPILOT_ENABLED=ready to process ready cards.",
      "Executor: NEON_WORKBOARD_AUTOPILOT_EXECUTOR=codex|dry|gateway-dry; default codex.",
      "Safety: codex mode also requires NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready; write mode requires NEON_HARNESS_WRITE_ENABLED=ready."
    ].join("\n");
  }

  const result = await runNeonWorkboardAutoDispatchOnce(
    process.cwd(),
    await createWorkboardAutopilotDispatchOptions()
  );

  return renderNeonWorkboardAutoDispatchReport(result);
}

async function runWorkboardAutopilotLoop(): Promise<undefined> {
  if (!isReadyLike(process.env["NEON_WORKBOARD_AUTOPILOT_ENABLED"])) {
    console.log(
      [
        "Neonika Workboard autopilot loop: not-run",
        "Set NEON_WORKBOARD_AUTOPILOT_ENABLED=ready to poll ready cards.",
        "Stop: Ctrl+C"
      ].join("\n")
    );
    return undefined;
  }

  const intervalMs = readPositiveIntegerEnv("NEON_WORKBOARD_AUTOPILOT_INTERVAL_MS", 15_000);
  const options = await createWorkboardAutopilotDispatchOptions();
  let stopped = false;
  const stopPromise = waitForShutdownSignal({
    close: async () => {
      stopped = true;
    }
  });

  console.log(
    [
      "Neonika Workboard autopilot loop: ready",
      `Interval: ${intervalMs}ms`,
      `Owner: ${options.ownerId ?? "workboard-autopilot"}`,
      "Stop: Ctrl+C"
    ].join("\n")
  );

  while (!stopped) {
    try {
      const result = await runNeonWorkboardAutoDispatchOnce(process.cwd(), options);
      if (result.processed > 0 || result.skipped > 0) {
        console.log(renderNeonWorkboardAutoDispatchReport(result));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`workboard-autopilot-loop error ${redactText(message)}`);
    }

    await Promise.race([sleepMs(intervalMs), stopPromise]);
  }

  await stopPromise;
  console.log("Neonika Workboard autopilot loop: stopped");
  return undefined;
}

async function runWorkboardAutopilotSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-workboard-autopilot-smoke-"));
  const now = createIncrementingDate("2026-06-05T12:30:00.000Z");

  try {
    const successCard = await createNeonWorkboardCard(
      projectRoot,
      {
        title: "Autopilot success card",
        status: "ready",
        priority: "urgent",
        agentId: "chaty",
        taskId: "workboard-autopilot-smoke-success"
      },
      now().getTime()
    );
    const completed = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
      executor: createNeonDryRunWorkboardExecutor(),
      ownerId: "smoke",
      maxCards: 1,
      now
    });
    const failureCard = await createNeonWorkboardCard(
      projectRoot,
      {
        title: "Autopilot blocked card sk-live-SHOULD-REDACT",
        status: "ready",
        priority: "normal",
        agentId: "chaty",
        taskId: "workboard-autopilot-smoke-blocked"
      },
      now().getTime()
    );
    const blocked = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
      executor: async () => {
        throw new Error("smoke failure sk-live-SHOULD-REDACT");
      },
      ownerId: "smoke",
      maxCards: 1,
      now
    });
    const empty = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
      executor: createNeonDryRunWorkboardExecutor(),
      ownerId: "smoke",
      maxCards: 1,
      now
    });
    const cards = await readNeonWorkboardCards(projectRoot);
    const tasks = await readNeonTasks(projectRoot);
    const success = cards.find((card) => card.id === successCard.id);
    const failure = cards.find((card) => card.id === failureCard.id);
    const successTask = tasks.find((task) => task.taskId === "workboard-autopilot-smoke-success");
    const failureTask = tasks.find((task) => task.taskId === "workboard-autopilot-smoke-blocked");
    const serialized = JSON.stringify(cards);

    if (
      completed.completed !== 1 ||
      blocked.blocked !== 1 ||
      empty.state !== "empty" ||
      success?.status !== "done" ||
      failure?.status !== "blocked" ||
      successTask?.status !== "done" ||
      failureTask?.status !== "blocked" ||
      serialized.includes("sk-live-")
    ) {
      throw new Error("Workboard autopilot smoke failed");
    }

    return [
      "Neonika Workboard autopilot smoke: ok",
      `Completed card: ${successCard.id}`,
      `Blocked card: ${failureCard.id}`,
      `Task sync: done=${successTask?.status ?? "missing"} blocked=${failureTask?.status ?? "missing"}`,
      `Empty queue: ${empty.state}`,
      `Secret in cards: ${serialized.includes("sk-live-") ? "leak" : "redacted"}`,
      "",
      renderNeonWorkboardAutoDispatchReport(completed),
      "",
      renderNeonWorkboardAutoDispatchReport(blocked),
      "",
      renderNeonWorkboardAutoDispatchReport(empty)
    ].join("\n");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

async function createWorkboardAutopilotDispatchOptions(): Promise<INeonWorkboardAutoDispatchOptions> {
  const executor = await createWorkboardAutopilotExecutor(readWorkboardAutopilotExecutorModeEnv());

  return {
    executor,
    ownerId: readOptionalEnv("NEON_WORKBOARD_AUTOPILOT_OWNER_ID") ?? "chaty",
    ttlSeconds: readPositiveIntegerEnv("NEON_WORKBOARD_AUTOPILOT_TTL_SECONDS", 30 * 60),
    maxCards: readPositiveIntegerEnv("NEON_WORKBOARD_AUTOPILOT_MAX_CARDS", 1)
  };
}

type TWorkboardAutopilotExecutorMode = "codex" | "dry" | "gateway-dry";

async function createWorkboardAutopilotExecutor(
  mode: TWorkboardAutopilotExecutorMode
): Promise<TNeonWorkboardAutoDispatchExecutor> {
  if (mode === "dry") {
    return createNeonDryRunWorkboardExecutor();
  }

  const runMode = readWorkboardAutopilotRunModeEnv();

  if (mode === "gateway-dry") {
    return createNeonGatewayShadowWorkboardExecutor({
      harness: createDryRunHarness(),
      mode: runMode
    });
  }

  const lifecycleGate = resolveNeonInFlightRunGate();
  if (!lifecycleGate.enabled) {
    throw new Error("Refusing Workboard autopilot codex executor: set NEON_LIVE_RUN_LIFECYCLE_ENABLED=ready first");
  }

  if (runMode === "write" && !isReadyLike(process.env["NEON_HARNESS_WRITE_ENABLED"])) {
    throw new Error("Refusing Workboard autopilot write mode: set NEON_HARNESS_WRITE_ENABLED=ready first");
  }

  return createNeonGatewayShadowWorkboardExecutor({
    harness: await createDiscordTapHarness("codex", lifecycleGate),
    mode: runMode,
    writeRun: writeNeonGatewayRunLatest
  });
}

function readWorkboardAutopilotExecutorModeEnv(): TWorkboardAutopilotExecutorMode {
  const normalized = (readOptionalEnv("NEON_WORKBOARD_AUTOPILOT_EXECUTOR") ?? "codex")
    .trim()
    .toLowerCase();

  if (normalized === "dry" || normalized === "dry-run") {
    return "dry";
  }

  if (normalized === "gateway-dry" || normalized === "shadow-dry") {
    return "gateway-dry";
  }

  if (normalized === "codex") {
    return "codex";
  }

  throw new Error(`Invalid NEON_WORKBOARD_AUTOPILOT_EXECUTOR: ${normalized}`);
}

function readWorkboardAutopilotRunModeEnv(): "read-only" | "write" {
  const normalized = (readOptionalEnv("NEON_WORKBOARD_AUTOPILOT_RUN_MODE") ?? "write").trim().toLowerCase();

  return normalized === "read-only" ? "read-only" : "write";
}

function createIncrementingDate(startIso: string): () => Date {
  let current = Date.parse(startIso);

  return () => {
    current += 1000;
    return new Date(current);
  };
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }

  return value as Record<string, unknown>;
}

function readJsonRecordField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return readJsonRecord(record[key]);
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected string field ${key}`);
  }

  return value.trim();
}

async function runTaskAudit(): Promise<string> {
  const [tasks, runs] = await Promise.all([
    readNeonTasks(process.cwd()),
    readNeonGatewayRuns(process.cwd(), { maxRuns: 2000 })
  ]);
  const knownRunIds = new Set(runs.map((run) => run.runId));
  const findings = listNeonTaskAuditFindings(tasks, { knownRunIds });
  const summary = summarizeNeonTaskAuditFindings(findings);
  return renderNeonTaskAuditReport(findings, summary);
}

async function runFlowAudit(): Promise<string> {
  const flows = await readNeonFlows(process.cwd());
  const findings = listNeonFlowAuditFindings(flows);
  const summary = summarizeNeonFlowAuditFindings(findings);
  return renderNeonFlowAuditReport(findings, summary);
}

function runTaskDeliverySmoke(): string {
  const base = "2026-06-02T10:00:00.000Z";
  const makeTask = (
    taskId: string,
    status: INeonTaskRecord["status"],
    title: string,
    summary?: string,
    runId?: string
  ): INeonTaskRecord => ({
    taskId,
    title,
    ...(summary ? { summary } : {}),
    source: "flow",
    channel: "cli",
    ownerAgentId: "neo",
    status,
    priority: "normal",
    labels: [],
    links: [],
    runIds: runId ? [runId] : [],
    createdAt: base,
    updatedAt: base
  });
  const cases: ReadonlyArray<{ label: string; input: INeonTaskDeliveryInput }> = [
    {
      label: "done",
      input: {
        task: makeTask(
          "t-done",
          "done",
          "Reindex memory store",
          "Indexed 482 entries. token sk-live-SHOULD-REDACT",
          "run-abcd1234ef"
        )
      }
    },
    { label: "cancelled", input: { task: makeTask("t-cancel", "cancelled", "Backfill citations") } },
    { label: "in-progress (not terminal)", input: { task: makeTask("t-prog", "in-progress", "Stream replay") } },
    {
      label: "done + silent policy",
      input: { task: makeTask("t-silent", "done", "Nightly cleanup"), notifyPolicy: "silent" }
    },
    {
      label: "done + already delivered",
      input: { task: makeTask("t-dup", "done", "Build docs"), deliveryState: "delivered" }
    }
  ];
  const lines: string[] = ["Neon task terminal-delivery policy (shadow: never sends):", ""];
  for (const entry of cases) {
    const decision = decideNeonTaskTerminalDelivery(entry.input);
    const verdict = decision.deliver ? "DELIVER" : "skip";
    lines.push(`- ${entry.label}: ${verdict} (${decision.reason})`);
    if (decision.deliver) {
      lines.push(`    message: ${formatNeonTaskTerminalMessage(entry.input.task)}`);
      lines.push("    [suppressed: shadow outbound, no send]");
    }
  }
  return lines.join("\n");
}

async function runTaskLookup(): Promise<string> {
  const args = process.argv.slice(3);
  const tasks = await readNeonTasks(process.cwd());
  const header = `Task store: ${tasks.length} task(s)`;

  const readFlag = (name: string): string | undefined => {
    const idx = args.indexOf(name);
    if (idx < 0) {
      return undefined;
    }
    const value = args[idx + 1];
    return value !== undefined && !value.startsWith("--") ? value : undefined;
  };

  // --owner is an optional modifier: combined with --run/--session it owner-scopes
  // the single-access lookup (a task is only returned when it belongs to ownerId),
  // alone it lists the owner's tasks below. Closes the gap where single-access was
  // unscoped while listNeonTasksForOwner already scoped the list view.
  const ownerId = readFlag("--owner");
  const scopeToOwner = (match: INeonTaskRecord | undefined): INeonTaskRecord | undefined =>
    ownerId === undefined ? match : scopeNeonTaskToOwner(match, ownerId);
  const ownerLabel = (label: string): string => (ownerId === undefined ? label : `${label} owner=${ownerId}`);

  const runId = readFlag("--run");
  if (runId !== undefined) {
    return `${header}\n${renderTaskLookupOne(ownerLabel(`run=${runId}`), scopeToOwner(findNeonTaskByRunId(tasks, runId)))}`;
  }
  const sessionKey = readFlag("--session");
  if (sessionKey !== undefined) {
    return `${header}\n${renderTaskLookupOne(ownerLabel(`session=${sessionKey}`), scopeToOwner(findLatestNeonTaskForSessionKey(tasks, sessionKey)))}`;
  }
  const flowId = readFlag("--flow");
  if (flowId !== undefined) {
    return `${header}\n${renderTaskLookupMany(`flow=${flowId}`, listNeonTasksForFlowId(tasks, flowId))}`;
  }
  if (ownerId !== undefined) {
    return `${header}\n${renderTaskLookupMany(`owner=${ownerId}`, listNeonTasksForOwner(tasks, ownerId))}`;
  }

  const token = args.find((arg) => !arg.startsWith("--"));
  if (token !== undefined) {
    return `${header}\n${renderTaskLookupOne(`token=${token}`, resolveNeonTaskForLookupToken(tasks, token))}`;
  }

  return `${header}\nUsage: task-lookup <token> | --run <id> | --flow <id> | --owner <id> | --session <key>`;
}

function renderTaskLookupOne(label: string, task: INeonTaskRecord | undefined): string {
  return task ? `${label} -> ${describeTaskOneLine(task)}` : `${label} -> no match`;
}

function renderTaskLookupMany(label: string, tasks: readonly INeonTaskRecord[]): string {
  if (tasks.length === 0) {
    return `${label} -> no match`;
  }
  return [
    `${label} -> ${tasks.length} match(es):`,
    ...tasks.map((task) => `  ${describeTaskOneLine(task)}`)
  ].join("\n");
}

function describeTaskOneLine(task: INeonTaskRecord): string {
  const flow = task.flowId ? `, flow=${task.flowId}` : "";
  const runs = task.runIds.length > 0 ? `, runs=${task.runIds.length}` : "";
  return `${task.taskId} [${task.status}/${task.priority}] ${task.title} (owner=${task.ownerAgentId}${flow}${runs})`;
}

async function runCommitmentsSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-commitments-smoke-"));
  const storePath = join(dir, "commitments.jsonl");
  const nowMs = Date.parse("2026-06-03T12:00:00.000Z");
  const sample = buildNeonCommitmentRecord(
    {
      id: "smoke-1",
      agentId: "neo",
      sessionKey: "smoke-session",
      channel: "discord",
      kind: "deadline_check",
      source: "agent_promise",
      suggestedText: "Follow up on the deploy",
      dedupeKey: "smoke-deploy",
      confidence: 0.8,
      dueWindow: { earliestMs: nowMs - 60_000, latestMs: nowMs + 3_600_000, timezone: "UTC" }
    },
    nowMs
  );

  try {
    const offGate = resolveNeonCommitmentStoreGate(process.env);
    const offAppend = await appendNeonCommitment({ commitment: sample, gate: offGate, storePath });

    const armedGate: INeonCommitmentStoreGate = {
      enabled: true,
      reason: "store-enabled",
      envKey: "NEON_COMMITMENTS_STORE_ENABLED"
    };
    const armedAppend = await appendNeonCommitment({ commitment: sample, gate: armedGate, storePath });

    const transition = applyNeonCommitmentStatus(sample, "snoozed", nowMs + 1_000, {
      snoozedUntilMs: nowMs + 7_200_000
    });
    const transitionNote = transition.applied
      ? "transition pending -> snoozed (until +2h)"
      : `transition rejected: ${transition.reason}`;
    if (transition.applied) {
      await appendNeonCommitment({ commitment: transition.commitment, gate: armedGate, storePath });
    }

    const stored = await readNeonCommitments({ storePath });
    const dueNow = listNeonDueCommitments(stored, nowMs, "smoke-session");
    const dueLater = listNeonDueCommitments(stored, nowMs + 10_800_000, "smoke-session");

    return [
      `== default-off == append: ${offAppend.state} (${offGate.reason})`,
      `== armed == append: ${armedAppend.state} (${armedAppend.commitmentId ?? "none"})`,
      transitionNote,
      `Stored (latest-per-id): ${stored.length}`,
      "-- due now --",
      renderNeonDueCommitmentsReport(dueNow),
      "-- due after snooze elapses (+3h) --",
      renderNeonDueCommitmentsReport(dueLater)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runCommitmentHintsImportSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-commitment-hints-import-smoke-"));
  const hintsPath = join(dir, "commitment-hints.json");
  const storePath = join(dir, "commitments.jsonl");
  const nowMs = Date.parse("2026-06-10T12:00:00.000Z");
  const sampleHints = {
    hints: [
      {
        id: "smoke-hint-1",
        title: "Obsidian-Memory-Vault bauen und Action-Inbox nach neonika migrieren",
        source: "codex:/workspace",
        excerpt: "Sample excerpt for the import smoke.",
        priorityHint: "high",
        confidence: 0.92,
        capturedAt: "2026-06-10T14:32:28+02:00"
      }
    ]
  };

  try {
    await writeFile(hintsPath, `${JSON.stringify(sampleHints, null, 2)}\n`, "utf8");

    const offGate = resolveNeonCommitmentStoreGate(process.env);
    const blocked = await importNeonCommitmentHints({ hintsPath, storePath, gate: offGate, now: () => nowMs });

    const armedGate: INeonCommitmentStoreGate = {
      enabled: true,
      reason: "store-enabled",
      envKey: "NEON_COMMITMENTS_STORE_ENABLED"
    };
    const first = await importNeonCommitmentHints({ hintsPath, storePath, gate: armedGate, now: () => nowMs });
    const second = await importNeonCommitmentHints({ hintsPath, storePath, gate: armedGate, now: () => nowMs });
    const stored = await readNeonCommitments({ storePath });

    return [
      `== default-off == import: ${blocked.state} (${offGate.reason})`,
      `== armed (1st) == import: ${first.state}, imported=${first.imported.length}, skipped=${first.skipped.length}`,
      `== armed (2nd, idempotent) == import: ${second.state}, imported=${second.imported.length}, skipped=${second.skipped.length}`,
      `Stored (latest-per-id): ${stored.length}`,
      ...first.imported.map((c) => `  imported ${c.id} [${c.kind}/${c.source}] :: ${c.suggestedText}`)
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runCommitmentLifecycleSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-commitment-lifecycle-smoke-"));
  const storePath = join(dir, "commitments.jsonl");
  const nowMs = Date.parse("2026-06-03T12:00:00.000Z");
  const commitment = buildNeonCommitmentRecord(
    {
      id: "lifecycle-smoke-1",
      agentId: "chaty",
      sessionKey: "smoke-session",
      channel: "discord",
      kind: "open_loop",
      source: "agent_promise",
      suggestedText: "Follow up on the deployment",
      dedupeKey: "lifecycle-smoke-deploy",
      confidence: 0.85,
      dueWindow: { earliestMs: nowMs - 60_000, latestMs: nowMs + 3_600_000, timezone: "UTC" }
    },
    nowMs - 120_000
  );

  try {
    const storeGate = resolveNeonCommitmentStoreGate({ NEON_COMMITMENTS_STORE_ENABLED: "ready" });
    await appendNeonCommitment({ commitment, gate: storeGate, storePath });

    const off = await markNeonCommitmentsHeartbeatObserved({
      commitmentIds: [commitment.id],
      storePath,
      nowMs,
      gate: resolveNeonCommitmentLifecycleGate({})
    });
    const armed = await markNeonCommitmentsHeartbeatObserved({
      commitmentIds: [commitment.id],
      storePath,
      nowMs,
      gate: resolveNeonCommitmentLifecycleGate({ NEON_COMMITMENT_LIFECYCLE_ENABLED: "ready" }),
      storeGate,
      snoozeMs: 900_000
    });
    const stored = await readNeonCommitments({ storePath });
    const updated = stored.find((candidate) => candidate.id === commitment.id);
    const dueNow = listNeonDueCommitments(stored, nowMs, "smoke-session");
    const dueLater = listNeonDueCommitments(stored, nowMs + 900_001, "smoke-session");

    return [
      `== default-off == ${off.state} (${off.gate.reason}), updated=${off.updatedIds.length}`,
      `== armed == ${armed.state} (${armed.gate.reason}), updated=${armed.updatedIds.length}, skipped=${armed.skippedIds.length}`,
      `Stored (latest-per-id): ${stored.length}`,
      `Latest: status=${updated?.status ?? "missing"} attempts=${updated?.attempts ?? 0} snoozedUntil=${updated?.snoozedUntilMs ?? "none"}`,
      "-- due now --",
      renderNeonDueCommitmentsReport(dueNow),
      "-- due after snooze elapses --",
      renderNeonDueCommitmentsReport(dueLater),
      "Safety: lifecycle only writes commitment JSONL; outbound suppressed; no Discord send."
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function runCommitmentCaptureSmoke(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-commitment-capture-smoke-"));
  const storePath = join(dir, "commitments.jsonl");
  const now = new Date("2026-06-03T12:00:00.000Z");
  const message = createCommitmentCaptureSmokeMessage();
  const run = createCommitmentCaptureSmokeRun(message, now.toISOString());

  try {
    const off = await captureNeonCommitmentsFromRun({
      projectRoot: dir,
      run,
      message,
      gate: resolveNeonCommitmentCaptureGate({}),
      storePath,
      now: () => now
    });
    const armed = await captureNeonCommitmentsFromRun({
      projectRoot: dir,
      run,
      message,
      gate: resolveNeonCommitmentCaptureGate({ NEON_COMMITMENT_CAPTURE_ENABLED: "ready" }),
      storePath,
      now: () => now
    });
    const duplicate = await captureNeonCommitmentsFromRun({
      projectRoot: dir,
      run,
      message,
      gate: resolveNeonCommitmentCaptureGate({ NEON_COMMITMENT_CAPTURE_ENABLED: "ready" }),
      storePath,
      now: () => now
    });
    const stored = await readNeonCommitments({ storePath });
    const dueAtWake = listNeonDueCommitments(stored, now.getTime() + 16 * 60_000, run.harnessSessionKey);

    return [
      `== default-off == ${off.state} (${off.gate.reason}), captured=${off.captured.length}`,
      `== armed == ${armed.state} (${armed.gate.reason}), captured=${armed.captured.length}`,
      `== duplicate == ${duplicate.state}, skipped=${duplicate.skipped.length}`,
      `Stored (latest-per-id): ${stored.length}`,
      "-- due after +16m --",
      renderNeonDueCommitmentsReport(dueAtWake),
      "Safety: structural extraction only; outbound suppressed; no LLM call."
    ].join("\n");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

function createCommitmentCaptureSmokeMessage(): INeonGatewayInboundMessage {
  return {
    channel: "discord",
    accountId: "default",
    guildId: "900000000000000001",
    channelId: "900000000000000005",
    threadId: "900000000000000011",
    messageId: "commitment-capture-smoke-message",
    userId: "operator",
    userDisplayName: "Operator",
    agentId: "chaty",
    workspaceRoot: "/tmp/neonika-commitment-capture-smoke",
    mode: "read-only",
    content: "<@900000000000000010> check bitte später ob der Deploy grün ist",
    createdAt: "2026-06-03T11:59:00.000Z"
  };
}

function createCommitmentCaptureSmokeRun(
  message: INeonGatewayInboundMessage,
  completedAt: string
): INeonGatewayShadowRun {
  return {
    runId: "neon-shadow-commitment-capture-smoke",
    mode: "shadow",
    status: "completed",
    request: {
      channel: message.channel,
      accountId: message.accountId,
      ...(message.guildId ? { guildId: message.guildId } : {}),
      channelId: message.channelId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.messageId ? { messageId: message.messageId } : {}),
      userId: message.userId,
      ...(message.userDisplayName ? { userDisplayName: message.userDisplayName } : {}),
      agentId: message.agentId,
      workspaceRoot: message.workspaceRoot,
      mode: message.mode,
      contentPreview: message.content,
      receivedAt: message.createdAt ?? completedAt
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "neon:codex:chaty:discord:default:channel:commitment-capture",
    memoryState: "skipped",
    events: [{ kind: "final", text: "Ich erinnere dich in 15m daran und checke den Deploy nochmal." }],
    finalText: "Ich erinnere dich in 15m daran und checke den Deploy nochmal.",
    delivery: {
      state: "suppressed",
      targetChannel: message.channel,
      targetChannelId: message.channelId,
      reason: "shadow-mode",
      finalText: "Ich erinnere dich in 15m daran und checke den Deploy nochmal."
    },
    startedAt: "2026-06-03T11:59:30.000Z",
    completedAt
  };
}

function createWorkboardSmokeTasks(): readonly INeonTaskRecord[] {
  const base = "2026-06-02T10:00:00.000Z";

  return [
    {
      taskId: "task-triage-inbox",
      title: "Triage Discord inbox backlog",
      summary: "Group new channel messages into the workboard. token sk-live-SHOULD-REDACT",
      source: "channel",
      sourceRef: "discord/900000000000000005",
      channel: "discord",
      channelId: "900000000000000005",
      ownerAgentId: "chaty",
      status: "in-progress",
      priority: "high",
      labels: ["inbox", "triage"],
      links: [{ type: "run", ref: "chat-smoke-run", label: "origin run" }],
      runIds: ["chat-smoke-run"],
      createdAt: base,
      updatedAt: base
    },
    {
      taskId: "task-wire-context-pack",
      title: "Wire bounded context pack into agent recall",
      source: "operator",
      channel: "cli",
      ownerAgentId: "neo",
      status: "ready",
      priority: "normal",
      labels: ["context"],
      links: [],
      runIds: [],
      createdAt: base,
      updatedAt: base
    },
    {
      taskId: "task-await-canary-approval",
      title: "Await operator approval for canary outbound",
      source: "flow",
      channel: "cli",
      ownerAgentId: "neo",
      status: "blocked",
      priority: "urgent",
      due: "2026-05-01T00:00:00.000Z",
      labels: ["gated", "approval"],
      links: [{ type: "flow", ref: "flow-canary-promote" }],
      runIds: [],
      flowId: "flow-canary-promote",
      createdAt: base,
      updatedAt: base
    }
  ];
}

async function runFlowsReport(): Promise<string> {
  const snapshot = await createNeonFlowsSnapshot(process.cwd(), {
    maxRecords: 500
  });

  return renderNeonFlowsReport(snapshot);
}

async function runFlowPlanReport(): Promise<string> {
  const flowId = process.argv.slice(3)[0]?.trim();

  if (!flowId) {
    return "Usage: neonika flow-plan <flowId>";
  }

  const flow = await readNeonFlow(process.cwd(), flowId);

  if (!flow) {
    return `Neonika Flow not found: ${flowId}`;
  }

  return renderNeonFlowPlanReport(planNeonFlowExecution(flow));
}

async function runFlowsSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-flows-smoke-"));

  try {
    for (const flow of createFlowsSmokeFlows()) {
      await writeNeonFlow(projectRoot, flow);
    }

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const flowsResponse = await fetch(`${handle.url}/api/neon-flows?limit=50`);
      const flowsPayload = (await flowsResponse.json()) as INeonFlowsSnapshot;

      const planResponse = await fetch(`${handle.url}/api/neon-flows/plan?flowId=flow-auto-reply`);
      const planPayload = (await planResponse.json()) as INeonFlowExecutionPlan;

      if (
        !flowsResponse.ok ||
        flowsPayload.state !== "ready" ||
        flowsPayload.totals.flows !== 2 ||
        flowsPayload.totals.gatedSteps < 2
      ) {
        throw new Error(`Flows smoke failed with HTTP ${flowsResponse.status}`);
      }

      if (
        !planResponse.ok ||
        planPayload.executable !== false ||
        planPayload.totals.blocked < 2 ||
        planPayload.totals.plannable < 1
      ) {
        throw new Error(`Flow plan smoke failed with HTTP ${planResponse.status}`);
      }

      const leaks = JSON.stringify([flowsPayload, planPayload]).includes("sk-live-")
        ? "leak"
        : "redacted";

      return [
        "Neonika Flows API: ok",
        `URL: ${handle.url}/api/neon-flows`,
        `Flows: ${flowsPayload.totals.flows} (armed ${flowsPayload.totals.armed}) · gated steps: ${flowsPayload.totals.gatedSteps}`,
        `Plan: ${planPayload.flowId} executable=${planPayload.executable} blocked=${planPayload.totals.blocked} plannable=${planPayload.totals.plannable}`,
        `Secret in payload: ${leaks}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}

function createFlowsSmokeFlows(): readonly INeonFlowDefinition[] {
  const base = "2026-06-02T10:00:00.000Z";

  return [
    {
      flowId: "flow-auto-reply",
      name: "Auto-reply triage for one Discord channel",
      description: "Recall context, draft, then a gated send. token sk-live-SHOULD-REDACT",
      ownerAgentId: "chaty",
      trigger: { kind: "channel-message", match: "discord/900000000000000005" },
      steps: [
        { stepId: "recall", title: "Recall channel context", effect: "read", action: "context.pack", gated: false },
        { stepId: "draft", title: "Draft a reply", effect: "read", action: "agent.draft", gated: false },
        { stepId: "send", title: "Send the reply", effect: "send", action: "discord.send", gated: false },
        { stepId: "track", title: "Create a follow-up task", effect: "write", action: "workboard.create", gated: false }
      ],
      status: "armed",
      createdAt: base,
      updatedAt: base
    },
    {
      flowId: "flow-nightly-recall",
      name: "Nightly memory recall digest",
      ownerAgentId: "neo",
      trigger: { kind: "schedule", match: "0 3 * * *" },
      steps: [
        { stepId: "scan", title: "Scan recent runs", effect: "read", action: "runs.read", gated: false },
        { stepId: "summarize", title: "Summarize highlights", effect: "read", action: "agent.summarize", gated: true }
      ],
      status: "draft",
      createdAt: base,
      updatedAt: base
    }
  ];
}

function resolveContextChannel(value: string | undefined): TNeonChannel {
  switch (value) {
    case "discord":
    case "telegram":
    case "whatsapp":
    case "webchat":
    case "device":
      return value;
    default:
      return "cli";
  }
}

async function runContextPackReport(): Promise<string> {
  const args = process.argv.slice(3);
  const agentId = args[0]?.trim() || "neo";
  const channel = resolveContextChannel(args[1]?.trim());
  const query = args.slice(2).join(" ").trim();

  const pack = await createNeonContextPack(
    process.cwd(),
    {
      agentId,
      channel,
      ...(query ? { query } : {})
    },
    { maxRuns: 50, memoryProvider: createMergedNeonMemoryProvider() }
  );

  return renderNeonContextPackReport(pack);
}

async function runContextSmoke(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neonika-context-smoke-"));

  try {
    await writeNeonGatewayRun(projectRoot, createChatSmokeRun(projectRoot));
    await writeNeonTask(projectRoot, {
      taskId: "task-context-triage",
      title: "Triage backlog token sk-live-SHOULD-REDACT",
      source: "channel",
      channel: "discord",
      channelId: "900000000000000005",
      ownerAgentId: "chaty",
      status: "in-progress",
      priority: "high",
      labels: ["triage"],
      links: [],
      runIds: ["chat-smoke-run"],
      createdAt: "2026-06-02T10:00:00.000Z",
      updatedAt: "2026-06-02T10:00:00.000Z"
    });

    const handle = await listenNeonGatewayHttpServer(
      {
        projectRoot
      },
      {
        host: "127.0.0.1",
        port: 0
      }
    );

    try {
      const url = `${handle.url}/api/neon-context/pack?agentId=chaty&channel=discord&channelId=900000000000000005&query=triage`;
      const response = await fetch(url);
      const payload = (await response.json()) as INeonContextPack;

      const runsSection = payload.sections.find((section) => section.id === "runs");
      const tasksSection = payload.sections.find((section) => section.id === "tasks");
      const channelSection = payload.sections.find((section) => section.id === "channel");

      if (
        !response.ok ||
        payload.state !== "ready" ||
        (runsSection?.items.length ?? 0) < 1 ||
        (tasksSection?.items.length ?? 0) < 1 ||
        (channelSection?.items.length ?? 0) !== 1
      ) {
        throw new Error(`Context smoke failed with HTTP ${response.status}`);
      }

      const leaks = JSON.stringify(payload).includes("sk-live-") ? "leak" : "redacted";

      return [
        "Neonika Context Pack API: ok",
        `URL: ${handle.url}/api/neon-context/pack`,
        `State: ${payload.state} · items: ${payload.totals.items} · chars: ${payload.bounds.charsUsed}/${payload.bounds.charBudget}`,
        `Runs: ${runsSection?.items.length} · Tasks: ${tasksSection?.items.length} · Channel: ${channelSection?.items.length}`,
        `Secret in payload: ${leaks}`
      ].join("\n");
    } finally {
      await handle.close();
    }
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
}
