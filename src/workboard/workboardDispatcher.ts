import { redactText } from "../harness/redaction.js";
import type { ICodexHarness, THarnessRunMode, TNeonChannel } from "../harness/types.js";
import { runNeonGatewayShadow } from "../gateway/shadowGateway.js";
import { writeNeonGatewayRun } from "../gateway/runStore.js";
import type { INeonGatewayInboundMessage, INeonGatewayShadowRun } from "../gateway/types.js";
import type {
  INeonWorkboardCard,
  TNeonWorkboardProofStatus
} from "./workboardModel.js";
import {
  blockNeonWorkboardCard,
  claimNeonWorkboardCard,
  completeNeonWorkboardCard,
  dispatchNeonWorkboard,
  readNeonWorkboardCards
} from "./workboardStore.js";
import { syncNeonWorkboardCardTask } from "./workboardTaskSync.js";

const DEFAULT_OWNER_ID = "workboard-autopilot";
const DEFAULT_TTL_SECONDS = 30 * 60;
const DEFAULT_MAX_CARDS = 1;
const DEFAULT_MAX_RECORDS = 2000;
const neonChannels: readonly TNeonChannel[] = ["discord", "telegram", "whatsapp", "webchat", "cli", "device"];

export type TNeonWorkboardAutoDispatchState = "empty" | "processed";
export type TNeonWorkboardAutoDispatchItemState = "completed" | "blocked" | "claim-skipped";
export type TNeonWorkboardAutoDispatchExecutorState = "completed" | "blocked";

export interface INeonWorkboardAutoDispatchProofInput {
  readonly status: TNeonWorkboardProofStatus;
  readonly label?: string | undefined;
  readonly command?: string | undefined;
  readonly url?: string | undefined;
  readonly note?: string | undefined;
}

export interface INeonWorkboardAutoDispatchExecutorInput {
  readonly projectRoot: string;
  readonly card: INeonWorkboardCard;
  readonly token: string;
  readonly now: () => Date;
}

export interface INeonWorkboardAutoDispatchExecutorResult {
  readonly state: TNeonWorkboardAutoDispatchExecutorState;
  readonly summary: string;
  readonly proof?: INeonWorkboardAutoDispatchProofInput | undefined;
  readonly runId?: string | undefined;
}

export type TNeonWorkboardAutoDispatchExecutor = (
  input: INeonWorkboardAutoDispatchExecutorInput
) => Promise<INeonWorkboardAutoDispatchExecutorResult>;

