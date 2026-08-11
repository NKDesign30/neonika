import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import type { INeonOutboundSendResult } from "./outboundSender.js";
import type { TNeonOutboundStage } from "../core/cutover.js";

export type TNeonDeliveryIntentKind = "text" | "media" | "poll" | "embed";
export type TNeonDeliveryReceiptState = "attempting" | "delivered" | "suppressed" | "uncertain";
export type TNeonExactlyOnceDeliveryState =
  | "delivered"
  | "already-delivered"
  | "suppressed"
  | "in-flight"
  | "transport-error"
  | "payload-mismatch";

export interface INeonDeliveryReceipt {
  readonly version: 1;
  readonly intentKey: string;
  readonly runId: string;
  readonly kind: TNeonDeliveryIntentKind;
  readonly channelId: string;
  readonly threadId?: string;
  readonly payloadHash: string;
  readonly nonce: string;
  readonly state: TNeonDeliveryReceiptState;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messageId?: string;
  readonly cutoverStage?: TNeonOutboundStage;
}

export interface INeonExactlyOnceDeliveryResult {
  readonly state: TNeonExactlyOnceDeliveryState;
  readonly intentKey: string;
  readonly outboundSent: boolean;
  readonly attempts: number;
  readonly messageId?: string;
  readonly cutoverStage?: TNeonOutboundStage;
  readonly reason?: string;
}

export interface IExecuteNeonExactlyOnceDeliveryOptions {
  readonly projectRoot: string;
  readonly intentId: string;
  readonly runId: string;
  readonly kind: TNeonDeliveryIntentKind;
  readonly target: INeonDeliveryQueueTarget;
  readonly payloadHash: string;
  readonly send: (target: INeonDeliveryQueueTarget) => Promise<INeonOutboundSendResult>;
  readonly now?: () => Date;
  readonly lockStaleMs?: number;
}

export interface IReadNeonDeliveryReceiptsOptions {
  readonly maxReceipts?: number;
}

const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1_000;
const deliveryReceiptDirectory = "delivery-receipts";

export async function executeNeonExactlyOnceDelivery(
  options: IExecuteNeonExactlyOnceDeliveryOptions
): Promise<INeonExactlyOnceDeliveryResult> {
  const now = options.now ?? (() => new Date());
  const intentKey = createIntentKey(options.intentId);
  const nonce = createDeliveryNonce(options.intentId);
  const paths = resolveReceiptPaths(options.projectRoot, intentKey);
  await mkdir(dirname(paths.receiptPath), { recursive: true });

  const before = await readNeonDeliveryReceiptFile(paths.receiptPath);
  const beforeDecision = resolveExistingReceipt(before, options.payloadHash, intentKey);
  if (beforeDecision) {
    return beforeDecision;
  }

  const lock = await acquireIntentLock(paths.lockPath, options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS, now);
  if (!lock) {
    const concurrent = await readNeonDeliveryReceiptFile(paths.receiptPath);
    return resolveExistingReceipt(concurrent, options.payloadHash, intentKey) ?? {
      state: "in-flight",
      intentKey,
      outboundSent: false,
      attempts: concurrent?.attempts ?? 0,
      reason: "delivery intent is already in flight"
    };
  }

  try {
    const current = await readNeonDeliveryReceiptFile(paths.receiptPath);
    const lockedDecision = resolveExistingReceipt(current, options.payloadHash, intentKey);
    if (lockedDecision) {
      return lockedDecision;
    }

    const attemptedAt = now().toISOString();
    const attempting: INeonDeliveryReceipt = {
      version: 1,
      intentKey,
      runId: requireBounded(options.runId, "runId", 200),
      kind: options.kind,
      channelId: requireBounded(options.target.channelId, "channelId", 100),
      ...(options.target.threadId
        ? { threadId: requireBounded(options.target.threadId, "threadId", 100) }
        : {}),
      payloadHash: requireHash(options.payloadHash),
      nonce,
      state: "attempting",
      attempts: (current?.attempts ?? 0) + 1,
      createdAt: current?.createdAt ?? attemptedAt,
      updatedAt: attemptedAt
    };
    await writeNeonDeliveryReceiptFile(paths.receiptPath, attempting);

    try {
      const result = await options.send({
        ...options.target,
        deliveryIntentId: options.intentId
      });
      const updatedAt = now().toISOString();
      if (result.outboundSent) {
        const delivered: INeonDeliveryReceipt = {
          ...attempting,
          state: "delivered",
          updatedAt,
          messageId: result.messageId,
          cutoverStage: result.cutoverStage
        };
        await writeNeonDeliveryReceiptFile(paths.receiptPath, delivered);
        return {
          state: "delivered",
          intentKey,
          outboundSent: true,
          attempts: delivered.attempts,
          messageId: result.messageId,
          cutoverStage: result.cutoverStage
        };
      }

      const suppressed: INeonDeliveryReceipt = {
        ...attempting,
        state: "suppressed",
        updatedAt
      };
      await writeNeonDeliveryReceiptFile(paths.receiptPath, suppressed);
      return {
        state: "suppressed",
        intentKey,
        outboundSent: false,
        attempts: suppressed.attempts,
        reason: result.reason
      };
    } catch {
      const uncertain: INeonDeliveryReceipt = {
        ...attempting,
        state: "uncertain",
        updatedAt: now().toISOString()
      };
      await writeNeonDeliveryReceiptFile(paths.receiptPath, uncertain);
      return {
        state: "transport-error",
        intentKey,
        outboundSent: false,
        attempts: uncertain.attempts,
        reason: "transport-error"
      };
    }
  } finally {
    await lock.close();
    await unlink(paths.lockPath).catch(() => undefined);
  }
}

