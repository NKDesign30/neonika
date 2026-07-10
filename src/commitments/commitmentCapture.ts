import { createHash } from "node:crypto";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";
import type { INeonGatewayInboundMessage, INeonGatewayShadowRun } from "../gateway/types.js";
import {
  appendNeonCommitment,
  buildNeonCommitmentRecord,
  findActiveNeonCommitmentByDedupeKey,
  readNeonCommitments,
  resolveNeonCommitmentStoreGate,
  resolveNeonCommitmentStorePath,
  type INeonCommitmentRecord
} from "./commitmentStore.js";

export type TNeonCommitmentCaptureState = "captured" | "skipped" | "blocked";

export interface INeonCommitmentCaptureGate {
  readonly enabled: boolean;
  readonly reason: "capture-enabled" | "capture-disabled";
  readonly envKey: typeof commitmentCaptureEnabledEnvKey;
}

export interface INeonCommitmentCaptureCandidate {
  readonly commitment: INeonCommitmentRecord;
  readonly sourceRunId: string;
  readonly sourceMessageId?: string;
  readonly evidence: string;
}

export interface INeonCommitmentCaptureResult {
  readonly state: TNeonCommitmentCaptureState;
  readonly gate: INeonCommitmentCaptureGate;
  readonly storePath?: string;
  readonly captured: readonly INeonCommitmentCaptureCandidate[];
  readonly skipped: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface ICaptureNeonCommitmentsFromRunOptions {
  readonly projectRoot: string;
  readonly run: INeonGatewayShadowRun;
  readonly message: INeonGatewayInboundMessage;
  readonly gate?: INeonCommitmentCaptureGate;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly storePath?: string;
  readonly now?: () => Date;
}

const commitmentCaptureEnabledEnvKey = "NEON_COMMITMENT_CAPTURE_ENABLED";
const defaultDueOffsetMs = 24 * 60 * 60 * 1000;
const dueWindowMs = 60 * 60 * 1000;
const suggestedTextMaxLength = 280;

const promisePattern =
  /\b(?:ich\s+(?:erinnere|melde|checke|schaue)|erinnere\s+dich|melde\s+mich|i(?:'ll| will)\s+(?:remind|check|follow up)|remind\s+you|follow\s+up)\b/iu;

export function resolveNeonCommitmentCaptureGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonCommitmentCaptureGate {
  const enabled = readReadyCutoverEnv(env, commitmentCaptureEnabledEnvKey);
  return {
    enabled,
    reason: enabled ? "capture-enabled" : "capture-disabled",
    envKey: commitmentCaptureEnabledEnvKey
  };
}

export function buildNeonCommitmentCaptureCandidates(options: {
  readonly run: INeonGatewayShadowRun;
  readonly message: INeonGatewayInboundMessage;
  readonly nowMs: number;
}): readonly INeonCommitmentCaptureCandidate[] {
  if (options.run.status !== "completed") {
    return [];
  }

  const finalText = options.run.finalText.trim();
  if (!promisePattern.test(finalText)) {
    return [];
  }

  const dueMs = resolveCommitmentDueMs(`${finalText}\n${options.message.content}`, options.nowMs);
  const suggestedText = buildSuggestedCommitmentText(options.message.content, finalText);
  const dedupeKey = buildCommitmentDedupeKey(options.run, options.message, dueMs, suggestedText);
  const commitment = buildNeonCommitmentRecord(
    {
      id: buildCommitmentId(options.run.runId, dedupeKey),
      agentId: options.run.request.agentId,
      sessionKey: options.run.harnessSessionKey,
      channel: options.run.request.channel,
      kind: "open_loop",
      source: "agent_promise",
      suggestedText,
      dedupeKey,
      confidence: 0.78,
      dueWindow: {
        earliestMs: dueMs,
        latestMs: dueMs + dueWindowMs,
        timezone: "UTC"
      }
    },
    options.nowMs
  );

  return [
    {
      commitment,
      sourceRunId: options.run.runId,
      ...(options.message.messageId ? { sourceMessageId: options.message.messageId } : {}),
      evidence: redactText(trimToSingleLine(finalText).slice(0, suggestedTextMaxLength))
    }
  ];
}

export async function captureNeonCommitmentsFromRun(
  options: ICaptureNeonCommitmentsFromRunOptions
): Promise<INeonCommitmentCaptureResult> {
  const gate = options.gate ?? resolveNeonCommitmentCaptureGate(options.env ?? process.env);
  const storePath = options.storePath ?? resolveNeonCommitmentStorePath(options.projectRoot);

  if (!gate.enabled) {
    return {
      state: "blocked",
      gate,
      storePath,
      captured: [],
      skipped: [],
      diagnostics: [
        `commitment capture blocked: set ${gate.envKey} to arm structural extraction from completed runs`
      ]
    };
  }

  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const candidates = buildNeonCommitmentCaptureCandidates({
    run: options.run,
    message: options.message,
    nowMs
  });

  if (candidates.length === 0) {
    return {
      state: "skipped",
      gate,
      storePath,
      captured: [],
      skipped: ["no-structural-promise-detected"],
      diagnostics: ["No explicit commitment promise found in the completed run."]
    };
  }

  const existing = await readNeonCommitments({ storePath });
  const captured: INeonCommitmentCaptureCandidate[] = [];
  const skipped: string[] = [];
  const storeGate = resolveNeonCommitmentStoreGate({ NEON_COMMITMENTS_STORE_ENABLED: "ready" });

  for (const candidate of candidates) {
    if (findActiveNeonCommitmentByDedupeKey(existing, candidate.commitment.dedupeKey)) {
      skipped.push(`duplicate:${candidate.commitment.dedupeKey}`);
      continue;
    }
    const append = await appendNeonCommitment({
      commitment: candidate.commitment,
      gate: storeGate,
      storePath
    });
    if (append.state === "appended") {
      captured.push(candidate);
    } else {
      skipped.push(`append-blocked:${candidate.commitment.id}`);
    }
  }

  return {
    state: captured.length > 0 ? "captured" : "skipped",
    gate,
    storePath,
    captured,
    skipped,
    diagnostics: [
      `commitment capture evaluated ${candidates.length} candidate(s), captured ${captured.length}, skipped ${skipped.length}.`
    ]
  };
}

function resolveCommitmentDueMs(text: string, nowMs: number): number {
  const inMatch = /\bin\s+(\d{1,3})\s*(m|min|minute|minutes|minuten|h|hr|hour|hours|stunde|stunden|d|day|days|tag|tagen)\b/iu.exec(text);
  if (inMatch) {
    const amount = Number.parseInt(inMatch[1] ?? "", 10);
    const unit = (inMatch[2] ?? "").toLowerCase();
    if (Number.isInteger(amount) && amount > 0) {
      return nowMs + amount * unitToMs(unit);
    }
  }

  if (/\b(?:morgen|tomorrow)\b/iu.test(text)) {
    return nowMs + defaultDueOffsetMs;
  }
  if (/\b(?:heute|today)\b/iu.test(text)) {
    return nowMs + 2 * 60 * 60 * 1000;
  }

  return nowMs + defaultDueOffsetMs;
}

function unitToMs(unit: string): number {
  if (unit === "m" || unit === "min" || unit === "minute" || unit === "minutes" || unit === "minuten") {
    return 60 * 1000;
  }
  if (unit === "h" || unit === "hr" || unit === "hour" || unit === "hours" || unit === "stunde" || unit === "stunden") {
    return 60 * 60 * 1000;
  }
  return defaultDueOffsetMs;
}

function buildSuggestedCommitmentText(userText: string, finalText: string): string {
  const user = trimToSingleLine(userText).replace(/^<@!?[0-9]+>\s*/u, "");
  const assistant = trimToSingleLine(finalText);
  return redactText(`Follow-up: ${user || assistant}`.slice(0, suggestedTextMaxLength));
}

function buildCommitmentDedupeKey(
  run: INeonGatewayShadowRun,
  message: INeonGatewayInboundMessage,
  dueMs: number,
  suggestedText: string
): string {
  return [
    run.request.channel,
    run.request.accountId,
    run.request.channelId,
    message.messageId ?? run.runId,
    String(dueMs),
    hashText(suggestedText).slice(0, 12)
  ].join(":");
}

function buildCommitmentId(runId: string, dedupeKey: string): string {
  return `commitment-${hashText(`${runId}:${dedupeKey}`).slice(0, 16)}`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function trimToSingleLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}
