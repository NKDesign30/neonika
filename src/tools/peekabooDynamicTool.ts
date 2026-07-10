import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  requestNeonPeekabooProxy,
  resolveNeonPeekabooProxySocketPath,
  resolveNeonPeekabooProxyTcpUrl
} from "./peekabooProxy.js";
import {
  type ICodexAppServerRequest,
  type ICodexDynamicToolCallParams,
  type ICodexDynamicToolCallResponse,
  type ICodexDynamicToolSpec,
  type IJsonObject,
  type TCodexAppServerRequestHandler,
  type TJsonValue
} from "../harness/appServerProtocol.js";
import { redactText } from "../harness/redaction.js";

export interface IExecuteNeonPeekabooDynamicToolCallOptions {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly socketPath?: string;
  readonly tcpUrl?: string;
  readonly timeoutMs?: number;
}

interface IResolvedPeekabooToolRequest {
  readonly args: readonly string[];
  readonly outputPath?: string;
}

const PEEKABOO_TOOL_NAME = "peekaboo";
const PEEKABOO_DYNAMIC_TOOL_TIMEOUT_MS = 180_000;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

export const neonPeekabooDynamicToolSpec: ICodexDynamicToolSpec = {
  name: PEEKABOO_TOOL_NAME,
  description:
    "Run Peekaboo on the Neon host for macOS UI inspection and screenshots. Use this instead of shelling out to peekaboo when available.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        enum: ["permissions", "image", "see", "list"]
      },
      mode: {
        type: "string",
        enum: ["screen", "window", "app", "area"]
      },
      target: {
        type: "string",
        enum: ["apps", "windows", "screens"]
      },
      app: {
        type: "string",
        minLength: 1,
        maxLength: 120
      },
      path: {
        type: "string",
        minLength: 1,
        maxLength: 180
      },
      annotate: {
        type: "boolean"
      }
    },
    required: ["command"]
  }
};

export function createNeonPeekabooAppServerRequestHandler(
  options: IExecuteNeonPeekabooDynamicToolCallOptions
): TCodexAppServerRequestHandler {
  return async (request) => await handleNeonPeekabooAppServerRequest(request, options);
}

export async function handleNeonPeekabooAppServerRequest(
  request: ICodexAppServerRequest,
  options: IExecuteNeonPeekabooDynamicToolCallOptions
): Promise<TJsonValue> {
  if (request.method !== "item/tool/call") {
    throw new Error(`Unsupported Codex app-server request: ${request.method}`);
  }

  const call = readPeekabooDynamicToolCallParams(request.params);

  if (!call) {
    return codexDynamicToolResponseToJson(createPeekabooToolResponse(false, "Malformed peekaboo tool call."));
  }

  return codexDynamicToolResponseToJson(await executeNeonPeekabooDynamicToolCall(call, options));
}

