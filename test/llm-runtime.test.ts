import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createNeonClaudeCliLlmInvoker,
  createNeonClaudeCliProcessRunner,
  createNeonCodexCliLlmInvoker,
  createNeonCodexCliProcessRunner,
  createNeonDryRunLlmInvoker,
  resolveNeonLlmGate,
  type INeonLlmProcessRunner,
  type INeonLlmRequest
} from "../src/index.js";

// S2: the gated LLM seam. No test spawns a real model — the process boundary is a
// fake runner. The whole point is proving the default is constructively no-call.
const REQUEST: INeonLlmRequest = { prompt: "summarize this session", model: "haiku" };

function fakeRunner(stdout: string, exitCode = 0): INeonLlmProcessRunner {
  return {
    run() {
      return Promise.resolve({ stdout, exitCode });
    }
  };
}

describe("Neonika LLM runtime seam (S2)", () => {
  it("resolves the gate off by default and on only for ready-shaped env", () => {
    assert.equal(resolveNeonLlmGate({}).enabled, false);
    assert.equal(resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" }).enabled, true);
    assert.equal(resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "maybe" }).enabled, false);
  });

  it("dry-run invoker never calls, regardless of input", async () => {
    const result = await createNeonDryRunLlmInvoker().invoke(REQUEST);
    assert.equal(result.called, false);
    if (!result.called) {
      assert.equal(result.reason, "llm-dry-run-no-call");
    }
  });

  it("gated invoker stays no-call when the gate is closed, even with a runner present", async () => {
    const invoker = createNeonClaudeCliLlmInvoker({
      gate: resolveNeonLlmGate({}),
      runner: fakeRunner("should never be reached")
    });
    const result = await invoker.invoke(REQUEST);
    assert.equal(result.called, false);
    if (!result.called) {
      assert.equal(result.reason, "llm-gate-closed");
    }
  });

  it("gated invoker stays no-call when armed but no runner is injected", async () => {
    const invoker = createNeonClaudeCliLlmInvoker({
      gate: resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" })
    });
    const result = await invoker.invoke(REQUEST);
    assert.equal(result.called, false);
    if (!result.called) {
      assert.equal(result.reason, "llm-no-runner-injected");
    }
  });

  it("calls only when armed AND a runner is injected, returning the trimmed text", async () => {
    const invoker = createNeonClaudeCliLlmInvoker({
      gate: resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" }),
      runner: fakeRunner("  a concise summary\n")
    });
    const result = await invoker.invoke(REQUEST);
    assert.equal(result.called, true);
    if (result.called) {
      assert.equal(result.text, "a concise summary");
      assert.equal(result.model, "haiku");
    }
  });

  it("treats a non-zero exit or empty output as a failed (no-call) result", async () => {
    const armed = resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" });
    const failed = await createNeonClaudeCliLlmInvoker({ gate: armed, runner: fakeRunner("", 1) }).invoke(REQUEST);
    assert.equal(failed.called, false);

    const empty = await createNeonClaudeCliLlmInvoker({ gate: armed, runner: fakeRunner("   ", 0) }).invoke(REQUEST);
    assert.equal(empty.called, false);
  });
});

// Ticket #17: the Codex head sits on the exact same gated seam as the Claude head.
// Same fake-runner discipline — no test ever spawns a real `codex exec` process.
const CODEX_REQUEST: INeonLlmRequest = { prompt: "weigh in on the tradeoff", model: "codex" };

describe("Neonika Codex head LLM invoker (ticket #17)", () => {
  it("is dry-run by default: gate closed stays no-call even with a runner present", async () => {
    const invoker = createNeonCodexCliLlmInvoker({
      gate: resolveNeonLlmGate({}),
      runner: fakeRunner("should never be reached")
    });
    const result = await invoker.invoke(CODEX_REQUEST);
    assert.equal(result.called, false);
    if (!result.called) {
      assert.equal(result.reason, "llm-gate-closed");
    }
  });

  it("stays no-call when armed but no runner is injected", async () => {
    const invoker = createNeonCodexCliLlmInvoker({
      gate: resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" })
    });
    const result = await invoker.invoke(CODEX_REQUEST);
    assert.equal(result.called, false);
    if (!result.called) {
      assert.equal(result.reason, "llm-no-runner-injected");
    }
  });

  it("calls only when armed AND a runner is injected, returning the trimmed codex text", async () => {
    const invoker = createNeonCodexCliLlmInvoker({
      gate: resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" }),
      runner: fakeRunner("  a pragmatic counter-take\n")
    });
    const result = await invoker.invoke(CODEX_REQUEST);
    assert.equal(result.called, true);
    if (result.called) {
      assert.equal(result.text, "a pragmatic counter-take");
      assert.equal(result.model, "codex");
    }
  });

  it("treats a non-zero exit or empty codex output as a failed (no-call) result", async () => {
    const armed = resolveNeonLlmGate({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" });
    const failed = await createNeonCodexCliLlmInvoker({ gate: armed, runner: fakeRunner("", 1) }).invoke(CODEX_REQUEST);
    assert.equal(failed.called, false);

    const empty = await createNeonCodexCliLlmInvoker({ gate: armed, runner: fakeRunner("   ", 0) }).invoke(CODEX_REQUEST);
    assert.equal(empty.called, false);
  });

  it("exposes a codex process runner factory without spawning it", () => {
    const runner = createNeonCodexCliProcessRunner();
    assert.equal(typeof runner.run, "function");
  });

  it("guards the Claude runner against a codex model: constructive no-call, no spawn", async () => {
    // A codex model handed to the Claude runner is a wiring error, not a spawn.
    // The guard returns exit 1 synchronously — no `claude` process is launched.
    const result = await createNeonClaudeCliProcessRunner().run(CODEX_REQUEST);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
  });
});
