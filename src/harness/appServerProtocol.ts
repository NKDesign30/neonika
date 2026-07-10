export type TJsonValue = null | boolean | number | string | TJsonValue[] | IJsonObject;

export interface IJsonObject {
  readonly [key: string]: TJsonValue;
}

export type TCodexAppServerTransportMode = "stdio" | "websocket";

export type TCodexAppServerMethod =
  | "initialize"
  | "thread/start"
  | "thread/resume"
  | "thread/unsubscribe"
  | "turn/start"
  | "turn/interrupt";

export interface ICodexDynamicToolSpec extends IJsonObject {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TJsonValue;
}

export interface ICodexAppServerStartOptions {
  readonly transport: TCodexAppServerTransportMode;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly authToken?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly clearEnv: readonly string[];
  readonly inheritEnv?: boolean;
}

export interface ICodexAppServerRequest {
  readonly jsonrpc?: "2.0";
  readonly id: number | string;
  readonly method: string;
  readonly params?: TJsonValue;
}

export interface ICodexAppServerResponseError {
  readonly code?: number;
  readonly message: string;
  readonly data?: TJsonValue;
}

export interface ICodexAppServerResponse {
  readonly jsonrpc?: "2.0";
  readonly id: number | string;
  readonly result?: TJsonValue;
  readonly error?: ICodexAppServerResponseError;
}

export interface ICodexDynamicToolCallParams {
  readonly namespace?: string | null;
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments?: TJsonValue;
}

export type TCodexDynamicToolCallOutputContentItem =
  | {
      readonly type: "inputText";
      readonly text: string;
    }
  | {
      readonly type: "inputImage";
      readonly imageUrl: string;
    }
  | IJsonObject;

export interface ICodexDynamicToolCallResponse {
  readonly success: boolean;
  readonly contentItems: readonly TCodexDynamicToolCallOutputContentItem[];
}

export interface ICodexAppServerNotification {
  readonly jsonrpc?: "2.0";
  readonly method: string;
  readonly params?: TJsonValue;
}

export type TCodexAppServerNotificationHandler = (
  notification: ICodexAppServerNotification
) => Promise<void> | void;

export type TCodexAppServerRequestHandler = (
  request: ICodexAppServerRequest
) => Promise<TJsonValue | undefined> | TJsonValue | undefined;

export interface ICodexAppServerRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ICodexAppServerClient {
  initialize(): Promise<void>;
  request(
    method: TCodexAppServerMethod,
    params?: TJsonValue,
    options?: ICodexAppServerRequestOptions
  ): Promise<TJsonValue | undefined>;
  subscribe(handler: TCodexAppServerNotificationHandler): () => void;
  close(): Promise<void>;
}

export const codexAppServerMethods = {
  initialize: "initialize",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadUnsubscribe: "thread/unsubscribe",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt"
} as const satisfies Record<string, TCodexAppServerMethod>;

export function validateStartOptions(options: ICodexAppServerStartOptions): void {
  if (options.transport === "websocket" && !options.url) {
    throw new Error("websocket Codex app-server transport requires a URL");
  }

  if (options.transport === "stdio" && !options.command) {
    throw new Error("stdio Codex app-server transport requires a command");
  }
}
