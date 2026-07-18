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
  readonly serviceTier?: string;
}

export interface ICodexTurnHandle {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: TCodexTurnStatus;
  readonly response: TJsonValue | undefined;
}

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
      readonly type: "error";
      readonly message: string;
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
    case "error": {
      return {
        type: "error",
        message: redactText(readString(params?.["message"]) ?? "Codex app-server emitted an error")
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