export function createNeonDeliveryPayloadHash(
  parts: readonly (string | Uint8Array)[]
): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = typeof part === "string" ? Buffer.from(part, "utf8") : Buffer.from(part);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function createNeonDeliveryIntentId(
  runId: string,
  target: INeonDeliveryQueueTarget,
  kind: TNeonDeliveryIntentKind
): string {
  return [
    "neon-delivery",
    requireBounded(runId, "runId", 200),
    requireBounded(target.accountId, "accountId", 100),
    requireBounded(target.channelId, "channelId", 100),
    target.threadId ? requireBounded(target.threadId, "threadId", 100) : "main",
    kind
  ].join(":");
}

export async function readNeonDeliveryReceipt(
  projectRoot: string,
  intentId: string
): Promise<INeonDeliveryReceipt | undefined> {
  return await readNeonDeliveryReceiptFile(
    resolveReceiptPaths(projectRoot, createIntentKey(intentId)).receiptPath
  );
}

export async function readNeonDeliveryReceipts(
  projectRoot: string,
  options: IReadNeonDeliveryReceiptsOptions = {}
): Promise<readonly INeonDeliveryReceipt[]> {
  const directory = resolveDeliveryReceiptDirectory(projectRoot);
  let names: readonly string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  const receipts: INeonDeliveryReceipt[] = [];
  for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))) {
    const receipt = await readNeonDeliveryReceiptFile(join(directory, name));
    if (receipt) {
      receipts.push(receipt);
    }
  }
  const ordered = receipts
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const maxReceipts = normalizeMaxReceipts(options.maxReceipts);
  return maxReceipts === undefined ? ordered : ordered.slice(0, maxReceipts);
}

function resolveExistingReceipt(
  receipt: INeonDeliveryReceipt | undefined,
  payloadHash: string,
  intentKey: string
): INeonExactlyOnceDeliveryResult | undefined {
  if (!receipt) {
    return undefined;
  }
  if (receipt.payloadHash !== payloadHash) {
    return {
      state: "payload-mismatch",
      intentKey,
      outboundSent: false,
      attempts: receipt.attempts,
      reason: "delivery intent payload changed"
    };
  }
  if (receipt.state === "delivered") {
    return {
      state: "already-delivered",
      intentKey,
      outboundSent: false,
      attempts: receipt.attempts,
      ...(receipt.messageId ? { messageId: receipt.messageId } : {}),
      ...(receipt.cutoverStage ? { cutoverStage: receipt.cutoverStage } : {}),
      reason: "delivery receipt already exists"
    };
  }
  return undefined;
}

