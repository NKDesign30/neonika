import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import { truncateUtf16Safe } from "../text/utf16Safe.js";
import {
  buildNeonDiscordComponentCustomId,
  isNeonDiscordCustomIdWithinLimit,
  parseNeonDiscordComponentCustomId
} from "./discordComponentCustomId.js";

export type TNeonDiscordComponentInteractionKind = "button" | "string-select" | "modal-submit";

export interface INeonDiscordComponentInteraction {
  readonly interactionId: string;
  readonly kind: TNeonDiscordComponentInteractionKind;
  readonly customId: string;
  readonly userId: string;
  readonly userDisplayName?: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly messageId?: string;
  readonly values?: readonly string[];
  readonly fields?: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface INeonDiscordComponentInteractionEvent {
  readonly interaction: INeonDiscordComponentInteraction;
  deferEphemeral(): Promise<void>;
  editEphemeral(message: string): Promise<void>;
  postPublic?(message: string): Promise<void>;
  showModal?(modal: INeonDiscordModal): Promise<void>;
}

export interface INeonDiscordModalTextInput {
  readonly customId: string;
  readonly label: string;
  readonly style: "short" | "paragraph";
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface INeonDiscordModal {
  readonly customId: string;
  readonly title: string;
  readonly inputs: readonly INeonDiscordModalTextInput[];
}

export interface INeonDiscordComponentActionContext {
  readonly actionId: string;
  readonly actionType: string;
  readonly sessionKey: string;
  readonly resourceRef?: string;
  readonly interaction: INeonDiscordComponentInteraction;
}

export interface INeonDiscordComponentActionOutcome {
  readonly message: string;
  readonly publicMessage?: string;
  readonly modal?: INeonDiscordModal;
}

export type TNeonDiscordComponentResponseMode = "deferred-ephemeral" | "modal";
export type TNeonDiscordComponentActionAudience = "owner" | "channel";

export type TNeonDiscordComponentActionHandler = (
  context: INeonDiscordComponentActionContext
) => INeonDiscordComponentActionOutcome | Promise<INeonDiscordComponentActionOutcome>;

export interface INeonDiscordComponentActionRegistration {
  readonly ownerUserId: string;
  readonly audience?: TNeonDiscordComponentActionAudience;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly actionType: string;
  readonly interactionKind: TNeonDiscordComponentInteractionKind;
  readonly responseMode?: TNeonDiscordComponentResponseMode;
  readonly consumptionKey?: string;
  readonly resourceRef?: string;
  readonly expiresAt: string;
  readonly handler: TNeonDiscordComponentActionHandler;
}

export interface INeonDiscordRegisteredComponentAction {
  readonly actionId: string;
  readonly customId: string;
  readonly expiresAt: string;
}

export type TNeonDiscordComponentActionRejectReason =
  | "invalid-custom-id"
  | "unknown-action"
  | "owner-mismatch"
  | "scope-mismatch"
  | "interaction-kind-mismatch"
  | "handler-unavailable"
  | "expired"
  | "already-consumed";

export type TNeonDiscordComponentActionDispatchResult =
  | {
      readonly state: "completed";
      readonly actionId: string;
      readonly actionType: string;
      readonly sessionKey: string;
      readonly consumedAt: string;
      readonly message: string;
      readonly publicMessage?: string;
      readonly modal?: INeonDiscordModal;
    }
  | {
      readonly state: "rejected";
      readonly reason: TNeonDiscordComponentActionRejectReason;
      readonly message: string;
    }
  | {
      readonly state: "failed";
      readonly actionId: string;
      readonly actionType: string;
      readonly sessionKey: string;
      readonly consumedAt: string;
      readonly message: string;
    };

export interface INeonDiscordComponentActionRegistry {
  register(registration: INeonDiscordComponentActionRegistration): INeonDiscordRegisteredComponentAction;
  cleanupExpired(): number;
  resolveResponseMode(customId: string): TNeonDiscordComponentResponseMode;
  dispatch(
    interaction: INeonDiscordComponentInteraction
  ): Promise<TNeonDiscordComponentActionDispatchResult>;
}

export interface INeonDiscordComponentActionRegistryOptions {
  readonly now?: () => Date;
  readonly createActionId?: () => string;
  readonly maxEntries?: number;
  readonly maxLifetimeMs?: number;
  readonly statePath?: string;
  readonly resolveHandler?: (
    actionType: string
  ) => TNeonDiscordComponentActionHandler | undefined;
  readonly onHandlerError?: (error: Error, context: INeonDiscordComponentActionContext) => void;
  readonly onStateError?: (error: Error) => void;
}

interface IMutableDiscordComponentActionRecord {
  readonly actionId: string;
  readonly ownerUserId: string;
  readonly audience: TNeonDiscordComponentActionAudience;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly actionType: string;
  readonly interactionKind: TNeonDiscordComponentInteractionKind;
  readonly responseMode: TNeonDiscordComponentResponseMode;
  readonly consumptionKey?: string;
  readonly resourceRef?: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly handler?: TNeonDiscordComponentActionHandler;
  consumedAt?: string;
}

interface IDiscordComponentConsumptionRecord {
  readonly consumedAt: string;
  readonly expiresAtMs: number;
}

const componentActionPrefix = "action:";
const defaultMaxEntries = 1_000;
const defaultMaxLifetimeMs = 24 * 60 * 60 * 1_000;
const maxActionIdLength = 64;
const maxActionMessageLength = 1_800;
const componentActionStateVersion = 1;

interface IPersistedComponentActionState {
  readonly version: typeof componentActionStateVersion;
  readonly actions: readonly IPersistedComponentActionRecord[];
  readonly consumptions: readonly IPersistedComponentConsumptionRecord[];
}

interface IPersistedComponentActionRecord {
  readonly actionId: string;
  readonly ownerUserId: string;
  readonly audience?: TNeonDiscordComponentActionAudience;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly actionType: string;
  readonly interactionKind: TNeonDiscordComponentInteractionKind;
  readonly responseMode?: TNeonDiscordComponentResponseMode;
  readonly consumptionKey?: string;
  readonly resourceRef?: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
}

interface IPersistedComponentConsumptionRecord {
  readonly consumptionKey: string;
  readonly consumedAt: string;
  readonly expiresAt: string;
}

export function resolveNeonDiscordComponentActionStatePath(projectRoot: string): string {
  return join(projectRoot, "state", "gateway", "discord-component-actions.json");
}

export function createNeonDiscordComponentActionRegistry(
  options: INeonDiscordComponentActionRegistryOptions = {}
): INeonDiscordComponentActionRegistry {
  const now = options.now ?? (() => new Date());
  const createActionId = options.createActionId ?? createOpaqueActionId;
  const maxEntries = normalizePositiveInteger(options.maxEntries, defaultMaxEntries, "maxEntries");
  const maxLifetimeMs = normalizePositiveInteger(
    options.maxLifetimeMs,
    defaultMaxLifetimeMs,
    "maxLifetimeMs"
  );
  const loaded = loadComponentActionState(options, now().getTime(), maxLifetimeMs, maxEntries);
  const records = loaded.records;
  const consumedGroups = loaded.consumedGroups;

  const persist = (): boolean => {
    if (!options.statePath) {
      return true;
    }
    try {
      writeComponentActionState(options.statePath, records, consumedGroups);
      return true;
    } catch (error) {
      options.onStateError?.(normalizeError(error, "Discord component action state write failed"));
      return false;
    }
  };
  if (options.statePath) {
    persist();
  }

  return {
    register: (registration) => {
      const nowMs = now().getTime();
      if (removeExpiredRecords(records, consumedGroups, nowMs) > 0 && !persist()) {
        throw new Error("Discord component action state cleanup failed");
      }
      if (records.size >= maxEntries) {
        throw new Error(`Discord component action registry is full (${maxEntries} entries)`);
      }

      const ownerUserId = requireNonEmpty(registration.ownerUserId, "ownerUserId");
      const audience = normalizeAudience(registration.audience);
      const channelId = requireNonEmpty(registration.channelId, "channelId");
      const sessionKey = requireNonEmpty(registration.sessionKey, "sessionKey");
      const actionType = requireNonEmpty(registration.actionType, "actionType");
      const guildId = normalizeOptionalNonEmpty(registration.guildId, "guildId");
      const consumptionKey = normalizeOptionalNonEmpty(registration.consumptionKey, "consumptionKey");
      const resourceRef = normalizeOptionalNonEmpty(registration.resourceRef, "resourceRef");
      const responseMode = registration.responseMode ?? "deferred-ephemeral";
      if (options.statePath && resourceRef && !/^[A-Za-z0-9._:-]{1,400}$/u.test(resourceRef)) {
        throw new Error("Persistent Discord component action resourceRef must be opaque");
      }
      const expiresAtMs = Date.parse(registration.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
        throw new Error("Discord component action expiresAt must be a future ISO timestamp");
      }
      if (expiresAtMs - nowMs > maxLifetimeMs) {
        throw new Error(`Discord component action lifetime exceeds ${maxLifetimeMs}ms`);
      }
      const scopedConsumptionKey = consumptionKey
        ? buildScopedConsumptionKey({
            ownerUserId,
            ...(guildId ? { guildId } : {}),
            channelId,
            sessionKey,
            consumptionKey
          })
        : undefined;
      if (
        scopedConsumptionKey &&
        Array.from(records.values()).some(
          (record) =>
            record.consumptionKey === scopedConsumptionKey && record.expiresAtMs !== expiresAtMs
        )
      ) {
        throw new Error("Discord component actions in one consumption group must share expiresAt");
      }

      const actionId = normalizeActionId(createActionId());
      if (records.has(actionId)) {
        throw new Error("Discord component action id already exists");
      }
      const customId = buildNeonDiscordComponentCustomId({
        componentId: `${componentActionPrefix}${actionId}`
      });
      if (!isNeonDiscordCustomIdWithinLimit(customId)) {
        throw new Error("Discord component action custom id exceeds Discord's limit");
      }

      const expiresAt = new Date(expiresAtMs).toISOString();
      records.set(actionId, {
        actionId,
        ownerUserId,
        audience,
        ...(guildId ? { guildId } : {}),
        channelId,
        sessionKey,
        actionType,
        interactionKind: registration.interactionKind,
        responseMode,
        ...(scopedConsumptionKey ? { consumptionKey: scopedConsumptionKey } : {}),
        ...(resourceRef ? { resourceRef } : {}),
        expiresAt,
        expiresAtMs,
        handler: registration.handler
      });

      if (!persist()) {
        records.delete(actionId);
        throw new Error("Discord component action state write failed");
      }

      return { actionId, customId, expiresAt };
    },
    cleanupExpired: () => {
      const removed = removeExpiredRecords(records, consumedGroups, now().getTime());
      if (removed > 0 && !persist()) {
        throw new Error("Discord component action state cleanup failed");
      }
      return removed;
    },
    resolveResponseMode: (customId) => {
      const parsed = parseNeonDiscordComponentCustomId(customId);
      if (!parsed?.componentId.startsWith(componentActionPrefix)) {
        return "deferred-ephemeral";
      }
      return records.get(parsed.componentId.slice(componentActionPrefix.length))?.responseMode ?? "deferred-ephemeral";
    },
    dispatch: async (interaction) => {
      const parsed = parseNeonDiscordComponentCustomId(interaction.customId);
      if (!parsed?.componentId.startsWith(componentActionPrefix)) {
        return rejected("invalid-custom-id");
      }

      const actionId = parsed.componentId.slice(componentActionPrefix.length);
      const record = records.get(actionId);
      if (!record) {
        return rejected("unknown-action");
      }
      if (
        interaction.channelId !== record.channelId ||
        (record.guildId !== undefined && interaction.guildId !== record.guildId)
      ) {
        return rejected("scope-mismatch");
      }
      if (record.audience === "owner" && interaction.userId !== record.ownerUserId) {
        return rejected("owner-mismatch");
      }
      if (interaction.kind !== record.interactionKind) {
        return rejected("interaction-kind-mismatch");
      }

      if (!record.handler) {
        return rejected("handler-unavailable");
      }

      const dispatchNow = now();
      if (record.expiresAtMs <= dispatchNow.getTime()) {
        return rejected("expired");
      }
      if (
        record.consumedAt !== undefined ||
        (record.consumptionKey !== undefined && consumedGroups.has(record.consumptionKey))
      ) {
        return rejected("already-consumed");
      }

      const consumedAt = dispatchNow.toISOString();
      record.consumedAt = consumedAt;
      if (record.consumptionKey !== undefined) {
        consumedGroups.set(record.consumptionKey, {
          consumedAt,
          expiresAtMs: record.expiresAtMs
        });
      }
      if (!persist()) {
        delete record.consumedAt;
        if (record.consumptionKey !== undefined) {
          consumedGroups.delete(record.consumptionKey);
        }
        return {
          state: "failed",
          actionId,
          actionType: record.actionType,
          sessionKey: record.sessionKey,
          consumedAt,
          message: "Die Aktion konnte nicht sicher gespeichert werden."
        };
      }
      const context: INeonDiscordComponentActionContext = {
        actionId,
        actionType: record.actionType,
        sessionKey: record.sessionKey,
        ...(record.resourceRef ? { resourceRef: record.resourceRef } : {}),
        interaction
      };

      try {
        const outcome = await record.handler(context);
        const modal = outcome.modal ? normalizeModal(outcome.modal) : undefined;
        const publicMessage = outcome.publicMessage
          ? normalizeActionMessage(outcome.publicMessage)
          : undefined;
        if (record.responseMode === "modal" && !modal) {
          throw new Error("Modal component action did not return a modal");
        }
        return {
          state: "completed",
          actionId,
          actionType: record.actionType,
          sessionKey: record.sessionKey,
          consumedAt,
          message: normalizeActionMessage(outcome.message),
          ...(publicMessage ? { publicMessage } : {}),
          ...(modal ? { modal } : {})
        };
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error("Unknown component action error");
        options.onHandlerError?.(normalized, context);
        return {
          state: "failed",
          actionId,
          actionType: record.actionType,
          sessionKey: record.sessionKey,
          consumedAt,
          message: "Die Aktion ist fehlgeschlagen. Bitte erneut starten."
        };
      }
    }
  };
}

function normalizeModal(modal: INeonDiscordModal): INeonDiscordModal {
  const customId = requireNonEmpty(modal.customId, "modal.customId");
  const title = requireNonEmpty(modal.title, "modal.title");
  if (customId.length > 100 || title.length > 45 || modal.inputs.length < 1 || modal.inputs.length > 5) {
    throw new Error("Discord modal exceeds platform limits");
  }
  const seenIds = new Set<string>();
  const inputs = modal.inputs.map((input) => {
    const inputId = requireNonEmpty(input.customId, "modal.input.customId");
    const label = requireNonEmpty(input.label, "modal.input.label");
    if (inputId.length > 100 || label.length > 45 || seenIds.has(inputId)) {
      throw new Error("Discord modal input id or label is invalid");
    }
    seenIds.add(inputId);
    const minLength = input.minLength ?? 0;
    const maxLength = input.maxLength ?? 4_000;
    if (
      !Number.isSafeInteger(minLength) ||
      !Number.isSafeInteger(maxLength) ||
      minLength < 0 ||
      maxLength < 1 ||
      maxLength > 4_000 ||
      minLength > maxLength ||
      (input.placeholder !== undefined && input.placeholder.length > 100)
    ) {
      throw new Error("Discord modal input limits are invalid");
    }
    return {
      customId: inputId,
      label,
      style: input.style,
      ...(input.placeholder !== undefined ? { placeholder: input.placeholder } : {}),
      required: input.required ?? true,
      minLength,
      maxLength
    };
  });
  return { customId, title, inputs };
}

function createOpaqueActionId(): string {
  return randomBytes(18).toString("base64url");
}

function normalizeActionId(value: string): string {
  const normalized = requireNonEmpty(value, "actionId");
  if (normalized.length > maxActionIdLength || !/^[a-zA-Z0-9_-]+$/u.test(normalized)) {
    throw new Error(`Discord component action id must match [a-zA-Z0-9_-] and fit ${maxActionIdLength} chars`);
  }
  return normalized;
}

function buildScopedConsumptionKey(input: {
  readonly ownerUserId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly consumptionKey: string;
}): string {
  return [
    input.ownerUserId,
    input.guildId ?? "dm",
    input.channelId,
    input.sessionKey,
    input.consumptionKey
  ].join("\u001F");
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Discord component action ${field} is required`);
  }
  return normalized;
}

function normalizeOptionalNonEmpty(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmpty(value, field);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Discord component action ${field} must be positive`);
  }
  return Math.trunc(value);
}

