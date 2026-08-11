import type { INeonChannelRouteRef } from "../channels/routeProjection.js";
import { readReadyCutoverEnv } from "../core/cutover.js";
import {
  markNeonGatewayRunDelivered,
  runNeonGatewayShadow
} from "../gateway/shadowGateway.js";
import { deliverNeonCanaryReplyForRun } from "../gateway/canaryReplyLoop.js";
import type { INeonOutboundSender } from "../gateway/outboundSender.js";
import { writeNeonGatewayRunLatest } from "../gateway/runStore.js";
import type {
  INeonGatewayInboundMessage,
  INeonGatewayShadowRun
} from "../gateway/types.js";
import { redactText } from "../harness/redaction.js";
import type {
  IAgentAttachment,
  ICodexHarness,
  IMemoryAttachment,
  TCodexHarnessEvent,
  TNeonChannel
} from "../harness/types.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";

const scheduledAgentExecutionEnvKey = "NEON_SCHEDULED_AGENT_EXECUTION_ENABLED" as const;
const defaultMaxAttempts = 2;
const maximumMaxAttempts = 3;
const previewMaxLength = 180;

export type TNeonScheduledAgentExecutionReason = "execution-disabled" | "execution-enabled";
export type TNeonScheduledAgentExecutionState = "blocked" | "executed" | "failed";

export interface INeonScheduledAgentExecutionGate {
  readonly enabled: boolean;
  readonly reason: TNeonScheduledAgentExecutionReason;
  readonly envKey: typeof scheduledAgentExecutionEnvKey;
}

export interface INeonScheduledAgentSpecification {
  readonly runId: string;
  readonly source: "cron" | "heartbeat";
  readonly sourceId: string;
  readonly agentId: string;
  readonly goal: string;
  readonly content: string;
  readonly receivedAt: string;
  readonly deliveryTarget?: INeonChannelRouteRef;
}