async function acquireIntentLock(
  lockPath: string,
  staleMs: number,
  now: () => Date
): Promise<Awaited<ReturnType<typeof open>> | undefined> {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) {
      throw error;
    }
  }
  try {
    const lockStat = await stat(lockPath);
    if (now().getTime() - lockStat.mtimeMs <= staleMs) {
      return undefined;
    }
    await unlink(lockPath);
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST") || isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function readNeonDeliveryReceiptFile(
  receiptPath: string
): Promise<INeonDeliveryReceipt | undefined> {
  try {
    const receipt = parseReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
    if (!receipt) {
      throw new Error(`Invalid delivery receipt: ${receiptPath}`);
    }
    return receipt;
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function writeNeonDeliveryReceiptFile(
  receiptPath: string,
  receipt: INeonDeliveryReceipt
): Promise<void> {
  const tempPath = `${receiptPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tempPath, receiptPath);
}

function parseReceipt(value: unknown): INeonDeliveryReceipt | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = readReceiptKind(value["kind"]);
  const state = readReceiptState(value["state"]);
  if (
    value["version"] !== 1 ||
    typeof value["intentKey"] !== "string" ||
    typeof value["runId"] !== "string" ||
    !kind ||
    typeof value["channelId"] !== "string" ||
    (value["threadId"] !== undefined && typeof value["threadId"] !== "string") ||
    typeof value["payloadHash"] !== "string" ||
    typeof value["nonce"] !== "string" ||
    !state ||
    typeof value["attempts"] !== "number" ||
    !Number.isSafeInteger(value["attempts"]) ||
    value["attempts"] < 1 ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    (value["messageId"] !== undefined && typeof value["messageId"] !== "string")
  ) {
    return undefined;
  }
  return {
    version: 1,
    intentKey: value["intentKey"],
    runId: value["runId"],
    kind,
    channelId: value["channelId"],
    ...(typeof value["threadId"] === "string" ? { threadId: value["threadId"] } : {}),
    payloadHash: value["payloadHash"],
    nonce: value["nonce"],
    state,
    attempts: value["attempts"],
    createdAt: value["createdAt"],
    updatedAt: value["updatedAt"],
    ...(typeof value["messageId"] === "string" ? { messageId: value["messageId"] } : {}),
    ...(value["cutoverStage"] === "canary" || value["cutoverStage"] === "primary"
      ? { cutoverStage: value["cutoverStage"] }
      : {})
  };
}

function readReceiptState(value: unknown): TNeonDeliveryReceiptState | undefined {
  return value === "attempting" || value === "delivered" || value === "suppressed" || value === "uncertain"
    ? value
    : undefined;
}

function readReceiptKind(value: unknown): TNeonDeliveryIntentKind | undefined {
  return value === "text" || value === "media" || value === "poll" || value === "embed"
    ? value
    : undefined;
}

function resolveReceiptPaths(projectRoot: string, intentKey: string): {
  readonly receiptPath: string;
  readonly lockPath: string;
} {
  const directory = resolveDeliveryReceiptDirectory(projectRoot);
  return {
    receiptPath: join(directory, `${intentKey}.json`),
    lockPath: join(directory, `${intentKey}.lock`)
  };
}

function resolveDeliveryReceiptDirectory(projectRoot: string): string {
  return join(projectRoot, "state", "gateway", deliveryReceiptDirectory);
}

function normalizeMaxReceipts(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000) {
    throw new Error("Delivery receipt maxReceipts must be between 1 and 1000");
  }
  return value;
}

function createIntentKey(intentId: string): string {
  return createHash("sha256").update(requireBounded(intentId, "intentId", 1_000)).digest("hex");
}

function createDeliveryNonce(intentId: string): string {
  return `neon-${createHash("sha256").update(`${intentId}:0`).digest("hex").slice(0, 20)}`;
}

function requireHash(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error("Delivery payloadHash must be a SHA-256 hex digest");
  }
  return normalized;
}

function requireBounded(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`Delivery ${field} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