function removeExpiredRecords(
  records: Map<string, IMutableDiscordComponentActionRecord>,
  consumedGroups: Map<string, IDiscordComponentConsumptionRecord>,
  nowMs: number
): number {
  let removed = 0;
  for (const [actionId, record] of records) {
    if (record.expiresAtMs <= nowMs) {
      records.delete(actionId);
      removed += 1;
    }
  }
  for (const [consumptionKey, record] of consumedGroups) {
    if (record.expiresAtMs <= nowMs) {
      consumedGroups.delete(consumptionKey);
      removed += 1;
    }
  }
  return removed;
}

function normalizeActionMessage(message: string): string {
  const normalized = message.trim().replaceAll("@", "@\u200B");
  if (normalized.length === 0) {
    return "Aktion abgeschlossen.";
  }
  return truncateUtf16Safe(normalized, maxActionMessageLength);
}

function rejected(reason: TNeonDiscordComponentActionRejectReason): TNeonDiscordComponentActionDispatchResult {
  const messages: Readonly<Record<TNeonDiscordComponentActionRejectReason, string>> = {
    "invalid-custom-id": "Diese Aktion ist ungültig.",
    "unknown-action": "Diese Aktion ist nicht mehr verfügbar.",
    "owner-mismatch": "Diese Aktion gehört einem anderen Nutzer.",
    "scope-mismatch": "Diese Aktion gehört zu einem anderen Discord-Kontext.",
    "interaction-kind-mismatch": "Diese Aktion hat den falschen Interaktionstyp.",
    "handler-unavailable": "Diese Aktion ist nach dem Neustart nicht verfügbar.",
    expired: "Diese Aktion ist abgelaufen.",
    "already-consumed": "Diese Aktion wurde bereits verwendet."
  };
  return { state: "rejected", reason, message: messages[reason] };
}

