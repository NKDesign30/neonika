export const neonWorkboardStatuses = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done"
] as const;

export const neonWorkboardPriorities = ["low", "normal", "high", "urgent"] as const;
export const neonWorkboardSourceKinds = ["discord-message", "operator", "gateway-run"] as const;

export type TNeonWorkboardStatus = (typeof neonWorkboardStatuses)[number];
export type TNeonWorkboardPriority = (typeof neonWorkboardPriorities)[number];
export type TNeonWorkboardSourceKind = (typeof neonWorkboardSourceKinds)[number];
export type TNeonWorkboardProofStatus = "passed" | "failed" | "skipped" | "unknown";
export type TNeonWorkboardNotificationKind = "completed" | "failed" | "stale";

export interface INeonWorkboardClaim {
  readonly ownerId: string;
  readonly token: string;
  readonly claimedAt: number;
  readonly lastHeartbeatAt: number;
  readonly expiresAt?: number | undefined;
}

export interface INeonWorkboardComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface INeonWorkboardProof {
  readonly id: string;
  readonly status: TNeonWorkboardProofStatus;
  readonly createdAt: number;
  readonly label?: string | undefined;
  readonly command?: string | undefined;
  readonly url?: string | undefined;
  readonly note?: string | undefined;
}

export interface INeonWorkboardNotification {
  readonly id: string;
  readonly kind: TNeonWorkboardNotificationKind;
  readonly createdAt: number;
  readonly message: string;
  readonly sessionKey?: string | undefined;
  readonly runId?: string | undefined;
}

export interface INeonWorkboardSource {
  readonly kind: TNeonWorkboardSourceKind;
  readonly channel?: string | undefined;
  readonly accountId?: string | undefined;
  readonly guildId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly userId?: string | undefined;
  readonly userDisplayName?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly dedupeKey?: string | undefined;
}

export interface INeonWorkboardMetadata {
  readonly source?: INeonWorkboardSource | undefined;
  readonly claim?: INeonWorkboardClaim | undefined;
  readonly comments?: readonly INeonWorkboardComment[] | undefined;
  readonly proof?: readonly INeonWorkboardProof[] | undefined;
  readonly notifications?: readonly INeonWorkboardNotification[] | undefined;
  readonly failureCount?: number | undefined;
  readonly dispatchCount?: number | undefined;
  readonly lastDispatchAt?: number | undefined;
}

export interface INeonWorkboardCard {
  readonly id: string;
  readonly title: string;
  readonly notes?: string | undefined;
  readonly status: TNeonWorkboardStatus;
  readonly priority: TNeonWorkboardPriority;
  readonly labels: readonly string[];
  readonly agentId?: string | undefined;
  readonly sessionKey?: string | undefined;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly position: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
  readonly metadata?: INeonWorkboardMetadata | undefined;
}

export interface INeonWorkboardListResult {
  readonly cards: readonly INeonWorkboardCard[];
  readonly statuses: readonly TNeonWorkboardStatus[];
}

export interface INeonWorkboardStatsResult {
  readonly total: number;
  readonly active: number;
  readonly byStatus: Partial<Record<TNeonWorkboardStatus, number>>;
  readonly byAgent: Record<string, number>;
  readonly updatedAt?: number;
}

export function isNeonWorkboardStatus(value: unknown): value is TNeonWorkboardStatus {
  return neonWorkboardStatuses.includes(value as TNeonWorkboardStatus);
}

export function isNeonWorkboardPriority(value: unknown): value is TNeonWorkboardPriority {
  return neonWorkboardPriorities.includes(value as TNeonWorkboardPriority);
}

export function isNeonWorkboardSourceKind(value: unknown): value is TNeonWorkboardSourceKind {
  return neonWorkboardSourceKinds.includes(value as TNeonWorkboardSourceKind);
}

export function parseNeonWorkboardCard(value: unknown): INeonWorkboardCard | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const title = readString(value, "title");
  const status = value["status"];
  const priority = value["priority"];
  const position = readNumber(value, "position");
  const createdAt = readNumber(value, "createdAt");
  const updatedAt = readNumber(value, "updatedAt");

  if (
    !id ||
    !title ||
    !isNeonWorkboardStatus(status) ||
    !isNeonWorkboardPriority(priority) ||
    position === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }

  const metadata = parseMetadata(value["metadata"]);

  return {
    id,
    title,
    ...(readString(value, "notes") ? { notes: readString(value, "notes") } : {}),
    status,
    priority,
    labels: readStringList(value["labels"], 24),
    ...(readString(value, "agentId") ? { agentId: readString(value, "agentId") } : {}),
    ...(readString(value, "sessionKey") ? { sessionKey: readString(value, "sessionKey") } : {}),
    ...(readString(value, "runId") ? { runId: readString(value, "runId") } : {}),
    ...(readString(value, "taskId") ? { taskId: readString(value, "taskId") } : {}),
    ...(readString(value, "sourceUrl") ? { sourceUrl: readString(value, "sourceUrl") } : {}),
    position,
    createdAt,
    updatedAt,
    ...(readNumber(value, "startedAt") ? { startedAt: readNumber(value, "startedAt") } : {}),
    ...(readNumber(value, "completedAt") ? { completedAt: readNumber(value, "completedAt") } : {}),
    ...(metadata ? { metadata } : {})
  };
}

export function projectNeonWorkboardCards(
  records: readonly INeonWorkboardCard[]
): readonly INeonWorkboardCard[] {
  const latest = new Map<string, INeonWorkboardCard>();
  const order: string[] = [];

  for (const record of records) {
    if (!latest.has(record.id)) {
      order.push(record.id);
    }
    latest.set(record.id, record);
  }

  return order
    .map((id) => latest.get(id))
    .filter((card): card is INeonWorkboardCard => card !== undefined);
}

