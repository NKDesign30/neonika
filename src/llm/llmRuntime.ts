import { spawn } from "node:child_process";
import { readReadyCutoverEnv } from "../core/cutover.js";

// Neonika LLM runtime seam — the first model-call path in Neonika. It mirrors the
// outboundSender / memoryWriteRuntime gating discipline exactly: a no-op default
// that can NEVER call a model (the dry-run result type forbids `called: true` by
// construction), and a gated implementation that can only spawn when BOTH an env
// gate is armed AND a process runner is explicitly injected. With no injected
// runner, a real call is constructively impossible regardless of the flag.
//
// Hard rule (Neo core rule 15 / CLAUDE.md / AGENTS.md): the ONLY allowed model
// call is the `claude -p` Max-Plan CLI (or Codex CLI). NEVER api.anthropic.com,
// never a paid SDK. The real runner here spawns the `claude` binary — never HTTP.

// Head-tagged model axis. A round embodies two heads (spec #15): Neo on the
// `claude` head, Chaty on the `codex` head. The union widens the seam to cover
// both without muddying their identities — each head has its own CLI transport
// and its own model space, joined only at the `INeonLlmRequest` boundary.
export type TNeonClaudeModel = "haiku" | "sonnet";
export type TNeonCodexModel = "codex";
export type TNeonLlmModel = TNeonClaudeModel | TNeonCodexModel;

const llmEnabledEnvKey = "NEON_TRANSCRIPT_LLM_ENABLED";

export type TNeonLlmGateReason = "llm-disabled" | "llm-enabled";

export interface INeonLlmGate {
  readonly enabled: boolean;
  readonly reason: TNeonLlmGateReason;
  readonly envKey: typeof llmEnabledEnvKey;
}

export interface INeonLlmRequest {
  readonly prompt: string;
  readonly model: TNeonLlmModel;
}

// Discriminated union: the dry-run / blocked path is `called: false` and the type
// makes setting `called: true` on it a compile error — the no-call invariant is
// enforced by the type, not by discipline.
export interface INeonLlmNotCalledResult {
  readonly called: false;
  readonly model: TNeonLlmModel;
  readonly reason: string;
}

export interface INeonLlmCalledResult {
  readonly called: true;
  readonly model: TNeonLlmModel;
  readonly text: string;
}

export type TNeonLlmResult = INeonLlmNotCalledResult | INeonLlmCalledResult;

export interface INeonLlmInvoker {
  invoke(request: INeonLlmRequest): Promise<TNeonLlmResult>;
}

export interface INeonLlmProcessResult {
  readonly stdout: string;
  readonly exitCode: number;
}

// The spawn boundary, injectable so tests never spawn a real model. The default
// real runner is `createNeonClaudeCliProcessRunner` and is only used when a caller
// explicitly opts in.
export interface INeonLlmProcessRunner {
  run(request: INeonLlmRequest): Promise<INeonLlmProcessResult>;
}

export function resolveNeonLlmGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonLlmGate {
  const enabled = readReadyCutoverEnv(env, llmEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "llm-enabled" : "llm-disabled",
    envKey: llmEnabledEnvKey
  };
}

// No-op default invoker. Never spawns, always `called: false`. This is what every
// caller gets unless they deliberately construct the gated invoker with a runner.
export function createNeonDryRunLlmInvoker(): INeonLlmInvoker {
  return {
    invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      return Promise.resolve({
        called: false,
        model: request.model,
        reason: "llm-dry-run-no-call"
      });
    }
  };
}

export interface ICreateNeonCliLlmInvokerOptions {
  readonly gate: INeonLlmGate;
  /** Injected process boundary. Omitted -> a real call is constructively impossible. */
  readonly runner?: INeonLlmProcessRunner;
}

// Both heads share the same gate discipline; only the injected runner differs.
export type ICreateNeonClaudeCliLlmInvokerOptions = ICreateNeonCliLlmInvokerOptions;
export type ICreateNeonCodexCliLlmInvokerOptions = ICreateNeonCliLlmInvokerOptions;

