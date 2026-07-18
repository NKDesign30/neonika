import { createHash } from "node:crypto";
import { execFile } from "node:child_process";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { isOnePasswordSecretRef, parseOnePasswordSecretRef } from "./secretRefs.js";

/**
 * Gated 1Password secret-ref resolution (DP-13, secret half).
 *
 * Neonika counts/displays `op://` refs read-only and never resolves them. This
 * adds the gated resolution path: behind `NEON_SECRET_RESOLUTION_ENABLED` (default-off)
 * it shells out to the `op` CLI to resolve ONE ref. The resolved value is the one thing
 * that must never leak — so it is NEVER returned in the result, logged, or persisted.
 * The result carries only a leak-safe descriptor (value length + a short sha256
 * fingerprint, which proves a value was resolved without revealing it). The raw value
 * is optionally handed to a transient `consume` callback and then dropped. Resolving
 * real credentials is a deliberate operator decision (the flag); Neon never resolves by
 * default.
 */
export type TNeonSecretResolutionGateReason = "resolution-disabled" | "resolution-enabled";
export type TNeonSecretResolutionState = "resolved" | "blocked";
export type TNeonSecretResolutionBlockReason =
  | "gate-disabled"
  | "not-a-ref"
  | "invalid-timeout"
  | "resolution-failed";

const secretResolutionEnabledEnvKey = "NEON_SECRET_RESOLUTION_ENABLED";
const fingerprintLength = 16;

export interface INeonSecretResolutionGate {
  readonly enabled: boolean;
  readonly reason: TNeonSecretResolutionGateReason;
  readonly envKey: typeof secretResolutionEnabledEnvKey;
}

export interface INeonOpCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type TNeonOpRunner = (ref: string) => Promise<INeonOpCommandResult>;

export interface INeonSecretResolutionResult {
  readonly state: TNeonSecretResolutionState;
  readonly blockReason?: TNeonSecretResolutionBlockReason;
  readonly gate: INeonSecretResolutionGate;
  readonly refRedacted: string;
  readonly valueLength?: number;
  readonly valueFingerprint?: string;
  readonly valuePersisted: false;
  readonly valueLogged: false;
  readonly safety: { readonly secretInResult: false };
  readonly diagnostics: readonly string[];
}

export interface IResolveNeonSecretRefOptions {
  readonly ref: string;
  readonly gate: INeonSecretResolutionGate;
  readonly runOp?: TNeonOpRunner;
  /** Transient consumer for the raw value. It is called once and never stored. */
  readonly consume?: (value: string) => void;
  readonly timeoutMs?: number;
}

const safety = { secretInResult: false } as const;

export function resolveNeonSecretResolutionGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonSecretResolutionGate {
  const enabled = readReadyCutoverEnv(env, secretResolutionEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "resolution-enabled" : "resolution-disabled",
    envKey: secretResolutionEnabledEnvKey
  };
}

export async function resolveNeonSecretRef(
  options: IResolveNeonSecretRefOptions
): Promise<INeonSecretResolutionResult> {
  const refRedacted = redactSecretRef(options.ref);

  if (!options.gate.enabled) {
    return blocked("gate-disabled", options.gate, refRedacted, [
      "secret resolution blocked: NEON_SECRET_RESOLUTION_ENABLED is off (default)"
    ]);
  }
  if (!isOnePasswordSecretRef(options.ref)) {
    return blocked("not-a-ref", options.gate, refRedacted, [
      "secret resolution blocked: not a valid op:// reference"
    ]);
  }

  const timeoutMs = options.timeoutMs ?? 6_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return blocked("invalid-timeout", options.gate, refRedacted, [
      "secret resolution blocked: timeoutMs must be a positive integer"
    ]);
  }

  const runOp = options.runOp ?? createDefaultOpRunner(timeoutMs);
  const result = await runOp(options.ref);
  const value = result.stdout.replace(/\n+$/, "");

  if (result.exitCode !== 0 || value.length === 0) {
    // Never surface stderr verbatim — it can echo the ref or environment details.
    return blocked("resolution-failed", options.gate, refRedacted, [
      `secret resolution failed (op exit ${result.exitCode})`
    ]);
  }

  // Use the value transiently, then drop it. It never enters the result/state/log.
  options.consume?.(value);
  const valueFingerprint = createHash("sha256").update(value).digest("hex").slice(0, fingerprintLength);
  const valueLength = value.length;

  return {
    state: "resolved",
    gate: options.gate,
    refRedacted,
    valueLength,
    valueFingerprint,
    valuePersisted: false,
    valueLogged: false,
    safety,
    diagnostics: ["secret resolved into process and consumed transiently; value not returned, logged, or persisted"]
  };
}

export function renderNeonSecretResolutionReport(result: INeonSecretResolutionResult): string {
  return [
    `Neonika Secret Resolution: ${result.state}${result.blockReason ? ` / ${result.blockReason}` : ""} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Ref: ${result.refRedacted}`,
    `Value length: ${result.valueLength ?? "n/a"}`,
    `Value fingerprint: ${result.valueFingerprint ?? "n/a"}`,
    `Safety: secretInResult=${result.safety.secretInResult} valuePersisted=${result.valuePersisted} valueLogged=${result.valueLogged}`,
    ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)
  ].join("\n");
}

/** Redact an op:// ref to vault/item/field shape without the resolved value (the ref itself is not a secret). */
function redactSecretRef(ref: string): string {
  const parts = parseOnePasswordSecretRef(ref);
  if (!parts) {
    return "op://<invalid-ref>";
  }
  return `op://${parts.vault}/${parts.item}/${parts.field}`;
}

function createDefaultOpRunner(timeoutMs: number): TNeonOpRunner {
  return (ref) =>
    new Promise<INeonOpCommandResult>((resolveCommand) => {
      execFile(
        "op",
        ["read", ref],
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 },
        (error, stdout, stderr) => {
          resolveCommand({
            exitCode: error && typeof error.code === "number" ? error.code : error ? 1 : 0,
            stdout,
            stderr
          });
        }
      );
    });
}

function blocked(
  blockReason: TNeonSecretResolutionBlockReason,
  gate: INeonSecretResolutionGate,
  refRedacted: string,
  diagnostics: readonly string[]
): INeonSecretResolutionResult {
  return {
    state: "blocked",
    blockReason,
    gate,
    refRedacted,
    valuePersisted: false,
    valueLogged: false,
    safety,
    diagnostics
  };
}