function parseMetadata(value: unknown): INeonWorkboardMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata: INeonWorkboardMetadata = {
    ...(parseSource(value["source"]) ? { source: parseSource(value["source"]) } : {}),
    ...(parseClaim(value["claim"]) ? { claim: parseClaim(value["claim"]) } : {}),
    ...(parseComments(value["comments"]).length > 0 ? { comments: parseComments(value["comments"]) } : {}),
    ...(parseProofList(value["proof"]).length > 0 ? { proof: parseProofList(value["proof"]) } : {}),
    ...(parseNotifications(value["notifications"]).length > 0
      ? { notifications: parseNotifications(value["notifications"]) }
      : {}),
    ...(readNumber(value, "failureCount") !== undefined
      ? { failureCount: readNumber(value, "failureCount") }
      : {}),
    ...(readNumber(value, "dispatchCount") !== undefined
      ? { dispatchCount: readNumber(value, "dispatchCount") }
      : {}),
    ...(readNumber(value, "lastDispatchAt") !== undefined
      ? { lastDispatchAt: readNumber(value, "lastDispatchAt") }
      : {})
  };

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function parseSource(value: unknown): INeonWorkboardSource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const kind = value["kind"];
  if (!isNeonWorkboardSourceKind(kind)) {
    return undefined;
  }

  return {
    kind,
    ...(readString(value, "channel") ? { channel: readString(value, "channel") } : {}),
    ...(readString(value, "accountId") ? { accountId: readString(value, "accountId") } : {}),
    ...(readString(value, "guildId") ? { guildId: readString(value, "guildId") } : {}),
    ...(readString(value, "channelId") ? { channelId: readString(value, "channelId") } : {}),
    ...(readString(value, "threadId") ? { threadId: readString(value, "threadId") } : {}),
    ...(readString(value, "messageId") ? { messageId: readString(value, "messageId") } : {}),
    ...(readString(value, "userId") ? { userId: readString(value, "userId") } : {}),
    ...(readString(value, "userDisplayName") ? { userDisplayName: readString(value, "userDisplayName") } : {}),
    ...(readString(value, "createdAt") ? { createdAt: readString(value, "createdAt") } : {}),
    ...(readString(value, "dedupeKey") ? { dedupeKey: readString(value, "dedupeKey") } : {})
  };
}

function parseClaim(value: unknown): INeonWorkboardClaim | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const ownerId = readString(value, "ownerId");
  const token = readString(value, "token");
  const claimedAt = readNumber(value, "claimedAt");
  const lastHeartbeatAt = readNumber(value, "lastHeartbeatAt");

  if (!ownerId || !token || claimedAt === undefined || lastHeartbeatAt === undefined) {
    return undefined;
  }

  return {
    ownerId,
    token,
    claimedAt,
    lastHeartbeatAt,
    ...(readNumber(value, "expiresAt") !== undefined ? { expiresAt: readNumber(value, "expiresAt") } : {})
  };
}

function parseComments(value: unknown): readonly INeonWorkboardComment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(parseComment)
    .filter((comment): comment is INeonWorkboardComment => comment !== undefined)
    .slice(-50);
}

function parseComment(value: unknown): INeonWorkboardComment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const body = readString(value, "body");
  const createdAt = readNumber(value, "createdAt");

  return id && body && createdAt !== undefined ? { id, body, createdAt } : undefined;
}

function parseProofList(value: unknown): readonly INeonWorkboardProof[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(parseProof)
    .filter((proof): proof is INeonWorkboardProof => proof !== undefined)
    .slice(-40);
}

function parseProof(value: unknown): INeonWorkboardProof | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const createdAt = readNumber(value, "createdAt");
  const status = readProofStatus(value["status"]);

  if (!id || createdAt === undefined) {
    return undefined;
  }

  return {
    id,
    status,
    createdAt,
    ...(readString(value, "label") ? { label: readString(value, "label") } : {}),
    ...(readString(value, "command") ? { command: readString(value, "command") } : {}),
    ...(readString(value, "url") ? { url: readString(value, "url") } : {}),
    ...(readString(value, "note") ? { note: readString(value, "note") } : {})
  };
}

function parseNotifications(value: unknown): readonly INeonWorkboardNotification[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(parseNotification)
    .filter((notification): notification is INeonWorkboardNotification => notification !== undefined)
    .slice(-20);
}

function parseNotification(value: unknown): INeonWorkboardNotification | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = readString(value, "id");
  const message = readString(value, "message");
  const createdAt = readNumber(value, "createdAt");
  const kind = value["kind"];

  if (
    !id ||
    !message ||
    createdAt === undefined ||
    (kind !== "completed" && kind !== "failed" && kind !== "stale")
  ) {
    return undefined;
  }

  return {
    id,
    kind,
    createdAt,
    message,
    ...(readString(value, "sessionKey") ? { sessionKey: readString(value, "sessionKey") } : {}),
    ...(readString(value, "runId") ? { runId: readString(value, "runId") } : {})
  };
}

function readProofStatus(value: unknown): TNeonWorkboardProofStatus {
  return value === "passed" || value === "failed" || value === "skipped" || value === "unknown"
    ? value
    : "unknown";
}

function readStringList(value: unknown, maxEntries: number): readonly string[] {
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const values: string[] = [];

  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed && !values.includes(trimmed)) {
      values.push(trimmed);
    }
    if (values.length >= maxEntries) {
      break;
    }
  }

  return values;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];

  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
