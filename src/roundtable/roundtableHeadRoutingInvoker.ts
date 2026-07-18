/**
 * Neonika Roundtable head-routing invoker — the Live-Arming wiring for a round
 * (spec issue #15, tickets #17/#18/#23).
 *
 * `buildNeonRoundtableConvenedHeads` gives both heads ONE shared invoker, but a
 * real round has two transports: Neo speaks on the `claude` head (`claude -p`),
 * Chaty on the `codex` head (`codex exec`). This module is the "later concern"
 * that `roundtableRound.ts` deferred: a single `INeonLlmInvoker` that routes each
 * request to the correct head transport by its model tag, so the shared-invoker
 * seam stays intact while each head still reaches its own CLI.
 *
 * Two layers, so routing is testable without a spawn:
 * - `createNeonRoundtableHeadRoutingInvoker` is pure over two injected sub-invokers
 *   — a test passes two fakes and asserts a `codex` request reaches the codex fake
 *   and everything else the claude fake. Real varianz (two transports), real seam.
 * - `createNeonRoundtableArmedInvoker` is the thin convenience the CLI uses: it
 *   wires the real gated Claude and Codex invokers (each with its real CLI process
 *   runner) behind the router. Both remain dry-run unless the gate is armed — the
 *   gate is passed straight through, so an unarmed gate yields `called: false` on
 *   both heads exactly as before. This module arms nothing on its own; only a
 *   caller that resolves an armed gate turns it live.
 */

import {
  createNeonClaudeCliLlmInvoker,
  createNeonClaudeCliProcessRunner,
  createNeonCodexCliLlmInvoker,
  createNeonCodexCliProcessRunner,
  type INeonLlmGate,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type TNeonLlmResult
} from "../llm/llmRuntime.js";

export interface ICreateNeonRoundtableHeadRoutingInvokerOptions {
  /** Handles the Claude head (models `haiku` / `sonnet`) — Neo. */
  readonly claude: INeonLlmInvoker;
  /** Handles the Codex head (model `codex`) — Chaty. */
  readonly codex: INeonLlmInvoker;
}

/**
 * Routes each request to the transport that owns its model tag: `codex` -> the
 * codex head, `haiku`/`sonnet` -> the claude head. Pure over its two injected
 * invokers, so the routing decision is exercised by fakes with no real spawn.
 */
export function createNeonRoundtableHeadRoutingInvoker(
  options: ICreateNeonRoundtableHeadRoutingInvokerOptions
): INeonLlmInvoker {
  return {
    invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      return request.model === "codex"
        ? options.codex.invoke(request)
        : options.claude.invoke(request);
    }
  };
}

/**
 * The armed round invoker the CLI injects when the LLM gate is enabled: real
 * gated Claude and Codex invokers, each with its real CLI process runner, behind
 * the router. Passing an unarmed gate keeps both heads dry-run (`called: false`),
 * so this is safe to build unconditionally — but the CLI only builds it once the
 * gate resolves enabled, keeping the shadow-contract default (dry-run) intact.
 */
export function createNeonRoundtableArmedInvoker(gate: INeonLlmGate): INeonLlmInvoker {
  return createNeonRoundtableHeadRoutingInvoker({
    claude: createNeonClaudeCliLlmInvoker({ gate, runner: createNeonClaudeCliProcessRunner() }),
    codex: createNeonCodexCliLlmInvoker({ gate, runner: createNeonCodexCliProcessRunner() })
  });
}
