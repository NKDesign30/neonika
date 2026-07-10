import {
  codexAppServerMethods,
  type ICodexAppServerClient,
  type ICodexAppServerNotification,
  type ICodexAppServerRequest,
  type ICodexAppServerRequestOptions,
  type ICodexAppServerResponse,
  type ICodexAppServerResponseError,
  type TCodexAppServerRequestHandler,
  type TCodexAppServerMethod,
  type TCodexAppServerNotificationHandler,
  type TJsonValue
} from "./appServerProtocol.js";

export interface ICodexJsonRpcTransport {
  send(message: ICodexAppServerRequest | ICodexAppServerResponse): Promise<void>;
  onMessage(handler: (message: unknown) => void): () => void;
  onClose(handler: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export interface ICodexJsonRpcClientOptions {
  readonly defaultRequestTimeoutMs?: number;
  readonly initializeParams?: TJsonValue;
  readonly serverRequestHandler?: TCodexAppServerRequestHandler;
}

interface IPendingJsonRpcRequest {
  readonly timeout: NodeJS.Timeout | undefined;
  readonly abortSignal: AbortSignal | undefined;
  readonly abortHandler: (() => void) | undefined;
  resolve(value: TJsonValue | undefined): void;
  reject(error: Error): void;
}

export class CodexJsonRpcError extends Error {
  readonly code?: number;
  readonly data?: TJsonValue;

  constructor(error: ICodexAppServerResponseError) {
    super(error.message);
    this.name = "CodexJsonRpcError";

    if (typeof error.code === "number") {
      this.code = error.code;
    }

    if (error.data !== undefined) {
      this.data = error.data;
    }
  }
}

export class CodexJsonRpcClient implements ICodexAppServerClient {
  private readonly defaultRequestTimeoutMs: number;
  private readonly handlers = new Set<TCodexAppServerNotificationHandler>();
  private readonly initializeParams: TJsonValue;
  private readonly pending = new Map<number | string, IPendingJsonRpcRequest>();
  private readonly serverRequestHandler: TCodexAppServerRequestHandler | undefined;
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeClose: () => void;
  private nextRequestId = 1;
  private initialized = false;
  private closed = false;

  constructor(
    private readonly transport: ICodexJsonRpcTransport,
    options: ICodexJsonRpcClientOptions = {}
  ) {
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? 30_000;
    this.initializeParams = options.initializeParams ?? defaultInitializeParams;
    this.serverRequestHandler = options.serverRequestHandler;
    this.unsubscribeMessage = transport.onMessage((message) => {
      this.handleMessage(message);
    });
    this.unsubscribeClose = transport.onClose((error) => {
      this.closeWithError(error ?? new Error("Codex app-server transport closed"));
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.request(codexAppServerMethods.initialize, this.initializeParams);
    this.initialized = true;
  }

  async request(
    method: TCodexAppServerMethod,
    params?: TJsonValue,
    options: ICodexAppServerRequestOptions = {}
  ): Promise<TJsonValue | undefined> {
    if (this.closed) {
      throw new Error("Codex app-server client is closed");
    }

    if (options.signal?.aborted) {
      throw new Error(`Codex app-server request ${method} aborted before send`);
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const message = createRequestMessage(id, method, params);

    return new Promise<TJsonValue | undefined>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs;
      const cleanup = () => {
        const current = this.pending.get(id);

        if (!current) {
          return;
        }

        if (current.timeout) {
          clearTimeout(current.timeout);
        }

        if (current.abortSignal && current.abortHandler) {
          current.abortSignal.removeEventListener("abort", current.abortHandler);
        }

        this.pending.delete(id);
      };
      const rejectOnce = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timeout =
        timeoutMs > 0
          ? setTimeout(() => {
              rejectOnce(new Error(`Codex app-server request ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      const abortHandler = options.signal
        ? () => {
            rejectOnce(new Error(`Codex app-server request ${method} aborted`));
          }
        : undefined;

      if (options.signal && abortHandler) {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.pending.set(id, {
        timeout,
        abortSignal: options.signal,
        abortHandler,
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: rejectOnce
      });

      void this.transport.send(message).catch((error: unknown) => {
        rejectOnce(error instanceof Error ? error : new Error("Codex app-server request send failed"));
      });
    });
  }

  subscribe(handler: TCodexAppServerNotificationHandler): () => void {
    this.handlers.add(handler);

    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closeWithError(new Error("Codex app-server client closed"));
    await this.transport.close();
  }

  getPendingRequestCountForTests(): number {
    return this.pending.size;
  }

  private handleMessage(message: unknown): void {
    if (isCodexAppServerServerRequest(message)) {
      this.handleServerRequest(message);
      return;
    }

    if (isCodexAppServerResponse(message)) {
      this.handleResponse(message);
      return;
    }

    if (isCodexAppServerNotification(message)) {
      this.handleNotification(message);
    }
  }

  private handleServerRequest(request: ICodexAppServerRequest): void {
    const handler = this.serverRequestHandler ?? defaultServerRequestHandler;

    void Promise.resolve(handler(request))
      .then(async (result) => {
        await this.transport.send(createResponseMessage(request.id, result));
      })
      .catch(async (error: unknown) => {
        await this.transport
          .send(createErrorResponseMessage(request.id, error))
          .catch(() => undefined);
      });
  }

  private handleResponse(response: ICodexAppServerResponse): void {
    const pending = this.pending.get(response.id);

    if (!pending) {
      return;
    }

    if (response.error) {
      pending.reject(new CodexJsonRpcError(response.error));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: ICodexAppServerNotification): void {
    for (const handler of this.handlers) {
      void Promise.resolve(handler(notification)).catch(() => undefined);
    }
  }

  private closeWithError(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.unsubscribeMessage();
    this.unsubscribeClose();

    const pending = Array.from(this.pending.values());

    for (const request of pending) {
      request.reject(error);
    }

    this.pending.clear();
    this.handlers.clear();
  }
}

function createRequestMessage(
  id: number,
  method: TCodexAppServerMethod,
  params?: TJsonValue
): ICodexAppServerRequest {
  if (params === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      method
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    method,
    params
  };
}

function createResponseMessage(
  id: number | string,
  result: TJsonValue | undefined
): ICodexAppServerResponse {
  if (result === undefined) {
    return {
      jsonrpc: "2.0",
      id,
      result: null
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function createErrorResponseMessage(id: number | string, error: unknown): ICodexAppServerResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32_000,
      message: error instanceof Error ? error.message : "Codex app-server request handler failed"
    }
  };
}

function isCodexAppServerServerRequest(value: unknown): value is ICodexAppServerRequest {
  if (!isRecord(value) || !isRequestId(value["id"]) || typeof value["method"] !== "string") {
    return false;
  }

  return value["params"] === undefined || isJsonValue(value["params"]);
}

function isCodexAppServerResponse(value: unknown): value is ICodexAppServerResponse {
  if (!isRecord(value) || !isRequestId(value["id"])) {
    return false;
  }

  if (!("result" in value) && !("error" in value)) {
    return false;
  }

  const result = value["result"];
  const error = value["error"];

  return (result === undefined || isJsonValue(result)) && (error === undefined || isResponseError(error));
}

function defaultServerRequestHandler(request: ICodexAppServerRequest): TJsonValue {
  if (request.method === "item/tool/call") {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Neon Core did not register a handler for this app-server tool call."
        }
      ]
    };
  }

  throw new Error(`Unsupported Codex app-server request: ${request.method}`);
}

function isCodexAppServerNotification(value: unknown): value is ICodexAppServerNotification {
  if (!isRecord(value) || typeof value["method"] !== "string" || "id" in value) {
    return false;
  }

  return value["params"] === undefined || isJsonValue(value["params"]);
}

function isResponseError(value: unknown): value is ICodexAppServerResponseError {
  if (!isRecord(value) || typeof value["message"] !== "string") {
    return false;
  }

  const code = value["code"];
  const data = value["data"];

  return (code === undefined || typeof code === "number") && (data === undefined || isJsonValue(data));
}

function isRequestId(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function isJsonValue(value: unknown): value is TJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((entry: unknown) => isJsonValue(entry));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry: unknown) => isJsonValue(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const defaultInitializeParams = {
  clientInfo: {
    name: "neon-core",
    title: "Neon Core",
    version: "0.1.0"
  },
  capabilities: {
    experimentalApi: true
  }
} as const satisfies TJsonValue;