function normalizeError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function loadComponentActionState(
  options: INeonDiscordComponentActionRegistryOptions,
  nowMs: number,
  maxLifetimeMs: number,
  maxEntries: number
): {
  readonly records: Map<string, IMutableDiscordComponentActionRecord>;
  readonly consumedGroups: Map<string, IDiscordComponentConsumptionRecord>;
} {
  const records = new Map<string, IMutableDiscordComponentActionRecord>();
  const consumedGroups = new Map<string, IDiscordComponentConsumptionRecord>();
  if (!options.statePath) {
    return { records, consumedGroups };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(options.statePath, "utf8"));
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) {
      options.onStateError?.(normalizeError(error, "Discord component action state read failed"));
    }
    return { records, consumedGroups };
  }
  if (!isRecord(parsed) || parsed["version"] !== componentActionStateVersion) {
    options.onStateError?.(new Error("Discord component action state version is invalid"));
    return { records, consumedGroups };
  }

  const actions = Array.isArray(parsed["actions"]) ? parsed["actions"] : [];
  for (const value of actions) {
    const action = parsePersistedAction(value, nowMs, maxLifetimeMs, options.resolveHandler);
    if (action && records.size < maxEntries) {
      records.set(action.actionId, action);
    }
  }
  const consumptions = Array.isArray(parsed["consumptions"]) ? parsed["consumptions"] : [];
  for (const value of consumptions) {
    const consumption = parsePersistedConsumption(value, nowMs);
    if (consumption) {
      consumedGroups.set(consumption.consumptionKey, consumption.record);
    }
  }
  return { records, consumedGroups };
}

