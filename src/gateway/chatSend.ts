/**
 * Dashboard chat send pipeline (parity row "Dashboard Chat Send").
 *
 * The Mission Control chat composer needs a real send path, but the runtime is
 * in shadow: nothing may actually be delivered. This module is that path,
 * shadow-safe by construction. An operator-composed message is injected as a
 * gateway inbound message, processed through the existing shadow gateway
 * (`runNeonGatewayShadow`, delivery hard-suppressed), persisted as a run, and a
 * dry-run delivery candidate is enqueued from it. The candidate carries
 * `outboundSent: false` and stays `queued-dry-run`; promoting it to an actual
 * canary send is the SEPARATE, gated `/api/neon-delivery/approval` path
 * (operator approval + canary gates), never this entry point.
 *
 * No new send capability is introduced: this composes existing shadow + queue
 * primitives. The HTTP route in front of it is mutation-authed (token or
 * loopback-compat).
 *
 * Channel scope: queue-visible dry-run targets are deliberately narrow:
 * `discord` and `webchat`. Discord can later be promoted through the existing
 * gated canary path; webchat is queue-visible for Mission-Control-only dry-run
 * continuity and has no live outbound transport here. Other channels still
 * produce shadow runs, but their candidates are intentionally not queue-visible
 * until their delivery contracts exist.
 */

import type { ICodexHarness, IMemoryAttachment, THarnessRunMode, TNeonChannel } from "../harness/types.js";
import {
  enqueueNeonDeliveryDryRunCandidate,
  isNeonDeliveryQueueVisibleChannel,
  type TNeonDeliveryQueueState
} from "./deliveryQueue.js";
import { writeNeonGatewayRun } from "./runStore.js";
import { runNeonGatewayShadow } from "./shadowGateway.js";

const CHAT_SEND_TEXT_MAX_LENGTH = 4000;

export class NeonChatSendValidationError extends Error {
  constructor(
    message: string,
    readonly field: "channelId" | "text" | "agentId"
  ) {
    super(message);
    this.name = "NeonChatSendValidationError";
  }
}

export interface INeonChatSendInput {
  /**
   * Target channel. Defaults to `discord` because that is the only live outbound
   * transport. `webchat` is allowed as a queue-visible dry-run target; all other
   * channels remain shadow-run-only until their delivery contracts exist.
   */
  readonly channel?: TNeonChannel;
  readonly accountId?: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly agentId?: string;
  readonly userId?: string;
  readonly userDisplayName?: string;
  readonly text: string;
  readonly mode?: THarnessRunMode;
  readonly workspaceRoot?: string;
}

export interface INeonChatSendResult {
  readonly state: "queued-dry-run" | "blocked";
  readonly runId: string;
  readonly candidateId: string;
  readonly outboundSent: false;
  readonly deliveryState: "suppressed";
  readonly candidateState: TNeonDeliveryQueueState;
  readonly channel: TNeonChannel;
  readonly channelId: string;
  readonly agentId: string;
  readonly finalTextPreview: string;
  /**
   * Whether the enqueued candidate is readable back from the delivery queue. The
   * queue parser only accepts deliberate dry-run delivery targets. Honest
   * signal, not a silent drop.
   */
  readonly candidateVisibleInQueue: boolean;
}

export interface INeonChatSendOptions {
  readonly harness: ICodexHarness;
  readonly memory?: IMemoryAttachment;
  readonly now?: () => Date;
}

function requireNonEmpty(
  value: string | undefined,
  field: "channelId" | "text" | "agentId"
): string {
  const trimmed = (value ?? "").trim();
  if (trimmed.length === 0) {
    throw new NeonChatSendValidationError(`chat send requires a non-empty ${field}`, field);
  }
  return trimmed;
}

/**
 * Submits an operator-composed chat message through the shadow gateway and
 * enqueues a dry-run delivery candidate. Never sends; the candidate defaults to
 * `queued-dry-run` with `outboundSent: false`.
 */
export async function submitNeonChatSend(
  projectRoot: string,
  input: INeonChatSendInput,
  options: INeonChatSendOptions
): Promise<INeonChatSendResult> {
  const channelId = requireNonEmpty(input.channelId, "channelId");
  const text = requireNonEmpty(input.text, "text");
  if (text.length > CHAT_SEND_TEXT_MAX_LENGTH) {
    throw new NeonChatSendValidationError(
      `chat send text exceeds ${CHAT_SEND_TEXT_MAX_LENGTH} characters`,
      "text"
    );
  }

  const channel: TNeonChannel = input.channel ?? "discord";
  const agentId = (input.agentId ?? "chaty").trim() || "chaty";
  const memory: IMemoryAttachment =
    options.memory ?? { state: "skipped", hitCount: 0, note: "dashboard chat send" };

  const result = await runNeonGatewayShadow(
    {
      message: {
        channel,
        accountId: input.accountId?.trim() || "dashboard",
        channelId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        userId: input.userId?.trim() || "operator",
        ...(input.userDisplayName ? { userDisplayName: input.userDisplayName } : {}),
        agentId,
        workspaceRoot: input.workspaceRoot?.trim() || projectRoot,
        mode: input.mode ?? "read-only",
        content: text,
        ...(options.now ? { createdAt: options.now().toISOString() } : {})
      },
      memory
    },
    {
      harness: options.harness,
      ...(options.now ? { now: options.now } : {})
    }
  );

  await writeNeonGatewayRun(projectRoot, result.run);

  const candidate = await enqueueNeonDeliveryDryRunCandidate(
    projectRoot,
    result.run,
    options.now ? { now: options.now } : {}
  );

  return {
    state: candidate.state === "blocked" ? "blocked" : "queued-dry-run",
    runId: result.run.runId,
    candidateId: candidate.id,
    outboundSent: false,
    deliveryState: "suppressed",
    candidateState: candidate.state,
    channel,
    channelId,
    agentId,
    finalTextPreview: candidate.finalTextPreview,
    candidateVisibleInQueue: isNeonDeliveryQueueVisibleChannel(channel)
  };
}

export function renderNeonChatSendReport(result: INeonChatSendResult): string {
  return [
    "Neon Chat Send (dry-run)",
    `State: ${result.state}`,
    `Run: ${result.runId}`,
    `Candidate: ${result.candidateId} (${result.candidateState})`,
    `Channel: ${result.channel}/${result.channelId} agent=${result.agentId}`,
    `Outbound sent: ${result.outboundSent}`,
    `Delivery: ${result.deliveryState}`,
    `Queue-visible: ${result.candidateVisibleInQueue}`,
    `Preview: ${result.finalTextPreview}`
  ].join("\n");
}
