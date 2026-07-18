/**
 * Adapted in part from OpenClaw src/agents/tool-display-config.ts.
 * See THIRD_PARTY_NOTICES.md for attribution and license details.
 */
import {
  codexAppServerMethods,
  type ICodexAppServerClient,
  type ICodexAppServerNotification,
  type ICodexDynamicToolSpec,
  type IJsonObject,
  type TJsonValue
} from "./appServerProtocol.js";
import { redactText } from "./redaction.js";

export type TCodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type TCodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type TCodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type TCodexThreadSource = "started" | "resumed";
export type TCodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress" | "unknown";

export interface ICodexThreadStartInput {
  readonly client: ICodexAppServerClient;
  readonly cwd: string;
  readonly existingThreadId?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly serviceTier?: string;
  readonly approvalPolicy?: TCodexApprovalPolicy;
  readonly sandbox?: TCodexSandboxMode;
  readonly baseInstructions?: string;
  readonly developerInstructions?: string;
  readonly dynamicTools?: readonly ICodexDynamicToolSpec[];
  readonly ephemeral?: boolean;
}

export interface ICodexThreadHandle {
  readonly threadId: string;
  readonly source: TCodexThreadSource;
  readonly response: TJsonValue | undefined;
}

export interface ICodexTurnStartInput {
  readonly client: ICodexAppServerClient;
  readonly threadId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly approvalPolicy?: TCodexApprovalPolicy;
  readonly model?: string;
  readonly effort?: TCodexReasoningEffort;
  readonly serviceTier?: string;
}

export interface ICodexTurnHandle {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: TCodexTurnStatus;
  readonly response: TJsonValue | undefined;
}

export type TCodexProgressItemType =
  | "commandExecution"
  | "fileChange"
  | "webSearch"
  | "mcpToolCall"
  | "reasoning"
  | "imageView";

const codexProgressItemTypes: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "webSearch",
  "mcpToolCall",
  "reasoning",
  "imageView"
]);

export type TCodexRunEvent =
  | {
      readonly type: "thread.started";
      readonly threadId: string;
    }
  | {
      readonly type: "turn.started";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: TCodexTurnStatus;
    }
  | {
      readonly type: "assistant.delta";
      readonly threadId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "turn.completed";
      readonly threadId: string;
      readonly turnId: string;
      readonly status: TCodexTurnStatus;
    }
  | {
      readonly type: "item.progress";
      readonly threadId: string;
      readonly itemId: string;
      readonly itemType: TCodexProgressItemType;
      readonly phase: "started" | "completed";
      readonly detail?: string;
    }
  | {
      readonly type: "reasoning.delta";
      readonly threadId: string;
      readonly itemId: string;
      readonly text: string;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly willRetry: boolean;
    }
  | {
      readonly type: "unknown";
      readonly method: string;
    };

export async function startOrResumeCodexThread(
  input: ICodexThreadStartInput
): Promise<ICodexThreadHandle> {
  const source: TCodexThreadSource = input.existingThreadId ? "resumed" : "started";
  const response = await input.client.request(
    source === "resumed" ? codexAppServerMethods.threadResume : codexAppServerMethods.threadStart,
    source === "resumed" ? buildThreadResumeParams(input) : buildThreadStartParams(input)
  );
  const threadId = readNestedString(response, ["thread", "id"]);

  if (!threadId) {
    throw new Error(`Codex app-server thread ${source} response did not include thread.id`);
  }

  return {
    threadId,
    source,
    response
  };
}

export async function startCodexTurn(input: ICodexTurnStartInput): Promise<ICodexTurnHandle> {
  const response = await input.client.request(
    codexAppServerMethods.turnStart,
    buildTurnStartParams(input),
    input.signal ? { signal: input.signal } : undefined
  );
  const turnId = readNestedString(response, ["turn", "id"]);

  if (!turnId) {
    throw new Error("Codex app-server turn/start response did not include turn.id");
  }

  return {
    threadId: input.threadId,
    turnId,
    status: readTurnStatus(readNestedString(response, ["turn", "status"])),
    response
  };
}

export async function unsubscribeCodexThread(
  client: ICodexAppServerClient,
  threadId: string
): Promise<TJsonValue | undefined> {
  return await client.request(codexAppServerMethods.threadUnsubscribe, {
    threadId
  });
}

export async function interruptCodexTurn(
  client: ICodexAppServerClient,
  input: {
    readonly threadId: string;
    readonly turnId: string;
  }
): Promise<TJsonValue | undefined> {
  return await client.request(codexAppServerMethods.turnInterrupt, {
    threadId: input.threadId,
    turnId: input.turnId
  });
}

export function createTextTurnInput(text: string): TJsonValue {
  return [
    {
      type: "text",
      text,
      text_elements: []
    }
  ];
}

const PROGRESS_ITEM_DETAIL_MAX_CHARS = 160;

// Detail extraction mirrors OpenClaw's per-tool detailKeys idea
// (openclaw src/agents/tool-display-config.ts) rebuilt Neon-native: one
// leak-checked line fragment per item type, never the raw payload.
function readProgressItemDetail(
  params: IJsonObject | undefined,
  itemType: TCodexProgressItemType
): string | undefined {
  const raw = ((): string | undefined => {
    switch (itemType) {
      case "commandExecution":
        return readNestedString(params, ["item", "command"]);
      case "webSearch":
        return readNestedString(params, ["item", "query"]);
      case "mcpToolCall": {
        const server = readNestedString(params, ["item", "server"]);
        const tool = readNestedString(params, ["item", "tool"]);
        return server && tool ? `${server}/${tool}` : (tool ?? server);
      }
      case "fileChange": {
        const item = params?.["item"];
        const changes = isJsonObject(item) ? item["changes"] : undefined;
        return Array.isArray(changes) && changes.length > 0
          ? `${changes.length} Datei(en)`
          : undefined;
      }
      case "reasoning":
      case "imageView":
        return undefined;
    }
  })();

  const trimmed = raw?.trim().replace(/\s+/gu, " ");
  if (!trimmed) {
    return undefined;
  }
  const redacted = redactText(trimmed);
  return redacted.length > PROGRESS_ITEM_DETAIL_MAX_CHARS
    ? `${redacted.slice(0, PROGRESS_ITEM_DETAIL_MAX_CHARS - 1)}…`
    : redacted;
}

