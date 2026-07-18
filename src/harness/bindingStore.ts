import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveBindingPath } from "./statePaths.js";
import type { TMemoryAttachmentState } from "./types.js";

export interface ICodexThreadBinding {
  readonly schemaVersion: 1;
  readonly sessionKey: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
  readonly memoryState: TMemoryAttachmentState;
  readonly baseInstructionsHash?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IWriteCodexThreadBindingInput {
  readonly sessionKey: string;
  readonly threadId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly approvalPolicy: ICodexThreadBinding["approvalPolicy"];
  readonly sandbox: ICodexThreadBinding["sandbox"];
  readonly memoryState: TMemoryAttachmentState;
  readonly baseInstructionsHash?: string;
  readonly createdAt?: string;
}

export async function writeCodexThreadBinding(
  projectRoot: string,
  input: IWriteCodexThreadBindingInput
): Promise<ICodexThreadBinding> {
  const now = new Date().toISOString();
  const binding: ICodexThreadBinding = {
    schemaVersion: 1,
    sessionKey: input.sessionKey,
    threadId: input.threadId,
    cwd: input.cwd,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    memoryState: input.memoryState,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    ...(input.baseInstructionsHash ? { baseInstructionsHash: input.baseInstructionsHash } : {}),
    ...(input.model ? { model: input.model } : {})
  };
  const path = resolveBindingPath(projectRoot, input.sessionKey);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, "utf8");

  return binding;
}

export async function readCodexThreadBinding(
  projectRoot: string,
  sessionKey: string
): Promise<ICodexThreadBinding | undefined> {
  const path = resolveBindingPath(projectRoot, sessionKey);
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }

    throw error;
  }

  try {
    return parseCodexThreadBinding(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function parseCodexThreadBinding(value: unknown): ICodexThreadBinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (
    record["schemaVersion"] !== 1 ||
    typeof record["sessionKey"] !== "string" ||
    typeof record["threadId"] !== "string" ||
    typeof record["cwd"] !== "string" ||
    !isApprovalPolicy(record["approvalPolicy"]) ||
    !isSandbox(record["sandbox"]) ||
    !isMemoryState(record["memoryState"]) ||
    typeof record["createdAt"] !== "string" ||
    typeof record["updatedAt"] !== "string"
  ) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    sessionKey: record["sessionKey"],
    threadId: record["threadId"],
    cwd: record["cwd"],
    approvalPolicy: record["approvalPolicy"],
    sandbox: record["sandbox"],
    memoryState: record["memoryState"],
    createdAt: record["createdAt"],
    updatedAt: record["updatedAt"],
    ...(typeof record["baseInstructionsHash"] === "string"
      ? { baseInstructionsHash: record["baseInstructionsHash"] }
      : {}),
    ...(typeof record["model"] === "string" ? { model: record["model"] } : {})
  };
}

/** Spec fields compared against a persisted binding before reusing its thread. */
export interface INeonBindingResumeSpec {
  readonly cwd: string;
  readonly approvalPolicy: ICodexThreadBinding["approvalPolicy"];
  readonly sandbox: ICodexThreadBinding["sandbox"];
  readonly model?: string | undefined;
  readonly baseInstructionsHash?: string | undefined;
}

export interface INeonBindingResumeDecision {
  readonly matches: boolean;
  readonly drift: readonly string[];
}

/**
 * Decide whether a persisted binding still matches the current turn spec, so the
 * harness can resume its thread instead of blindly reusing a stale thread under a
 * changed cwd / approval policy / sandbox. Mirrors upstream
 * `sessionMatchesConfiguredBinding` (persistent-bindings.lifecycle.ts): on drift
 * the caller starts a fresh thread rather than resuming the wrong one.
 *
 * `model` drift is reported but only disqualifies when BOTH sides name a model
 * and they differ — the harness falls back to the persisted model when no
 * explicit model is given, so an absent spec model is not a real mismatch.
 */
export function evaluateNeonBindingResume(
  persisted: ICodexThreadBinding,
  spec: INeonBindingResumeSpec
): INeonBindingResumeDecision {
  const drift: string[] = [];
  if (persisted.cwd !== spec.cwd) {
    drift.push("cwd");
  }
  if (persisted.approvalPolicy !== spec.approvalPolicy) {
    drift.push("approvalPolicy");
  }
  if (persisted.sandbox !== spec.sandbox) {
    drift.push("sandbox");
  }
  if (spec.model !== undefined && persisted.model !== undefined && persisted.model !== spec.model) {
    drift.push("model");
  }
  if (
    spec.baseInstructionsHash !== undefined &&
    persisted.baseInstructionsHash !== spec.baseInstructionsHash
  ) {
    drift.push("baseInstructions");
  }
  return { matches: drift.length === 0, drift };
}

function isApprovalPolicy(value: unknown): value is ICodexThreadBinding["approvalPolicy"] {
  return (
    value === "never" ||
    value === "on-request" ||
    value === "on-failure" ||
    value === "untrusted"
  );
}

function isSandbox(value: unknown): value is ICodexThreadBinding["sandbox"] {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isMemoryState(value: unknown): value is TMemoryAttachmentState {
  return value === "attached" || value === "skipped" || value === "failed";
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    (error as { readonly code: string }).code === code
  );
}
