export type TNeonChannel = "discord" | "telegram" | "whatsapp" | "webchat" | "cli" | "device";
export type THarnessRunMode = "read-only" | "write";
export type TMemoryAttachmentState = "attached" | "skipped" | "failed";
export type TAgentRuntime = "codex" | "claude" | "hybrid" | "human-gate";

export interface ICodexSessionBinding {
  readonly channel: TNeonChannel;
  readonly accountId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly mode: THarnessRunMode;
  /** Explicit, already leak-safe peer key for an identity linked across channels. */
  readonly sessionPeerKey?: string;
}

export interface IMemoryAttachment {
  readonly state: TMemoryAttachmentState;
  readonly hitCount: number;
  readonly note: string;
  readonly excerpts?: readonly IMemoryExcerpt[];
}

export interface IMemoryExcerpt {
  readonly source: string;
  readonly text: string;
}

export interface ICodexHarnessInput {
  readonly abortSignal?: AbortSignal;
  readonly onEvent?: (event: TCodexHarnessEvent) => void;
  readonly runId?: string;
  readonly prompt: string;
  readonly binding: ICodexSessionBinding;
  readonly memory: IMemoryAttachment;
  readonly agent?: IAgentAttachment;
}

export interface IAgentAttachment {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly runtime: TAgentRuntime;
  readonly instructions: readonly string[];
  readonly memoryQuerySeeds: readonly string[];
}

export type TCodexHarnessEvent =
  | {
      readonly kind: "assistant-delta";
      readonly text: string;
    }
  | {
      readonly kind: "tool-start";
      readonly toolName: string;
      readonly toolCallId?: string;
      readonly detail?: string;
      readonly hideFromChannelProgress?: true;
    }
  | {
      readonly kind: "tool-output";
      readonly toolName: string;
      readonly toolCallId?: string;
      readonly output: string;
      readonly detail?: string;
      readonly hideFromChannelProgress?: true;
    }
  | {
      readonly kind: "file-write";
      readonly path: string;
    }
  | {
      readonly kind: "command-exit";
      readonly command: string;
      readonly exitCode: number;
    }
  | {
      readonly kind: "token-usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | {
      readonly kind: "final";
      readonly text: string;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
    };

export interface ICodexHarnessResult {
  readonly sessionKey: string;
  readonly memoryState: TMemoryAttachmentState;
  readonly events: readonly TCodexHarnessEvent[];
  readonly finalText: string;
  readonly cancelled?: true;
}

export type TNeonHarnessId = "codex-app-server" | "claude-cli";

export interface INeonHarnessRuntimeMetadata {
  readonly provider: "openai" | "anthropic";
  readonly runtime: "codex" | "claude";
  readonly lane: TNeonHarnessId;
  readonly model: string;
  readonly effort: string;
}

const NEON_HARNESS_IDS: readonly TNeonHarnessId[] = ["codex-app-server", "claude-cli"];

export function isNeonHarnessId(value: unknown): value is TNeonHarnessId {
  return typeof value === "string" && (NEON_HARNESS_IDS as readonly string[]).includes(value);
}

export function isHarnessEventHiddenFromChannelProgress(event: TCodexHarnessEvent): boolean {
  switch (event.kind) {
    case "tool-start":
    case "tool-output":
      return event.hideFromChannelProgress === true;
    case "assistant-delta":
    case "file-write":
    case "command-exit":
    case "token-usage":
    case "final":
    case "failed":
      return false;
  }
}

export interface ICodexHarness {
  readonly id: TNeonHarnessId;
  readonly runtime?: INeonHarnessRuntimeMetadata;
  run(input: ICodexHarnessInput): Promise<ICodexHarnessResult>;
}