function parsePersistedAction(
  value: unknown,
  nowMs: number,
  maxLifetimeMs: number,
  resolveHandler: INeonDiscordComponentActionRegistryOptions["resolveHandler"]
): IMutableDiscordComponentActionRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const actionId = readBoundedString(value["actionId"], maxActionIdLength);
  const ownerUserId = readBoundedString(value["ownerUserId"], 100);
  const channelId = readBoundedString(value["channelId"], 100);
  const sessionKey = readBoundedString(value["sessionKey"], 500);
  const actionType = readBoundedString(value["actionType"], 100);
  const expiresAt = readBoundedString(value["expiresAt"], 40);
  const interactionKind = readInteractionKind(value["interactionKind"]);
  const responseMode = readResponseMode(value["responseMode"]);
  const audience = readAudience(value["audience"]);
  if (!actionId || !ownerUserId || !channelId || !sessionKey || !actionType || !expiresAt || !interactionKind) {
    return undefined;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || expiresAtMs - nowMs > maxLifetimeMs) {
    return undefined;
  }
  const guildId = readOptionalBoundedString(value["guildId"], 100);
  const consumptionKey = readOptionalBoundedString(value["consumptionKey"], 1_000);
  const resourceRef = readOptionalBoundedString(value["resourceRef"], 400);
  if (resourceRef && !/^[A-Za-z0-9._:-]+$/u.test(resourceRef)) {
    return undefined;
  }
  const consumedAt = readOptionalIsoTimestamp(value["consumedAt"]);
  const handler = resolveHandler?.(actionType);

  return {
    actionId,
    ownerUserId,
    audience,
    ...(guildId ? { guildId } : {}),
    channelId,
    sessionKey,
    actionType,
    interactionKind,
    responseMode,
    ...(consumptionKey ? { consumptionKey } : {}),
    ...(resourceRef ? { resourceRef } : {}),
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    ...(consumedAt ? { consumedAt } : {}),
    ...(handler ? { handler } : {})
  };
}