// Head-agnostic gated invoker body. A real model call requires the env gate
// armed AND an injected runner; either missing yields `called: false`. Even when
// armed it only ever reaches the injected runner (a `claude -p` / `codex exec`
// CLI spawn), never an HTTP endpoint. The Claude and Codex factories below are
// thin wrappers so both heads sit on one identical, testable seam.
function createGatedCliLlmInvoker(options: ICreateNeonCliLlmInvokerOptions): INeonLlmInvoker {
  return {
    async invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      if (!options.gate.enabled) {
        return { called: false, model: request.model, reason: "llm-gate-closed" };
      }
      if (!options.runner) {
        return { called: false, model: request.model, reason: "llm-no-runner-injected" };
      }

      const result = await options.runner.run(request);
      if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
        return {
          called: false,
          model: request.model,
          reason: `llm-call-failed-exit-${result.exitCode}`
        };
      }

      return { called: true, model: request.model, text: result.stdout.trim() };
    }
  };
}

// Claude head (Neo). Inject `createNeonClaudeCliProcessRunner` to arm a real spawn.
export function createNeonClaudeCliLlmInvoker(
  options: ICreateNeonClaudeCliLlmInvokerOptions
): INeonLlmInvoker {
  return createGatedCliLlmInvoker(options);
}

// Codex head (Chaty). Same seam, same gate; inject `createNeonCodexCliProcessRunner`
// to arm a real `codex exec` spawn. Dry-run by default like the Claude head.
export function createNeonCodexCliLlmInvoker(
  options: ICreateNeonCodexCliLlmInvokerOptions
): INeonLlmInvoker {
  return createGatedCliLlmInvoker(options);
}

const claudeModelArg: Record<TNeonClaudeModel, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-4-6"
};

function isClaudeModel(model: TNeonLlmModel): model is TNeonClaudeModel {
  return model === "haiku" || model === "sonnet";
}

// Real process runner: spawns the `claude -p` Max-Plan CLI over stdin/stdout.
// Never used by default — a caller must inject it into the gated invoker. The
// prompt goes via stdin (not argv) so it cannot leak into the process table.
export function createNeonClaudeCliProcessRunner(): INeonLlmProcessRunner {
  return {
    run(request: INeonLlmRequest): Promise<INeonLlmProcessResult> {
      // Defensive narrowing: the Claude runner only maps Claude-head models. A
      // codex model here is a caller wiring error, not a spawn — return a
      // constructive no-call (the gated invoker maps it to llm-call-failed).
      if (!isClaudeModel(request.model)) {
        return Promise.resolve({ stdout: "", exitCode: 1 });
      }
      const model = request.model;
      return new Promise<INeonLlmProcessResult>((resolve) => {
        const child = spawn("claude", ["-p", "--model", claudeModelArg[model]], {
          stdio: ["pipe", "pipe", "ignore"]
        });

        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.on("error", () => {
          resolve({ stdout: "", exitCode: 1 });
        });
        child.on("close", (code) => {
          resolve({ stdout, exitCode: code ?? 1 });
        });

        child.stdin.write(request.prompt);
        child.stdin.end();
      });
    }
  };
}

// Real process runner for the Codex head (Chaty): spawns the `codex exec` CLI
// (Max-Plan Codex, never a paid SDK). Never used by default — a caller must
// inject it into the gated Codex invoker. Mirrors the Claude runner: the prompt
// is fed over stdin via the `-` argument (never argv, so it cannot leak into the
// process table). `--sandbox read-only` keeps a discussion head from mutating
// the repo even once armed; v1 uses the codex-configured model (no `-m` pin, so
// no brittle model id) and returns raw stdout — codex exec prints the whole
// verbose session, not just the final answer. Extracting the clean last message
// (`--output-last-message` writes it to a file, so that needs a temp-file dance,
// or `--json` event parsing) is a later refinement when the round wires turns.
export function createNeonCodexCliProcessRunner(): INeonLlmProcessRunner {
  return {
    run(request: INeonLlmRequest): Promise<INeonLlmProcessResult> {
      return new Promise<INeonLlmProcessResult>((resolve) => {
        const child = spawn("codex", ["exec", "--sandbox", "read-only", "-"], {
          stdio: ["pipe", "pipe", "ignore"]
        });

        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.on("error", () => {
          resolve({ stdout: "", exitCode: 1 });
        });
        child.on("close", (code) => {
          resolve({ stdout, exitCode: code ?? 1 });
        });

        child.stdin.write(request.prompt);
        child.stdin.end();
      });
    }
  };
}

export function renderNeonLlmGateReport(gate: INeonLlmGate): string {
  return [
    `Neonika LLM gate: ${gate.reason} (env ${gate.envKey})`,
    `Enabled: ${gate.enabled}`,
    "Transport: claude -p / codex exec Max-Plan CLI only (never api.anthropic.com, never a paid SDK)",
    "Default invoker: dry-run (called=false); a real call needs the gate armed AND an injected runner"
  ].join("\n");
}
