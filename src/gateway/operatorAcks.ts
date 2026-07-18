import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { redactText } from "../harness/redaction.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";
import { resolveGatewayStatePaths } from "./runStore.js";

/**
 * Operator run-acknowledgement: the FIRST gated `operator.write` mutation in the
 * Neon Gateway (DP-3). It is idempotent by `runId` (a single ack per run, re-acking
 * upserts the same key) and side-effect-bounded: it writes one small JSON marker
 * file and never sends, mutates a run, or touches outbound. The note is redacted
 * before persistence so an operator comment can never carry a secret into state.
 *
 * Authorization lives at the WS layer: `run.ack.set` is a write-scoped method,
 * denied unless the connection holds `operator.write` (deny-by-default).
 */
const OPERATOR_ACKS_FILE = "operator-acks.json";
const ackNoteMaxLength = 280;

export interface INeonOperatorAck {
  readonly runId: string;
  readonly ackedBy: string;
  readonly note?: string;
  readonly ackedAt: string;
}

export interface INeonOperatorAckResult {
  readonly ack: INeonOperatorAck;
  readonly created: boolean;
  readonly safety: { readonly outboundSent: false; readonly mutation: "operator-ack" };
}

export interface IRecordNeonOperatorAckOptions {
  readonly now?: () => Date;
}

function resolveOperatorAcksPath(projectRoot: string): string {
  return join(resolveGatewayStatePaths(projectRoot).gatewayRoot, OPERATOR_ACKS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAck(value: unknown): INeonOperatorAck | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const runId = value["runId"];
  const ackedBy = value["ackedBy"];
  const ackedAt = value["ackedAt"];
  const note = value["note"];
  if (typeof runId !== "string" || typeof ackedBy !== "string" || typeof ackedAt !== "string") {
    return undefined;
  }
  return { runId, ackedBy, ackedAt, ...(typeof note === "string" ? { note } : {}) };
}

function normalizeAckText(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

export async function readNeonOperatorAcks(
  projectRoot: string
): Promise<readonly INeonOperatorAck[]> {
  try {
    const raw = await readFile(resolveOperatorAcksPath(projectRoot), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return [];
    }
    return Object.values(parsed)
      .map(parseAck)
      .filter((ack): ack is INeonOperatorAck => Boolean(ack));
  } catch {
    return [];
  }
}

export async function recordNeonOperatorAck(
  projectRoot: string,
  params: unknown,
  options: IRecordNeonOperatorAckOptions = {}
): Promise<INeonOperatorAckResult> {
  if (!isRecord(params)) {
    throw new Error("run.ack.set requires an object with runId and ackedBy");
  }
  const runId = normalizeAckText(params["runId"]);
  const ackedBy = normalizeAckText(params["ackedBy"]);
  if (!runId || !ackedBy) {
    throw new Error("run.ack.set requires non-empty runId and ackedBy");
  }
  const noteRaw = normalizeAckText(params["note"]);
  const note = noteRaw ? truncateUtf16Safe(redactText(noteRaw), ackNoteMaxLength) : undefined;
  const ackedAt = (options.now?.() ?? new Date()).toISOString();

  const existing = await readNeonOperatorAcks(projectRoot);
  const acks = new Map(existing.map((ack) => [ack.runId, ack]));
  const created = !acks.has(runId);
  const ack: INeonOperatorAck = { runId, ackedBy, ackedAt, ...(note ? { note } : {}) };
  acks.set(runId, ack);

  const path = resolveOperatorAcksPath(projectRoot);
  await mkdir(dirname(path), { recursive: true });
  const serialized = Object.fromEntries([...acks].map(([id, value]) => [id, value]));
  await writeFile(path, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");

  return { ack, created, safety: { outboundSent: false, mutation: "operator-ack" } };
}