function parsePersistedConsumption(
  value: unknown,
  nowMs: number
): { readonly consumptionKey: string; readonly record: IDiscordComponentConsumptionRecord } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const consumptionKey = readBoundedString(value["consumptionKey"], 1_000);
  const consumedAt = readOptionalIsoTimestamp(value["consumedAt"]);
  const expiresAt = readOptionalIsoTimestamp(value["expiresAt"]);
  if (!consumptionKey || !consumedAt || !expiresAt) {
    return undefined;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return undefined;
  }
  return {
    consumptionKey,
    record: { consumedAt, expiresAtMs }
  };
}

function writeComponentActionState(
  statePath: string,
  records: ReadonlyMap<string, IMutableDiscordComponentActionRecord>,
  consumedGroups: ReadonlyMap<string, IDiscordComponentConsumptionRecord>
): void {
  const state: IPersistedComponentActionState = {
    version: componentActionStateVersion,
    actions: Array.from(records.values())
      .sort((left, right) => left.actionId.localeCompare(right.actionId))
      .map((record) => ({
        actionId: record.actionId,
        ownerUserId: record.ownerUserId,
        ...(record.audience !== "owner" ? { audience: record.audience } : {}),
        ...(record.guildId ? { guildId: record.guildId } : {}),
        channelId: record.channelId,
        sessionKey: record.sessionKey,
        actionType: record.actionType,
        interactionKind: record.interactionKind,
        ...(record.responseMode !== "deferred-ephemeral" ? { responseMode: record.responseMode } : {}),
        ...(record.consumptionKey ? { consumptionKey: record.consumptionKey } : {}),
        ...(record.resourceRef ? { resourceRef: record.resourceRef } : {}),
        expiresAt: record.expiresAt,
        ...(record.consumedAt ? { consumedAt: record.consumedAt } : {})
      })),
    consumptions: Array.from(consumedGroups.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([consumptionKey, record]) => ({
        consumptionKey,
        consumedAt: record.consumedAt,
        expiresAt: new Date(record.expiresAtMs).toISOString()
      }))
  };
  const directory = dirname(statePath);
  const tempPath = `${statePath}.${process.pid}.tmp`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  renameSync(tempPath, statePath);
}

function readInteractionKind(value: unknown): TNeonDiscordComponentInteractionKind | undefined {
  return value === "button" || value === "string-select" || value === "modal-submit"
    ? value
    : undefined;
}

function readResponseMode(value: unknown): TNeonDiscordComponentResponseMode {
  return value === "modal" ? "modal" : "deferred-ephemeral";
}

function readAudience(value: unknown): TNeonDiscordComponentActionAudience {
  return value === "channel" ? "channel" : "owner";
}

function normalizeAudience(
  value: TNeonDiscordComponentActionAudience | undefined
): TNeonDiscordComponentActionAudience {
  if (value === undefined || value === "owner") {
    return "owner";
  }
  if (value === "channel") {
    return "channel";
  }
  throw new Error("Discord component action audience is invalid");
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function readOptionalBoundedString(value: unknown, maxLength: number): string | undefined {
  return value === undefined ? undefined : readBoundedString(value, maxLength);
}

function readOptionalIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return new Date(Date.parse(value)).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
