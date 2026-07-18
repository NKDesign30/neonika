import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createNeonRoundtableHeadRoutingInvoker,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type TNeonLlmResult
} from "../src/index.js";

// A recording sub-invoker: notes which head+model it saw, never spawns.
function recordingInvoker(label: string, calls: string[]): INeonLlmInvoker {
  return {
    invoke(request: INeonLlmRequest): Promise<TNeonLlmResult> {
      calls.push(`${label}:${request.model}`);
      return Promise.resolve({ called: true, model: request.model, text: `${label} answered` });
    }
  };
}

test("routes the codex model to the codex head only", async () => {
  const calls: string[] = [];
  const invoker = createNeonRoundtableHeadRoutingInvoker({
    claude: recordingInvoker("claude", calls),
    codex: recordingInvoker("codex", calls)
  });

  const result = await invoker.invoke({ prompt: "p", model: "codex" });

  assert.deepEqual(calls, ["codex:codex"]);
  assert.equal(result.called, true);
});

test("routes claude-head models (sonnet, haiku) to the claude head only", async () => {
  const calls: string[] = [];
  const invoker = createNeonRoundtableHeadRoutingInvoker({
    claude: recordingInvoker("claude", calls),
    codex: recordingInvoker("codex", calls)
  });

  await invoker.invoke({ prompt: "p", model: "sonnet" });
  await invoker.invoke({ prompt: "p", model: "haiku" });

  assert.deepEqual(calls, ["claude:sonnet", "claude:haiku"]);
});

test("passes a dry-run sub-invoker result straight through (no arming of its own)", async () => {
  const dryRun: INeonLlmInvoker = {
    invoke: (request) =>
      Promise.resolve({ called: false, model: request.model, reason: "llm-dry-run-no-call" })
  };
  const invoker = createNeonRoundtableHeadRoutingInvoker({ claude: dryRun, codex: dryRun });

  const claudeResult = await invoker.invoke({ prompt: "p", model: "sonnet" });
  const codexResult = await invoker.invoke({ prompt: "p", model: "codex" });

  assert.equal(claudeResult.called, false);
  assert.equal(codexResult.called, false);
});