export function projectCodexNotification(
  notification: ICodexAppServerNotification
): TCodexRunEvent {
  const params = isJsonObject(notification.params) ? notification.params : undefined;

  switch (notification.method) {
    case "thread/started": {
      const threadId = readNestedString(params, ["thread", "id"]);

      return threadId
        ? {
            type: "thread.started",
            threadId
          }
        : {
            type: "unknown",
            method: notification.method
          };
    }
    case "turn/started": {
      const threadId = readString(params?.["threadId"]);
      const turnId = readNestedString(params, ["turn", "id"]);

      return threadId && turnId
        ? {
            type: "turn.started",
            threadId,
            turnId,
            status: readTurnStatus(readNestedString(params, ["turn", "status"]))
          }
        : {
            type: "unknown",
            method: notification.method
          };
    }
    case "item/agentMessage/delta": {
      const threadId = readString(params?.["threadId"]);
      const turnId = readString(params?.["turnId"]);
      const itemId = readString(params?.["itemId"]);
      const delta = readString(params?.["delta"]);

      return threadId && turnId && itemId && delta !== undefined
        ? {
            type: "assistant.delta",
            threadId,
            turnId,
            itemId,
            text: redactText(delta)
          }
        : {
            type: "unknown",
            method: notification.method
          };
    }
    case "turn/completed": {
      const threadId = readString(params?.["threadId"]);
      const turnId = readNestedString(params, ["turn", "id"]);

      return threadId && turnId
        ? {
            type: "turn.completed",
            threadId,
            turnId,
            status: readTurnStatus(readNestedString(params, ["turn", "status"]))
          }
        : {
            type: "unknown",
            method: notification.method
          };
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const threadId = readString(params?.["threadId"]);
      const itemId = readString(params?.["itemId"]);
      const delta = readString(params?.["delta"]);

      return threadId && itemId && delta !== undefined
        ? {
            type: "reasoning.delta",
            threadId,
            itemId,
            text: redactText(delta)
          }
        : {
            type: "unknown",
            method: notification.method
          };
    }
    case "item/started":
    case "item/completed": {
      const threadId = readString(params?.["threadId"]);
      const itemId = readNestedString(params, ["item", "id"]);
      const itemType = readNestedString(params, ["item", "type"]);

      // agentMessage is the reply itself (already streamed via item/agentMessage/delta),
      // not a work step worth surfacing as progress.
      if (!threadId || !itemId || !itemType || !codexProgressItemTypes.has(itemType)) {
        return {
          type: "unknown",
          method: notification.method
        };
      }
      const detail = readProgressItemDetail(params, itemType as TCodexProgressItemType);
      return {
        type: "item.progress",
        threadId,
        itemId,
        itemType: itemType as TCodexProgressItemType,
        phase: notification.method === "item/started" ? "started" : "completed",
        ...(detail ? { detail } : {})
      };
    }
    case "error": {
      return {
        type: "error",
        message: redactText(
          readNestedString(params, ["error", "message"]) ??
            readString(params?.["message"]) ??
            "Codex app-server emitted an error"
        ),
        willRetry: params?.["willRetry"] === true
      };
    }
    default:
      return {
        type: "unknown",
        method: notification.method
      };
  }
}

function buildThreadStartParams(input: ICodexThreadStartInput): TJsonValue {
  return compactJsonObject({
    cwd: input.cwd,
    model: input.model,
    modelProvider: input.modelProvider,
    serviceTier: input.serviceTier,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    baseInstructions: input.baseInstructions,
    developerInstructions: input.developerInstructions,
    dynamicTools: input.dynamicTools ? [...input.dynamicTools] : undefined,
    ephemeral: input.ephemeral
  });
}

function buildThreadResumeParams(input: ICodexThreadStartInput): TJsonValue {
  return compactJsonObject({
    threadId: input.existingThreadId,
    cwd: input.cwd,
    model: input.model,
    modelProvider: input.modelProvider,
    serviceTier: input.serviceTier,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    baseInstructions: input.baseInstructions,
    developerInstructions: input.developerInstructions
  });
}

function buildTurnStartParams(input: ICodexTurnStartInput): TJsonValue {
  return compactJsonObject({
    threadId: input.threadId,
    input: createTextTurnInput(input.prompt),
    cwd: input.cwd,
    approvalPolicy: input.approvalPolicy,
    model: input.model,
    effort: input.effort,
    serviceTier: input.serviceTier
  });
}

function compactJsonObject(entries: Readonly<Record<string, TJsonValue | undefined>>): IJsonObject {
  const result: Record<string, TJsonValue> = {};

  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return result;
}

function readNestedString(value: TJsonValue | undefined, path: readonly string[]): string | undefined {
  let current: TJsonValue | undefined = value;

  for (const key of path) {
    if (!isJsonObject(current)) {
      return undefined;
    }

    current = current[key];
  }

  return readString(current);
}

function readString(value: TJsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTurnStatus(value: string | undefined): TCodexTurnStatus {
  if (value === "completed" || value === "interrupted" || value === "failed" || value === "inProgress") {
    return value;
  }

  return "unknown";
}

function isJsonObject(value: TJsonValue | undefined): value is IJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
