import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import {
  isNeonWorkboardPriority,
  isNeonWorkboardStatus,
  neonWorkboardPriorities,
  neonWorkboardStatuses,
  parseNeonWorkboardCard,
  projectNeonWorkboardCards,
  type INeonWorkboardCard,
  type INeonWorkboardClaim,
  type INeonWorkboardComment,
  type INeonWorkboardListResult,
  type INeonWorkboardMetadata,
  type INeonWorkboardNotification,
  type INeonWorkboardProof,
  type INeonWorkboardSource,
  type INeonWorkboardStatsResult,
  type TNeonWorkboardPriority,
  type TNeonWorkboardSourceKind,
  type TNeonWorkboardStatus
} from "./workboardModel.js";

const DEFAULT_STATE_ROOT = "state";
const WORKBOARD_STATE_DIR = "workboard";
const WORKBOARD_FILE = "cards.jsonl";
const POSITION_STEP = 1000;
const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
const CLAIM_RECLAIM_GRACE_MS = 5 * 60 * 1000;

export interface INeonWorkboardStatePaths {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly workboardRoot: string;
  readonly cardsPath: string;
}

export interface INeonWorkboardReadOptions {
  readonly maxRecords?: number;
}

export interface INeonWorkboardCreateInput {
  readonly title?: unknown;
  readonly notes?: unknown;
  readonly status?: unknown;
  readonly priority?: unknown;
  readonly labels?: unknown;
  readonly agentId?: unknown;
  readonly sessionKey?: unknown;
  readonly runId?: unknown;
  readonly taskId?: unknown;
  readonly sourceUrl?: unknown;
  readonly source?: unknown;
  readonly position?: unknown;
}

export interface INeonWorkboardClaimInput {
  readonly id?: unknown;
  readonly ownerId?: unknown;
  readonly token?: unknown;
  readonly ttlSeconds?: unknown;
}

export interface INeonWorkboardHeartbeatInput {
  readonly id?: unknown;
  readonly ownerId?: unknown;
  readonly token?: unknown;
  readonly note?: unknown;
}

export interface INeonWorkboardCompleteInput extends INeonWorkboardHeartbeatInput {
  readonly summary?: unknown;
  readonly proof?: unknown;
}

export interface INeonWorkboardBlockInput extends INeonWorkboardHeartbeatInput {
  readonly reason?: unknown;
}

export interface INeonWorkboardClaimResult {
  readonly card: INeonWorkboardCard;
  readonly token: string;
}

export interface INeonWorkboardDispatchResult {
  readonly promoted: readonly INeonWorkboardCard[];
  readonly reclaimed: readonly INeonWorkboardCard[];
  readonly blocked: readonly INeonWorkboardCard[];
  readonly count: number;
}

export function resolveNeonWorkboardStatePaths(projectRoot: string): INeonWorkboardStatePaths {
  const resolvedProjectRoot = resolve(projectRoot);
  const stateRoot = join(resolvedProjectRoot, DEFAULT_STATE_ROOT);
  const workboardRoot = join(stateRoot, WORKBOARD_STATE_DIR);

  return {
    projectRoot: resolvedProjectRoot,
    stateRoot,
    workboardRoot,
    cardsPath: join(workboardRoot, WORKBOARD_FILE)
  };
}

export async function readNeonWorkboardCardRecords(
  projectRoot: string,
  options: INeonWorkboardReadOptions = {}
): Promise<readonly INeonWorkboardCard[]> {
  const paths = resolveNeonWorkboardStatePaths(projectRoot);
  let raw: string;

  try {
    raw = await readFile(paths.cardsPath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }

  const records = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCardLine)
    .filter((card): card is INeonWorkboardCard => card !== undefined);

  return options.maxRecords ? records.slice(-options.maxRecords) : records;
}

