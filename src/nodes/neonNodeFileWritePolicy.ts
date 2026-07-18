import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";

/**
 * Gated remote `file.write` policy (DP-7).
 *
 * Upstream writes/fetches files on remote nodes. Neonika keeps node transport
 * read-only (`file.list`/`dir.list`/`file.read`, poll-only) and blocks writes.
 * This adds the gated write path WITHOUT allowing arbitrary remote filesystem
 * tampering: a write only happens when ALL gates hold — `NEON_NODE_FILE_WRITE_ENABLED`
 * (default-off), an operator approval, the `file.write` scope, AND the target path
 * resolves strictly INSIDE an operator-designated allowlist root. Any `..`/absolute
 * escape is hard-blocked (`path-escape`) before touching disk. The bounded root is
 * the safety boundary — like DP-11's isolated memory store, a write can never leave
 * the sandbox the operator points at. Pointing the root at a sensitive directory is a
 * deliberate operator/product decision.
 */
export type TNeonNodeFileWriteGateReason = "write-disabled" | "write-enabled";
export type TNeonNodeFileWriteState = "written" | "blocked";
export type TNeonNodeFileWriteBlockReason =
  | "gate-disabled"
  | "not-approved"
  | "missing-scope"
  | "path-escape"
  | "empty-content";

const fileWriteEnabledEnvKey = "NEON_NODE_FILE_WRITE_ENABLED";
const fileWriteScope = "file.write";
const maxFileWriteBytes = 64 * 1024;
const previewMaxLength = 160;

export interface INeonNodeFileWriteGate {
  readonly enabled: boolean;
  readonly reason: TNeonNodeFileWriteGateReason;
  readonly envKey: typeof fileWriteEnabledEnvKey;
}

export interface INeonNodeContainedPath {
  readonly contained: boolean;
  readonly relativePath?: string;
  readonly resolvedPath?: string;
}

export interface INeonNodeFileWriteResult {
  readonly state: TNeonNodeFileWriteState;
  readonly blockReason?: TNeonNodeFileWriteBlockReason;
  readonly gate: INeonNodeFileWriteGate;
  readonly relativePath?: string;
  readonly bytesWritten?: number;
  readonly contentPreview: string;
  readonly safety: { readonly wroteOutsideAllowlistRoot: false; readonly pathEscapeChecked: true };
  readonly diagnostics: readonly string[];
}

export interface IWriteNeonNodeFileOptions {
  readonly allowlistRoot: string;
  readonly requestedPath: string;
  readonly content: string;
  readonly gate: INeonNodeFileWriteGate;
  readonly approved: boolean;
  readonly scopes: readonly string[];
}

const safety = { wroteOutsideAllowlistRoot: false, pathEscapeChecked: true } as const;

export function resolveNeonNodeFileWriteGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonNodeFileWriteGate {
  const enabled = readReadyCutoverEnv(env, fileWriteEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "write-enabled" : "write-disabled",
    envKey: fileWriteEnabledEnvKey
  };
}

/**
 * Resolve `requestedPath` against `allowlistRoot` and reject anything that escapes
 * the root (`..`, or an absolute path outside it). Pure: no I/O.
 */
export function resolveNeonNodeContainedWritePath(
  allowlistRoot: string,
  requestedPath: string
): INeonNodeContainedPath {
  const resolvedRoot = resolve(allowlistRoot);
  const resolvedTarget = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(resolvedRoot, requestedPath);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);

  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    return { contained: false };
  }

  return {
    contained: true,
    relativePath: relativeTarget.split(sep).join("/"),
    resolvedPath: resolvedTarget
  };
}

export async function writeNeonNodeFile(
  options: IWriteNeonNodeFileOptions
): Promise<INeonNodeFileWriteResult> {
  const contentPreview = redactText(options.content.replace(/\s+/g, " ").trim()).slice(0, previewMaxLength);
  const contained = resolveNeonNodeContainedWritePath(options.allowlistRoot, options.requestedPath);

  if (!options.gate.enabled) {
    return blocked("gate-disabled", options.gate, contentPreview, [
      "remote file.write blocked: NEON_NODE_FILE_WRITE_ENABLED is off (default)"
    ]);
  }
  if (!options.approved) {
    return blocked("not-approved", options.gate, contentPreview, [
      "remote file.write blocked: operator approval is required"
    ]);
  }
  if (!options.scopes.includes(fileWriteScope)) {
    return blocked("missing-scope", options.gate, contentPreview, [
      `remote file.write blocked: device session lacks the ${fileWriteScope} scope`
    ]);
  }
  if (!contained.contained || !contained.resolvedPath || !contained.relativePath) {
    return blocked("path-escape", options.gate, contentPreview, [
      "remote file.write blocked: target path escapes the allowlist root"
    ]);
  }
  if (options.content.length === 0) {
    return blocked("empty-content", options.gate, contentPreview, ["remote file.write blocked: empty content"]);
  }

  const payload = options.content.slice(0, maxFileWriteBytes);
  await mkdir(dirname(contained.resolvedPath), { recursive: true });
  await writeFile(contained.resolvedPath, payload, "utf8");

  return {
    state: "written",
    gate: options.gate,
    relativePath: contained.relativePath,
    bytesWritten: Buffer.byteLength(payload, "utf8"),
    contentPreview,
    safety,
    diagnostics: [`wrote ${Buffer.byteLength(payload, "utf8")} byte(s) inside the allowlist root`]
  };
}

export function renderNeonNodeFileWriteReport(result: INeonNodeFileWriteResult): string {
  return [
    `Neonika Node File Write: ${result.state}${result.blockReason ? ` / ${result.blockReason}` : ""} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Path: ${result.relativePath ?? "none"}`,
    `Bytes: ${result.bytesWritten ?? 0}`,
    `Preview: ${result.contentPreview}`,
    `Safety: wroteOutsideAllowlistRoot=${result.safety.wroteOutsideAllowlistRoot} pathEscapeChecked=${result.safety.pathEscapeChecked}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

function blocked(
  blockReason: TNeonNodeFileWriteBlockReason,
  gate: INeonNodeFileWriteGate,
  contentPreview: string,
  diagnostics: readonly string[]
): INeonNodeFileWriteResult {
  return { state: "blocked", blockReason, gate, contentPreview, safety, diagnostics };
}
