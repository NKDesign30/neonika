import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { INeonHarnessRuntimeMetadata } from "../harness/types.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type {
  INeonDiscordComponentActionContext,
  INeonDiscordComponentActionOutcome,
  INeonDiscordComponentActionRegistry
} from "./discordComponentActionRegistry.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import type { INeonGatewayShadowRun } from "./types.js";

export interface INeonDiscordRuntimeOption extends INeonHarnessRuntimeMetadata {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Curated Claude runtime presets for the /model picker. The Claude lane can
 * run any model/effort combination, so the picker offers a hand-picked palette
 * instead of a single env-pinned entry. Kept small on purpose: together with
 * the three Codex capacity tiers the catalog stays far below Discord's
 * 25-option select limit.
 * kiss: no pagination — the flat select carries the whole catalog. Upgrade
 * path: paginated selects once the catalog outgrows 25 entries.
 */
export const neonDiscordClaudeRuntimePresets: readonly INeonDiscordRuntimeOption[] = [
  {
    id: "claude-opus-high",
    label: "Claude · Opus · high",
    description: "Anthropic · Standard für normale Aufgaben",
    provider: "anthropic",
    runtime: "claude",
    lane: "claude-cli",
    model: "opus",
    effort: "high"
  },
  {
    id: "claude-opus-xhigh",
    label: "Claude · Opus · xhigh",
    description: "Anthropic · schwere Aufgaben, tiefes Denken",
    provider: "anthropic",
    runtime: "claude",
    lane: "claude-cli",
    model: "opus",
    effort: "xhigh"
  },
  {
    id: "claude-sonnet-medium",
    label: "Claude · Sonnet · medium",
    description: "Anthropic · schnelle Alltagsantworten",
    provider: "anthropic",
    runtime: "claude",
    lane: "claude-cli",
    model: "sonnet",
    effort: "medium"
  },
  {
    id: "claude-haiku-low",
    label: "Claude · Haiku · low",
    description: "Anthropic · Blitzantworten, minimale Kosten",
    provider: "anthropic",
    runtime: "claude",
    lane: "claude-cli",
    model: "haiku",
    effort: "low"
  }
];

export interface INeonDiscordSessionRuntimeSelection extends INeonHarnessRuntimeMetadata {
  readonly version: 1;
  readonly selectionId: string;
  readonly sessionKey: string;
  readonly ownerUserId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly status: "pending-confirmation" | "confirmed";
  readonly selectedAt: string;
  readonly confirmedAt?: string;
  readonly confirmedRunId?: string;
}

export interface INeonDiscordSessionRuntimePickerTransport {
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }>;
}