export async function readNeonWorkboardCards(
  projectRoot: string,
  options: INeonWorkboardReadOptions = {}
): Promise<readonly INeonWorkboardCard[]> {
  const cards = await readNeonWorkboardCardsInternal(projectRoot, options);

  return cards.map(redactNeonWorkboardCard).sort(compareWorkboardCards);
}

export async function createNeonWorkboardSnapshot(
  projectRoot: string,
  options: INeonWorkboardReadOptions = {}
): Promise<INeonWorkboardListResult> {
  return {
    cards: await readNeonWorkboardCards(projectRoot, options),
    statuses: neonWorkboardStatuses
  };
}

export async function createNeonWorkboardCard(
  projectRoot: string,
  input: INeonWorkboardCreateInput,
  now = Date.now()
): Promise<INeonWorkboardCard> {
  const cards = await readNeonWorkboardCardsInternal(projectRoot);
  const status = normalizeStatus(input.status, "todo");
  const position = normalizePosition(
    input.position,
    Math.max(0, ...cards.filter((card) => card.status === status).map((card) => card.position)) +
      POSITION_STEP
  );
  const title = normalizeRequiredString(input.title, "title", 180);
  const agentId = normalizeOptionalString(input.agentId, 120);
  const sessionKey = normalizeOptionalString(input.sessionKey, 200);
  const runId = normalizeOptionalString(input.runId, 200);
  const taskId = normalizeOptionalString(input.taskId, 160);
  const sourceUrl = normalizeOptionalString(input.sourceUrl, 2000);
  const source = normalizeSource(input.source);
  const card: INeonWorkboardCard = {
    id: randomUUID(),
    title: redactText(title),
    ...(normalizeOptionalString(input.notes, 4000) ? { notes: redactText(normalizeOptionalString(input.notes, 4000)!) } : {}),
    status,
    priority: normalizePriority(input.priority, "normal"),
    labels: normalizeLabels(input.labels).map(redactText),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(sourceUrl ? { sourceUrl: redactText(sourceUrl) } : {}),
    position,
    createdAt: now,
    updatedAt: now,
    ...(status === "running" ? { startedAt: now } : {}),
    ...(status === "done" ? { completedAt: now } : {}),
    ...(source ? { metadata: { source } } : {})
  };

  await appendNeonWorkboardCard(projectRoot, card);

  return redactNeonWorkboardCard(card);
}

export async function getNeonWorkboardCard(
  projectRoot: string,
  id: string
): Promise<INeonWorkboardCard | undefined> {
  const card = await getNeonWorkboardCardInternal(projectRoot, id);

  return card ? redactNeonWorkboardCard(card) : undefined;
}

