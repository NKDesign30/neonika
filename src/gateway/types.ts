import type {
  IAgentAttachment,
  ICodexHarnessResult,
  INeonHarnessRuntimeMetadata,
  IMemoryAttachment,
  TCodexHarnessEvent,
  THarnessRunMode,
  TNeonChannel,
  TNeonHarnessId
} from "../harness/types.js";
import type {
  TNeonExternalContentPatternId,
  TNeonExternalContentSeverity
} from "../security/externalContent.js";

/**
 * Persisted shape of a suspicious external-content finding on a Gateway run.
 *
 * Deliberately carries only id/severity/count and NOT the human-readable label:
 * the detector labels (e.g. "ignore previous instructions") themselves match the
 * Doctor external-content regexes, so persisting them into runs.jsonl would make
 * the read-only external-content check re-detect its own metadata and inflate the
 * baseline. The hyphenated pattern ids (e.g. "ignore-previous-instructions") do not
 * match those regexes. The label stays derivable from the id at display time.
 */
export interface INeonGatewayPersistedFinding {
  readonly id: TNeonExternalContentPatternId;
  readonly severity: TNeonExternalContentSeverity;
  readonly count: number;
}

/**
 * Run-store audit posture. `shadow` is the default: the run was observed and
 * its outbound was held back. `live` means the run resulted in a real outbound
 * delivery (a sent reply with a real channel message id) under a canary/primary
 * cutover stage. Historical shadow audit records keep `shadow`.
 */
export type TNeonGatewayRunMode = "shadow" | "live";
export type TNeonGatewayRunStatus = "running" | "completed" | "failed" | "cancelled";
/**
 * Delivery outcome on the persisted run. `suppressed` means nothing went out
 * (the shadow default). `delivered` means the reply was actually sent and a
 * real channel message id was returned.
 */
export type TNeonGatewayDeliveryState = "suppressed" | "delivered";

export interface INeonGatewayInboundMessage {
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly mode: THarnessRunMode;
  readonly sessionPeerKey?: string;
  readonly goal?: string;
  readonly content: string;
  readonly context?: readonly INeonGatewayPromptContextMessage[];
  readonly attachments?: readonly INeonGatewayInboundAttachment[];
  readonly createdAt?: string;
}

export interface INeonGatewayPromptContextMessage {
  readonly direction: "inbound" | "agent";
  readonly agentId: string;
  readonly text: string;
  readonly createdAt?: string;
  readonly userDisplayName?: string;
}

export type TNeonGatewayInboundAttachmentKind = "audio" | "image" | "video" | "file";

export interface INeonGatewayInboundAttachment {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly durationSeconds?: number;
  readonly kind: TNeonGatewayInboundAttachmentKind;
  readonly voiceMessage?: boolean;
}

export interface INeonGatewayShadowInput {
  readonly message: INeonGatewayInboundMessage;
  readonly memory: IMemoryAttachment;
  readonly agent?: IAgentAttachment;
}

export interface INeonGatewayRunRequest {
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly mode: THarnessRunMode;
  readonly goal?: string;
  readonly contentPreview: string;
  readonly receivedAt: string;
  readonly suspiciousFindings?: readonly INeonGatewayPersistedFinding[];
  readonly sourceHadVoiceAttachment?: boolean;
  readonly requestedVoiceReply?: boolean;
}

export interface INeonGatewayDeliveryResult {
  readonly state: TNeonGatewayDeliveryState;
  readonly targetChannel: TNeonChannel;
  readonly targetChannelId: string;
  readonly reason: string;
  readonly finalText: string;
  /** Real channel message id, present only when `state` is `delivered`. */
  readonly messageId?: string;
}

export interface INeonGatewayShadowRun {
  readonly runId: string;
  readonly mode: TNeonGatewayRunMode;
  readonly status: TNeonGatewayRunStatus;
  readonly request: INeonGatewayRunRequest;
  readonly harnessId: TNeonHarnessId;
  readonly runtime?: INeonHarnessRuntimeMetadata;
  readonly harnessSessionKey: string;
  readonly memoryState: IMemoryAttachment["state"];
  readonly events: readonly TCodexHarnessEvent[];
  readonly finalText: string;
  readonly delivery: INeonGatewayDeliveryResult;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface INeonGatewayShadowResult {
  readonly run: INeonGatewayShadowRun;
  readonly harness: ICodexHarnessResult;
}