export interface ICreateNeonDiscordSessionRuntimePickerOptions {
  readonly projectRoot: string;
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly transport: INeonDiscordSessionRuntimePickerTransport;
  readonly catalog: readonly INeonDiscordRuntimeOption[];
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export interface INeonDiscordSessionRuntimePickerOpenInput {
  readonly target: INeonDeliveryQueueTarget;
  readonly ownerUserId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
}

export interface INeonDiscordSessionRuntimePicker {
  open(input: INeonDiscordSessionRuntimePickerOpenInput): Promise<{ readonly messageId: string }>;
  resolve(sessionKey: string, ownerUserId: string): INeonDiscordSessionRuntimeSelection | undefined;
  confirmRun(run: INeonGatewayShadowRun): Promise<boolean>;
  handleAction(context: INeonDiscordComponentActionContext): Promise<INeonDiscordComponentActionOutcome>;
  list(): readonly INeonDiscordSessionRuntimeSelection[];
}

const RUNTIME_PICKER_ACTION = "session-runtime:select";
const DEFAULT_PICKER_TTL_MS = 15 * 60 * 1_000;

export function isNeonDiscordSessionRuntimePickerCommand(content: string): boolean {
  return /^\/(?:model|modell|runtime)\s*$/iu.test(content.trim());
}

export function isNeonDiscordSessionRuntimeActionType(actionType: string): boolean {
  return actionType === RUNTIME_PICKER_ACTION;
}

export function resolveNeonDiscordSessionRuntimeStatePath(projectRoot: string): string {
  return join(projectRoot, "state", "gateway", "discord-session-runtimes.json");
}

export function createNeonDiscordSessionRuntimePicker(
  options: ICreateNeonDiscordSessionRuntimePickerOptions
): INeonDiscordSessionRuntimePicker {
  const now = options.now ?? (() => new Date());
  const ttlMs = normalizeTtl(options.ttlMs);
  const catalog = validateCatalog(options.catalog);
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const statePath = resolveNeonDiscordSessionRuntimeStatePath(options.projectRoot);
  const selections = loadSelections(statePath);
  let writeTail = Promise.resolve();
  const resolveSelection = (
    sessionKey: string,
    ownerUserId: string
  ): INeonDiscordSessionRuntimeSelection | undefined => {
    const selected = selections.get(createSelectionKey(sessionKey, ownerUserId));
    const catalogEntry = selected ? catalogById.get(selected.selectionId) : undefined;
    return selected && catalogEntry && sameRuntime(selected, catalogEntry) ? selected : undefined;
  };

  const persist = async (): Promise<void> => {
    const write = writeTail.then(async () => {
      await writeSelections(statePath, selections);
    });
    writeTail = write.catch(() => undefined);
    await write;
  };

  const handleAction = async (
    context: INeonDiscordComponentActionContext
  ): Promise<INeonDiscordComponentActionOutcome> => {
    const values = context.interaction.values;
    if (!values || values.length !== 1) {
      throw new Error("Discord runtime picker requires exactly one selection");
    }
    const selected = catalogById.get(values[0] ?? "");
    if (!selected) {
      throw new Error("Discord runtime picker selection is not in the server catalog");
    }
    const timestamp = now().toISOString();
    const record: INeonDiscordSessionRuntimeSelection = {
      version: 1,
      selectionId: selected.id,
      sessionKey: context.sessionKey,
      ownerUserId: context.interaction.userId,
      ...(context.interaction.guildId ? { guildId: context.interaction.guildId } : {}),
      channelId: context.interaction.channelId,
      provider: selected.provider,
      runtime: selected.runtime,
      lane: selected.lane,
      model: selected.model,
      effort: selected.effort,
      status: "pending-confirmation",
      selectedAt: timestamp
    };
    selections.set(createSelectionKey(record.sessionKey, record.ownerUserId), record);
    await persist();
    return {
      message: `${selected.label} gewählt. Der nächste echte Turn bestätigt Provider, Modell, Lane und Effort.`
    };
  };

  return {
    open: async (input) => {
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
      const action = options.registry.register({
        ownerUserId: input.ownerUserId,
        ...(input.guildId ? { guildId: input.guildId } : {}),
        channelId: input.channelId,
        sessionKey: input.sessionKey,
        actionType: RUNTIME_PICKER_ACTION,
        interactionKind: "string-select",
        expiresAt,
        handler: handleAction
      });
      const current = resolveSelection(input.sessionKey, input.ownerUserId);
      const rows: readonly TNeonDiscordActionRow[] = [
        {
          select: {
            customId: action.customId,
            placeholder: "Provider · Modell · Effort wählen",
            minValues: 1,
            maxValues: 1,
            options: catalog.map((entry) => ({
              label: entry.label,
              value: entry.id,
              description: entry.description,
              ...(current?.selectionId === entry.id ? { default: true } : {})
            }))
          }
        }
      ];
      const currentLabel = current
        ? `${current.provider} · ${current.model} · ${current.lane} · ${current.effort}`
        : "Session-Standard";
      return await options.transport.postComponents(
        input.target,
        `Runtime für diese Session wählen. Aktuell: ${currentLabel}.`,
        rows
      );
    },
    resolve: resolveSelection,
    confirmRun: async (run) => {
      const key = createSelectionKey(run.harnessSessionKey, run.request.userId);
      const selected = resolveSelection(run.harnessSessionKey, run.request.userId);
      if (!selected || !run.runtime || !sameRuntime(selected, run.runtime)) {
        return false;
      }
      const confirmed: INeonDiscordSessionRuntimeSelection = {
        ...selected,
        status: "confirmed",
        confirmedAt: run.completedAt,
        confirmedRunId: run.runId
      };
      selections.set(key, confirmed);
      await persist();
      return true;
    },
    handleAction,
    list: () => Array.from(selections.values())
      .filter((selection) => resolveSelection(selection.sessionKey, selection.ownerUserId) !== undefined)
      .sort((left, right) => left.selectedAt.localeCompare(right.selectedAt))
  };
}

function validateCatalog(catalog: readonly INeonDiscordRuntimeOption[]): readonly INeonDiscordRuntimeOption[] {
  if (catalog.length === 0 || catalog.length > 25) {
    throw new Error("Discord runtime picker catalog must contain 1 to 25 options");
  }
  const ids = new Set<string>();
  return catalog.map((entry) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(entry.id) || ids.has(entry.id)) {
      throw new Error("Discord runtime picker option id is invalid or duplicated");
    }
    ids.add(entry.id);
    if (entry.label.trim().length === 0 || entry.label.length > 100) {
      throw new Error("Discord runtime picker option label is invalid");
    }
    if (entry.description.trim().length === 0 || entry.description.length > 100) {
      throw new Error("Discord runtime picker option description is invalid");
    }
    if (!/^[A-Za-z0-9._:/+-]{1,100}$/u.test(entry.model)) {
      throw new Error("Discord runtime picker model is invalid");
    }
    if (!/^[A-Za-z0-9._-]{1,32}$/u.test(entry.effort)) {
      throw new Error("Discord runtime picker effort is invalid");
    }
    if (
      (entry.runtime === "codex" && (entry.provider !== "openai" || entry.lane !== "codex-app-server")) ||
      (entry.runtime === "claude" && (entry.provider !== "anthropic" || entry.lane !== "claude-cli"))
    ) {
      throw new Error("Discord runtime picker provider, runtime, and lane are incompatible");
    }
    return { ...entry };
  });
}