export async function claimNeonWorkboardCard(
  projectRoot: string,
  input: INeonWorkboardClaimInput,
  now = Date.now()
): Promise<INeonWorkboardClaimResult> {
  const id = normalizeRequiredString(input.id, "id", 160);
  const ownerId = normalizeRequiredString(input.ownerId, "ownerId", 120);
  const token = normalizeOptionalString(input.token, 160) ?? randomUUID();
  const ttlMs = normalizeTtlMs(input.ttlSeconds);
  const card = await requireNeonWorkboardCardInternal(projectRoot, id);
  const claim = card.metadata?.claim;

  if (claim?.expiresAt && claim.expiresAt > now) {
    throw new Error(`card already claimed by ${claim.ownerId}.`);
  }

  if (card.status === "scheduled") {
    throw new Error("card is scheduled for later.");
  }

  const next: INeonWorkboardCard = {
    ...card,
    status: card.status === "backlog" || card.status === "todo" || card.status === "ready" ? "running" : card.status,
    agentId: card.agentId ?? ownerId,
    startedAt: card.startedAt ?? now,
    updatedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      claim: {
        ownerId,
        token,
        claimedAt: now,
        lastHeartbeatAt: now,
        expiresAt: now + ttlMs
      }
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return {
    card: redactNeonWorkboardCard(next),
    token
  };
}

export async function heartbeatNeonWorkboardCard(
  projectRoot: string,
  input: INeonWorkboardHeartbeatInput,
  now = Date.now()
): Promise<INeonWorkboardCard> {
  const id = normalizeRequiredString(input.id, "id", 160);
  const card = await requireNeonWorkboardCardInternal(projectRoot, id);
  const claim = assertClaimAccess(card, input);
  const note = normalizeOptionalString(input.note, 400);
  const nextClaim: INeonWorkboardClaim = {
    ...claim,
    lastHeartbeatAt: Math.max(now, claim.lastHeartbeatAt + 1),
    ...(claim.expiresAt ? { expiresAt: now + Math.max(1, claim.expiresAt - claim.lastHeartbeatAt) } : {})
  };
  const comments = note
    ? [...(card.metadata?.comments ?? []), createComment(redactText(note), now)].slice(-50)
    : card.metadata?.comments;
  const next: INeonWorkboardCard = {
    ...card,
    updatedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      claim: nextClaim,
      ...(comments ? { comments } : {})
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return redactNeonWorkboardCard(next);
}

export async function completeNeonWorkboardCard(
  projectRoot: string,
  input: INeonWorkboardCompleteInput,
  now = Date.now()
): Promise<INeonWorkboardCard> {
  const id = normalizeRequiredString(input.id, "id", 160);
  const card = await requireNeonWorkboardCardInternal(projectRoot, id);
  assertClaimAccess(card, input);
  const summary = normalizeOptionalString(input.summary, 2000);
  const proof = parseProofInput(input.proof, now);
  const comments = summary
    ? [...(card.metadata?.comments ?? []), createComment(redactText(summary), now)].slice(-50)
    : card.metadata?.comments;
  const notification = createNotification("completed", summary ?? "Workboard card completed.", card, now);
  const next: INeonWorkboardCard = {
    ...card,
    status: "done",
    updatedAt: now,
    completedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      claim: undefined,
      failureCount: 0,
      ...(comments ? { comments } : {}),
      ...(proof ? { proof: [...(card.metadata?.proof ?? []), proof].slice(-40) } : {}),
      notifications: [...(card.metadata?.notifications ?? []), notification].slice(-20)
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return redactNeonWorkboardCard(next);
}

export async function blockNeonWorkboardCard(
  projectRoot: string,
  input: INeonWorkboardBlockInput,
  now = Date.now()
): Promise<INeonWorkboardCard> {
  const id = normalizeRequiredString(input.id, "id", 160);
  const card = await requireNeonWorkboardCardInternal(projectRoot, id);
  assertClaimAccess(card, input);
  const reason = normalizeOptionalString(input.reason, 2000) ?? "Workboard card blocked.";
  const notification = createNotification("failed", reason, card, now);
  const next: INeonWorkboardCard = {
    ...card,
    status: "blocked",
    updatedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      claim: undefined,
      failureCount: (card.metadata?.failureCount ?? 0) + 1,
      comments: [...(card.metadata?.comments ?? []), createComment(redactText(reason), now)].slice(-50),
      notifications: [...(card.metadata?.notifications ?? []), notification].slice(-20)
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return redactNeonWorkboardCard(next);
}

export async function dispatchNeonWorkboard(
  projectRoot: string,
  now = Date.now()
): Promise<INeonWorkboardDispatchResult> {
  const cards = await readNeonWorkboardCardsInternal(projectRoot);
  const reclaimed: INeonWorkboardCard[] = [];
  const blocked: INeonWorkboardCard[] = [];
  const promoted: INeonWorkboardCard[] = [];

  for (const card of cards) {
    const claim = card.metadata?.claim;
    const claimExpired = Boolean(claim?.expiresAt && now - claim.expiresAt > CLAIM_RECLAIM_GRACE_MS);

    if (card.status === "running" && claimExpired) {
      const next = await blockExpiredCard(projectRoot, card, now);
      blocked.push(redactNeonWorkboardCard(next));
      continue;
    }

    if (claimExpired) {
      const next = await clearExpiredClaim(projectRoot, card, now);
      reclaimed.push(redactNeonWorkboardCard(next));
      continue;
    }

    if (card.status === "ready") {
      const next = await recordReadyDispatch(projectRoot, card, now);
      promoted.push(redactNeonWorkboardCard(next));
    }
  }

  return {
    promoted,
    reclaimed,
    blocked,
    count: promoted.length + reclaimed.length + blocked.length
  };
}

export async function createNeonWorkboardStats(
  projectRoot: string
): Promise<INeonWorkboardStatsResult> {
  const cards = await readNeonWorkboardCards(projectRoot);
  const byStatus: Partial<Record<TNeonWorkboardStatus, number>> = {};
  const byAgent: Record<string, number> = {};
  let updatedAt: number | undefined;

  for (const card of cards) {
    byStatus[card.status] = (byStatus[card.status] ?? 0) + 1;
    byAgent[card.agentId ?? "(default)"] = (byAgent[card.agentId ?? "(default)"] ?? 0) + 1;
    updatedAt = Math.max(updatedAt ?? 0, card.updatedAt);
  }

  return {
    total: cards.length,
    active: cards.filter((card) => card.status !== "done").length,
    byStatus,
    byAgent,
    ...(updatedAt ? { updatedAt } : {})
  };
}

export function redactNeonWorkboardCard(card: INeonWorkboardCard): INeonWorkboardCard {
  const claim = card.metadata?.claim;
  const source = card.metadata?.source ? redactWorkboardSource(card.metadata.source) : undefined;
  return {
    ...card,
    title: redactText(card.title),
    ...(card.notes ? { notes: redactText(card.notes) } : {}),
    labels: card.labels.map(redactText),
    ...(card.sourceUrl ? { sourceUrl: redactText(card.sourceUrl) } : {}),
    ...(card.metadata
      ? {
          metadata: cleanMetadata({
            ...card.metadata,
            ...(source ? { source } : {}),
            ...(claim ? { claim: { ...claim, token: "[redacted]" } } : {})
          })
        }
      : {})
  };
}

async function readNeonWorkboardCardsInternal(
  projectRoot: string,
  options: INeonWorkboardReadOptions = {}
): Promise<readonly INeonWorkboardCard[]> {
  const records = await readNeonWorkboardCardRecords(projectRoot, options);

  return [...projectNeonWorkboardCards(records)].sort(compareWorkboardCards);
}

async function getNeonWorkboardCardInternal(
  projectRoot: string,
  id: string
): Promise<INeonWorkboardCard | undefined> {
  return (await readNeonWorkboardCardsInternal(projectRoot)).find((card) => card.id === id.trim());
}

async function requireNeonWorkboardCardInternal(
  projectRoot: string,
  id: string
): Promise<INeonWorkboardCard> {
  const card = await getNeonWorkboardCardInternal(projectRoot, id);

  if (!card) {
    throw new Error(`card not found: ${id}`);
  }

  return card;
}

async function appendNeonWorkboardCard(projectRoot: string, card: INeonWorkboardCard): Promise<void> {
  const paths = resolveNeonWorkboardStatePaths(projectRoot);

  await mkdir(dirname(paths.cardsPath), { recursive: true });
  await appendFile(paths.cardsPath, `${JSON.stringify(card)}\n`, "utf8");
}

async function blockExpiredCard(
  projectRoot: string,
  card: INeonWorkboardCard,
  now: number
): Promise<INeonWorkboardCard> {
  const reason = "Claim expired without a recent heartbeat.";
  const next: INeonWorkboardCard = {
    ...card,
    status: "blocked",
    updatedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      claim: undefined,
      failureCount: (card.metadata?.failureCount ?? 0) + 1,
      notifications: [...(card.metadata?.notifications ?? []), createNotification("failed", reason, card, now)].slice(-20)
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return next;
}

async function clearExpiredClaim(
  projectRoot: string,
  card: INeonWorkboardCard,
  now: number
): Promise<INeonWorkboardCard> {
  const next: INeonWorkboardCard = {
    ...card,
    updatedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      claim: undefined
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return next;
}

async function recordReadyDispatch(
  projectRoot: string,
  card: INeonWorkboardCard,
  now: number
): Promise<INeonWorkboardCard> {
  const next: INeonWorkboardCard = {
    ...card,
    updatedAt: now,
    metadata: cleanMetadata({
      ...card.metadata,
      dispatchCount: (card.metadata?.dispatchCount ?? 0) + 1,
      lastDispatchAt: now
    })
  };

  await appendNeonWorkboardCard(projectRoot, next);

  return next;
}

function assertClaimAccess(
  card: INeonWorkboardCard,
  input: INeonWorkboardHeartbeatInput
): INeonWorkboardClaim {
  const claim = card.metadata?.claim;

  if (!claim) {
    throw new Error("card is not claimed.");
  }

  const token = normalizeOptionalString(input.token, 160);
  const ownerId = normalizeOptionalString(input.ownerId, 120);

  if (token && token !== claim.token) {
    throw new Error("claim token does not match.");
  }

  if (!token && ownerId && ownerId !== claim.ownerId) {
    throw new Error("claim owner does not match.");
  }

  return claim;
}

function parseProofInput(value: unknown, now: number): INeonWorkboardProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const status = readProofStatus(record["status"]);

  return {
    id: randomUUID(),
    status,
    createdAt: now,
    ...(normalizeOptionalString(record["label"], 180) ? { label: redactText(normalizeOptionalString(record["label"], 180)!) } : {}),
    ...(normalizeOptionalString(record["command"], 400) ? { command: redactText(normalizeOptionalString(record["command"], 400)!) } : {}),
    ...(normalizeOptionalString(record["url"], 2000) ? { url: redactText(normalizeOptionalString(record["url"], 2000)!) } : {}),
    ...(normalizeOptionalString(record["note"], 800) ? { note: redactText(normalizeOptionalString(record["note"], 800)!) } : {})
  };
}

function createComment(body: string, createdAt: number): INeonWorkboardComment {
  return {
    id: randomUUID(),
    body,
    createdAt
  };
}

function createNotification(
  kind: INeonWorkboardNotification["kind"],
  message: string,
  card: INeonWorkboardCard,
  createdAt: number
): INeonWorkboardNotification {
  return {
    id: randomUUID(),
    kind,
    createdAt,
    message: redactText(message),
    ...(card.sessionKey ? { sessionKey: card.sessionKey } : {}),
    ...(card.runId ? { runId: card.runId } : {})
  };
}

function normalizeStatus(value: unknown, fallback: TNeonWorkboardStatus): TNeonWorkboardStatus {
  return isNeonWorkboardStatus(value) ? value : fallback;
}

function normalizePriority(value: unknown, fallback: TNeonWorkboardPriority): TNeonWorkboardPriority {
  return isNeonWorkboardPriority(value) ? value : fallback;
}

function normalizeLabels(value: unknown): readonly string[] {
  const entries =
    typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const labels: string[] = [];

  for (const entry of entries) {
    const label = normalizeOptionalString(entry, 40);
    if (label && !labels.includes(label)) {
      labels.push(label);
    }
    if (labels.length >= 12) {
      break;
    }
  }

  return labels;
}

function normalizeRequiredString(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeOptionalString(value, maxLength);

  if (!normalized) {
    throw new Error(`${field} is required.`);
  }

  return normalized;
}

function normalizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  if (normalized.length > maxLength) {
    throw new Error(`value must be ${maxLength} characters or fewer.`);
  }

  return normalized;
}

function normalizePosition(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function normalizeTtlMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CLAIM_TTL_MS;
  }

  return Math.max(1, Math.trunc(value)) * 1000;
}

function normalizeSource(value: unknown): INeonWorkboardSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const kind = normalizeSourceKind(record["kind"]);
  if (!kind) {
    return undefined;
  }

  return {
    kind,
    ...(normalizeOptionalString(record["channel"], 80) ? { channel: normalizeOptionalString(record["channel"], 80) } : {}),
    ...(normalizeOptionalString(record["accountId"], 120) ? { accountId: normalizeOptionalString(record["accountId"], 120) } : {}),
    ...(normalizeOptionalString(record["guildId"], 120) ? { guildId: normalizeOptionalString(record["guildId"], 120) } : {}),
    ...(normalizeOptionalString(record["channelId"], 120) ? { channelId: normalizeOptionalString(record["channelId"], 120) } : {}),
    ...(normalizeOptionalString(record["threadId"], 120) ? { threadId: normalizeOptionalString(record["threadId"], 120) } : {}),
    ...(normalizeOptionalString(record["messageId"], 120) ? { messageId: normalizeOptionalString(record["messageId"], 120) } : {}),
    ...(normalizeOptionalString(record["userId"], 120) ? { userId: normalizeOptionalString(record["userId"], 120) } : {}),
    ...(normalizeOptionalString(record["userDisplayName"], 120)
      ? { userDisplayName: redactText(normalizeOptionalString(record["userDisplayName"], 120)!) }
      : {}),
    ...(normalizeOptionalString(record["createdAt"], 80) ? { createdAt: normalizeOptionalString(record["createdAt"], 80) } : {}),
    ...(normalizeOptionalString(record["dedupeKey"], 240) ? { dedupeKey: normalizeOptionalString(record["dedupeKey"], 240) } : {})
  };
}

function normalizeSourceKind(value: unknown): TNeonWorkboardSourceKind | undefined {
  return value === "discord-message" || value === "operator" || value === "gateway-run" ? value : undefined;
}

function redactWorkboardSource(source: INeonWorkboardSource): INeonWorkboardSource {
  return {
    ...source,
    ...(source.userDisplayName ? { userDisplayName: redactText(source.userDisplayName) } : {})
  };
}

function readProofStatus(value: unknown): INeonWorkboardProof["status"] {
  return value === "passed" || value === "failed" || value === "skipped" || value === "unknown"
    ? value
    : "unknown";
}

function cleanMetadata(metadata: INeonWorkboardMetadata): INeonWorkboardMetadata | undefined {
  const next: INeonWorkboardMetadata = {
    ...(metadata.source ? { source: metadata.source } : {}),
    ...(metadata.claim ? { claim: metadata.claim } : {}),
    ...(metadata.comments?.length ? { comments: metadata.comments } : {}),
    ...(metadata.proof?.length ? { proof: metadata.proof } : {}),
    ...(metadata.notifications?.length ? { notifications: metadata.notifications } : {}),
    ...(metadata.failureCount !== undefined ? { failureCount: metadata.failureCount } : {}),
    ...(metadata.dispatchCount !== undefined ? { dispatchCount: metadata.dispatchCount } : {}),
    ...(metadata.lastDispatchAt !== undefined ? { lastDispatchAt: metadata.lastDispatchAt } : {})
  };

  return Object.keys(next).length > 0 ? next : undefined;
}

function parseCardLine(line: string): INeonWorkboardCard | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  return parseNeonWorkboardCard(parsed);
}

function compareWorkboardCards(left: INeonWorkboardCard, right: INeonWorkboardCard): number {
  if (left.status !== right.status) {
    return neonWorkboardStatuses.indexOf(left.status) - neonWorkboardStatuses.indexOf(right.status);
  }

  if (left.position !== right.position) {
    return left.position - right.position;
  }

  if (left.priority !== right.priority) {
    return neonWorkboardPriorities.indexOf(right.priority) - neonWorkboardPriorities.indexOf(left.priority);
  }

  return left.createdAt - right.createdAt;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