export async function executeNeonPeekabooDynamicToolCall(
  call: ICodexDynamicToolCallParams,
  options: IExecuteNeonPeekabooDynamicToolCallOptions
): Promise<ICodexDynamicToolCallResponse> {
  if (call.tool !== PEEKABOO_TOOL_NAME) {
    return createPeekabooToolResponse(false, `Unknown Neon host tool: ${call.tool}`);
  }

  const request = resolvePeekabooToolRequest(call.arguments, options.projectRoot);

  if (!request) {
    return createPeekabooToolResponse(false, "Invalid peekaboo tool arguments.");
  }

  if (request.outputPath) {
    await mkdir(dirname(request.outputPath), { recursive: true });
  }

  try {
    const env = options.env ?? process.env;
    const response = await requestNeonPeekabooProxy({
      tcpUrl: options.tcpUrl ?? env["NEON_PEEKABOO_PROXY_URL"] ?? resolveNeonPeekabooProxyTcpUrl(),
      socketPath: options.socketPath ?? env["NEON_PEEKABOO_PROXY_SOCKET"] ?? resolveNeonPeekabooProxySocketPath(options.projectRoot),
      args: request.args,
      timeoutMs: options.timeoutMs ?? PEEKABOO_DYNAMIC_TOOL_TIMEOUT_MS
    });
    const success = response.exitCode === 0 && !response.error;

    return createPeekabooToolResponse(
      success,
      renderPeekabooProxyResponse(response, request.outputPath)
    );
  } catch (error) {
    return createPeekabooToolResponse(
      false,
      `Peekaboo host tool failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

function resolvePeekabooToolRequest(
  value: TJsonValue | undefined,
  projectRoot: string
): IResolvedPeekabooToolRequest | undefined {
  const input = isJsonObject(value) ? value : undefined;
  const command = readString(input?.["command"]);

  if (!command) {
    return undefined;
  }

  if (command === "permissions") {
    return { args: ["permissions", "--json"] };
  }

  if (command === "list") {
    const target = readString(input?.["target"]) ?? "apps";

    if (!["apps", "windows", "screens"].includes(target)) {
      return undefined;
    }

    return { args: ["list", target, "--json"] };
  }

  if (command === "see") {
    return {
      args: ["see", ...(readBoolean(input?.["annotate"]) === false ? [] : ["--annotate"]), "--json"]
    };
  }

  if (command === "image") {
    const mode = readString(input?.["mode"]) ?? "screen";

    if (!["screen", "window", "app", "area"].includes(mode)) {
      return undefined;
    }

    const outputPath = resolvePeekabooCapturePath(projectRoot, readString(input?.["path"]));
    const app = readString(input?.["app"]);
    const args = [
      "image",
      "--mode",
      mode,
      "--path",
      outputPath,
      "--json",
      ...(app ? ["--app", app] : [])
    ];

    return { args, outputPath };
  }

  return undefined;
}

function readPeekabooDynamicToolCallParams(
  value: TJsonValue | undefined
): ICodexDynamicToolCallParams | undefined {
  const input = isJsonObject(value) ? value : undefined;
  const threadId = readString(input?.["threadId"]);
  const turnId = readString(input?.["turnId"]);
  const callId = readString(input?.["callId"]);
  const tool = readString(input?.["tool"]);

  if (!threadId || !turnId || !callId || !tool) {
    return undefined;
  }

  const namespace = input ? input["namespace"] : undefined;

  return {
    threadId,
    turnId,
    callId,
    tool,
    ...(namespace === null || typeof namespace === "string" ? { namespace } : {}),
    ...(input && input["arguments"] !== undefined ? { arguments: input["arguments"] } : {})
  };
}

function resolvePeekabooCapturePath(projectRoot: string, requestedPath: string | undefined): string {
  const fileName = requestedPath ? basename(requestedPath) : `peekaboo-${new Date().toISOString().replaceAll(":", "-")}.png`;
  const safeName = fileName.endsWith(".png") ? fileName : `${fileName}.png`;

  return join(projectRoot, "state", "gateway", "peekaboo-captures", safeName);
}

function renderPeekabooProxyResponse(
  response: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: string;
  },
  outputPath: string | undefined
): string {
  const lines = [
    `exitCode=${response.exitCode}`,
    ...(outputPath ? [`outputPath=${outputPath}`] : []),
    response.stdout.trim() ? `stdout:\n${response.stdout.trim()}` : "",
    response.stderr.trim() ? `stderr:\n${response.stderr.trim()}` : "",
    response.error ? `error=${response.error}` : ""
  ].filter((line) => line.length > 0);

  return truncateToolText(redactText(lines.join("\n")));
}

function createPeekabooToolResponse(success: boolean, text: string): ICodexDynamicToolCallResponse {
  return {
    success,
    contentItems: [
      {
        type: "inputText",
        text: truncateToolText(redactText(text))
      }
    ]
  };
}

function codexDynamicToolResponseToJson(response: ICodexDynamicToolCallResponse): TJsonValue {
  const contentItems: TJsonValue[] = response.contentItems.map((item) => {
    if ("type" in item && item.type === "inputText") {
      return {
        type: "inputText",
        text: item.text
      };
    }

    if ("type" in item && item.type === "inputImage") {
      return {
        type: "inputImage",
        imageUrl: item.imageUrl
      };
    }

    return item;
  });

  return {
    success: response.success,
    contentItems
  };
}

function truncateToolText(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_TOOL_OUTPUT_CHARS - 15)}\n[truncated]`;
}

function readString(value: TJsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: TJsonValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isJsonObject(value: TJsonValue | undefined): value is IJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