function loadSelections(statePath: string): Map<string, INeonDiscordSessionRuntimeSelection> {
  const records = new Map<string, INeonDiscordSessionRuntimeSelection>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return records;
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["selections"])) {
    return records;
  }
  for (const candidate of parsed["selections"]) {
    const record = parseSelection(candidate);
    if (record) {
      records.set(createSelectionKey(record.sessionKey, record.ownerUserId), record);
    }
  }
  return records;
}

async function writeSelections(
  statePath: string,
  selections: ReadonlyMap<string, INeonDiscordSessionRuntimeSelection>
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const state = {
    version: 1,
    selections: Array.from(selections.values()).sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
  };
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, statePath);
}

function parseSelection(value: unknown): INeonDiscordSessionRuntimeSelection | undefined {
  if (!isRecord(value) || value["version"] !== 1) {
    return undefined;
  }
  const selectionId = readString(value["selectionId"], 64);
  const sessionKey = readString(value["sessionKey"], 200);
  const ownerUserId = readString(value["ownerUserId"], 100);
  const guildId = readString(value["guildId"], 100);
  const channelId = readString(value["channelId"], 100);
  const model = readString(value["model"], 100);
  const effort = readString(value["effort"], 32);
  const selectedAt = readTimestamp(value["selectedAt"]);
  const confirmedAt = readTimestamp(value["confirmedAt"]);
  const confirmedRunId = readString(value["confirmedRunId"], 200);
  const provider = value["provider"] === "openai" || value["provider"] === "anthropic" ? value["provider"] : undefined;
  const runtime = value["runtime"] === "codex" || value["runtime"] === "claude" ? value["runtime"] : undefined;
  const lane = value["lane"] === "codex-app-server" || value["lane"] === "claude-cli" ? value["lane"] : undefined;
  const status = value["status"] === "pending-confirmation" || value["status"] === "confirmed" ? value["status"] : undefined;
  if (!selectionId || !sessionKey || !ownerUserId || !channelId || !model || !effort || !selectedAt || !provider || !runtime || !lane || !status) {
    return undefined;
  }
  if (
    status === "confirmed" && (!confirmedAt || !confirmedRunId) ||
    runtime === "codex" && (provider !== "openai" || lane !== "codex-app-server") ||
    runtime === "claude" && (provider !== "anthropic" || lane !== "claude-cli")
  ) {
    return undefined;
  }
  return {
    version: 1,
    selectionId,
    sessionKey,
    ownerUserId,
    ...(guildId ? { guildId } : {}),
    channelId,
    provider,
    runtime,
    lane,
    model,
    effort,
    status,
    selectedAt,
    ...(confirmedAt ? { confirmedAt } : {}),
    ...(confirmedRunId ? { confirmedRunId } : {})
  };
}

function sameRuntime(
  left: INeonHarnessRuntimeMetadata,
  right: INeonHarnessRuntimeMetadata
): boolean {
  return left.provider === right.provider &&
    left.runtime === right.runtime &&
    left.lane === right.lane &&
    left.model === right.model &&
    left.effort === right.effort;
}

function createSelectionKey(sessionKey: string, ownerUserId: string): string {
  return createHash("sha256").update(`${sessionKey}\0${ownerUserId}`).digest("hex");
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_PICKER_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 60 * 60 * 1_000) {
    throw new Error("Discord runtime picker ttlMs is invalid");
  }
  return Math.trunc(ttl);
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function readTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(Date.parse(value)).toISOString()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
