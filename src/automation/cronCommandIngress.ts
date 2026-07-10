import type { INeonGatewayInboundMessage } from "../gateway/types.js";
import { redactText } from "../harness/redaction.js";
import {
  appendNeonCronStoreEvent,
  projectNeonCronStoreJobs,
  readNeonCronStoreEvents,
  renderNeonCronDeliveryPreview,
  renderNeonCronStoreJobs,
  resolveNeonCronMutation,
  resolveNeonCronStoreGate,
  type INeonCronStoreEvent,
  type INeonCronStoreGate,
  type INeonCronStoreJob,
  type TNeonCronJobMutation,
  type TNeonCronStoreAppendState
} from "./cronStore.js";
import { parseNeonCronSchedule } from "./cronSchedule.js";

export type TNeonCronCommandState = "not-cron-command" | "rejected" | "listed" | "mutated" | "blocked";

export interface INeonCronCommandParseResult {
  readonly mutation: TNeonCronJobMutation | "list";
  readonly id?: string | undefined;
  readonly schedule?: string | undefined;
  readonly label?: string | undefined;
  readonly error?: string | undefined;
}

export interface INeonCronCommandResult {
  readonly state: TNeonCronCommandState;
  readonly command?: INeonCronCommandParseResult | undefined;
  readonly event?: INeonCronStoreEvent | undefined;
  readonly appendState?: TNeonCronStoreAppendState | undefined;
  readonly gate?: INeonCronStoreGate | undefined;
  readonly reason?: string | undefined;
  readonly jobs: readonly INeonCronStoreJob[];
  readonly report: string;
}

const cronCommandPattern = /^\/cron(?:\s+|$)/iu;
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,79}$/iu;

export function parseNeonCronCommand(content: string): INeonCronCommandParseResult | undefined {
  const trimmed = content.trim();
  if (!cronCommandPattern.test(trimmed)) {
    return undefined;
  }

  const body = trimmed.replace(/^\/cron\s*/iu, "").trim();
  if (body.length === 0 || body === "list") {
    return { mutation: "list" };
  }

  const [rawAction, rawId, rawSchedule, ...labelParts] = body.split(/\s+/);
  const action = normalizeCronAction(rawAction);
  const id = rawId?.trim();
  if (!action || !id || !idPattern.test(id)) {
    return { mutation: "list", error: "Usage: /cron add <id> <schedule> <label...>" };
  }

  if (action === "add") {
    const schedule = rawSchedule?.trim();
    const label = labelParts.join(" ").trim();
    if (!schedule || label.length === 0) {
      return { mutation: "add", id, error: "Usage: /cron add <id> <schedule> <label...>" };
    }
    return { mutation: "add", id, schedule, label };
  }

  return { mutation: action, id };
}

export async function processNeonCronCommand(
  projectRoot: string,
  message: INeonGatewayInboundMessage,
  options: {
    readonly gate?: INeonCronStoreGate;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly now?: () => Date;
  } = {}
): Promise<INeonCronCommandResult> {
  const command = parseNeonCronCommand(message.content);
  const before = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
  if (!command) {
    return {
      state: "not-cron-command",
      jobs: before,
      report: "Not a Neon cron command."
    };
  }

  if (command.error) {
    return createRejectedCronCommandResult(command, before, command.error);
  }

  if (command.mutation === "list") {
    return {
      state: "listed",
      command: redactCronCommand(command),
      jobs: before,
      report: renderCronCommandReport("Cron jobs", before)
    };
  }

  if (!command.id) {
    return createRejectedCronCommandResult(command, before, "Usage: /cron enable|disable|rm <id>");
  }

  if (command.mutation === "add") {
    const parsedSchedule = parseNeonCronSchedule(command.schedule ?? "");
    if (parsedSchedule.kind === "invalid") {
      return createRejectedCronCommandResult(command, before, parsedSchedule.reason);
    }
  }

  const resolved = resolveNeonCronMutation(before, {
    id: command.id,
    mutation: command.mutation,
    atMs: (options.now?.() ?? new Date()).getTime(),
    ...(command.schedule ? { schedule: command.schedule } : {}),
    ...(command.label ? { label: command.label } : {}),
    deliveryTarget: {
      channel: "discord",
      accountId: message.accountId,
      to: message.channelId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      chatType: message.guildId ? "channel" : "direct"
    }
  });
  if (!resolved.ok) {
    return createRejectedCronCommandResult(command, before, resolved.reason);
  }

  const gate = options.gate ?? resolveNeonCronStoreGate(options.env ?? process.env);
  const append = await appendNeonCronStoreEvent(projectRoot, gate, resolved.event);
  const after = projectNeonCronStoreJobs(await readNeonCronStoreEvents(projectRoot));
  if (append.state !== "appended") {
    return {
      state: "blocked",
      command: redactCronCommand(command),
      event: resolved.event,
      appendState: append.state,
      gate,
      jobs: after,
      report: [`Cron command blocked: ${gate.reason} (${gate.envKey})`, ...append.diagnostics].join("\n")
    };
  }

  return {
    state: "mutated",
    command: redactCronCommand(command),
    event: resolved.event,
    appendState: append.state,
    gate,
    jobs: after,
    report: renderCronCommandReport(
      `Cron ${command.mutation} ${command.id}: ${append.state}`,
      after
    )
  };
}

function normalizeCronAction(value: string | undefined): TNeonCronJobMutation | undefined {
  switch (value?.toLowerCase()) {
    case "add":
      return "add";
    case "enable":
      return "enable";
    case "disable":
      return "disable";
    case "rm":
    case "remove":
    case "delete":
      return "remove";
    default:
      return undefined;
  }
}

function createRejectedCronCommandResult(
  command: INeonCronCommandParseResult,
  jobs: readonly INeonCronStoreJob[],
  reason: string
): INeonCronCommandResult {
  return {
    state: "rejected",
    command: redactCronCommand(command),
    reason: redactText(reason),
    jobs,
    report: `Cron command rejected: ${redactText(reason)}`
  };
}

function redactCronCommand(command: INeonCronCommandParseResult): INeonCronCommandParseResult {
  return {
    mutation: command.mutation,
    ...(command.id ? { id: command.id } : {}),
    ...(command.schedule ? { schedule: command.schedule } : {}),
    ...(command.label ? { label: redactText(command.label) } : {}),
    ...(command.error ? { error: redactText(command.error) } : {})
  };
}

function renderCronCommandReport(title: string, jobs: readonly INeonCronStoreJob[]): string {
  return [title, "", renderNeonCronStoreJobs(jobs), "", renderNeonCronDeliveryPreview(jobs)].join("\n");
}
