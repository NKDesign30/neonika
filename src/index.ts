export {
  getNeonChannelManifest,
  isNeonChannelPlatform,
  listNeonChannelManifests,
  neonChannelManifests,
  neonChannelPlatforms,
  renderNeonChannelManifestLine,
  summarizeNeonChannelManifests,
  type INeonChannelInboundCapabilities,
  type INeonChannelManifest,
  type INeonChannelManifestTotals,
  type INeonChannelOutboundCapabilities,
  type TNeonChannelLiveStatus,
  type TNeonChannelLoginPolicy,
  type TNeonChannelPlatform,
  type TNeonChannelTransport,
  type TNeonChannelWorkspaceScope
} from "./channels/channelManifest.js";
export {
  createNeonChannelRegistrySnapshot,
  neonChannelRegistryPlatformOrder,
  renderNeonChannelRegistryReport,
  type ICreateNeonChannelRegistrySnapshotOptions,
  type INeonChannelRegistryEntry,
  type INeonChannelRegistrySnapshot,
  type INeonChannelRegistryTotals,
  type INeonChannelRuntimeStatus,
  type TNeonChannelDeliveryPosture,
  type TNeonChannelRegistryState
} from "./channels/channelRegistry.js";
export {
  decideNeonChannelInbound,
  type INeonChannelInboundEnvelope,
  type INeonChannelInboundIdentity,
  type INeonChannelInboundPolicy,
  type TNeonChannelInboundDecision,
  type TNeonChannelInboundDropReason,
  type TNeonChannelMentionPolicy
} from "./channels/channelInbound.js";
export {
  describeNeonChannelRoute,
  neonChannelRouteFromInboundIdentity,
  neonRoutesShareTarget,
  normalizeNeonChannelRoute,
  type INeonChannelRouteInput,
  type INeonChannelRouteRef,
  type TNeonChannelRouteChatType
} from "./channels/routeProjection.js";
export {
  neonImplicitMentionKindWhen,
  renderNeonInboundMentionDecisionReport,
  resolveNeonInboundMentionDecision,
  type INeonInboundMentionDecision,
  type INeonInboundMentionFacts,
  type INeonInboundMentionPolicy,
  type IResolveNeonInboundMentionDecisionParams,
  type TNeonImplicitMentionKind
} from "./channels/inboundMentionDecision.js";
export {
  compileNeonAllowlist,
  formatNeonAllowlistMatchMeta,
  resolveNeonAllowlistCandidates,
  resolveNeonAllowlistMatchByCandidates,
  resolveNeonAllowlistMatchSimple,
  resolveNeonCompiledAllowlistMatch,
  type INeonAllowlistCandidate,
  type INeonAllowlistMatch,
  type INeonCompiledAllowlist,
  type TNeonAllowlistMatchSource
} from "./channels/inboundAllowlistMatch.js";
export {
  NEON_ACCESS_GROUP_ALLOW_FROM_PREFIX,
  compileNeonAllowFrom,
  isNeonSenderIdAllowed,
  mergeNeonDmAllowFromSources,
  normalizeNeonStringEntries,
  parseNeonAccessGroupAllowFromEntry,
  renderNeonAllowFromPolicyReport,
  resolveNeonGroupAllowFromSources,
  type INeonCompiledAllowFrom
} from "./channels/inboundAllowFromPolicy.js";
export {
  expandNeonAllowFromWithAccessGroups,
  formatNeonAccessGroupMatchMeta,
  resolveNeonAccessGroupMatchState,
  type INeonAccessGroupMatchState,
  type INeonMessageSendersAccessGroup,
  type TNeonAccessGroup
} from "./channels/inboundAccessGroups.js";
export {
  NEON_DM_ACCESS_REASON,
  renderNeonDirectDmAccessReport,
  resolveNeonDirectDmAccess,
  type INeonDirectDmAccess,
  type TNeonDmAccessDecision,
  type TNeonDmAccessReasonCode,
  type TNeonDmPolicy
} from "./channels/inboundDirectDmAccess.js";
export {
  renderNeonInboundAccessDecisionReport,
  resolveNeonInboundAccessDecision,
  type INeonInboundAccessDecision,
  type INeonInboundAccessFacts,
  type TNeonInboundAccessBlockReason
} from "./channels/inboundAccessDecision.js";
export {
  renderNeonChannelOutboundPolicyLine,
  resolveAllNeonChannelOutboundPolicies,
  resolveNeonChannelOutboundPolicy,
  type INeonChannelOutboundPolicy,
  type IResolveNeonChannelOutboundPolicyOptions,
  type TNeonChannelOutboundMode
} from "./channels/channelOutbound.js";
export {
  adaptDiscordEnvelopeToChannelInbound,
  adaptDiscordPolicyToChannelInbound,
  decideDiscordViaChannelContract,
  mapDiscordDropReasonToChannel,
  mapDiscordMentionPolicyToChannel
} from "./channels/discordChannelAdapter.js";
export {
  resolveNeonCanonicalPeer,
  type INeonCanonicalPeerResolution,
  type INeonChannelPeerInput
} from "./channels/channelIdentity.js";
export {
  assertNeonWhatsAppAuthLinked,
  assertNeonWhatsAppCredentialsPersisted,
  inspectNeonWhatsAppAuthState,
  type INeonWhatsAppAuthEvidence,
  type TNeonWhatsAppAuthReason,
  type TNeonWhatsAppAuthState
} from "./channels/whatsappAuth.js";
export {
  createSilentNeonWhatsAppLogger,
  hardenNeonWhatsAppAuthDirectory,
  loadNeonWhatsAppRuntime,
  renderNeonWhatsAppLoginReport,
  runNeonWhatsAppLogin,
  type INeonBaileysRuntime,
  type INeonWhatsAppLoginResult,
  type INeonWhatsAppSocket,
  type IRunNeonWhatsAppLoginOptions
} from "./channels/whatsappLogin.js";
export {
  decideNeonWhatsAppInbound,
  runNeonWhatsAppShadowIngress,
  type INeonWhatsAppInboundMessage,
  type IRunNeonWhatsAppShadowIngressOptions,
  type TNeonWhatsAppDropReason,
  type TNeonWhatsAppInboundDecision
} from "./channels/whatsappInbound.js";
export {
  startNeonWhatsAppShadowTap,
  type INeonWhatsAppShadowTapHandle,
  type INeonWhatsAppTapCloseResult,
  type INeonWhatsAppTapStats,
  type IStartNeonWhatsAppShadowTapOptions,
  type TNeonWhatsAppTapEvent
} from "./channels/whatsappShadowTap.js";
export {
  createNeonWhatsAppReplayStore,
  type ICreateNeonWhatsAppReplayStoreOptions,
  type INeonWhatsAppReplayStore
} from "./channels/whatsappReplayStore.js";
export { installNeonWhatsAppLibsignalLogGuard } from "./channels/whatsappLogGuard.js";
export {
  createNeonWhatsAppStatusSnapshot,
  renderNeonWhatsAppStatusReport,
  type INeonWhatsAppStatusSnapshot,
  type TNeonWhatsAppStatusState
} from "./channels/whatsappStatus.js";
export {
  acquireNeonWhatsAppTapLock,
  type IAcquireNeonWhatsAppTapLockOptions,
  type INeonWhatsAppTapLock
} from "./channels/whatsappTapLock.js";
export {
  createNeonAutomationSnapshot,
  evaluateNeonCronRunIntent,
  renderNeonAutomationCronJobReport,
  renderNeonAutomationCronListReport,
  renderNeonAutomationReport,
  type ICreateNeonAutomationSnapshotOptions,
  type INeonAutomationDream,
  type INeonAutomationHook,
  type INeonAutomationHookEventGroup,
  type INeonAutomationHookRegistration,
  type INeonAutomationHookRegistry,
  type INeonAutomationJob,
  type INeonAutomationRunIntent,
  type INeonAutomationSnapshot,
  type INeonAutomationSource,
  type INeonAutomationTotals,
  type TNeonAutomationEntryPolicy,
  type TNeonAutomationEntryState,
  type TNeonAutomationHookRegistryState,
  type TNeonAutomationJobKind,
  type TNeonAutomationRunIntentAction,
  type TNeonAutomationRunIntentReason,
  type TNeonAutomationRunIntentState,
  type TNeonAutomationState
} from "./automation/neonAutomation.js";
export {
  evaluateNeonCronTick,
  renderNeonCronTickReport,
  resolveNeonCronTimerGate,
  type IEvaluateNeonCronTickOptions,
  type INeonCronTickResult,
  type INeonCronTimerGate,
  type TNeonCronTimerReason
} from "./automation/cronTimerRuntime.js";
export {
  parseNeonCronCommand,
  processNeonCronCommand,
  type INeonCronCommandParseResult,
  type INeonCronCommandResult,
  type TNeonCronCommandState
} from "./automation/cronCommandIngress.js";
export {
  computeNeonNextRunAtMs,
  describeNeonCronSchedule,
  isNeonCronScheduleDue,
  parseNeonCronSchedule,
  type INeonCronFields,
  type TNeonCronSchedule
} from "./automation/cronSchedule.js";
export {
  readNeonCronDaemonCursor,
  renderNeonCronDaemonTickReport,
  resolveNeonCronDaemonCursorPath,
  runNeonCronDaemonTick,
  writeNeonCronDaemonCursor,
  type INeonCronCatchupEmission,
  type INeonCronDaemonCursor,
  type INeonCronDaemonSnapshotFactoryInput,
  type INeonCronDaemonTickResult,
  type IRunNeonCronDaemonTickOptions
} from "./automation/cronDaemonRuntime.js";
export {
  buildNeonCronShadowRun,
  executeNeonCronRunIntents,
  type IExecuteNeonCronRunIntentsOptions,
  type INeonCronExecutionResult,
  type INeonCronShadowRunEmission
} from "./automation/cronRunExecutor.js";
export {
  appendNeonCronIntentLog,
  buildNeonCronIntentEntries,
  readNeonCronIntentLog,
  renderNeonCronIntentLog,
  resolveNeonCronIntentLogGate,
  resolveNeonCronIntentLogPath,
  type INeonCronIntentLogAppendResult,
  type INeonCronIntentLogEntry,
  type TNeonCronIntentLogState,
  type TNeonCronIntentStatus
} from "./automation/cronIntentLog.js";
export {
  appendNeonCronStoreEvent,
  projectNeonCronStoreJobs,
  readNeonCronStoreEvents,
  renderNeonCronDeliveryPreview,
  renderNeonCronStoreJobs,
  resolveNeonCronMutation,
  resolveNeonCronStoreGate,
  resolveNeonCronStorePath,
  type INeonCronStoreAppendResult,
  type INeonCronStoreEvent,
  type INeonCronStoreGate,
  type INeonCronStoreJob,
  type IResolveNeonCronMutationInput,
  type TNeonCronJobMutation,
  type TNeonCronMutationResolution,
  type TNeonCronStoreAppendState
} from "./automation/cronStore.js";
export {
  buildNeonCronStoreAutomationJobs,
  createNeonCronStoreAutomationSnapshot,
  type ICreateNeonCronStoreAutomationSnapshotOptions
} from "./automation/cronStoreSnapshot.js";
export {
  createNeonCronDaemonService,
  isNeonCronDaemonStale,
  readNeonCronDaemonLiveState,
  resolveNeonCronDaemonLivePath,
  writeNeonCronDaemonLiveState,
  type ICreateNeonCronDaemonServiceOptions,
  type INeonCronDaemonLiveState,
  type INeonCronDaemonService,
  type INeonCronDaemonTickOutcome
} from "./automation/cronDaemonService.js";
export {
  computeNextHeartbeatPhaseDueMs,
  normalizeModulo,
  resolveHeartbeatPhaseMs,
  resolveNextHeartbeatDueMs,
  seekNextActivePhaseDueMs
} from "./automation/heartbeatSchedule.js";
export {
  isWithinNeonHeartbeatActiveHours,
  parseNeonHeartbeatActiveHoursTime,
  type INeonHeartbeatActiveHours
} from "./automation/heartbeatActiveHours.js";
export {
  getNeonWakeTargetKey,
  isNeonRetryableHeartbeatBusySkipReason,
  normalizeNeonHeartbeatWakeReason,
  queueNeonPendingWakeReason,
  resolveNeonWakePriority,
  NEON_HEARTBEAT_WAKE_REASON_FALLBACK,
  type INeonHeartbeatWakeOverride,
  type INeonPendingWakeReason,
  type TNeonHeartbeatWakeIntent,
  type TNeonHeartbeatWakeSource,
  type TNeonRetryableHeartbeatBusySkipReason
} from "./automation/heartbeatWake.js";
export {
  recordNeonHeartbeatRunStart,
  shouldDeferNeonHeartbeatWake,
  DEFAULT_FLOOD_THRESHOLD as NEON_HEARTBEAT_DEFAULT_FLOOD_THRESHOLD,
  DEFAULT_FLOOD_WINDOW_MS as NEON_HEARTBEAT_DEFAULT_FLOOD_WINDOW_MS,
  DEFAULT_MIN_WAKE_SPACING_MS as NEON_HEARTBEAT_DEFAULT_MIN_WAKE_SPACING_MS,
  type INeonHeartbeatShouldDeferInput,
  type TNeonHeartbeatDeferDecision,
  type TNeonHeartbeatDeferReason
} from "./automation/heartbeatCooldown.js";
export {
  evaluateNeonHeartbeatTick,
  renderNeonHeartbeatTickReport,
  resolveNeonHeartbeatTimerGate,
  type IEvaluateNeonHeartbeatTickOptions,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatCommitmentWakeInput,
  type INeonHeartbeatDeferredAgent,
  type INeonHeartbeatTickResult,
  type INeonHeartbeatTimerGate,
  type INeonHeartbeatWakeEmission,
  type TNeonHeartbeatTimerReason
} from "./automation/heartbeatTimerRuntime.js";
export {
  readNeonHeartbeatDaemonCursor,
  renderNeonHeartbeatDaemonTickReport,
  resolveNeonHeartbeatDaemonCursorPath,
  runNeonHeartbeatDaemonTick,
  writeNeonHeartbeatDaemonCursor,
  type INeonHeartbeatCatchupEmission,
  type INeonHeartbeatDaemonCursor,
  type INeonHeartbeatDaemonTickResult,
  type IRunNeonHeartbeatDaemonTickOptions
} from "./automation/heartbeatDaemonRuntime.js";
export {
  appendNeonHeartbeatIntentLog,
  buildNeonHeartbeatIntentEntries,
  readNeonHeartbeatIntentLog,
  renderNeonHeartbeatIntentLog,
  resolveNeonHeartbeatIntentLogGate,
  resolveNeonHeartbeatIntentLogPath,
  type INeonHeartbeatIntentLogAppendResult,
  type INeonHeartbeatIntentLogEntry,
  type TNeonHeartbeatIntentLogState,
  type TNeonHeartbeatIntentStatus
} from "./automation/heartbeatIntentLog.js";
export {
  buildNeonHeartbeatWakeRun,
  executeNeonHeartbeatWakeIntents,
  type IExecuteNeonHeartbeatWakeIntentsOptions,
  type INeonHeartbeatExecutionResult
} from "./automation/heartbeatRunExecutor.js";
export {
  NEON_HEARTBEAT_DEFAULT_AGENT_ID,
  NEON_HEARTBEAT_DEFAULT_AGENT_INTERVAL_MS,
  parseNeonHeartbeatDurationMs,
  resolveNeonHeartbeatAgentsFromEnv,
  type IResolveNeonHeartbeatAgentsOptions
} from "./automation/heartbeatRuntimeConfig.js";
export {
  createNeonHeartbeatDaemonService,
  isNeonHeartbeatDaemonStale,
  readNeonHeartbeatDaemonLiveState,
  resolveNeonHeartbeatDaemonLivePath,
  writeNeonHeartbeatDaemonLiveState,
  type ICreateNeonHeartbeatDaemonServiceOptions,
  type INeonHeartbeatDaemonLiveState,
  type INeonHeartbeatDaemonService,
  type INeonHeartbeatDaemonTickOutcome
} from "./automation/heartbeatDaemonService.js";
export {
  classifyNeonHeartbeatResponse,
  isNeonHeartbeatContentEffectivelyEmpty,
  isNeonHeartbeatOkResponse,
  isNeonHeartbeatUserMessage,
  renderNeonHeartbeatClassificationReport,
  NEON_HEARTBEAT_OK_TOKEN,
  NEON_HEARTBEAT_POLL_MARKER,
  type INeonHeartbeatClassification,
  type TNeonHeartbeatReason,
  type TNeonHeartbeatVerdict
} from "./automation/heartbeatPolicy.js";
export {
  createNeonReadOnlyHookHandlers,
  dispatchNeonInternalHook,
  renderNeonHookDispatchReport,
  resolveNeonHookDispatchGate,
  type IDispatchNeonInternalHookOptions,
  type INeonHookDispatchAuditEntry,
  type INeonHookDispatchGate,
  type INeonHookDispatchResult,
  type INeonInternalHookContext,
  type INeonReadOnlyHookHandler,
  type TNeonHookDispatchReason
} from "./automation/hookDispatch.js";
export {
  promoteNeonDreamProposal,
  renderNeonDreamingReflectionReport,
  resolveNeonDreamingGate,
  runNeonDreamingReflection,
  type INeonDreamCandidate,
  type INeonDreamingGate,
  type INeonDreamingReflectionResult,
  type INeonDreamProposal,
  type IPromoteNeonDreamProposalOptions,
  type IRunNeonDreamingReflectionOptions,
  type TNeonDreamingGateReason,
  type TNeonDreamingPhase,
  type TNeonDreamProposalKind
} from "./automation/dreamingRuntime.js";
export {
  deriveNeonConceptTags,
  neonTopConceptTag,
  NEON_MAX_CONCEPT_TAGS
} from "./automation/conceptVocabulary.js";
export {
  evaluateNeonDreamTick,
  readNeonDreamPhaseCursor,
  renderNeonDreamTickReport,
  resolveNeonDreamPhaseCursorPath,
  runNeonDreamPhaseTick,
  selectNextNeonDreamPhase,
  writeNeonDreamPhaseCursor,
  type IEvaluateNeonDreamTickOptions,
  type INeonDreamPhaseCursor,
  type INeonDreamPhaseTickResult,
  type INeonDreamTickResult,
  type IRunNeonDreamPhaseTickOptions
} from "./automation/dreamPhaseTick.js";
export {
  neonikaArchitecture,
  renderArchitectureSummary,
  type IArchitectureLayer,
  type INeonikaArchitecture
} from "./core/architecture.js";
export {
  deriveCutoverGateStates,
  evaluateCanaryExitGate,
  evaluateMirrorExitGate,
  evaluatePrimaryExitGate,
  evaluateRetireExitGate,
  evaluateShadowExitGate,
  isNeonOutboundStage,
  isNeonSteadyCutoverStage,
  neonikaCutoverStages,
  neonDefaultCutoverStage,
  nextCutoverStage,
  renderCutoverPlan,
  resolveCutoverStageFromEnv,
  type ICanaryExitGateEvidence,
  type ICanaryExitGateFacts,
  type ICutoverGateState,
  type ICutoverGateStateFacts,
  type ICutoverStage,
  type IMirrorExitGateEvidence,
  type IMirrorExitGateFacts,
  type IPrimaryExitGateEvidence,
  type IPrimaryExitGateFacts,
  type IRetireExitGateEvidence,
  type IRetireExitGateFacts,
  type IShadowExitGateEvidence,
  type IShadowExitGateFacts,
  type TCutoverGateState,
  type TCutoverStageId,
  type TNeonOutboundStage
} from "./core/cutover.js";
export {
  createNeonCutoverGateSnapshot,
  renderNeonCutoverGateReport,
  type ICreateNeonCutoverGateSnapshotOptions,
  type INeonCutoverGate,
  type INeonCutoverGateSnapshot,
  type INeonCutoverGateSource,
  type TNeonCutoverGateState,
  type TNeonCutoverReadinessState
} from "./core/cutoverGate.js";
export {
  loadNeonCutoverEnv,
  readNeonCutoverPromotion,
  renderNeonCutoverPromotionReport,
  resolveNeonCutoverPromotionPath,
  sanitizeNeonCutoverPromotionEnv,
  writeNeonCutoverPromotion,
  type INeonCutoverPromotion
} from "./core/cutoverPromotion.js";
export {
  createNeonMirrorEvidenceSnapshot,
  readNeonMirrorEvidence,
  renderNeonMirrorEvidenceReport,
  resolveNeonMirrorEvidencePaths,
  writeNeonMirrorEvidence,
  type INeonMirrorEvidenceInput,
  type INeonMirrorEvidencePaths,
  type INeonMirrorEvidenceReadOptions,
  type INeonMirrorEvidenceRecord,
  type INeonMirrorEvidenceSnapshot,
  type INeonMirrorEvidenceTotals,
  type TNeonMirrorEvidenceState,
  type TNeonMirrorEvidenceVerdict
} from "./core/mirrorEvidence.js";
export {
  defaultNeonMirrorVerdict,
  renderNeonMirrorComparisonReport,
  resolveNeonMirrorRunGate,
  runNeonMirrorComparison,
  type INeonMirrorComparisonResult,
  type INeonMirrorRunGate,
  type INeonMirrorSideResult,
  type IRunNeonMirrorComparisonOptions,
  type TNeonMirrorComparisonState,
  type TNeonMirrorRunGateReason
} from "./core/mirrorRun.js";
export {
  renderNeonGatedSideEffectPostureReport,
  resolveNeonGatedSideEffectPosture,
  type INeonGatedSideEffectGate,
  type INeonGatedSideEffectPosture,
  type INeonGatedSideEffectPostureTotals,
  type TNeonGatedSideEffectCategory,
  type TNeonGatedSideEffectPostureState
} from "./core/gatedSideEffectsPosture.js";
export {
  createNeonRetireExportBundle,
  parseNeonRetireBundle,
  renderNeonRetireRoundTripReport,
  serializeNeonRetireBundle,
  verifyNeonRetireRoundTrip,
  NEON_RETIRE_BUNDLE_VERSION,
  type INeonRetireExportBundle,
  type INeonRetireParseResult,
  type INeonRetireRoundTripResult
} from "./core/retireExport.js";
export {
  assessNeonNodeRuntime,
  isNeonSupportedNodeVersion,
  neonSupportedNodeEngine,
  parseNeonNodeVersion,
  type INeonNodeRuntimeAssessment,
  type INeonNodeVersionParts,
  type TNeonNodeRuntimeSupportState
} from "./core/nodeRuntimeGuard.js";
export {
  createNeonDoctorSnapshot,
  renderNeonDoctorExplainReport,
  renderNeonDoctorReport,
  type ICreateNeonDoctorSnapshotOptions,
  type INeonDoctorCheck,
  type INeonDoctorSnapshot,
  type INeonDoctorSource,
  type INeonDoctorTotals,
  type TNeonDoctorCheckId,
  type TNeonDoctorState
} from "./doctor/neonDoctor.js";
export {
  applyNeonDoctorPermissionFix,
  renderNeonDoctorPermissionFixReport,
  resolveNeonDoctorFixGate,
  rollbackNeonDoctorPermissionFix,
  type IApplyNeonDoctorPermissionFixOptions,
  type INeonDoctorFixGate,
  type INeonDoctorFixRollback,
  type INeonDoctorPermissionFixResult,
  type TNeonDoctorFixBlockReason,
  type TNeonDoctorFixGateReason,
  type TNeonDoctorFixKind,
  type TNeonDoctorFixState
} from "./doctor/doctorFixRuntime.js";
export {
  detectNeonCloudSyncedStateDir,
  type INeonCloudSyncDetectionDeps,
  type INeonCloudSyncedStateDir,
  type TNeonCloudSyncStorage
} from "./doctor/stateIntegrity.js";
export {
  createNeonOnboardingSnapshot,
  renderNeonOnboardingReport,
  type ICreateNeonOnboardingSnapshotOptions,
  type INeonOnboardingConfigPreview,
  type INeonOnboardingEnvPreview,
  type INeonOnboardingSnapshot,
  type INeonOnboardingStep,
  type TNeonOnboardingState,
  type TNeonOnboardingStepId,
  type TNeonOnboardingStepState
} from "./onboarding/neonOnboarding.js";
export {
  neonSetupConfigFile,
  neonSetupConfigRootEnvKey,
  neonSetupDiscordTokenEnvKey,
  applyNeonSetupEnvironment,
  readNeonSetupConfig,
  renderNeonSetupReport,
  resolveNeonSetupPaths,
  runNeonSetup,
  type INeonSetupChannelInput,
  type INeonSetupConfig,
  type INeonSetupDiscordInput,
  type INeonSetupEnvironmentResult,
  type INeonSetupIdentityLink,
  type INeonSetupPaths,
  type INeonSetupResult,
  type INeonSetupWhatsAppInput,
  type IRunNeonSetupOptions,
  type TNeonSetupChannel,
  type TNeonSetupState,
  type TNeonWhatsAppMode
} from "./onboarding/neonSetup.js";
export {
  classifyOnePasswordSecretRef,
  countOnePasswordSecretRefs,
  isOnePasswordSecretRef,
  parseOnePasswordSecretRef,
  resolveSecretInputStatus,
  summarizeOnePasswordSecretRefReachability,
  type IOnePasswordSecretRefParts,
  type IOnePasswordSecretRefReachabilitySummary,
  type TNeonSecretInputStatus,
  type TOnePasswordSecretRefReachability
} from "./secrets/secretRefs.js";
export {
  renderNeonSecretResolutionReport,
  resolveNeonSecretRef,
  resolveNeonSecretResolutionGate,
  type INeonOpCommandResult,
  type INeonSecretResolutionGate,
  type INeonSecretResolutionResult,
  type IResolveNeonSecretRefOptions,
  type TNeonOpRunner,
  type TNeonSecretResolutionBlockReason,
  type TNeonSecretResolutionGateReason,
  type TNeonSecretResolutionState
} from "./secrets/secretResolution.js";
export {
  evaluateNeonToolAvailability,
  resolveNeonToolsLiveGate,
  type INeonToolAvailabilityContext,
  type INeonToolAvailabilityDiagnostic,
  type INeonToolDescriptor,
  type INeonToolsLiveGate,
  type TNeonToolAvailabilityExpression,
  type TNeonToolAvailabilitySignal,
  type TNeonToolExecutorRef,
  type TNeonToolFamily,
  type TNeonToolOwnerRef,
  type TNeonToolSideEffect,
  type TNeonToolUnavailableReason
} from "./tools/toolCapabilities.js";
export {
  buildNeonToolPlan,
  neonToolDescriptorCatalog,
  neonToolProviderCatalog,
  NeonToolPlanContractError,
  type IBuildNeonToolPlanOptions,
  type INeonHiddenToolPlanEntry,
  type INeonToolPlan,
  type INeonToolPlanEntry,
  type INeonToolProvider,
  type TNeonToolPlanContractCode,
  type TNeonToolProviderKind
} from "./tools/toolCatalog.js";
export {
  boundNeonToolResult,
  planNeonToolInvocation,
  type IBoundNeonToolResultOptions,
  type IBoundNeonToolResultParams,
  type INeonToolInvocationPlan,
  type INeonToolResult,
  type IPlanNeonToolInvocationParams,
  type TNeonToolInvocationDecision
} from "./tools/toolPolicy.js";
export {
  collectPresentToolSecretRefs,
  createNeonToolInventorySnapshot,
  renderNeonToolInventoryReport,
  type ICreateNeonToolInventoryOptions,
  type INeonToolEntrySnapshot,
  type INeonToolFamilySnapshot,
  type INeonToolInventorySnapshot,
  type INeonToolInventoryTotals,
  type INeonToolProviderSnapshot,
  type TNeonToolProviderReadiness
} from "./tools/neonTools.js";
export {
  createNeonPeekabooAppServerEnv,
  getNeonPeekabooBridgeSocketCandidates,
  renderNeonPeekabooBridgeSocketExportShell,
  resolveNeonPeekabooBin,
  resolveNeonPeekabooBridgeSocket,
  resolveNeonPeekabooPathPrepend,
  type INeonPeekabooAppServerEnv,
  type INeonPeekabooBridgeSocketResolution,
  type IResolveNeonPeekabooBridgeSocketOptions,
  type TNeonPeekabooBridgeSocketSource
} from "./tools/peekabooRuntime.js";
export {
  createNeonPeekabooAppServerRequestHandler,
  executeNeonPeekabooDynamicToolCall,
  handleNeonPeekabooAppServerRequest,
  neonPeekabooDynamicToolSpec,
  type IExecuteNeonPeekabooDynamicToolCallOptions
} from "./tools/peekabooDynamicTool.js";
export {
  listenNeonPeekabooProxy,
  NEON_PEEKABOO_PROXY_MAX_JSON_BYTES,
  NEON_PEEKABOO_PROXY_MAX_OUTPUT_FIELD_BYTES,
  renderNeonPeekabooProxyShimScript,
  requestNeonPeekabooProxy,
  resolveNeonPeekabooProxySocketPath,
  resolveNeonPeekabooProxyTcpUrl,
  type IListenNeonPeekabooProxyOptions,
  type INeonPeekabooProxyRequest,
  type INeonPeekabooProxyResponse,
  type INeonPeekabooProxyServerHandle,
  type IRenderNeonPeekabooProxyShimScriptOptions,
  type IRequestNeonPeekabooProxyOptions
} from "./tools/peekabooProxy.js";
export {
  classifyNeonWebFetchHost,
  classifyNeonWebFetchTarget,
  executeNeonWebFetch,
  renderNeonWebFetchResult,
  type IExecuteNeonWebFetchParams,
  type INeonWebFetchResponse,
  type INeonWebFetchResult,
  type INeonWebFetchTargetDecision,
  type TNeonWebFetchBlockReason
} from "./tools/webFetch.js";
export {
  resolveNeonWebSearchProviders,
  renderNeonWebSearchResolution,
  type INeonUnavailableWebSearchProvider,
  type INeonWebSearchResolution
} from "./tools/webSearchResolution.js";
export {
  executeNeonWebSearch,
  extractNeonWebSearchHits,
  renderNeonWebSearchResult,
  resolveNeonWebSearchProviderKeyRef,
  type IExecuteNeonWebSearchParams,
  type INeonWebSearchHit,
  type INeonWebSearchProviderRequest,
  type INeonWebSearchResult,
  type TNeonWebSearchBlockReason,
  type TNeonWebSearchImpl
} from "./tools/webSearch.js";
export {
  detectSuspiciousExternalContentPatterns,
  wrapUntrustedExternalContent,
  type IDetectSuspiciousExternalContentOptions,
  type INeonExternalContentFinding,
  type INeonExternalContentWrapResult,
  type INeonWrapUntrustedExternalContentOptions,
  type TNeonExternalContentPatternId,
  type TNeonExternalContentSeverity,
  type TNeonExternalContentSource
} from "./security/externalContent.js";
export { safeEqualSecret } from "./security/secretEqual.js";
export {
  createNeonNodeActionRequestSnapshot,
  createNeonNodeActionResultPreview,
  readNeonNodeActionApprovalRecords,
  readNeonNodeActionRequestRecords,
  readNeonNodeActionResultPreviewRecords,
  recordNeonNodeActionApproval,
  recordNeonNodeActionRequest,
  renderNeonNodeActionRequestReport,
  resolveNeonNodeActionRequestPaths,
  type INeonNodeActionApprovalInput,
  type INeonNodeActionApprovalRecord,
  type INeonNodeActionApprovalSafety,
  type INeonNodeActionBrowserSnapshotPreview,
  type INeonNodeActionFileFetchPreview,
  type INeonNodeActionFileListPreview,
  type INeonNodeActionFileListPreviewEntry,
  type INeonNodeActionRequestInput,
  type INeonNodeActionRequestPaths,
  type INeonNodeActionRequestPolicy,
  type INeonNodeActionRequestRecord,
  type INeonNodeActionRequestSnapshot,
  type INeonNodeActionRequestTarget,
  type INeonNodeActionRequestTotals,
  type INeonNodeActionResultPreviewInput,
  type INeonNodeActionResultPreviewRecord,
  type INeonNodeActionResultPreviewSafety,
  type IReadNeonNodeActionRequestsOptions,
  type TNeonNodeActionApprovalPolicy,
  type TNeonNodeActionApprovalDecision,
  type TNeonNodeActionBlockReason,
  type TNeonNodeActionExecutionState,
  type TNeonNodeActionRequestKind,
  type TNeonNodeActionRequestSnapshotState,
  type TNeonNodeActionRequestState,
  type TNeonNodeActionResultPreviewBlockReason,
  type TNeonNodeActionResultPreviewKind,
  type TNeonNodeActionResultPreviewState
} from "./nodes/neonNodeActionRequests.js";
export {
  createNeonNodeExecPolicySnapshot,
  renderNeonNodeExecPolicyReport,
  resolveNeonNodeExecPolicy,
  type INeonNodeExecPolicyDecision,
  type INeonNodeExecPolicySnapshot,
  type TNeonNodeExecBlockReason,
  type TNeonNodeExecKind
} from "./nodes/neonNodeExecPolicy.js";
export {
  renderNeonNodeFileWriteReport,
  resolveNeonNodeContainedWritePath,
  resolveNeonNodeFileWriteGate,
  writeNeonNodeFile,
  type INeonNodeContainedPath,
  type INeonNodeFileWriteGate,
  type INeonNodeFileWriteResult,
  type IWriteNeonNodeFileOptions,
  type TNeonNodeFileWriteBlockReason,
  type TNeonNodeFileWriteGateReason,
  type TNeonNodeFileWriteState
} from "./nodes/neonNodeFileWritePolicy.js";
export {
  createNeonNodeTransportSnapshot,
  readNeonNodeTransportPollRecords,
  readNeonNodeTransportResultRecords,
  recordNeonNodeTransportPoll,
  recordNeonNodeTransportResult,
  renderNeonNodeTransportReport,
  resolveNeonNodeTransportPaths,
  type ICreateNeonNodeTransportSnapshotOptions,
  type INeonNodeTransportBlocker,
  type INeonNodeTransportBrowserSnapshotResult,
  type INeonNodeTransportBrowserTabResult,
  type INeonNodeTransportBrowserTabsResult,
  type INeonNodeTransportDispatch,
  type INeonNodeTransportFileFetchResult,
  type INeonNodeTransportDirFetchResult,
  type INeonNodeTransportDirFetchEntry,
  type INeonNodeTransportFileListEntry,
  type INeonNodeTransportFileListResult,
  type INeonNodeTransportPaths,
  type INeonNodeTransportPolicy,
  type INeonNodeTransportPollInput,
  type INeonNodeTransportPollRecord,
  type INeonNodeTransportPollResponse,
  type INeonNodeTransportPollSafety,
  type INeonNodeTransportResultInput,
  type INeonNodeTransportResultRecord,
  type INeonNodeTransportResultSafety,
  type INeonNodeTransportSafety,
  type INeonNodeTransportSnapshot,
  type INeonNodeTransportSource,
  type INeonNodeTransportTarget,
  type INeonNodeTransportTotals,
  type TNeonNodeTransportBlockerId,
  type TNeonNodeTransportDispatchState,
  type TNeonNodeTransportPollReplay,
  type TNeonNodeTransportPollState,
  type TNeonNodeTransportResultKind,
  type TNeonNodeTransportResultState,
  type TNeonNodeTransportState
} from "./nodes/neonNodeTransport.js";
export {
  createNeonNodeRunnerSnapshot,
  executeNeonNodeRunnerDispatch,
  readNeonNodeRunnerControl,
  readNeonNodeRunnerHealth,
  renderNeonNodeRunnerReport,
  renderNeonNodeRunnerSnapshotReport,
  resolveNeonNodeRunnerPaths,
  runNeonNodeRunnerLoop,
  runNeonNodeRunnerOnce,
  writeNeonNodeRunnerControl,
  type INeonNodeRunnerControlInput,
  type INeonNodeRunnerControlRecord,
  type INeonNodeRunnerDispatchOptions,
  type INeonNodeRunnerDispatchReport,
  type INeonNodeRunnerHealthRecord,
  type INeonNodeRunnerLoopOptions,
  type INeonNodeRunnerOnceResult,
  type INeonNodeRunnerOptions,
  type INeonNodeRunnerPaths,
  type INeonNodeRunnerSafety,
  type INeonNodeRunnerSnapshot,
  type INeonNodeRunnerTotals,
  type TNeonNodeRunnerControlState,
  type TNeonNodeRunnerDispatchState,
  type TNeonNodeRunnerFetch,
  type TNeonNodeRunnerHealthState,
  type TNeonNodeRunnerState
} from "./nodes/neonNodeRunner.js";
export {
  approveNeonNodeRunnerServiceAction,
  createNeonNodeRunnerServiceActionSnapshot,
  createNeonNodeRunnerServiceCanarySnapshot,
  createNeonNodeRunnerServiceSnapshot,
  detectNeonNodeRunnerPlistArgsDrift,
  executeNeonNodeRunnerServiceAction,
  readNeonNodeRunnerServiceActionApprovals,
  readNeonNodeRunnerServiceActionExecutions,
  readNeonNodeRunnerServiceActionRequests,
  renderNeonNodeRunnerServicePlist,
  renderNeonNodeRunnerServiceCanaryReport,
  renderNeonNodeRunnerServiceReport,
  requestNeonNodeRunnerServiceAction,
  resolveNeonNodeRunnerServicePaths,
  type ICreateNeonNodeRunnerServiceSnapshotOptions,
  type ICreateNeonNodeRunnerServiceCanarySnapshotOptions,
  type INeonNodeRunnerServiceActionApprovalInput,
  type INeonNodeRunnerServiceActionApprovalRecord,
  type INeonNodeRunnerServiceActionApprovalSafety,
  type INeonNodeRunnerServiceActionExecutionInput,
  type INeonNodeRunnerServiceActionExecutionRecord,
  type INeonNodeRunnerServiceActionExecutionSafety,
  type INeonNodeRunnerServiceActionRequestInput,
  type INeonNodeRunnerServiceActionRequestRecord,
  type INeonNodeRunnerServiceActionSafety,
  type INeonNodeRunnerServiceActionSnapshot,
  type INeonNodeRunnerServiceActionTotals,
  type INeonNodeRunnerServiceBlocker,
  type INeonNodeRunnerServiceCanaryBlocker,
  type INeonNodeRunnerServiceCanarySafety,
  type INeonNodeRunnerServiceCanarySnapshot,
  type INeonNodeRunnerServiceCommand,
  type INeonNodeRunnerServiceCredentials,
  type INeonNodeRunnerServicePaths,
  type INeonNodeRunnerServiceSafety,
  type INeonNodeRunnerServiceSnapshot,
  type TNeonNodeRunnerServiceActionDecision,
  type TNeonNodeRunnerServiceActionExecutionBlockReason,
  type TNeonNodeRunnerServiceActionExecutionState,
  type TNeonNodeRunnerServiceActionKind,
  type TNeonNodeRunnerServiceActionSnapshotState,
  type TNeonNodeRunnerServiceActionState,
  type TNeonNodeRunnerServiceBlockerId,
  type TNeonNodeRunnerServiceCanaryBlockerId,
  type TNeonNodeRunnerServiceCanaryState,
  type TNeonNodeRunnerServiceCommandId,
  type TNeonNodeRunnerServiceExecutorMode,
  type TNeonNodeRunnerServiceInstallState,
  type TNeonNodeRunnerServiceManager,
  type TNeonNodeRunnerServiceState
} from "./nodes/neonNodeRunnerService.js";
export {
  createNeonNodePairingRequest,
  createNeonNodePairingSnapshot,
  readNeonNodePairingApprovals,
  readNeonNodePairingRequests,
  recordNeonNodePairingApproval,
  renderNeonNodePairingReport,
  resolveNeonNodePairingPaths,
  verifyNeonNodePairingChallenge,
  type INeonNodePairingApprovalInput,
  type INeonNodePairingApprovalRecord,
  type INeonNodePairingChallengeVerifyInput,
  type INeonNodePairingChallengeVerifyResult,
  type INeonNodePairingPaths,
  type INeonNodePairingRequestInput,
  type INeonNodePairingRequestRecord,
  type INeonNodePairingRequestSummary,
  type INeonNodePairingSnapshot,
  type INeonNodePairingSnapshotTotals,
  type IReadNeonNodePairingOptions,
  type TNeonNodePairingApprovalDecision,
  type TNeonNodePairingChallengeVerifyState,
  type TNeonNodePairingRequestState
} from "./nodes/neonNodePairing.js";
export {
  neonOperatorScopesAllow,
  resolveNeonNodePairingForbiddenApprovalScope,
  resolveNeonNodePairingRequiredApprovalScopes,
  type TNeonNodeApprovalScope
} from "./nodes/neonNodePairingApprovalScopes.js";
export {
  createNeonNodePairingTokenGateSnapshot,
  renderNeonNodePairingTokenGateReport,
  type ICreateNeonNodePairingTokenGateSnapshotOptions,
  type INeonNodePairingTokenGateApproval,
  type INeonNodePairingTokenGateBlocker,
  type INeonNodePairingTokenGateSnapshot,
  type INeonNodePairingTokenGateSource,
  type INeonNodePairingTokenGateTotals,
  type TNeonNodePairingTokenGateBlockerId,
  type TNeonNodePairingTokenGateState
} from "./nodes/neonNodePairingTokenGate.js";
export {
  createNeonNodePairingCanaryTokenSnapshot,
  issueNeonNodePairingCanaryToken,
  readNeonNodePairingCanaryTokenIssues,
  renderNeonNodePairingCanaryTokenReport,
  resolveNeonNodePairingCanaryTokenPaths,
  type INeonNodePairingCanaryTokenDeliveryPolicy,
  type INeonNodePairingCanaryTokenIssueInput,
  type INeonNodePairingCanaryTokenIssueRecord,
  type INeonNodePairingCanaryTokenIssueResult,
  type INeonNodePairingCanaryTokenOneTimeSecret,
  type INeonNodePairingCanaryTokenPaths,
  type INeonNodePairingCanaryTokenSnapshot,
  type INeonNodePairingCanaryTokenTotals,
  type IReadNeonNodePairingCanaryTokensOptions,
  type TNeonNodePairingCanaryTokenIssueState,
  type TNeonNodePairingCanaryTokenSnapshotState,
  type TNeonNodePairingTokenDeliveryMethod,
  type TNeonNodePairingTokenDeliveryState
} from "./nodes/neonNodePairingCanaryTokens.js";
export {
  createNeonNodeDeviceSessionSnapshot,
  openNeonNodeDeviceSession,
  readNeonNodeDeviceSessionRecords,
  renderNeonNodeDeviceSessionReport,
  resolveNeonNodeDeviceSessionPaths,
  verifyNeonNodeDeviceSessionSecret,
  type INeonNodeDeviceSessionActionPolicy,
  type INeonNodeDeviceSessionBlockedScope,
  type INeonNodeDeviceSessionHandshakeInput,
  type INeonNodeDeviceSessionHandshakeResult,
  type INeonNodeDeviceSessionOneTimeSecret,
  type INeonNodeDeviceSessionPaths,
  type INeonNodeDeviceSessionPolicy,
  type INeonNodeDeviceSessionRecord,
  type INeonNodeDeviceSessionSnapshot,
  type INeonNodeDeviceSessionSummary,
  type INeonNodeDeviceSessionTotals,
  type IReadNeonNodeDeviceSessionsOptions,
  type TNeonNodeDeviceSessionBlockedScopeReason,
  type TNeonNodeDeviceSessionHandshakeState,
  type TNeonNodeDeviceSessionScope,
  type TNeonNodeDeviceSessionSnapshotState,
  type TNeonNodeDeviceSessionState
} from "./nodes/neonNodeDeviceSessions.js";
export {
  createNeonNodesSnapshot,
  renderNeonNodesReport,
  type ICreateNeonNodesSnapshotOptions,
  type INeonLocalNodeSummary,
  type INeonNodeCapability,
  type INeonNodePairingPolicy,
  type INeonNodeSafeRoot,
  type INeonNodesSnapshot,
  type INeonNodesSource,
  type INeonNodesTotals,
  type TNeonNodeCapabilityPolicy,
  type TNeonNodeCapabilityState,
  type TNeonNodeHealth,
  type TNeonNodeSafeRootKind,
  type TNeonNodesSnapshotState
} from "./nodes/neonNodes.js";
export {
  type INeonExtensionCapabilityCounts,
  type INeonExtensionSummary,
  type TNeonExtensionLoadState
} from "./skills/neonSkillExtensions.js";
export {
  createNeonExtensionInventorySnapshot,
  createNeonSkillInventorySnapshot,
  normalizeNeonSkillName,
  referenceRootEnvKey,
  renderNeonExtensionsReport,
  renderNeonSkillInventoryReport,
  resolveDefaultReferenceRoot,
  type ICreateNeonSkillInventoryOptions,
  type INeonExtensionInventorySnapshot,
  type INeonSkillInventorySnapshot,
  type INeonSkillInventorySource,
  type INeonSkillInventoryTotals,
  type INeonSkillRootConfig,
  type INeonSkillRootSnapshot,
  type INeonSkillSummary,
  type TNeonInventoryTrust,
  type TNeonSkillInventoryState,
  type TNeonSkillLoadState,
  type TNeonSkillRootKind
} from "./skills/neonSkills.js";
export {
  createNeonSkillCommandCatalog,
  renderNeonSkillCommandCatalogReport,
  type INeonSkillCommandCatalog,
  type INeonSkillCommandCatalogTotals,
  type INeonSkillCommandCollision,
  type INeonSkillCommandEntry
} from "./skills/skillCommandCatalog.js";
export {
  completeNeonSlashCommand,
  renderNeonSlashCompletions,
  type INeonSlashCompletion,
  type ICompleteNeonSlashCommandOptions
} from "./skills/slashCompletions.js";
export {
  renderNeonControlCommandGateReport,
  resolveNeonCommandAuthorized,
  resolveNeonControlCommandGate,
  resolveNeonDualTextControlCommandGate,
  type INeonCommandAuthorizer,
  type INeonControlCommandGateDecision,
  type IResolveNeonCommandAuthorizedParams,
  type IResolveNeonControlCommandGateParams,
  type IResolveNeonDualTextControlCommandGateParams,
  type TNeonCommandGatingMode
} from "./skills/slashCommandGate.js";
export {
  deriveNeonSkillInvocation,
  type INeonSkillInvocation,
  type INeonSkillInvocationInput,
  type TNeonSkillInvocationState
} from "./skills/skillInvocation.js";
export {
  scanNeonSkillScripts,
  type INeonSkillScriptScanResult,
  type IScanNeonSkillScriptsOptions
} from "./skills/skillScriptScan.js";
export {
  scanNeonSkillSource,
  summarizeNeonSkillFindings,
  unscannedNeonSkillSecuritySummary,
  type INeonSkillScanFinding,
  type INeonSkillScriptScanInput,
  type INeonSkillSecurityFinding,
  type INeonSkillSecuritySummary,
  type TNeonSkillScanRuleId,
  type TNeonSkillScanSeverity,
  type TNeonSkillSecurityState
} from "./skills/skillSecurityScan.js";
export {
  neonSkillPolicyWildcard,
  resolveAgentSkillPolicy,
  type INeonAgentSkillPolicyResult,
  type INeonSkillPolicyAgentRules,
  type INeonSkillPolicyConfig,
  type INeonSkillPolicyDecision,
  type IResolveAgentSkillPolicyOptions,
  type TNeonSkillPolicyDecision,
  type TNeonSkillPolicyReason
} from "./skills/skillPolicy.js";
export {
  loadNeonSkillPolicySource,
  neonSkillPolicySourceRelativePath,
  resolveNeonSkillPolicySourcePath,
  type INeonSkillPolicySourceResult,
  type TNeonSkillPolicySourceState
} from "./skills/skillPolicySource.js";
export {
  getLayerById,
  neonikaLayers,
  renderProductManifest,
  type INeonikaLayer,
  type TNeonikaLayerId
} from "./core/product.js";
export {
  buildNeonAgentMemoryQuery,
  createNeonAgentsSnapshot,
  defaultNeonAgentId,
  listNeonAgentProfiles,
  listNeonAgentSummaries,
  loadNeonAgentProfiles,
  neonAgentProfiles,
  renderNeonAgentIdentity,
  resolveNeonAgentAttachment,
  resolveNeonAgentProfile,
  type INeonAgentProfile,
  type INeonAgentRosterLoad,
  type INeonAgentSummary,
  type INeonAgentsSnapshot,
  type TNeonAgentRuntime
} from "./agents/registry.js";
export {
  readNeonAgentRoster,
  resolveNeonAgentRosterPath,
  type INeonAgentRosterRead
} from "./agents/agentRoster.js";
export {
  codexAppServerMethods,
  validateStartOptions,
  type ICodexAppServerClient,
  type ICodexAppServerNotification,
  type ICodexAppServerRequest,
  type ICodexAppServerRequestOptions,
  type ICodexAppServerResponse,
  type ICodexAppServerResponseError,
  type ICodexAppServerStartOptions,
  type ICodexDynamicToolCallParams,
  type ICodexDynamicToolCallResponse,
  type ICodexDynamicToolSpec,
  type IJsonObject,
  type TCodexAppServerMethod,
  type TCodexAppServerNotificationHandler,
  type TCodexAppServerRequestHandler,
  type TCodexAppServerTransportMode,
  type TCodexDynamicToolCallOutputContentItem,
  type TJsonValue
} from "./harness/appServerProtocol.js";
export {
  CodexJsonRpcClient,
  CodexJsonRpcError,
  type ICodexJsonRpcClientOptions,
  type ICodexJsonRpcTransport
} from "./harness/jsonRpcClient.js";
export {
  CodexStdioJsonRpcTransport,
  createCodexStdioTransport,
  resolveCodexStdioEnvironment,
  type ICodexStdioJsonRpcTransportOptions,
  type ICodexStdioSpawnOptions,
  type ICodexStdioTransportRuntime,
  type IStdioChildProcess,
  type TCodexStdioSpawn
} from "./harness/stdioTransport.js";
export {
  createTextTurnInput,
  interruptCodexTurn,
  projectCodexNotification,
  startCodexTurn,
  startOrResumeCodexThread,
  unsubscribeCodexThread,
  type ICodexThreadHandle,
  type ICodexThreadStartInput,
  type ICodexTurnHandle,
  type ICodexTurnStartInput,
  type TCodexApprovalPolicy,
  type TCodexRunEvent,
  type TCodexSandboxMode,
  type TCodexThreadSource,
  type TCodexTurnStatus
} from "./harness/threadRun.js";
export {
  createCodexAppServerHarness,
  hashNeonSessionStableBaseInstructions,
  type ICodexAppServerHarnessClientLease,
  type ICodexAppServerHarnessLifecycleRegistry,
  type ICodexAppServerHarnessOptions,
  type TCodexAppServerHarnessClientProvider
} from "./harness/codexAppServerHarness.js";
export {
  evaluateNeonBindingResume,
  parseCodexThreadBinding,
  readCodexThreadBinding,
  writeCodexThreadBinding,
  type ICodexThreadBinding,
  type INeonBindingResumeDecision,
  type INeonBindingResumeSpec,
  type IWriteCodexThreadBindingInput
} from "./harness/bindingStore.js";
export {
  resolveNeonHarnessRunMode,
  type INeonHarnessRunModeDecision,
  type TNeonHarnessRunModeReason
} from "./harness/runModeGate.js";
export { createDryRunHarness } from "./harness/dryRunHarness.js";
export {
  buildClaudeStreamArgs,
  createClaudeCliHarness,
  type IClaudeCliHarnessOptions,
  type IClaudeCliHarnessTransportLease,
  type IClaudeCliTurnSpec,
  type TClaudeCliEffort,
  type TClaudeCliHarnessTransportProvider,
  type TClaudeCliPermissionMode
} from "./harness/claudeCliHarness.js";
export {
  buildClaudeAllowControlResponse,
  buildClaudeDenyControlResponse,
  buildClaudeUserInputLine,
  projectClaudeStreamMessage,
  type IClaudeStreamProjection,
  type TClaudeStreamCompletion
} from "./harness/claudeStreamProtocol.js";
export {
  selectNeonHarness,
  type INeonHarnessRegistry,
  type INeonHarnessSelection,
  type TNeonHarnessSelectionReason
} from "./harness/harnessSelector.js";
export {
  ClaudeStreamProcessTransport,
  createClaudeProcessTransport,
  resolveClaudeEnvironment,
  type IClaudeProcessSpawnOptions,
  type IClaudeStreamProcessTransportOptions,
  type IClaudeProcessTransportRuntime,
  type IClaudeProcessTransportSpec,
  type IClaudeStreamTransport,
  type TClaudeProcessSpawn
} from "./harness/claudeStreamTransport.js";
export { redactHarnessEvent, redactSnapshotText, redactText } from "./harness/redaction.js";
export type { IRedactSnapshotTextOptions } from "./harness/redaction.js";
export { sliceUtf16Safe, truncateUtf16Safe } from "./text/utf16Safe.js";
export { deriveCodexSessionKey, hashWorkspace } from "./harness/sessionKey.js";
export {
  CodexAppServerClientPool,
  createStartOptionsKey,
  type ICodexAppServerClientLease,
  type TCodexAppServerClientFactory
} from "./harness/sharedClient.js";
export {
  createGatewayRunRequest,
  createHarnessInputFromGatewayMessage,
  createSessionBindingFromGatewayMessage,
  createShadowRunId,
  markNeonGatewayRunDelivered,
  renderGatewayPrompt,
  runNeonGatewayShadow,
  type INeonGatewayDeliveredReplyOutcome,
  type INeonGatewayShadowOptions
} from "./gateway/shadowGateway.js";
export {
  createNeonDiscordIngressDecision,
  mapDiscordSlashInteractionToMessageEnvelope,
  normalizeDiscordContent,
  runNeonDiscordShadowIngress,
  type INeonDiscordAuthor,
  type INeonDiscordIngressInput,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type INeonDiscordShadowIngressOptions,
  type INeonDiscordSlashInteractionEnvelope,
  type INeonDiscordSlashOption,
  type TDiscordMentionPolicy,
  type TNeonDiscordDropReason,
  type TNeonDiscordIngressDecision,
  type TNeonDiscordIngressDecisionState,
  type TNeonDiscordMemoryResolver,
  type TNeonDiscordShadowIngressResult,
  type TNeonDiscordSlashOptionValue,
  type TNeonGatewayRunWriter
} from "./gateway/discordIngress.js";
export {
  createNeonDiscordWorkboardDedupeKey,
  createNeonDiscordWorkboardSourceUrl,
  recordNeonDiscordWorkboardCard,
  resolveNeonDiscordWorkboardIntent,
  type INeonDiscordWorkboardIngestionOptions,
  type INeonDiscordWorkboardIntent,
  type TNeonDiscordWorkboardIngestionResult,
  type TNeonDiscordWorkboardIntentKind,
  type TNeonDiscordWorkboardSkipReason
} from "./workboard/discordWorkboardProducer.js";
export {
  dispatchNeonAutoReply,
  renderNeonAutoReplyDispatchReport,
  type INeonAutoReplyDispatchParams,
  type INeonAutoReplyPayload,
  type INeonAutoReplyPayloadSummary,
  type INeonAutoReplyPolicy,
  type INeonAutoReplyResult,
  type TNeonAutoReplyState,
  type TNeonAutoReplyStep
} from "./gateway/autoReplyDispatch.js";
export {
  deliverNeonCanaryReplyForRun,
  type IDeliverNeonCanaryReplyForRunOptions,
  type INeonCanaryReplyLoopResult,
  type TNeonCanaryReplyLoopState
} from "./gateway/canaryReplyLoop.js";
export {
  createNeonDiscordVoiceReplyAttachment,
  NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES,
  resolveNeonDiscordVoiceReplyOptionsFromEnv,
  type INeonDiscordVoiceReplyOptions,
  type INeonDiscordVoiceReplySynthesisInput,
  type INeonMacOsVoiceReplySynthesisInput,
  type INeonOpenAiVoiceReplySynthesisInput,
  type TNeonDiscordVoiceReplyMode
} from "./gateway/discordVoiceReplySynthesis.js";
export { normalizeNeonDiscordVoiceReplyTextForTts } from "./gateway/discordVoiceReplyTextNormalizer.js";
export {
  enrichNeonDiscordMessageWithVoiceTranscription,
  resolveNeonDiscordVoiceTranscriptionOptionsFromEnv,
  type INeonDiscordVoiceTranscriptionInput,
  type INeonDiscordVoiceTranscriptionOptions,
  type TNeonDiscordVoiceTranscriptionMode
} from "./gateway/discordVoiceTranscription.js";
export {
  createNeonDiscordTikTokVideoWorkflow,
  createNeonTikTokFileUploadSourceInfo,
  createNeonTikTokUploadChunkRequest,
  createNeonTikTokVideoEditPlan,
  initializeNeonTikTokDirectPost,
  initializeNeonTikTokInboxVideoUpload,
  NEON_TIKTOK_API_RESPONSE_MAX_BYTES,
  NEON_TIKTOK_OFFICIAL_DOCS,
  queryNeonTikTokCreatorInfo,
  renderNeonTikTokDiscordVideoWorkflow,
  resolveNeonTikTokPublishingGate,
  type INeonTikTokCreatorInfo,
  type INeonTikTokDiscordVideoWorkflow,
  type INeonTikTokDiscordVideoWorkflowInput,
  type INeonTikTokFileUploadSourceInfo,
  type INeonTikTokPostInfo,
  type INeonTikTokPublishInitData,
  type INeonTikTokPublishingGate,
  type INeonTikTokPullFromUrlSourceInfo,
  type INeonTikTokUploadChunkInput,
  type INeonTikTokUploadChunkRequest,
  type INeonTikTokVideoEditPlan,
  type INeonTikTokVideoEditPlanInput,
  type INeonTikTokWorkflowStep,
  type TNeonTikTokApiResult,
  type TNeonTikTokApiScope,
  type TNeonTikTokPostMode,
  type TNeonTikTokPrivacyLevel,
  type TNeonTikTokSourceInfo,
  type TNeonTikTokStepState,
  type TNeonTikTokTransferMethod,
  type TNeonTikTokWorkflowState
} from "./social/tiktokPublishing.js";
export { formatNeonDiscordReplyText } from "./gateway/discordReplyFormat.js";
export {
  createNeonLocalMediaAttachmentsFromText,
  type ICreateNeonLocalMediaAttachmentsOptions,
  type INeonLocalMediaAttachmentResult
} from "./gateway/localMediaAttachment.js";
export {
  buildNeonInboundReplayKey,
  claimNeonInboundReplay,
  createNeonDiscordInboundReplayFileStore,
  createNeonDiscordInboundReplayGuard,
  resolveNeonDiscordInboundReplayPath,
  type INeonDiscordInboundReplayGuard,
  type INeonDiscordInboundReplayFileStoreOptions,
  type INeonDiscordInboundReplayGuardOptions,
  type INeonDiscordInboundReplayPersistentStore,
  type TNeonInboundReplayClaim
} from "./gateway/discordInboundReplayGuard.js";
export {
  buildNeonWebhookPayload,
  NEON_DISCORD_WEBHOOK_LIMITS,
  type INeonWebhookPayload,
  type INeonValidatedWebhookPayload,
  type TNeonWebhookBuildResult
} from "./gateway/discordWebhookPayload.js";
export {
  buildNeonDiscordPollPayload,
  buildNeonDiscordStickerPayload,
  NEON_DISCORD_STICKER_POLL_LIMITS,
  type INeonDiscordPoll,
  type INeonDiscordPollAnswer,
  type TNeonPollBuildResult,
  type TNeonStickerBuildResult
} from "./gateway/discordStickerPollPayload.js";
export {
  createNeonDiscordWebhookTransport,
  evaluateNeonWebhookLivePreconditions,
  type ICreateNeonDiscordWebhookTransportOptions,
  type INeonDiscordWebhookTransport,
  type INeonWebhookClientLike,
  type INeonWebhookLivePreconditions,
  type INeonWebhookSendOptions
} from "./gateway/discordWebhookTransport.js";
export {
  renderNeonSlashCommandRegistrationPlanReport,
  resolveNeonSlashCommandRegistrationPlan,
  runNeonDiscordSlashInteractionShadow,
  type INeonDiscordSlashDispatchInput,
  type INeonSlashCommandRegistrationPlan,
  type TNeonDiscordSlashDispatchResult,
  type TNeonSlashCommandRegistrationScope,
  type TNeonSlashDispatchDropReason
} from "./gateway/discordSlashDispatch.js";
export {
  buildNeonSlashCommandPayload,
  createNeonDiscordOperatorSlashCommands,
  NEON_DISCORD_SLASH_LIMITS,
  type INeonSlashCommand,
  type INeonSlashCommandOption,
  type INeonValidatedSlashCommand,
  type INeonValidatedSlashCommandOption,
  type TNeonSlashCommandBuildResult
} from "./gateway/discordSlashCommandPayload.js";
export {
  createNeonDiscordSlashDeployTransport,
  type ICreateNeonDiscordSlashDeployTransportOptions,
  type INeonDiscordSlashDeployTransport
} from "./gateway/discordSlashDeployTransport.js";
export {
  createUnknownNeonDiscordRouteProbe,
  readNeonDiscordRouteProbe,
  resolveNeonDiscordRouteProbePath,
  writeNeonDiscordRouteProbe,
  type INeonDiscordRouteProbe,
  type INeonDiscordRouteProbeStats,
  type TNeonDiscordRouteProbeState
} from "./gateway/discordRouteProbe.js";
export {
  createDiscordJsShadowTapAdapter,
  mapDiscordJsInteractionToSlashEnvelope,
  mapDiscordJsMessageToEnvelope,
  startNeonDiscordShadowTap,
  type IDiscordJsChannelLike,
  type IDiscordJsCommandOptionLike,
  type IDiscordJsGuildMemberLike,
  type IDiscordJsInteractionLike,
  type IDiscordJsMentionUsersLike,
  type IDiscordJsMessageLike,
  type IDiscordJsUserLike,
  type INeonDiscordInteractionMapper,
  type INeonDiscordJsTapOptions,
  type INeonDiscordInboundDebounceOptions,
  type INeonDiscordMessageMapper,
  type INeonDiscordProbeHeartbeatOptions,
  type INeonDiscordProbeHeartbeatScheduler,
  type INeonDiscordShadowTapHandle,
  type INeonDiscordShadowTapOptions,
  type INeonDiscordShadowTapStats,
  type INeonDiscordTapAdapter,
  type TNeonDiscordShadowTapEvent
} from "./gateway/discordShadowTap.js";
export {
  createNeonChatConversationId,
  createNeonChatSnapshot,
  renderNeonChatReport,
  renderNeonChatToolCard,
  type ICreateNeonChatSnapshotOptions,
  type INeonChatFilters,
  type INeonChatConversation,
  type INeonChatMessage,
  type INeonChatSnapshot,
  type INeonChatToolEvent,
  type INeonChatTotals,
  type TNeonChatMessageDirection,
  type TNeonChatSnapshotState
} from "./gateway/chatTranscript.js";
export {
  NeonChatSendValidationError,
  renderNeonChatSendReport,
  submitNeonChatSend,
  type INeonChatSendInput,
  type INeonChatSendOptions,
  type INeonChatSendResult
} from "./gateway/chatSend.js";
export {
  createNeonSessionsSnapshot,
  renderNeonSessionsReport,
  type ICreateNeonSessionsSnapshotOptions,
  type INeonSessionSummary,
  type INeonSessionTokenTotals,
  type INeonSessionTranscriptRef,
  type INeonSessionsSnapshot,
  type INeonSessionsTotals,
  type TNeonSessionStatus,
  type TNeonSessionsSnapshotState
} from "./gateway/sessionSnapshot.js";
export {
  createNeonActivitySnapshot,
  renderNeonActivityReport,
  type ICreateNeonActivitySnapshotOptions,
  type INeonActivityEntry,
  type INeonActivitySnapshot,
  type INeonActivityTotals,
  type TNeonActivityEntryKind,
  type TNeonActivitySnapshotState,
  type TNeonActivityStatus
} from "./gateway/activitySnapshot.js";
export {
  createNeonIndexerSnapshot,
  projectNeonIndexer,
  renderNeonIndexerReport,
  type ICreateNeonIndexerSnapshotOptions,
  type INeonIndexerCandidate,
  type INeonIndexerProjection,
  type INeonIndexerSessionDigest,
  type INeonIndexerSignalCounts,
  type INeonIndexerSnapshot,
  type INeonIndexerTotals,
  type TNeonIndexerSnapshotState
} from "./indexer/indexerSnapshot.js";
export {
  classifyTranscriptMode,
  defaultTranscriptsDir,
  scanNeonTranscripts,
  transcriptHomePrefix,
  transcriptProjectLabel,
  type INeonTranscriptSessionFile,
  type IScanNeonTranscriptsOptions,
  type TNeonTranscriptMode
} from "./indexer/transcriptScan.js";
export {
  extractNeonTranscript,
  type IExtractNeonTranscriptOptions,
  type INeonTranscriptExtract,
  type INeonTranscriptMessage
} from "./indexer/transcriptExtract.js";
export {
  createNeonTranscriptSnapshot,
  projectNeonTranscript,
  renderNeonTranscriptReport,
  type ICreateNeonTranscriptSnapshotOptions,
  type INeonTranscriptInput,
  type INeonTranscriptProjection,
  type INeonTranscriptSessionDigest,
  type INeonTranscriptSnapshot,
  type INeonTranscriptSource,
  type INeonTranscriptTotals,
  type TNeonTranscriptSnapshotState
} from "./indexer/transcriptSnapshot.js";
export {
  renderNeonTranscriptProposalReport,
  runNeonTranscriptDecisionProposals,
  runNeonTranscriptSummaryProposal,
  type INeonTranscriptProposal,
  type IRunNeonTranscriptProposalOptions,
  type TNeonTranscriptProposalKind,
  type TNeonTranscriptProposalState
} from "./indexer/transcriptProposalRuntime.js";
export {
  evaluateNeonSummaryQuality,
  type IEvaluateNeonSummaryQualityOptions,
  type INeonSummaryQualityResult
} from "./indexer/summaryQualityGate.js";
export {
  createNeonMemoryIndexActivitySnapshot,
  readNeonMemoryIndexEntryDetail,
  type INeonMemoryIndexActivitySnapshot,
  type INeonMemoryIndexEntry,
  type INeonMemoryIndexEntryDetail,
  type TNeonMemoryIndexCategory,
  type TNeonMemoryIndexEntryDetailResult
} from "./indexer/memoryIndexActivity.js";
export {
  runNeonSummaryQualityCheck,
  type INeonSummaryQualityCliOutcome
} from "./indexer/summaryQualityCli.js";
export {
  neonDecisionActors,
  neonDecisionScopes,
  type INeonDecisionCandidate,
  type TNeonDecisionActor,
  type TNeonDecisionRejectClass,
  type TNeonDecisionScope
} from "./indexer/decisionTypes.js";
export {
  buildNeonDecisionBody,
  parseNeonDecisionBody,
  type INeonDecisionDocumentFields,
  type TNeonDecisionParseResult
} from "./indexer/decisionDocument.js";
export {
  evaluateNeonDecision,
  type INeonDecisionQualityVerdict
} from "./indexer/decisionQualityGate.js";
export {
  classifyNeonDecisionVoice,
  type INeonVoiceClassification,
  type INeonVoiceMessage
} from "./indexer/operatorVoiceDetector.js";
export {
  scoreNeonDecisionImportance,
  type INeonDecisionScoreInput
} from "./indexer/decisionImportance.js";
export {
  neonTranscriptStorePathEnvKey,
  renderNeonTranscriptArmingReport,
  resolveNeonTranscriptArming,
  type INeonTranscriptArming
} from "./indexer/transcriptArming.js";
export {
  promoteNeonTranscriptProposal,
  renderNeonTranscriptPersistReport,
  type INeonTranscriptPersistResult,
  type IPromoteNeonTranscriptProposalOptions,
  type TNeonTranscriptPersistMode,
  type TNeonTranscriptPersistState
} from "./indexer/transcriptPersistRuntime.js";
export {
  buildNeonTranscriptScheduleIntent,
  renderNeonTranscriptScheduleIntentReport,
  type IBuildNeonTranscriptScheduleIntentOptions,
  type INeonTranscriptScheduleIntent
} from "./indexer/transcriptScheduleIntent.js";
export {
  collectNeonLiveIndexRecords,
  defaultCodexSessionsDir,
  renderNeonLiveIndexMemorySyncReport,
  runNeonLiveIndexMemorySync,
  type ICollectNeonLiveIndexOptions,
  type INeonLiveIndexCollection,
  type INeonLiveIndexMemorySyncResult,
  type INeonLiveIndexRecord,
  type INeonLiveIndexTotals,
  type IRunNeonLiveIndexMemorySyncOptions,
  type TNeonLiveIndexSource,
  type TNeonLiveIndexSyncState
} from "./indexer/liveIndexSync.js";
export {
  applyNeonLiveIndexQualityGate,
  evaluateNeonLiveIndexRecord,
  renderNeonLiveIndexQualitySummary,
  type INeonLiveIndexQualityGateOutcome,
  type INeonLiveIndexQualitySummary,
  type INeonLiveIndexQualityVerdict,
  type INeonLiveIndexRejectedRecord,
  type TNeonLiveIndexRejectClass
} from "./indexer/liveIndexQualityGate.js";
export {
  createNeonLiveIndexDaemon,
  defaultNeonLiveIndexDaemonMetricsPath,
  defaultNeonLiveIndexDaemonStatePath,
  renderNeonLiveIndexDaemonReport,
  resolveNeonLiveIndexDaemonOptionsFromEnv,
  scanNeonLiveIndexDaemon,
  type INeonLiveIndexDaemonOptions,
  type INeonLiveIndexDaemonRecordState,
  type INeonLiveIndexDaemonService,
  type INeonLiveIndexDaemonSnapshot,
  type INeonLiveIndexDaemonSourceState,
  type INeonLiveIndexDaemonState,
  type INeonLiveIndexMemoryPromotionSnapshot,
  type TNeonLiveIndexDaemonScanReason,
  type TNeonLiveIndexMemoryPromotionState
} from "./indexer/liveIndexDaemon.js";
export {
  createNeonClaudeCliLlmInvoker,
  createNeonClaudeCliProcessRunner,
  createNeonCodexCliLlmInvoker,
  createNeonCodexCliProcessRunner,
  createNeonDryRunLlmInvoker,
  neonClaudeModelEnvKey,
  renderNeonLlmGateReport,
  resolveClaudeModelArg,
  resolveNeonLlmGate,
  type ICreateNeonClaudeCliLlmInvokerOptions,
  type ICreateNeonClaudeCliProcessRunnerOptions,
  type ICreateNeonCliLlmInvokerOptions,
  type ICreateNeonCodexCliLlmInvokerOptions,
  type INeonLlmCalledResult,
  type INeonLlmGate,
  type INeonLlmInvoker,
  type INeonLlmNotCalledResult,
  type INeonLlmProcessResult,
  type INeonLlmProcessRunner,
  type INeonLlmRequest,
  type TNeonClaudeModel,
  type TNeonCodexModel,
  type TNeonLlmGateReason,
  type TNeonLlmModel,
  type TNeonLlmResult
} from "./llm/llmRuntime.js";
export {
  createNeonFallbackLlmInvoker,
  type ICreateNeonFallbackLlmInvokerOptions,
  type INeonLlmFallbackEvent,
  type TNeonLlmFallbackReason
} from "./llm/llmFallbackInvoker.js";
export {
  createNeonReplaySnapshot,
  paginateNeonReplayEvents,
  renderNeonReplayEventPageReport,
  renderNeonReplayReport,
  type ICreateNeonReplaySnapshotOptions,
  type INeonReplayEvent,
  type INeonReplayEventPage,
  type INeonReplayEventPageItem,
  type INeonReplayFilters,
  type INeonReplayPageOptions,
  type INeonReplayRun,
  type INeonReplaySnapshot,
  type INeonReplayTotals,
  type TNeonReplayEventKind,
  type TNeonReplayEventStatus,
  type TNeonReplayPageState,
  type TNeonReplaySnapshotState
} from "./gateway/replaySnapshot.js";
export {
  createNeonReplayStream,
  formatNeonReplayStreamFrame,
  NEON_REPLAY_STREAM_DEFAULT_MAX_RUNS,
  type INeonReplayStreamFrame,
  type INeonReplayStreamHandle,
  type INeonReplayStreamOptions
} from "./gateway/replayStream.js";
export {
  createNeonActivityStream,
  formatNeonActivityStreamFrame,
  NEON_ACTIVITY_STREAM_DEFAULT_MAX_RUNS,
  type INeonActivityStreamFrame,
  type INeonActivityStreamHandle,
  type INeonActivityStreamOptions
} from "./gateway/activityStream.js";
export {
  parseGatewayRunLine,
  queryGatewayRuns,
  readNeonGatewayRuns,
  readNeonGatewayStatus,
  resolveGatewayStatePaths,
  scanNeonRunStoreIntegrity,
  summarizeGatewayRun,
  writeNeonGatewayRun,
  writeNeonGatewayRunLatest,
  type INeonGatewayRunQueryFilter,
  type INeonGatewayRunStoreReadOptions,
  type INeonGatewayRunSummary,
  type INeonGatewayStatePaths,
  type INeonGatewayStatus,
  type INeonRunStoreIntegrity
} from "./gateway/runStore.js";
export {
  rescueNeonGatewayRunStore,
  resolveNeonRunStoreRescueEnabled,
  renderNeonRunStoreRescueReport,
  type INeonRunStoreRescueOptions,
  type INeonRunStoreRescueResult
} from "./gateway/runStoreRescue.js";
export {
  createNeonGatewayRouteInspectionSnapshot,
  renderNeonGatewayRouteInspectionReport,
  type ICreateNeonGatewayRouteInspectionOptions,
  type INeonGatewayAllowlistSection,
  type INeonGatewayChannelAuthStatus,
  type INeonGatewayRouteAllowlist,
  type INeonGatewayRouteDiscordConfig,
  type INeonGatewayRouteInspectionSnapshot,
  type INeonGatewayRouteSummary,
  type TNeonGatewayChannelAuthState,
  type TNeonGatewayRouteInspectionState
} from "./gateway/routeInspection.js";
export {
  parseDiscordApplicationIdFromToken,
  resolveDiscordBotIdentityConsistency,
  type TDiscordBotIdentityConsistency
} from "./gateway/discordTokenIdentity.js";
export {
  createNeonDeliveryDryRunCandidate,
  createNeonDeliveryQueueSnapshot,
  enqueueNeonDeliveryDryRunCandidate,
  isNeonDeliveryQueueVisibleChannel,
  readNeonDeliveryApprovalRecords,
  readNeonDeliveryQueueCandidates,
  recordNeonDeliveryApproval,
  renderNeonDeliveryQueueReport,
  resolveNeonDeliveryQueuePaths,
  type INeonDeliveryApprovalInput,
  type INeonDeliveryApprovalRecord,
  type INeonDeliveryApprovalSafety,
  type INeonDeliveryQueueCandidate,
  type INeonDeliveryQueuePaths,
  type INeonDeliveryQueueReadOptions,
  type INeonDeliveryQueueSafety,
  type INeonDeliveryQueueSnapshot,
  type INeonDeliveryQueueTarget,
  type INeonDeliveryQueueTotals,
  type TNeonDeliveryAckState,
  type TNeonDeliveryAckStateCounts,
  type TNeonDeliveryApprovalDecision,
  type TNeonDeliveryQueueReason,
  type TNeonDeliveryQueueState,
  type TNeonDeliveryQueueVisibleChannel,
  type TNeonDeliveryRecoveryState
} from "./gateway/deliveryQueue.js";
export {
  deliverAndRecordNeonApprovedCandidate,
  deliverNeonApprovedCandidate,
  readNeonDeliveryDispatchRecords,
  readNeonDeliveryPlatformSendMarkers,
  recordNeonDeliveryDispatchResult,
  recordNeonDeliveryPlatformSendMarker,
  renderNeonDeliveryDispatchReport,
  type IDeliverAndRecordNeonApprovedCandidateOptions,
  type IDeliverNeonApprovedCandidateOptions,
  type INeonDeliveryDispatchRecord,
  type INeonDeliveryDispatchResult,
  type INeonDeliveryPlatformSendMarker,
  type TNeonDeliveryDispatchOutcome
} from "./gateway/deliveryDispatch.js";
export {
  planNeonDeliveryDrain,
  renderNeonDeliveryDrainPlanReport,
  resolveNeonDeliveryDrainGate,
  type INeonDeliveryDrainEntry,
  type INeonDeliveryDrainGate,
  type INeonDeliveryDrainPlan,
  type INeonDeliveryDrainPlanSafety,
  type INeonDeliveryDrainTotals,
  type IPlanNeonDeliveryDrainOptions,
  type TNeonDeliveryDrainDisposition,
  type TNeonDeliveryDrainReason,
  type TNeonDeliveryDrainState
} from "./gateway/deliveryDrainRuntime.js";
export {
  computeNeonDeliveryBackoffMs,
  planNeonDeliveryRetry,
  renderNeonDeliveryRetryScheduleReport,
  NEON_DELIVERY_BACKOFF_MS,
  NEON_DELIVERY_MAX_RETRIES,
  type INeonDeliveryRetryDecision,
  type INeonDeliveryRetryInput,
  type TNeonDeliveryRetryState
} from "./gateway/deliveryRetryPolicy.js";
export {
  classifyNeonDiscordSendError,
  planNeonDeliveryRetryAfterSendError,
  type INeonDiscordSendErrorClassification,
  type INeonSendRetryPlan,
  type TNeonSendRetryAction
} from "./gateway/discordSendError.js";
export {
  createNeonTypingStartGuard,
  renderNeonTypingStartGuardReport,
  type INeonTypingStartGuard,
  type INeonTypingStartGuardParams,
  type TNeonTypingStartOutcome
} from "./gateway/typingStartGuard.js";
export {
  isNeonPermanentDeliveryError,
  reconcileNeonDeliveryRecovery,
  renderNeonDeliveryReconcileReport,
  NEON_PERMANENT_DELIVERY_ERROR_PATTERNS,
  type INeonDeliveryReconcileDecision,
  type INeonDeliveryReconcileInput,
  type TNeonDeliveryReconcileState
} from "./gateway/deliveryRecoveryReconcile.js";
export {
  readNeonCanaryStabilityEvidence,
  renderNeonCanaryStabilityReport,
  summarizeNeonCanaryStability,
  type INeonCanaryStabilityPrimaryReadiness,
  type INeonCanaryStabilityRecord,
  type INeonCanaryStabilitySnapshot,
  type INeonCanaryStabilityTotals,
  type TNeonCanaryStabilityDisposition,
  type TNeonCanaryStabilityVerdict
} from "./gateway/canaryStabilityEvidence.js";
export {
  createNeonLiveSessionReadinessSnapshot,
  renderNeonLiveSessionReadinessReport,
  type INeonLiveSessionCapabilityReadiness,
  type INeonLiveSessionReadinessSnapshot,
  type INeonLiveSessionReadinessTotals,
  type TNeonLiveSessionCapability,
  type TNeonLiveSessionCapabilityState
} from "./gateway/liveSessionReadiness.js";
export {
  renderNeonInboundDebounceReport,
  resolveNeonInboundDebounceMs,
  shouldDebounceNeonTextInbound,
  type IResolveNeonInboundDebounceMsParams,
  type IShouldDebounceNeonTextInboundParams
} from "./gateway/inboundDebouncePolicy.js";
export {
  createNeonInboundDebouncer,
  type ICreateNeonInboundDebouncerOptions,
  type INeonInboundDebouncer,
  type INeonInboundDebouncerEnqueueParams,
  type INeonInboundDebounceScheduler,
  type INeonInboundDebounceTimer
} from "./gateway/inboundDebouncer.js";
export {
  createNeonInFlightRunRegistry,
  planNeonRunLifecycleAction,
  renderNeonInFlightRunReport,
  renderNeonRunLifecycleDecisionReport,
  resolveNeonInFlightRunGate,
  type INeonInFlightRunGate,
  type INeonInFlightRunRecord,
  type INeonInFlightRunRegistry,
  type INeonInFlightRunSnapshot,
  type INeonInFlightRunStart,
  type INeonRunLifecycleDecision,
  type INeonRunLifecycleDecisionSafety,
  type IPlanNeonRunLifecycleActionOptions,
  type TNeonInFlightGateReason,
  type TNeonInFlightRunState,
  type TNeonRunLifecycleAction,
  type TNeonRunLifecycleDecisionState
} from "./gateway/inFlightRunRegistry.js";
export {
  createNeonSessionActorQueue,
  NeonSessionActorQueue,
  NEON_SESSION_ACTOR_QUEUE_DEFAULT_MAX_IDLE_MS,
  normalizeNeonSessionActorQueueKey,
  type INeonSessionActorQueue,
  type INeonSessionActorQueueOptions,
  type INeonSessionActorQueueSessionSnapshot,
  type INeonSessionActorQueueSnapshot
} from "./gateway/sessionActorQueue.js";
export {
  readNeonOperatorAcks,
  recordNeonOperatorAck,
  type INeonOperatorAck,
  type INeonOperatorAckResult,
  type IRecordNeonOperatorAckOptions
} from "./gateway/operatorAcks.js";
export {
  createNeonCanaryOutboundSender,
  createNeonDryRunOutboundSender,
  deliverNeonDeliveryDryRunCandidate,
  evaluateNeonCanaryLivePreconditions,
  isNeonCanaryChannelEligible,
  resolveNeonCanaryChannelAllowlist,
  type INeonCanaryChannelAllowlist,
  type INeonCanaryLivePreconditions,
  type INeonCanaryOutboundGateFacts,
  type INeonCanaryOutboundSenderOptions,
  type INeonDryRunOutboundSenderOptions,
  type INeonOutboundSendResult,
  type INeonOutboundSender,
  type INeonOutboundSentResult,
  type INeonOutboundSuppressedResult,
  type INeonOutboundTransport
} from "./gateway/outboundSender.js";
export {
  createNeonCanaryReactionSender,
  createNeonDryRunReactionSender,
  mapNeonAckStateToReactionEmoji,
  neonAckStateReactionEmojis,
  reactNeonAckState,
  type INeonCanaryReactionSenderOptions,
  type INeonDryRunReactionSenderOptions,
  type INeonReactionResult,
  type INeonReactionSender,
  type INeonReactionSentResult,
  type INeonReactionSuppressedResult,
  type INeonReactionTransport
} from "./gateway/reactionSender.js";
export {
  applyNeonStatusReaction,
  isNeonTerminalStatusReaction,
  NEON_STATUS_REACTION_DEBOUNCE_MS,
  neonStatusReactionEmojis,
  planNeonStatusReactionEmit,
  resolveNeonStatusReactionEmoji,
  resolveNeonToolReactionState,
  shouldEmitNeonStatusReaction,
  type INeonStatusReactionPlan,
  type TNeonStatusReactionAction,
  type TNeonStatusReactionOverrides,
  type TNeonStatusReactionState
} from "./channels/statusReactions.js";
export {
  createNeonCanaryMessageEditSender,
  createNeonDryRunMessageEditSender,
  type INeonCanaryMessageEditSenderOptions,
  type INeonDryRunMessageEditSenderOptions,
  type INeonMessageDeleteResult,
  type INeonMessageDeleteSentResult,
  type INeonMessageDeleteSuppressedResult,
  type INeonMessageEditResult,
  type INeonMessageEditSender,
  type INeonMessageEditSentResult,
  type INeonMessageEditSuppressedResult,
  type INeonMessageEditTransport,
  type TNeonMessageMutationSuppressReason
} from "./gateway/messageEditSender.js";
export {
  collectNeonSecretAuditFields,
  neonSecretAuditEnvKeys,
  renderNeonSecretsAuditReport,
  resolveNeonSecretsAuditExitCode,
  runNeonSecretsAudit,
  type INeonSecretsAuditFinding,
  type INeonSecretsAuditInput,
  type INeonSecretsAuditReport,
  type TNeonSecretsAuditCode,
  type TNeonSecretsAuditExitCode
} from "./secrets/neonSecretsAudit.js";
export {
  renderNeonSecurityAuditReport,
  resolveNeonSecurityAuditExitCode,
  runNeonSecurityAudit,
  type INeonSecurityAuditReport,
  type INeonSecurityFinding,
  type TNeonSecurityAuditExitCode,
  type TNeonSecurityFindingSeverity
} from "./security/neonSecurityAudit.js";
export {
  createNeonDiscordOutboundTransport,
  type ICreateNeonDiscordOutboundTransportOptions,
  type INeonDiscordOutboundTransport
} from "./gateway/discordOutboundTransport.js";
export {
  createNeonDiscordReactionTransport,
  type ICreateNeonDiscordReactionTransportOptions,
  type INeonDiscordReactionTransport
} from "./gateway/discordReactionTransport.js";
export {
  createNeonDiscordTypingTransport,
  type ICreateNeonDiscordTypingTransportOptions,
  type INeonDiscordTypingTransport
} from "./gateway/discordTypingTransport.js";
export {
  buildNeonDiscordEmbedPayload,
  NEON_DISCORD_EMBED_LIMITS,
  type INeonDiscordEmbed,
  type INeonDiscordEmbedField,
  type TNeonDiscordEmbedBuildResult
} from "./gateway/discordRichPayload.js";
export {
  buildNeonDiscordComponentPayload,
  NEON_DISCORD_COMPONENT_LIMITS,
  type INeonDiscordButton,
  type INeonDiscordSelect,
  type INeonDiscordSelectOption,
  type TNeonDiscordActionRow,
  type TNeonDiscordButtonStyle,
  type TNeonDiscordComponentBuildResult
} from "./gateway/discordComponentPayload.js";
export {
  buildNeonDiscordComponentCustomId,
  buildNeonDiscordModalCustomId,
  isNeonDiscordCustomIdWithinLimit,
  NEON_DISCORD_COMPONENT_CUSTOM_ID_KEY,
  NEON_DISCORD_CUSTOM_ID_MAX_LENGTH,
  NEON_DISCORD_MODAL_CUSTOM_ID_KEY,
  parseNeonDiscordComponentCustomId,
  parseNeonDiscordModalCustomId,
  type INeonDiscordComponentCustomId,
  type INeonDiscordComponentCustomIdInput
} from "./gateway/discordComponentCustomId.js";
export {
  buildNeonMailDraftReviewCustomId,
  buildNeonMailDraftReviewPrompt,
  parseNeonMailDraftReviewCustomId,
  runNeonMailDraftReviewAction,
  type INeonMailDraftReviewActionHandlers,
  type INeonMailDraftReviewPrompt,
  type INeonMailDraftReviewPromptInput,
  type INeonMailDraftReviewSelection,
  type TNeonMailDraftReviewAction,
  type TNeonMailDraftReviewActionResult
} from "./gateway/mailDraftReviewFlow.js";
export {
  parseNeonDiscordMessageLink,
  type INeonDiscordMessageRef
} from "./gateway/discordMessageLink.js";
export {
  buildNeonDiscordMediaPayload,
  classifyNeonDiscordMediaKind,
  fetchNeonMediaBuffer,
  isNeonDiscordVideoMedia,
  NEON_DISCORD_MEDIA_LIMITS,
  type IBuildNeonDiscordMediaOptions,
  type IFetchNeonMediaBufferOptions,
  type INeonDiscordInlineAttachment,
  type INeonDiscordUrlAttachment,
  type INeonMediaFetchResponse,
  type TNeonDiscordMediaAttachment,
  type TNeonDiscordMediaBuildResult,
  type TNeonDiscordMediaKind,
  type TNeonValidatedMediaAttachment
} from "./gateway/discordMediaPayload.js";
export {
  buildNeonDiscordPresencePayload,
  NEON_DISCORD_PRESENCE_LIMITS,
  type INeonDiscordActivity,
  type INeonDiscordPresence,
  type TNeonDiscordActivityType,
  type TNeonDiscordPresenceBuildResult,
  type TNeonDiscordPresenceStatus
} from "./gateway/discordPresencePayload.js";
export {
  createNeonDiscordPresenceTransport,
  type ICreateNeonDiscordPresenceTransportOptions,
  type INeonDiscordPresenceTransport
} from "./gateway/discordPresenceTransport.js";
export {
  createNeonGatewayHttpServer,
  listenNeonGatewayHttpServer,
  type INeonGatewayHttpListenOptions,
  type INeonGatewayHttpServerHandle,
  type INeonGatewayHttpServerOptions,
  type INeonGatewayRunControlHttpRequest,
  type INeonGatewayRunControlHttpResult,
  type INeonGatewayRunControlRuntime,
  type TNeonGatewayRunControlHttpAction,
  type TNeonGatewayRunControlHttpState
} from "./gateway/httpServer.js";
export {
  createNeonSiteAnalyticsSnapshot,
  createNeonSitesSnapshot,
  neonSiteAnalyticsCommandEnvKey,
  neonSitesJsonEnvKey,
  type ICreateNeonSiteAnalyticsOptions,
  type INeonSite,
  type INeonSiteAnalyticsRunnerOptions,
  type INeonSitesSnapshot,
  type TNeonSiteAnalyticsResult,
  type TNeonSiteAnalyticsRunner
} from "./gateway/neonSites.js";
export {
  authorizeNeonHttpMutation,
  NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV,
  type INeonHttpMutationAuthDecision,
  type INeonHttpMutationAuthInput,
  type TNeonHttpMutationAuthMode,
  type TNeonHttpMutationAuthState
} from "./gateway/httpMutationAuth.js";
export {
  NEON_GATEWAY_EVENT_STREAM_HEARTBEAT_MS,
  createNeonGatewayRuntimeController,
  formatNeonGatewayEventStreamFrame,
  type INeonGatewayRuntimeController,
  type INeonGatewayRuntimeEventFrame,
  type INeonGatewayRuntimeNetwork,
  type INeonGatewayRuntimeProtocol,
  type INeonGatewayRuntimeReadyInput,
  type INeonGatewayRuntimeSnapshot,
  type INeonGatewayRuntimeTiming,
  type TNeonGatewayRuntimeEventName,
  type TNeonGatewayRuntimeState
} from "./gateway/lifecycle.js";
export {
  NEON_GATEWAY_MAX_BUFFERED_BYTES,
  NEON_GATEWAY_MAX_PAYLOAD_BYTES,
  NEON_GATEWAY_MIN_CLIENT_PROTOCOL_VERSION,
  NEON_GATEWAY_PROTOCOL_PATH,
  NEON_GATEWAY_PROTOCOL_VERSION,
  NEON_GATEWAY_WS_PATH,
  createNeonGatewayConnectChallenge,
  createNeonGatewayErrorResponseFrame,
  createNeonGatewayEventFrame,
  createNeonGatewayHelloOk,
  createNeonGatewayProtocolSnapshot,
  createNeonGatewayRequestFrame,
  createNeonGatewaySuccessResponseFrame,
  detectNeonGatewaySequenceGap,
  isNeonGatewayEventFrame,
  isNeonGatewayRequestFrame,
  isNeonGatewayResponseFrame,
  neonGatewayProtocolEvents,
  neonGatewayProtocolMethods,
  parseNeonGatewayFrame,
  parseNeonGatewayFrameJson,
  renderNeonGatewayProtocolReport,
  type ICreateNeonGatewayProtocolSnapshotOptions,
  type INeonGatewayEventFrame,
  type INeonGatewayFrameError,
  type INeonGatewayHelloOk,
  type INeonGatewayHelloOkAuth,
  type INeonGatewayProtocolSnapshot,
  type INeonGatewayRequestFrame,
  type INeonGatewayResponseFrame,
  type INeonGatewaySequenceGap,
  type INeonGatewayStateVersion,
  type TNeonGatewayFrame,
  type TNeonGatewayProtocolEvent,
  type TNeonGatewayProtocolMethod
} from "./gateway/protocol.js";
export {
  NEON_GATEWAY_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS,
  attachNeonGatewayWebSocketServer,
  isNeonGatewaySlowConsumer,
  resolveNeonGatewayHandshakeTimeoutMs,
  resolveNeonGatewayKeepaliveIntervalMs,
  type INeonGatewayWebSocketAttachOptions,
  type INeonGatewayWebSocketServerHandle
} from "./gateway/webSocketServer.js";
export {
  NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP,
  createNeonPreauthConnectionBudget,
  readNeonPreauthRemoteAddress,
  resolveNeonPreauthMaxConnectionsPerIp,
  type INeonPreauthConnectionBudget
} from "./gateway/preauthConnectionBudget.js";
export {
  NEON_GATEWAY_DEFAULT_MAX_UNAUTHORIZED_FRAMES,
  createNeonUnauthorizedFloodGuard,
  resolveNeonGatewayMaxUnauthorizedFrames,
  type INeonUnauthorizedFloodGuard
} from "./gateway/unauthorizedFloodGuard.js";
export {
  resolveNeonGatewayConnectAuth,
  type INeonGatewayConnectAuthDecision,
  type INeonGatewayConnectAuthInput,
  type TNeonGatewayConnectAuthState,
  type TNeonGatewayConnectAuthMode
} from "./gateway/connectAuth.js";
export {
  NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS,
  NEON_GATEWAY_DEFAULT_AUTH_WINDOW_MS,
  NEON_GATEWAY_DEFAULT_AUTH_LOCKOUT_MS,
  createNeonAuthRateLimiter,
  resolveNeonAuthRateLimitConfig,
  type INeonAuthRateLimiter,
  type INeonAuthRateLimitConfig,
  type INeonAuthRateLimitDecision
} from "./gateway/authRateLimit.js";
export {
  createNeonMissionControlGatewaySnapshot,
  fetchNeonMissionControlGatewaySnapshot,
  parseNeonMissionControlGatewaySnapshot,
  type ICreateGatewaySnapshotOptions,
  type IFetchGatewaySnapshotOptions,
  type INeonMissionControlGatewayEvent,
  type INeonMissionControlGatewaySnapshot,
  type INeonMissionControlGatewaySource,
  type INeonMissionControlGatewayTotals
} from "./missionControl/gatewaySnapshot.js";
export {
  neonTuiPanelDescriptors,
  neonTuiPanelOrder,
  renderNeonTuiBanner,
  renderNeonTuiDashboard,
  renderNeonTuiGoodbye,
  renderNeonTuiHelp,
  renderNeonTuiHelpHint,
  renderNeonTuiPanel,
  renderNeonTuiUnknownCommand,
  resolveNeonTuiPanelDescriptor,
  routeNeonTuiCommand,
  type INeonTuiDashboard,
  type INeonTuiPanelDescriptor,
  type INeonTuiPanelView,
  type TNeonTuiCommand,
  type TNeonTuiPanelId
} from "./tui/operatorShell.js";
export {
  loadNeonTuiDashboard,
  loadNeonTuiPanel,
  type ILoadNeonTuiDashboardOptions
} from "./tui/operatorShellData.js";
export {
  runNeonOperatorShell,
  type INeonOperatorShellResult,
  type IRunNeonOperatorShellOptions
} from "./tui/interactiveShell.js";
export {
  appendNeonWorkspaceNote,
  createNeonWorkspaceSnapshot,
  renderNeonWorkspaceSnapshotReport,
  resolveNeonWorkspaceNotePaths,
  resolveNeonWorkspaceNotesGate,
  type INeonWorkspaceFileSnapshot,
  type INeonWorkspaceNoteAppendResult,
  type INeonWorkspaceNoteInput,
  type INeonWorkspaceNotePaths,
  type INeonWorkspaceNotesGate,
  type INeonWorkspaceSnapshot,
  type TNeonWorkspaceNoteAppendState,
  type TNeonWorkspaceNoteKind,
  type TNeonWorkspaceNotesGateReason
} from "./workspace/workspaceNotes.js";
export {
  isNeonMissionControlPath,
  neonMissionControlViewNames,
  normalizeNeonMissionControlView,
  renderNeonMissionControlGatewayHtml,
  resolveNeonMissionControlViewFromPathname,
  type INeonMissionControlHtmlOptions,
  type TNeonMissionControlView
} from "./missionControl/gatewayHtml.js";
export { renderNeonMissionControlToolsPanel } from "./missionControl/toolsPanel.js";
export { renderNeonMissionControlGatePosturePanel } from "./missionControl/gatePosturePanel.js";
export {
  createNeonCronDaemonStatusSnapshot,
  renderNeonCronDaemonStatusReport,
  renderNeonMissionControlCronDaemonStatusPanel,
  type ICreateNeonCronDaemonStatusSnapshotOptions,
  type INeonCronDaemonStatusJob,
  type INeonCronDaemonStatusSnapshot
} from "./missionControl/cronDaemonStatusPanel.js";
export {
  createNeonHeartbeatDaemonStatusSnapshot,
  renderNeonHeartbeatDaemonStatusReport,
  renderNeonMissionControlHeartbeatDaemonStatusPanel,
  type ICreateNeonHeartbeatDaemonStatusSnapshotOptions,
  type INeonHeartbeatDaemonStatusAgent,
  type INeonHeartbeatDaemonStatusSnapshot
} from "./missionControl/heartbeatDaemonStatusPanel.js";
export {
  NEON_BLOCKED_ROW_READINESS,
  createNeonBlockedRowReadinessSnapshot,
  renderNeonBlockedRowReadinessReport,
  type INeonBlockedRowReadiness,
  type INeonBlockedRowReadinessSnapshot,
  type INeonBlockedRowReadinessStatus,
  type INeonBlockedRowReadinessTotals,
  type TNeonBlockedRowApproval,
  type TNeonBlockedRowCategory
} from "./missionControl/blockedRowReadiness.js";
export { renderNeonMissionControlBlockedReadinessPanel } from "./missionControl/blockedRowReadinessPanel.js";
export { renderNeonMissionControlLiveSessionReadinessPanel } from "./missionControl/liveSessionReadinessPanel.js";
export {
  deriveNeonActivityToolLabel,
  filterNeonMissionControlActivity,
  renderNeonMissionControlFilterReport
} from "./missionControl/missionControlFilter.js";
export type {
  INeonMissionControlFilterCriteria,
  INeonMissionControlFacetOption,
  INeonMissionControlFilterFacets,
  INeonMissionControlFilterResult
} from "./missionControl/missionControlFilter.js";
export {
  createNeonMemoryAttachment,
  createNeonMemoryCliProvider,
  createDefaultNeonMemoryProvider,
  parseMemorySearchOutput,
  readNeonMemoryStatus,
  type INeonMemoryStatus,
  type INeonMemoryCliProviderOptions,
  type INeonMemoryCommandResult,
  type INeonMemoryProvider,
  type INeonMemorySearchHit,
  type INeonMemorySearchOptions,
  type INeonMemorySearchResult,
  type IReadNeonMemoryStatusOptions,
  type TNeonMemoryStatusState,
  type TNeonMemoryCommandRunner
} from "./memory/neonMemory.js";
export {
  renderNeonMemoryMaintenanceReport,
  runNeonMemoryMaintenance,
  type INeonMemoryMaintenanceOptions,
  type INeonMemoryMaintenanceResult
} from "./memory/memoryMaintenance.js";
export {
  NEON_MEMORY_DB_PATH_ENV,
  recallNeonMemory,
  resolveNeonMemoryRecallDbPath,
  type INeonMemoryRecallHit,
  type INeonMemoryRecallOptions,
  type INeonMemoryRecallResult,
  type TNeonMemoryRecallMode,
  type TNeonMemoryRecallOrigin
} from "./memory/memoryRecall.js";
export {
  buildNeonFtsMatchExpression,
  createNeonMemoryDbProvider,
  defaultNeonMemoryDbPath,
  hybridSearchNeonMemoryDb,
  recordNeonMemoryDbAccess,
  searchNeonMemoryDb,
  targetsRealNeonDb,
  toNeonV3SearchResult,
  type INeonHybridSearchOptions,
  type INeonMemoryAccessTrackingResult,
  type INeonMemoryDbProviderOptions,
  type INeonMemoryDbRow,
  type INeonMemoryDbSearchOptions,
  type INeonMemoryHybridRow,
  type INeonV3SearchResult
} from "./memory/neonMemoryDbProvider.js";
export {
  NEON_MEMORY_BUSY_TIMEOUT_MS,
  openNeonMemoryDatabase,
  type INeonMemoryDbOpenOptions
} from "./memory/neonMemoryDbOpen.js";
export {
  backfillNeonMemoryEmbeddings,
  renderNeonEmbeddingBackfillReport,
  type INeonEmbeddingBackfillOptions,
  type INeonEmbeddingBackfillResult
} from "./memory/neonMemoryEmbeddingBackfill.js";
export {
  bootstrapNeonMemorySchema,
  computeNeonContentHash,
  renderNeonMemoryDbWriteReport,
  resolveNeonMemoryDbWriteGate,
  writeNeonMemoryDbEntry,
  type INeonMemoryDbWriteGate,
  type INeonMemoryDbWriteInput,
  type INeonMemoryDbWriteResult,
  type IWriteNeonMemoryDbEntryOptions
} from "./memory/neonMemoryDbWriter.js";
export {
  createNeonMemoryBackup,
  renderNeonMemoryBackupReport,
  rotateNeonMemoryBackups,
  type INeonMemoryBackupOptions,
  type INeonMemoryBackupResult
} from "./memory/neonMemoryBackup.js";
export {
  computeNeonMemoryRetention,
  recalcNeonMemoryImportance,
  renderNeonImportanceRecalcReport,
  type INeonImportanceRecalcOptions,
  type INeonImportanceRecalcResult,
  type INeonRetentionInput
} from "./memory/neonMemoryImportance.js";
export {
  bootstrapNeonRelationsSchema,
  discoverNeonMemoryRelations,
  renderNeonRelationDiscoveryReport,
  type INeonRelationDiscoveryOptions,
  type INeonRelationDiscoveryResult
} from "./memory/neonMemoryRelations.js";
export {
  bootstrapNeonArchiveSchema,
  pruneNeonMemory,
  renderNeonPruneReport,
  type INeonPruneOptions,
  type INeonPruneResult
} from "./memory/neonMemoryPrune.js";
export {
  findNeonMemoryMaintenanceBlock,
  resolveNeonMemoryMaintenanceAccess,
  type INeonMemoryAdditiveLabels,
  type INeonMemoryFreezingLabels,
  type INeonMemoryMaintenanceAccess,
  type INeonMemoryMaintenanceBlock,
  type TNeonMemoryMaintenanceBlockState
} from "./memory/memoryMaintenanceGate.js";
export {
  DEFAULT_NEON_OLLAMA_BASE_URL,
  DEFAULT_NEON_OLLAMA_EMBEDDING_MODEL,
  NEON_LOCAL_EMBEDDING_DIMENSIONS,
  NEON_LOCAL_EMBEDDING_NAME,
  NEON_OLLAMA_EMBEDDING_DIMENSIONS,
  bufferToNeonVector,
  createNeonLocalEmbeddingProvider,
  createNeonOllamaEmbeddingProvider,
  embedNeonLocalText,
  neonCosineSimilarity,
  neonVectorToBuffer,
  normalizeNeonVector,
  type INeonEmbeddingProvider,
  type INeonOllamaEmbeddingOptions
} from "./memory/neonEmbeddingProvider.js";
export {
  createNeonAgentMemoryAttachment,
  recallNeonAgentMemory,
  type INeonAgentMemoryAttachment,
  type INeonAgentRecallOptions,
  type INeonAgentScopedRecall
} from "./memory/agentRecall.js";
export {
  createDefaultMergedMemoryRoots,
  createMergedNeonMemoryProvider,
  memorySharedRootsEnvKey,
  resolveNeonSharedMemoryRoots,
  type INeonMergedMemoryFileRoot,
  type INeonMergedMemoryProviderOptions
} from "./memory/mergedMemoryProvider.js";
export {
  extractNeonQueryKeywords,
  isNeonQueryKeyword,
  isNeonQueryStopWord,
  tokenizeNeonQuery
} from "./memory/queryExpansion.js";
export {
  buildNeonMemoryFlushPlan,
  formatNeonMemoryFlushDateStamp,
  planNeonMemoryFlush,
  resolveNeonMemoryFlushGate,
  NEON_MEMORY_FLUSH_DEFAULT_SOFT_THRESHOLD_TOKENS,
  NEON_MEMORY_FLUSH_DEFAULT_FORCE_TRANSCRIPT_BYTES,
  NEON_MEMORY_FLUSH_ENV_VAR,
  type INeonMemoryFlushPlan,
  type INeonMemoryFlushGate,
  type INeonMemoryFlushPlanResult,
  type IBuildNeonMemoryFlushPlanOptions
} from "./memory/memoryFlushPlan.js";
export {
  appendNeonRecallEvent,
  hashNeonRecallQuery,
  readNeonRecallEvents,
  renderNeonRecallTrackingReport,
  resolveNeonRecallTrackingGate,
  summarizeNeonRecallCounts,
  NEON_RECALL_PROMOTION_MIN_RECALL_COUNT,
  NEON_RECALL_PROMOTION_MIN_UNIQUE_QUERIES,
  type INeonRecallEvent,
  type INeonRecallAppendRequest,
  type INeonRecallAppendResult,
  type IAppendNeonRecallEventOptions,
  type INeonRecallSourceCount,
  type TNeonRecallAppendState
} from "./memory/recallTracking.js";
export {
  appendNeonMemoryEvent,
  buildNeonDreamCompletedEvent,
  buildNeonPromotionAppliedEvent,
  buildNeonRecallRecordedEvent,
  readNeonMemoryEvents,
  renderNeonMemoryEventLogReport,
  resolveNeonMemoryEventLogGate,
  type INeonMemoryRecallRecordedEvent,
  type INeonMemoryPromotionAppliedEvent,
  type INeonMemoryDreamCompletedEvent,
  type INeonMemoryEventAppendResult,
  type TNeonMemoryEvent,
  type TNeonMemoryEventType,
  type TNeonMemoryEventAppendState,
  type TNeonDreamStorageMode
} from "./memory/memoryEventLog.js";
export {
  createNeonMemoryCliWriter,
  type INeonMemoryWriter,
  type INeonMemoryCliWriterOptions,
  type INeonMemoryWriteOptions,
  type INeonMemoryWriteRequest,
  type INeonMemoryWriteResult,
  type TNeonMemoryWriteMode,
  type TNeonMemoryWriteState
} from "./memory/neonMemory.js";
export {
  readNeonMemoryStore,
  renderNeonMemoryWriteRuntimeReport,
  resolveNeonMemoryWriteGate,
  writeNeonMemoryEntry,
  type INeonMemoryStoreEntry,
  type INeonMemoryWriteGate,
  type INeonMemoryWriteRuntimeResult,
  type IWriteNeonMemoryEntryOptions,
  type TNeonMemoryWriteGateReason
} from "./memory/memoryWriteRuntime.js";
export {
  createNeonMemoryExportManifest,
  createNeonMemoryImportPlan,
  renderNeonMemoryExportManifest,
  renderNeonMemoryImportPlanReport,
  type ICreateNeonMemoryExportManifestOptions,
  type ICreateNeonMemoryImportPlanOptions,
  type INeonMemoryExportManifest,
  type INeonMemoryImportPlan,
  type INeonMemoryImportRecord
} from "./memory/memoryImportExport.js";
export type {
  INeonGatewayDeliveryResult,
  INeonGatewayInboundMessage,
  INeonGatewayPersistedFinding,
  INeonGatewayRunRequest,
  INeonGatewayShadowInput,
  INeonGatewayShadowResult,
  INeonGatewayShadowRun,
  TNeonGatewayDeliveryState,
  TNeonGatewayRunMode,
  TNeonGatewayRunStatus
} from "./gateway/types.js";
export {
  fingerprintSessionKey,
  resolveBindingPath,
  resolveHarnessStatePaths,
  type IHarnessStatePaths
} from "./harness/statePaths.js";
export { isNeonHarnessId } from "./harness/types.js";
export type {
  IAgentAttachment,
  ICodexHarness,
  ICodexHarnessInput,
  ICodexHarnessResult,
  ICodexSessionBinding,
  IMemoryAttachment,
  IMemoryExcerpt,
  TAgentRuntime,
  TCodexHarnessEvent,
  THarnessRunMode,
  TMemoryAttachmentState,
  TNeonChannel,
  TNeonHarnessId
} from "./harness/types.js";
// Neonika SDK manifest — descriptor for the curated SDK layer. The four SDK
// contract surfaces (Gateway Client / Channel / Tool / Plugin) are consumed via
// the dedicated `src/sdk/index.js` barrel; only the manifest is surfaced here to
// keep the runtime barrel collision-free.
export {
  NEON_SDK_VERSION,
  createNeonSdkManifest,
  neonSdkSurfaces,
  renderNeonSdkManifest,
  type INeonSdkManifest,
  type INeonSdkSurface,
  type TNeonSdkSurfaceId,
  type TNeonSdkSurfaceStability
} from "./sdk/manifest.js";
export {
  createDefaultNeonPluginTrustPolicy,
  defaultBlockedPluginDependencies,
  evaluateNeonPluginTrust,
  NEON_PLUGIN_HOST_VERSION,
  parseNeonPluginManifest,
  satisfiesMinHostVersion,
  type ICreateNeonPluginTrustPolicyOptions,
  type INeonPluginCapabilityContribution,
  type INeonPluginCommandContribution,
  type INeonPluginInstallConstraints,
  type INeonPluginManifest,
  type INeonPluginTrustDecision,
  type INeonPluginTrustPolicy,
  type IParseNeonPluginManifestOptions,
  type TNeonPluginManifestFormat,
  type TNeonPluginTrustLevel
} from "./plugin-sdk/index.js";
export {
  buildNeonPluginCatalog,
  createNeonPluginInventorySnapshot,
  defaultPluginManifestLimit,
  neonPluginInstallGateFlag,
  planNeonPluginAction,
  readNeonPluginManifestSources,
  renderNeonPluginInstallPlanReport,
  renderNeonPluginsReport,
  resolveNeonPluginInstallGate,
  resolveNeonPluginInstallPlan,
  type IBuildNeonPluginCatalogOptions,
  type ICreateNeonPluginInventoryOptions,
  type INeonPluginCatalog,
  type INeonPluginCatalogEntry,
  type INeonPluginCatalogTotals,
  type INeonPluginGatePlan,
  type INeonPluginGatePlanStep,
  type INeonPluginInstallGate,
  type INeonPluginInstallPlanResult,
  type INeonPluginInventoryEntry,
  type INeonPluginInventorySnapshot,
  type INeonPluginManifestSource,
  type INeonPluginManifestSourceScan,
  type INeonPluginPackageProof,
  type IReadNeonPluginManifestSourcesOptions,
  type IResolveNeonPluginInstallPlanOptions,
  type TNeonPluginGateAction,
  type TNeonPluginGateDecision,
  type TNeonPluginInventoryState,
  type TNeonPluginPackageJsonState,
  type TNeonPluginPackageLiveProofState,
  type TNeonPluginPackageRuntimeEntryState,
} from "./plugins/index.js";
export {
  isNeonTaskChannel,
  isNeonTaskLinkType,
  isNeonTaskPriority,
  isNeonTaskSource,
  isNeonTaskStatus,
  neonTaskPriorityOrder,
  neonTaskStatusOrder,
  parseNeonTaskLink,
  parseNeonTaskRecord,
  projectNeonTaskRecords,
  type INeonTaskLink,
  type INeonTaskRecord,
  type TNeonTaskLinkType,
  type TNeonTaskPriority,
  type TNeonTaskSource,
  type TNeonTaskStatus
} from "./tasks/taskModel.js";
export {
  readNeonTaskRecords,
  readNeonTasks,
  redactTaskRecord,
  resolveNeonTaskStatePaths,
  writeNeonTask,
  type INeonTaskReadOptions,
  type INeonTaskStatePaths
} from "./tasks/taskStore.js";
export {
  findLatestNeonTaskForSessionKey,
  findNeonTaskByRunId,
  listNeonTasksForFlowId,
  listNeonTasksForOwner,
  scopeNeonTaskToOwner,
  resolveNeonTaskForLookupToken
} from "./tasks/taskLookup.js";
export {
  listNeonTaskAuditFindings,
  summarizeNeonTaskAuditFindings,
  renderNeonTaskAuditReport,
  type INeonTaskAuditFinding,
  type INeonTaskAuditSummary,
  type TNeonTaskAuditCode,
  type TNeonTaskAuditSeverity,
  type IListNeonTaskAuditFindingsOptions
} from "./tasks/taskAudit.js";
export {
  listNeonFlowAuditFindings,
  summarizeNeonFlowAuditFindings,
  renderNeonFlowAuditReport,
  type INeonFlowAuditFinding,
  type INeonFlowAuditSummary,
  type TNeonFlowAuditCode,
  type TNeonFlowAuditSeverity
} from "./tasks/flowAudit.js";
export {
  isNeonTerminalTaskStatus,
  decideNeonTaskTerminalDelivery,
  formatNeonTaskTerminalMessage,
  type TNeonTaskNotifyPolicy,
  type TNeonTaskDeliveryState,
  type TNeonTaskDeliveryReason,
  type INeonTaskDeliveryInput,
  type INeonTaskDeliveryDecision
} from "./tasks/taskDeliveryPolicy.js";
export {
  buildNeonCommitmentCaptureCandidates,
  captureNeonCommitmentsFromRun,
  resolveNeonCommitmentCaptureGate,
  type ICaptureNeonCommitmentsFromRunOptions,
  type INeonCommitmentCaptureCandidate,
  type INeonCommitmentCaptureGate,
  type INeonCommitmentCaptureResult,
  type TNeonCommitmentCaptureState
} from "./commitments/commitmentCapture.js";
export {
  appendNeonCommitment,
  applyNeonCommitmentStatus,
  buildNeonCommitmentRecord,
  findActiveNeonCommitmentByDedupeKey,
  isActiveNeonCommitmentStatus,
  listNeonDueCommitments,
  readNeonCommitments,
  renderNeonDueCommitmentsReport,
  resolveNeonCommitmentStoreGate,
  resolveNeonCommitmentStorePath,
  type IBuildNeonCommitmentInput,
  type INeonCommitmentAppendResult,
  type INeonCommitmentDueWindow,
  type INeonCommitmentRecord,
  type INeonCommitmentStoreGate,
  type TNeonCommitmentAppendState,
  type TNeonCommitmentKind,
  type TNeonCommitmentSource,
  type TNeonCommitmentStatus,
  type TNeonCommitmentTransition
} from "./commitments/commitmentStore.js";
export {
  NEON_COMMITMENT_LIFECYCLE_DEFAULT_SNOOZE_MS,
  markNeonCommitmentsHeartbeatObserved,
  neonCommitmentLifecycleEnvKey,
  resolveNeonCommitmentLifecycleGate,
  type IMarkNeonCommitmentsHeartbeatObservedOptions,
  type INeonCommitmentLifecycleGate,
  type INeonCommitmentLifecycleResult
} from "./commitments/commitmentLifecycle.js";
export {
  buildNeonCommitmentFromHint,
  importNeonCommitmentHints,
  parseNeonCommitmentHintsContent,
  type IImportNeonCommitmentHintsOptions,
  type INeonCommitmentHint,
  type INeonCommitmentHintImportResult,
  type INeonCommitmentHintParseResult,
  type TNeonCommitmentHintImportState
} from "./commitments/commitmentHintImport.js";
export {
  createNeonWorkboardSnapshot,
  renderNeonWorkboardReport,
  type ICreateNeonWorkboardSnapshotOptions,
  type INeonWorkboardColumn,
  type INeonWorkboardSnapshot,
  type INeonWorkboardTotals,
  type TNeonTaskPriorityCounts,
  type TNeonTaskStatusCounts,
  type TNeonWorkboardSnapshotState
} from "./tasks/workboardSnapshot.js";
export {
  createNeonWorkboardCard,
  createNeonWorkboardSnapshot as createNeonWorkboardCardSnapshot,
  createNeonWorkboardStats,
  blockNeonWorkboardCard,
  claimNeonWorkboardCard,
  completeNeonWorkboardCard,
  dispatchNeonWorkboard,
  getNeonWorkboardCard,
  heartbeatNeonWorkboardCard,
  readNeonWorkboardCardRecords,
  readNeonWorkboardCards,
  redactNeonWorkboardCard,
  resolveNeonWorkboardStatePaths,
  type INeonWorkboardBlockInput,
  type INeonWorkboardClaimInput,
  type INeonWorkboardClaimResult,
  type INeonWorkboardCompleteInput,
  type INeonWorkboardCreateInput,
  type INeonWorkboardDispatchResult,
  type INeonWorkboardHeartbeatInput,
  type INeonWorkboardReadOptions,
  type INeonWorkboardStatePaths
} from "./workboard/workboardStore.js";
export {
  createNeonDryRunWorkboardExecutor,
  createNeonGatewayShadowWorkboardExecutor,
  renderNeonWorkboardAutoDispatchReport,
  runNeonWorkboardAutoDispatchOnce,
  type INeonGatewayWorkboardExecutorOptions,
  type INeonWorkboardAutoDispatchBatchResult,
  type INeonWorkboardAutoDispatchExecutorInput,
  type INeonWorkboardAutoDispatchExecutorResult,
  type INeonWorkboardAutoDispatchItemResult,
  type INeonWorkboardAutoDispatchOptions,
  type INeonWorkboardAutoDispatchProofInput,
  type TNeonWorkboardAutoDispatchExecutor,
  type TNeonWorkboardAutoDispatchExecutorState,
  type TNeonWorkboardAutoDispatchItemState,
  type TNeonWorkboardAutoDispatchState
} from "./workboard/workboardDispatcher.js";
export {
  syncNeonWorkboardCardTask,
  type ISyncNeonWorkboardCardTaskOptions,
  type TSyncNeonWorkboardCardTaskResult
} from "./workboard/workboardTaskSync.js";
export {
  isNeonWorkboardPriority,
  isNeonWorkboardSourceKind,
  isNeonWorkboardStatus,
  neonWorkboardPriorities,
  neonWorkboardSourceKinds,
  neonWorkboardStatuses,
  parseNeonWorkboardCard,
  projectNeonWorkboardCards,
  type INeonWorkboardCard,
  type INeonWorkboardClaim,
  type INeonWorkboardComment,
  type INeonWorkboardListResult,
  type INeonWorkboardMetadata,
  type INeonWorkboardNotification,
  type INeonWorkboardProof,
  type INeonWorkboardSource,
  type INeonWorkboardStatsResult,
  type TNeonWorkboardNotificationKind,
  type TNeonWorkboardPriority,
  type TNeonWorkboardProofStatus,
  type TNeonWorkboardSourceKind,
  type TNeonWorkboardStatus
} from "./workboard/workboardModel.js";
export {
  neonWorkboardGatewayMethodNames,
  neonWorkboardReadGatewayMethods,
  neonWorkboardWriteGatewayMethods,
  parseNeonWorkboardRpcRequest,
  runNeonWorkboardGatewayMethod,
  type INeonWorkboardRpcRequest,
  type TNeonWorkboardGatewayMethod
} from "./workboard/workboardGateway.js";
export {
  isNeonFlowStatus,
  isNeonFlowStepEffect,
  isNeonFlowStepGated,
  isNeonFlowTriggerKind,
  neonFlowStatusOrder,
  parseNeonFlowDefinition,
  parseNeonFlowStep,
  parseNeonFlowTrigger,
  projectNeonFlowDefinitions,
  type INeonFlowDefinition,
  type INeonFlowStep,
  type INeonFlowTrigger,
  type TNeonFlowStatus,
  type TNeonFlowStepEffect,
  type TNeonFlowTriggerKind
} from "./tasks/flowModel.js";
export {
  readNeonFlow,
  readNeonFlowRecords,
  readNeonFlows,
  redactFlowDefinition,
  resolveNeonFlowStatePaths,
  writeNeonFlow,
  type INeonFlowReadOptions,
  type INeonFlowStatePaths
} from "./tasks/flowStore.js";
export {
  createNeonFlowsSnapshot,
  planNeonFlowExecution,
  renderNeonFlowPlanReport,
  renderNeonFlowsReport,
  type ICreateNeonFlowPlanOptions,
  type ICreateNeonFlowsSnapshotOptions,
  type INeonFlowExecutionPlan,
  type INeonFlowPlanSafety,
  type INeonFlowPlanTotals,
  type INeonFlowPlannedStep,
  type INeonFlowSummary,
  type INeonFlowsSnapshot,
  type INeonFlowsTotals,
  type TNeonFlowStatusCounts,
  type TNeonFlowStepDecision,
  type TNeonFlowStepDecisionReason,
  type TNeonFlowsSnapshotState
} from "./tasks/flowPlan.js";
export {
  assembleNeonContextPack,
  createNeonContextPack,
  renderNeonContextPackReport,
  type IAssembleNeonContextPackInput,
  type ICreateNeonContextPackOptions,
  type INeonContextItem,
  type INeonContextPack,
  type INeonContextPackBounds,
  type INeonContextPackRequest,
  type INeonContextPackSafety,
  type INeonContextPackTotals,
  type INeonContextSection,
  type TNeonContextPackState,
  type TNeonContextSectionId
} from "./context/contextPack.js";
export {
  renderNeonMissionControlWorkboardPanel
} from "./missionControl/workboardPanel.js";