export interface INeonScheduledAgentRuntime {
  readonly gate: INeonScheduledAgentExecutionGate;
  readonly resolveAgent: (agentId: string) => IAgentAttachment | undefined;
  readonly resolveHarness: (agent: IAgentAttachment) => ICodexHarness;
  readonly resolveMemory: (message: INeonGatewayInboundMessage) => Promise<IMemoryAttachment>;
  readonly sender?: INeonOutboundSender;
  readonly maxAttempts?: number;
  readonly delay?: (delayMs: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface INeonScheduledAgentExecutionResult {
  readonly state: TNeonScheduledAgentExecutionState;
  readonly run: INeonGatewayShadowRun;
  readonly attempts: number;
  readonly retryCount: number;
  readonly outboundSent: boolean;
  readonly diagnostics: readonly string[];
}

export interface IExecuteNeonScheduledAgentRunOptions {
  readonly projectRoot: string;
  readonly specification: INeonScheduledAgentSpecification;
  readonly runtime: INeonScheduledAgentRuntime;
  readonly writeRun?: (projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>;
}

export function resolveNeonScheduledAgentExecutionGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonScheduledAgentExecutionGate {
  const enabled = readReadyCutoverEnv(env, scheduledAgentExecutionEnvKey);
  return {
    enabled,
    reason: enabled ? "execution-enabled" : "execution-disabled",
    envKey: scheduledAgentExecutionEnvKey
  };
}

export async function executeNeonScheduledAgentRun(
  options: IExecuteNeonScheduledAgentRunOptions
): Promise<INeonScheduledAgentExecutionResult> {
  const writeRun = options.writeRun ?? writeNeonGatewayRunLatest;
  const message = createScheduledGatewayMessage(options.projectRoot, options.specification);

  if (!options.runtime.gate.enabled) {
    const run = buildScheduledTerminalRun({
      specification: options.specification,
      message,
      status: "completed",
      completedAt: options.specification.receivedAt
    });
    await writeRun(options.projectRoot, run);
    return {
      state: "blocked",
      run,
      attempts: 0,
      retryCount: 0,
      outboundSent: false,
      diagnostics: [
        `Agent execution blocked: requires ${options.runtime.gate.envKey}.`,
        "No harness invoked and no outbound attempted."
      ]
    };
  }

  const agent = options.runtime.resolveAgent(options.specification.agentId);
  if (!agent) {
    const run = buildScheduledTerminalRun({
      specification: options.specification,
      message,
      status: "failed",
      failureMessage: "Scheduled agent profile could not be resolved.",
      completedAt: resolveNow(options.runtime).toISOString()
    });
    await writeRun(options.projectRoot, run);
    return {
      state: "failed",
      run,
      attempts: 0,
      retryCount: 0,
      outboundSent: false,
      diagnostics: ["Scheduled run failed closed before harness invocation: agent profile unavailable."]
    };
  }

  const harness = options.runtime.resolveHarness(agent);
  const memory = await resolveScheduledMemory(options.runtime, message);
  const maxAttempts = resolveMaxAttempts(options.runtime.maxAttempts);
  const retryEvents: TCodexHarnessEvent[] = [];
  let attempts = 0;
  let terminalRun: INeonGatewayShadowRun | undefined;

  while (attempts < maxAttempts) {
    attempts += 1;
    let runningRun: INeonGatewayShadowRun | undefined;
    let runningPersisted = false;

    try {
      const result = await runNeonGatewayShadow(
        { message, memory, agent },
        {
          harness,
          ...(options.runtime.now ? { now: options.runtime.now } : {}),
          createRunId: () => options.specification.runId,
          onRunStarted: async (run) => {
            runningRun = run;
            await writeRun(options.projectRoot, run);
            runningPersisted = true;
          }
        }
      );
      terminalRun = withRetryEvents(result.run, retryEvents);
    } catch (error) {
      if (!runningPersisted || !runningRun) {
        throw error;
      }
      terminalRun = {
        ...runningRun,
        status: "failed",
        events: [
          ...retryEvents,
          { kind: "failed", message: "Scheduled harness invocation failed." }
        ],
        finalText: "",
        completedAt: resolveNow(options.runtime).toISOString()
      };
      if (attempts < maxAttempts && isTransientScheduledFailure(error)) {
        await writeRun(options.projectRoot, terminalRun);
        retryEvents.push(createRetryEvent(attempts, maxAttempts));
        await resolveDelay(options.runtime)(resolveRetryDelayMs(attempts));
        continue;
      }
    }

    await writeRun(options.projectRoot, terminalRun);
    if (terminalRun.status === "failed" && attempts < maxAttempts && isTransientRunFailure(terminalRun)) {
      retryEvents.push(createRetryEvent(attempts, maxAttempts));
      await resolveDelay(options.runtime)(resolveRetryDelayMs(attempts));
      continue;
    }
    break;
  }

  if (!terminalRun) {
    throw new Error("Scheduled agent execution produced no terminal run");
  }

  let persistedRun = terminalRun;
  let outboundSent = false;
  if (
    persistedRun.status === "completed" &&
    options.specification.deliveryTarget?.channel === "discord" &&
    options.runtime.sender
  ) {
    const delivery = await deliverNeonCanaryReplyForRun({
      run: persistedRun,
      sender: options.runtime.sender,
      replyMode: "channel",
      projectRoot: options.projectRoot
    });
    if (delivery.state === "delivered" && delivery.messageId) {
      persistedRun = markNeonGatewayRunDelivered(persistedRun, {
        messageId: delivery.messageId,
        ...(delivery.reason ? { reason: delivery.reason } : {}),
        ...(delivery.cutoverStage ? { cutoverStage: delivery.cutoverStage } : {})
      });
      await writeRun(options.projectRoot, persistedRun);
      outboundSent = true;
    } else {
      persistedRun = {
        ...persistedRun,
        delivery: {
          ...persistedRun.delivery,
          reason: `scheduled-outbound-${delivery.reason ?? delivery.state}`
        }
      };
      await writeRun(options.projectRoot, persistedRun);
    }
  }

  const state: TNeonScheduledAgentExecutionState =
    persistedRun.status === "completed" ? "executed" : "failed";
  return {
    state,
    run: persistedRun,
    attempts,
    retryCount: Math.max(0, attempts - 1),
    outboundSent,
    diagnostics: [
      `Scheduled ${options.specification.source} run ${state} after ${attempts} attempt(s).`,
      outboundSent
        ? "Outbound delivered through the existing Canary sender policy."
        : "Outbound not delivered; no eligible gated delivery completed."
    ]
  };
}

function createScheduledGatewayMessage(
  projectRoot: string,
  specification: INeonScheduledAgentSpecification
): INeonGatewayInboundMessage {
  const target = specification.deliveryTarget;
  const channel = resolveGatewayChannel(target);
  return {
    channel,
    accountId: target?.accountId ?? specification.source,
    channelId: target?.to ?? `${specification.source}-daemon`,
    ...(target?.threadId ? { threadId: target.threadId } : {}),
    userId: "system",
    userDisplayName: "Neonika Scheduler",
    agentId: specification.agentId,
    workspaceRoot: projectRoot,
    mode: "read-only",
    goal: specification.goal,
    content: specification.content,
    createdAt: specification.receivedAt
  };
}

function resolveGatewayChannel(target: INeonChannelRouteRef | undefined): TNeonChannel {
  if (!target) {
    return "cli";
  }
  if (target.channel === "discord" || target.channel === "telegram" || target.channel === "whatsapp") {
    return target.channel;
  }
  return "cli";
}

function buildScheduledTerminalRun(params: {
  readonly specification: INeonScheduledAgentSpecification;
  readonly message: INeonGatewayInboundMessage;
  readonly status: "completed" | "failed";
  readonly failureMessage?: string;
  readonly completedAt: string;
}): INeonGatewayShadowRun {
  const finalText = "";
  const events: readonly TCodexHarnessEvent[] =
    params.status === "failed"
      ? [{ kind: "failed", message: params.failureMessage ?? "Scheduled agent execution failed." }]
      : [];
  return {
    runId: params.specification.runId,
    mode: "shadow",
    status: params.status,
    request: {
      channel: params.message.channel,
      accountId: params.message.accountId,
      channelId: params.message.channelId,
      ...(params.message.threadId ? { threadId: params.message.threadId } : {}),
      userId: params.message.userId,
      ...(params.message.userDisplayName
        ? { userDisplayName: params.message.userDisplayName }
        : {}),
      agentId: params.message.agentId,
      workspaceRoot: params.message.workspaceRoot,
      mode: params.message.mode,
      goal: createPreview(params.specification.goal),
      contentPreview: createPreview(params.specification.content),
      receivedAt: params.specification.receivedAt
    },
    harnessId: "codex-app-server",
    harnessSessionKey: `scheduled:${sanitizeIdPart(params.specification.sourceId)}:${sanitizeIdPart(params.specification.agentId)}`,
    memoryState: "skipped",
    events,
    finalText,
    delivery: {
      state: "suppressed",
      targetChannel: params.message.channel,
      targetChannelId: params.message.channelId,
      reason: "scheduled-agent-execution-blocked",
      finalText
    },
    startedAt: params.specification.receivedAt,
    completedAt: params.completedAt
  };
}

async function resolveScheduledMemory(
  runtime: INeonScheduledAgentRuntime,
  message: INeonGatewayInboundMessage
): Promise<IMemoryAttachment> {
  try {
    return await runtime.resolveMemory(message);
  } catch {
    return {
      state: "failed",
      hitCount: 0,
      note: "Scheduled memory resolution failed."
    };
  }
}

function withRetryEvents(
  run: INeonGatewayShadowRun,
  retryEvents: readonly TCodexHarnessEvent[]
): INeonGatewayShadowRun {
  return retryEvents.length > 0 ? { ...run, events: [...retryEvents, ...run.events] } : run;
}

function createRetryEvent(attempt: number, maxAttempts: number): TCodexHarnessEvent {
  return {
    kind: "tool-output",
    toolName: "scheduled-agent-retry",
    output: `Transient harness failure; retrying after attempt ${attempt}/${maxAttempts}.`,
    hideFromChannelProgress: true
  };
}

function isTransientRunFailure(run: INeonGatewayShadowRun): boolean {
  const failure = [...run.events].reverse().find((event) => event.kind === "failed");
  return failure?.kind === "failed" && isTransientMessage(failure.message);
}

function isTransientScheduledFailure(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const status = record["status"] ?? record["statusCode"];
    if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) {
      return true;
    }
    const code = record["code"];
    if (
      typeof code === "string" &&
      ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EPIPE", "ETIMEDOUT"].includes(code)
    ) {
      return true;
    }
  }
  return error instanceof Error && isTransientMessage(error.message);
}

function isTransientMessage(message: string): boolean {
  return /\b(?:408|429|5\d\d|connection reset|rate limit|service unavailable|temporar(?:y|ily)|timed?\s*out|timeout|overloaded)\b/iu.test(
    message
  );
}

function resolveMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value)) {
    return defaultMaxAttempts;
  }
  return Math.min(maximumMaxAttempts, Math.max(1, value));
}

function resolveRetryDelayMs(attempt: number): number {
  return Math.min(5_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function resolveDelay(runtime: INeonScheduledAgentRuntime): (delayMs: number) => Promise<void> {
  return runtime.delay ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
}

function resolveNow(runtime: INeonScheduledAgentRuntime): Date {
  return runtime.now?.() ?? new Date();
}

function createPreview(value: string): string {
  const redacted = redactText(value).replace(/\s+/g, " ").trim();
  return redacted.length <= previewMaxLength
    ? redacted
    : `${truncateUtf16Safe(redacted, previewMaxLength - 1)}…`;
}

function sanitizeIdPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return normalized.length > 0 ? normalized : "unknown";
}
