import { redactText } from "../harness/redaction.js";
import type { INeonTaskRecord, TNeonTaskStatus } from "./taskModel.js";

/**
 * Task terminal-delivery policy — the deterministic decision + leak-safe message
 * format for "a task reached a terminal state, should the operator be notified?".
 *
 * This is the shadow-safe substrate of upstream's task-executor delivery
 * (src/tasks/task-executor-policy.ts: shouldAutoDeliverTaskTerminalUpdate:110 +
 * formatTaskTerminalMessage:29). The actual send stays hard-suppressed under the
 * shadow contract (gateway/outboundSender.ts): this module only decides + formats,
 * never delivers. Wiring the formatted message into the suppressed outbound seam at
 * real delivery time is the cutover-gated extension, not part of this slice.
 */

/** Notification preference for a task. `default` notifies on terminal, `silent` never, `state_changes` also on non-terminal transitions (state-change delivery is a separate path, not modeled here). */
export type TNeonTaskNotifyPolicy = "default" | "silent" | "state_changes";

/** Whether a terminal update has already been delivered for this task. */
export type TNeonTaskDeliveryState = "pending" | "delivered";

export interface INeonTaskDeliveryInput {
  readonly task: INeonTaskRecord;
  readonly notifyPolicy?: TNeonTaskNotifyPolicy;
  readonly deliveryState?: TNeonTaskDeliveryState;
}

/** Why a terminal delivery was chosen or skipped. Closed set so callers branch exhaustively instead of on free strings. */
export type TNeonTaskDeliveryReason =
  | "terminal-update"
  | "silent-policy"
  | "not-terminal"
  | "already-delivered";

export interface INeonTaskDeliveryDecision {
  readonly deliver: boolean;
  readonly reason: TNeonTaskDeliveryReason;
}

/** Terminal statuses in Neon's task model. `blocked` is a notify-worthy state-change, not terminal; `backlog/ready/in-progress` are open. */
const NEON_TERMINAL_TASK_STATUSES: readonly TNeonTaskStatus[] = ["done", "cancelled"];

export function isNeonTerminalTaskStatus(status: TNeonTaskStatus): boolean {
  return NEON_TERMINAL_TASK_STATUSES.includes(status);
}

/**
 * Decide whether a task's terminal update should be auto-delivered. Pure: no I/O,
 * no send. Skips silent policy, non-terminal status, and already-delivered tasks.
 */
export function decideNeonTaskTerminalDelivery(
  input: INeonTaskDeliveryInput
): INeonTaskDeliveryDecision {
  const notifyPolicy = input.notifyPolicy ?? "default";
  const deliveryState = input.deliveryState ?? "pending";
  if (notifyPolicy === "silent") {
    return { deliver: false, reason: "silent-policy" };
  }
  if (!isNeonTerminalTaskStatus(input.task.status)) {
    return { deliver: false, reason: "not-terminal" };
  }
  if (deliveryState === "delivered") {
    return { deliver: false, reason: "already-delivered" };
  }
  return { deliver: true, reason: "terminal-update" };
}

function resolveNeonTaskRunLabel(task: INeonTaskRecord): string {
  const runId = task.runIds[0];
  return runId ? ` (run ${runId.slice(0, 8)})` : "";
}

/**
 * Format the leak-safe terminal-delivery message for a task. Title and summary are
 * run through redactText so no secret crosses the (suppressed) delivery boundary.
 */
export function formatNeonTaskTerminalMessage(task: INeonTaskRecord): string {
  const title = redactText(task.title.trim() || "Background task");
  const runLabel = resolveNeonTaskRunLabel(task);
  const trimmedSummary = task.summary?.trim();
  const summary = trimmedSummary ? ` ${redactText(trimmedSummary)}` : "";
  if (task.status === "done") {
    return `Background task done: ${title}${runLabel}.${summary}`;
  }
  if (task.status === "cancelled") {
    return `Background task cancelled: ${title}${runLabel}.`;
  }
  // Non-terminal statuses are not terminal deliveries; callers gate on
  // decideNeonTaskTerminalDelivery first. Kept total so the formatter never throws.
  return `Background task ${task.status}: ${title}${runLabel}.${summary}`;
}
