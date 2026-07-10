import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createNeonFallbackLlmInvoker,
  type INeonLlmFallbackEvent,
  type INeonLlmInvoker,
  type INeonLlmRequest,
  type TNeonLlmResult
} from "../src/index.js";

function scriptedInvoker(
  script: (request: INeonLlmRequest) => TNeonLlmResult,
  calls: INeonLlmRequest[]
): INeonLlmInvoker {
  return {
    invoke(request) {
      calls.push(request);
      return Promise.resolve(script(request));
    }
  };
}

describe("Neon LLM fallback invoker", () => {
  it("passes gate-closed non-calls through without a fallback attempt", async () => {
    const calls: INeonLlmRequest[] = [];
    const invoker = createNeonFallbackLlmInvoker({
      invoker: scriptedInvoker(
        (request) => ({ called: false, model: request.model, reason: "llm-gate-closed" }),
        calls
      )
    });

    const result = await invoker.invoke({ prompt: "p", model: "haiku" });
    assert.equal(result.called, false);
    assert.ok(!result.called);
    assert.equal(result.reason, "llm-gate-closed");
    assert.equal(calls.length, 1);
  });

  it("escalates a genuine call failure to the fallback model", async () => {
    const calls: INeonLlmRequest[] = [];
    const events: INeonLlmFallbackEvent[] = [];
    const invoker = createNeonFallbackLlmInvoker({
      invoker: scriptedInvoker(
        (request) =>
          request.model === "haiku"
            ? { called: false, model: "haiku", reason: "llm-call-failed-exit-1" }
            : { called: true, model: "sonnet", text: "Zusammenfassung vom stärkeren Modell." },
        calls
      ),
      onFallback: (event) => events.push(event)
    });

    const result = await invoker.invoke({ prompt: "p", model: "haiku" });
    assert.ok(result.called);
    assert.equal(result.model, "sonnet");
    assert.equal(calls.length, 2);
    assert.deepEqual(events, [{ from: "haiku", to: "sonnet", reason: "call-failed" }]);
  });

  it("escalates on a quality reject of called output", async () => {
    const calls: INeonLlmRequest[] = [];
    const events: INeonLlmFallbackEvent[] = [];
    const invoker = createNeonFallbackLlmInvoker({
      invoker: scriptedInvoker(
        (request) =>
          request.model === "haiku"
            ? { called: true, model: "haiku", text: "Okay, hier ist eine Zusammenfassung:" }
            : { called: true, model: "sonnet", text: "- Substanzieller Inhalt" },
        calls
      ),
      shouldFallback: (text) => text.startsWith("Okay,"),
      onFallback: (event) => events.push(event)
    });

    const result = await invoker.invoke({ prompt: "p", model: "haiku" });
    assert.ok(result.called);
    assert.equal(result.model, "sonnet");
    assert.deepEqual(events, [{ from: "haiku", to: "sonnet", reason: "quality-reject" }]);
  });

  it("returns good primary output without escalation", async () => {
    const calls: INeonLlmRequest[] = [];
    const invoker = createNeonFallbackLlmInvoker({
      invoker: scriptedInvoker(
        () => ({ called: true, model: "haiku", text: "- Sauberer Stichpunkt" }),
        calls
      ),
      shouldFallback: () => false
    });

    const result = await invoker.invoke({ prompt: "p", model: "haiku" });
    assert.ok(result.called);
    assert.equal(result.model, "haiku");
    assert.equal(calls.length, 1);
  });

  it("never self-falls-back when the request already targets the fallback model", async () => {
    const calls: INeonLlmRequest[] = [];
    const invoker = createNeonFallbackLlmInvoker({
      invoker: scriptedInvoker(
        () => ({ called: false, model: "sonnet", reason: "llm-call-failed-exit-1" }),
        calls
      )
    });

    const result = await invoker.invoke({ prompt: "p", model: "sonnet" });
    assert.equal(result.called, false);
    assert.equal(calls.length, 1);
  });

  it("returns the fallback failure when both attempts fail", async () => {
    const calls: INeonLlmRequest[] = [];
    const invoker = createNeonFallbackLlmInvoker({
      invoker: scriptedInvoker(
        (request) => ({
          called: false,
          model: request.model,
          reason: "llm-call-failed-exit-1"
        }),
        calls
      )
    });

    const result = await invoker.invoke({ prompt: "p", model: "haiku" });
    assert.equal(result.called, false);
    assert.ok(!result.called);
    assert.equal(result.model, "sonnet");
    assert.equal(calls.length, 2);
  });
});