export {
  NEON_ROUNDTABLE_TURN_TEXT_CAP,
  appendNeonRoundtableTurn,
  createNeonRoundtableRoom,
  normalizeNeonRoundtableRoundId,
  readNeonRoundtableRoom,
  redactNeonRoundtableTurnText,
  renderNeonRoundtableRoomReport,
  resolveNeonRoundtableRoomPath,
  writeNeonRoundtableRoom,
  type IAppendNeonRoundtableTurnInput,
  type ICreateNeonRoundtableRoomInput,
  type INeonRoundtableParticipant,
  type INeonRoundtableRoomFile,
  type INeonRoundtableTurn,
  type TNeonRoundtablePurpose,
  type TNeonRoundtableRole,
  type TNeonRoundtableRoomStatus,
  type TNeonRoundtableRuntime,
  type TNeonRoundtableTurnKind
} from "./roundtable/roundtableRoomStore.js";
export {
  NEON_ROUNDTABLE_MAX_ROOMS_SCANNED,
  NEON_ROUNDTABLE_PROJECTION_TURN_LIMIT,
  NEON_ROUNDTABLE_ROOM_LIST_LIMIT,
  NEON_ROUNDTABLE_TURN_PREVIEW_CAP,
  createNeonRoundtableRoomsSnapshot,
  isNeonRoundtableRoomRunning,
  resolveNeonRoundtableRoomsDir,
  type ICreateNeonRoundtableRoomsSnapshotOptions,
  type INeonRoundtableRoomListEntry,
  type INeonRoundtableRoomProjection,
  type INeonRoundtableRoomsSnapshot,
  type INeonRoundtableTurnProjection
} from "./roundtable/roundtableRoomsSnapshot.js";
export {
  NEON_ROUNDTABLE_CONSENSUS_MARKER,
  NEON_ROUNDTABLE_ESCALATE_MARKER,
  NEON_ROUNDTABLE_SOURCE_MARKER,
  buildNeonRoundtableConvenedHeads,
  classifyNeonRoundtableStall,
  renderNeonRoundtableRoundResult,
  runNeonRoundtableRound,
  type INeonRoundtableEscalationEvent,
  type INeonRoundtableHead,
  type INeonRoundtableJudge,
  type INeonRoundtableRoundResult,
  type IRunNeonRoundtableRoundOptions,
  type TNeonRoundtableConveningSide,
  type TNeonRoundtableRoundOutcome,
  type TNeonRoundtableStallClass
} from "./roundtable/roundtableRound.js";
export {
  buildNeonRoundtableWakeNudgeMessage,
  dispatchNeonRoundtableWakeNudge,
  type INeonRoundtableWakeNudgeContent,
  type INeonRoundtableWakeNudgeResult,
  type IDispatchNeonRoundtableWakeNudgeOptions,
  type TNeonRoundtableWakeNudgeState
} from "./roundtable/roundtableWakeNudge.js";
export { renderNeonMissionControlRoundtableRoomsPanel } from "./missionControl/roundtableRoomsPanel.js";
export {
  createNeonRoundtableArmedInvoker,
  createNeonRoundtableHeadRoutingInvoker,
  type ICreateNeonRoundtableHeadRoutingInvokerOptions
} from "./roundtable/roundtableHeadRoutingInvoker.js";