export interface INeonWorkboardAutoDispatchOptions {
  readonly executor: TNeonWorkboardAutoDispatchExecutor;
  readonly ownerId?: string | undefined;
  readonly ttlSeconds?: number | undefined;
  readonly maxCards?: number | undefined;
  readonly maxRecords?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface INeonWorkboardAutoDispatchItemResult {
  readonly cardId: string;
  readonly title: string;
  readonly state: TNeonWorkboardAutoDispatchItemState;
  readonly summary?: string | undefined;
  readonly reason?: string | undefined;
  readonly runId?: string | undefined;
}

export interface INeonWorkboardAutoDispatchBatchResult {
  readonly state: TNeonWorkboardAutoDispatchState;
  readonly ownerId: string;
  readonly checked: number;
  readonly processed: number;
  readonly completed: number;
  readonly blocked: number;
  readonly skipped: number;
  readonly items: readonly INeonWorkboardAutoDispatchItemResult[];
}

export interface INeonGatewayWorkboardExecutorOptions {
  readonly harness: ICodexHarness;
  readonly mode?: THarnessRunMode | undefined;
  readonly now?: (() => Date) | undefined;
  readonly writeRun?: ((projectRoot: string, run: INeonGatewayShadowRun) => Promise<void>) | undefined;
}

export async function runNeonWorkboardAutoDispatchOnce(
  projectRoot: string,
  options: INeonWorkboardAutoDispatchOptions
): Promise<INeonWorkboardAutoDispatchBatchResult> {
  const now = options.now ?? (() => new Date());
  const ownerId = normalizeOptionalTrimmed(options.ownerId) ?? DEFAULT_OWNER_ID;
  const ttlSeconds = normalizePositiveInteger(options.ttlSeconds, DEFAULT_TTL_SECONDS);
  const maxCards = normalizePositiveInteger(options.maxCards, DEFAULT_MAX_CARDS);
  const maxRecords = normalizePositiveInteger(options.maxRecords, DEFAULT_MAX_RECORDS);

  await dispatchNeonWorkboard(projectRoot, now().getTime());

  const cards = await readNeonWorkboardCards(projectRoot, { maxRecords });
  const readyCards = cards.filter((card) => card.status === "ready").slice(0, maxCards);
  const items: INeonWorkboardAutoDispatchItemResult[] = [];

  for (const readyCard of readyCards) {
    const claimed = await claimReadyCard(projectRoot, readyCard, ownerId, ttlSeconds, now);

    if (!claimed) {
      items.push({
        cardId: readyCard.id,
        title: readyCard.title,
        state: "claim-skipped",
        reason: "Card could not be claimed."
      });
      continue;
    }

    try {
      const executorResult = await options.executor({
        projectRoot,
        card: claimed.card,
        token: claimed.token,
        now
      });

      if (executorResult.state === "completed") {
        await completeNeonWorkboardCard(
          projectRoot,
          {
            id: claimed.card.id,
            token: claimed.token,
            summary: executorResult.summary,
            ...(executorResult.proof ? { proof: executorResult.proof } : {})
          },
          now().getTime()
        );
        await syncNeonWorkboardCardTask(projectRoot, {
          card: claimed.card,
          status: "done",
          summary: executorResult.summary,
          ...(executorResult.runId ? { runId: executorResult.runId } : {}),
          nowMs: now().getTime()
        });

        items.push({
          cardId: claimed.card.id,
          title: claimed.card.title,
          state: "completed",
          summary: redactText(executorResult.summary),
          ...(executorResult.runId ? { runId: executorResult.runId } : {})
        });
        continue;
      }

      await blockNeonWorkboardCard(
        projectRoot,
        {
          id: claimed.card.id,
          token: claimed.token,
          reason: executorResult.summary
        },
        now().getTime()
      );
      await syncNeonWorkboardCardTask(projectRoot, {
        card: claimed.card,
        status: "blocked",
        summary: executorResult.summary,
        ...(executorResult.runId ? { runId: executorResult.runId } : {}),
        nowMs: now().getTime()
      });

      items.push({
        cardId: claimed.card.id,
        title: claimed.card.title,
        state: "blocked",
        reason: redactText(executorResult.summary),
        ...(executorResult.runId ? { runId: executorResult.runId } : {})
      });
    } catch (error) {
      const reason = `Executor failed: ${redactText(errorToMessage(error))}`;
      await blockNeonWorkboardCard(
        projectRoot,
        {
          id: claimed.card.id,
          token: claimed.token,
          reason
        },
        now().getTime()
      );
      await syncNeonWorkboardCardTask(projectRoot, {
        card: claimed.card,
        status: "blocked",
        summary: reason,
        nowMs: now().getTime()
      });

      items.push({
        cardId: claimed.card.id,
        title: claimed.card.title,
        state: "blocked",
        reason
      });
    }
  }

  return createDispatchResult(ownerId, readyCards.length, items);
}

export function createNeonDryRunWorkboardExecutor(): TNeonWorkboardAutoDispatchExecutor {
  return async (input) => ({
    state: "completed",
    summary: `Dry-run processed Workboard card ${input.card.id}: ${input.card.title}`,
    proof: {
      status: "passed",
      label: "workboard-autopilot-dry-run",
      command: "workboard-autopilot-dry-run",
      note: "No external side effect."
    }
  });
}

export function createNeonGatewayShadowWorkboardExecutor(
  options: INeonGatewayWorkboardExecutorOptions
): TNeonWorkboardAutoDispatchExecutor {
  return async (input) => {
    const result = await runNeonGatewayShadow(
      {
        message: createGatewayMessage(input.projectRoot, input.card, options.mode ?? "write"),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Workboard autopilot"
        }
      },
      {
        harness: options.harness,
        ...(options.now ? { now: options.now } : {})
      }
    );
    const writeRun = options.writeRun ?? writeNeonGatewayRun;

    await writeRun(input.projectRoot, result.run);

    if (result.run.status === "completed") {
      return {
        state: "completed",
        summary: result.run.finalText || `Gateway run ${result.run.runId} completed.`,
        runId: result.run.runId,
        proof: {
          status: "passed",
          label: "gateway-shadow-run",
          command: `harness:${result.run.harnessId}`,
          note: `run=${result.run.runId}`
        }
      };
    }

    return {
      state: "blocked",
      summary: result.run.finalText || `Gateway run ${result.run.runId} ended ${result.run.status}.`,
      runId: result.run.runId,
      proof: {
        status: "failed",
        label: "gateway-shadow-run",
        command: `harness:${result.run.harnessId}`,
        note: `run=${result.run.runId}`
      }
    };
  };
}

export function renderNeonWorkboardAutoDispatchReport(
  result: INeonWorkboardAutoDispatchBatchResult
): string {
  const lines = [
    `Neonika Workboard autopilot: ${result.state}`,
    `Owner: ${result.ownerId}`,
    `Ready checked: ${result.checked}`,
    `Processed: ${result.processed} (done ${result.completed} / blocked ${result.blocked} / skipped ${result.skipped})`
  ];

  for (const item of result.items) {
    const detail = item.summary ?? item.reason ?? "no detail";
    lines.push(
      `- ${item.state}: ${item.title} (${item.cardId})${item.runId ? ` run=${item.runId}` : ""} ${detail}`
    );
  }

  return lines.join("\n");
}

async function claimReadyCard(
  projectRoot: string,
  card: INeonWorkboardCard,
  ownerId: string,
  ttlSeconds: number,
  now: () => Date
): Promise<{ readonly card: INeonWorkboardCard; readonly token: string } | undefined> {
  try {
    return await claimNeonWorkboardCard(
      projectRoot,
      {
        id: card.id,
        ownerId,
        ttlSeconds
      },
      now().getTime()
    );
  } catch (error) {
    if (errorToMessage(error).includes("already claimed")) {
      return undefined;
    }

    throw error;
  }
}

function createDispatchResult(
  ownerId: string,
  checked: number,
  items: readonly INeonWorkboardAutoDispatchItemResult[]
): INeonWorkboardAutoDispatchBatchResult {
  const completed = items.filter((item) => item.state === "completed").length;
  const blocked = items.filter((item) => item.state === "blocked").length;
  const skipped = items.filter((item) => item.state === "claim-skipped").length;
  const processed = completed + blocked;

  return {
    state: processed > 0 ? "processed" : "empty",
    ownerId,
    checked,
    processed,
    completed,
    blocked,
    skipped,
    items
  };
}

function createGatewayMessage(
  projectRoot: string,
  card: INeonWorkboardCard,
  mode: THarnessRunMode
): INeonGatewayInboundMessage {
  const source = card.metadata?.source;

  return {
    channel: resolveGatewayChannel(card),
    accountId: source?.accountId ?? "workboard",
    ...(source?.guildId ? { guildId: source.guildId } : {}),
    channelId: source?.channelId ?? "workboard",
    ...(source?.threadId ? { threadId: source.threadId } : {}),
    messageId: source?.messageId ? `workboard:${card.id}:${source.messageId}` : `workboard:${card.id}`,
    userId: source?.userId ?? "workboard-autopilot",
    ...(source?.userDisplayName ? { userDisplayName: source.userDisplayName } : {}),
    agentId: card.agentId ?? "chaty",
    workspaceRoot: projectRoot,
    mode,
    goal: card.title,
    content: renderWorkboardGatewayContent(card),
    createdAt: source?.createdAt ?? new Date(card.createdAt).toISOString()
  };
}

function renderWorkboardGatewayContent(card: INeonWorkboardCard): string {
  const labels = card.labels.length > 0 ? card.labels.join(", ") : "none";
  const source = card.metadata?.source;
  const sourceLine = source?.kind
    ? `${source.kind}${source.messageId ? ` message=${source.messageId}` : ""}`
    : "operator";

  return [
    "Process this Neonika Workboard card.",
    "Do the work in the configured workspace and return concise completion proof.",
    `Card ID: ${card.id}`,
    `Title: ${card.title}`,
    `Priority: ${card.priority}`,
    `Labels: ${labels}`,
    `Source: ${sourceLine}`,
    "",
    "Notes:",
    card.notes ?? "(none)"
  ].join("\n");
}

function resolveGatewayChannel(card: INeonWorkboardCard): TNeonChannel {
  const source = card.metadata?.source;

  if (source?.kind === "discord-message") {
    return "discord";
  }

  if (source?.channel && (neonChannels as readonly string[]).includes(source.channel)) {
    return source.channel as TNeonChannel;
  }

  return "cli";
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeOptionalTrimmed(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  return normalized ? normalized : undefined;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