// Discord cockpit block. Kept as explicit exports so the public SDK surface
// remains reviewable while the live CLI and HTTP paths share the same modules.
export {
  createNeonDeliveryIntentId,
  createNeonDeliveryPayloadHash,
  executeNeonExactlyOnceDelivery,
  readNeonDeliveryReceipt,
  readNeonDeliveryReceipts,
  type IExecuteNeonExactlyOnceDeliveryOptions,
  type IReadNeonDeliveryReceiptsOptions,
  type INeonDeliveryReceipt,
  type INeonExactlyOnceDeliveryResult,
  type TNeonDeliveryIntentKind,
  type TNeonDeliveryReceiptState,
  type TNeonExactlyOnceDeliveryState
} from "./gateway/deliveryReceiptStore.js";
export {
  createNeonDiscordAgentButtonsRuntime,
  isNeonDiscordAgentButtonsActionType,
  parseNeonDiscordButtonsMarker,
  type ICreateNeonDiscordAgentButtonsRuntimeOptions,
  type INeonDiscordAgentButtonsExecuteInput,
  type INeonDiscordAgentButtonsRuntime,
  type INeonDiscordAgentButtonsTransport,
  type INeonDiscordButtonsMarkerParseResult
} from "./gateway/discordAgentButtons.js";
export {
  createNeonDiscordCapacityFingerprint,
  createNeonDiscordCapacityGate,
  createNeonDiscordCapacityUpgradeDecision,
  isNeonDiscordCapacityActionType,
  neonDiscordCapacityRuntimes,
  parseNeonDiscordCapacityUpgradeRequest,
  resolveNeonDiscordCapacityDecision,
  type ICreateNeonDiscordCapacityGateOptions,
  type INeonDiscordCapacityAttachment,
  type INeonDiscordCapacityDecision,
  type INeonDiscordCapacityExecutionInput,
  type INeonDiscordCapacityExecutionResult,
  type INeonDiscordCapacityGate,
  type INeonDiscordCapacityGateRequest,
  type INeonDiscordCapacityGateTransport,
  type INeonDiscordCapacityMessage,
  type INeonDiscordCapacityRuntime,
  type INeonDiscordCapacityUpgradeRequest,
  type TNeonDiscordCapacityTier
} from "./gateway/discordCapacityRouter.js";
export {
  neonDiscordCardMarkerColors,
  parseNeonDiscordCardMarker,
  type INeonDiscordCardMarkerParseResult
} from "./gateway/discordCardMarker.js";
export {
  createNeonDiscordComponentActionRegistry,
  resolveNeonDiscordComponentActionStatePath,
  type INeonDiscordComponentActionContext,
  type INeonDiscordComponentActionOutcome,
  type INeonDiscordComponentActionRegistration,
  type INeonDiscordComponentActionRegistry,
  type INeonDiscordComponentActionRegistryOptions,
  type INeonDiscordComponentInteraction,
  type INeonDiscordComponentInteractionEvent,
  type INeonDiscordModal,
  type INeonDiscordModalTextInput,
  type INeonDiscordRegisteredComponentAction,
  type TNeonDiscordComponentActionAudience,
  type TNeonDiscordComponentActionDispatchResult,
  type TNeonDiscordComponentActionHandler,
  type TNeonDiscordComponentActionRejectReason,
  type TNeonDiscordComponentInteractionKind,
  type TNeonDiscordComponentResponseMode
} from "./gateway/discordComponentActionRegistry.js";
export {
  NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION,
  createNeonDiscordPlanApprovalRuntime,
  isNeonDiscordPlanApprovalActionType,
  parseNeonDiscordPlanApprovalMarker,
  readNeonDiscordPlanApprovalSession,
  resolveNeonDiscordPlanApprovalSessionPath,
  resolveNeonDiscordWorkGovernanceInstruction,
  type ICreateNeonDiscordPlanApprovalRuntimeOptions,
  type INeonDiscordPlanApprovalActionInput,
  type INeonDiscordPlanApprovalMarkerParseResult,
  type INeonDiscordPlanApprovalRuntime,
  type INeonDiscordPlanApprovalSession,
  type INeonDiscordPlanApprovalTransport,
  type INeonDiscordPlanRevisionInput,
  type TNeonDiscordPlanApprovalStatus
} from "./gateway/discordPlanApproval.js";
export {
  NEON_DISCORD_POLL_MARKER_DEFAULT_DURATION_HOURS,
  parseNeonDiscordPollMarker,
  type INeonDiscordPollMarkerParseResult
} from "./gateway/discordPollMarker.js";
export {
  createNeonDiscordProgressCardRuntime,
  pickNeonProgressLabel,
  progressLineFromHarnessEvent,
  renderNeonDiscordProgressCard,
  shouldStartNeonDiscordProgressCard,
  type INeonDiscordProgressCardFinishResult,
  type INeonDiscordProgressCardHandle,
  type INeonDiscordProgressCardRuntime,
  type INeonDiscordProgressCardRuntimeOptions,
  type INeonDiscordProgressCardStartInput,
  type INeonDiscordProgressCardTransport,
  type INeonDiscordProgressSteps
} from "./gateway/discordProgressCard.js";
export {
  createNeonDiscordRecoveryRuntime,
  isNeonDiscordRecoveryActionType,
  readNeonDiscordRecoverySession,
  resolveNeonDiscordRecoverySessionPath,
  type ICreateNeonDiscordRecoveryRuntimeOptions,
  type INeonDiscordRecoveryExecutionRequest,
  type INeonDiscordRecoveryRuntime,
  type INeonDiscordRecoverySession,
  type INeonDiscordRecoveryTransport,
  type TNeonDiscordRecoveryAction,
  type TNeonDiscordRecoveryStartResult,
  type TNeonDiscordRecoveryStatus
} from "./gateway/discordRecoveryFlow.js";
export {
  createNeonDiscordRunControl,
  parseNeonDiscordRunControlCommand,
  registerNeonDiscordStopAction,
  type INeonDiscordRunControlOptions,
  type INeonDiscordRunControlResult,
  type INeonDiscordRunControlRuntime,
  type INeonDiscordStopActionInput,
  type TNeonDiscordRunControlCommand,
  type TNeonDiscordRunControlState
} from "./gateway/discordRunControl.js";
export {
  createNeonDiscordSessionRuntimePicker,
  isNeonDiscordSessionRuntimeActionType,
  isNeonDiscordSessionRuntimePickerCommand,
  neonDiscordClaudeRuntimePresets,
  resolveNeonDiscordSessionRuntimeStatePath,
  type ICreateNeonDiscordSessionRuntimePickerOptions,
  type INeonDiscordRuntimeOption,
  type INeonDiscordSessionRuntimePicker,
  type INeonDiscordSessionRuntimePickerOpenInput,
  type INeonDiscordSessionRuntimePickerTransport,
  type INeonDiscordSessionRuntimeSelection
} from "./gateway/discordSessionRuntimePicker.js";
export {
  createNeonDiscordThreadWorkspaceRuntime,
  deriveThreadTopic,
  readNeonDiscordThreadWorkspaces,
  resolveNeonDiscordThreadWorkspaceStatePath,
  shouldCreateNeonDiscordThreadWorkspace,
  type ICreateNeonDiscordThreadWorkspaceRuntimeOptions,
  type INeonDiscordThreadWorkspaceRecord,
  type INeonDiscordThreadWorkspaceRuntime,
  type INeonDiscordThreadWorkspaceTransport
} from "./gateway/discordThreadWorkspace.js";
export {
  formatNeonDiscordExpiryCountdown,
  NEON_DISCORD_ACCENT_COLOR,
  neonDiscordSeverityColors,
  type TNeonDiscordCardSeverity
} from "./gateway/discordUiColors.js";
export {
  createNeonPdfReviewRuntime,
  isNeonPdfReviewActionType,
  readNeonPdfReviewSession,
  resolveNeonPdfReviewSessionPath,
  type ICreateNeonPdfReviewRuntimeOptions,
  type INeonPdfReviewRevisionRequest,
  type INeonPdfReviewRuntime,
  type INeonPdfReviewSession,
  type INeonPdfReviewStartInput,
  type INeonPdfReviewTransport,
  type TNeonPdfReviewStartResult,
  type TNeonPdfReviewStatus
} from "./gateway/pdfReviewFlow.js";
export {
  createNeonMissionControlDiscordCockpitSnapshot,
  createUnknownNeonMissionControlDiscordCockpitSnapshot,
  parseNeonMissionControlDiscordCockpitSnapshot,
  readNeonMissionControlDiscordCockpitSnapshot,
  type ICreateNeonMissionControlDiscordCockpitOptions,
  type IReadNeonMissionControlDiscordCockpitOptions,
  type INeonMissionControlDiscordActiveRun,
  type INeonMissionControlDiscordCockpitSnapshot,
  type INeonMissionControlDiscordDeliveryReceipt,
  type INeonMissionControlDiscordDeliveryTotals,
  type INeonMissionControlDiscordRuntime,
  type TNeonMissionControlDiscordCockpitState,
  type TNeonMissionControlDiscordScopeState,
  type TNeonMissionControlDiscordSourceState
} from "./missionControl/discordCockpitSnapshot.js";
export { NEON_DISCORD_FILE_DELIVERY_INSTRUCTION } from "./harness/codexAppServerHarness.js";
export { createNeonDiscordDeliveryNonce } from "./gateway/discordOutboundTransport.js";
export type { INeonLocalMediaFile } from "./gateway/localMediaAttachment.js";
export {
  NeonSessionActorQueueCancellationError,
  isNeonSessionActorQueueCancellationError
} from "./gateway/sessionActorQueue.js";
export type { INeonHarnessRuntimeMetadata } from "./harness/types.js";
