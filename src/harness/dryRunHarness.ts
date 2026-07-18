import { redactHarnessEvent, redactText } from "./redaction.js";
import { deriveCodexSessionKey } from "./sessionKey.js";
import type {
  ICodexHarness,
  ICodexHarnessInput,
  ICodexHarnessResult,
  TCodexHarnessEvent
} from "./types.js";

export function createDryRunHarness(): ICodexHarness {
  return {
    id: "codex-app-server",
    run: runDryHarnessTurn
  };
}

async function runDryHarnessTurn(input: ICodexHarnessInput): Promise<ICodexHarnessResult> {
  const sessionKey = deriveCodexSessionKey(input.binding);
  const rawEvents: readonly TCodexHarnessEvent[] = [
    {
      kind: "assistant-delta",
      text: `Neon Codex Harness dry run accepted for ${input.binding.agentId}.`
    },
    {
      kind: "tool-start",
      toolName: "harness-smoke"
    },
    {
      kind: "tool-output",
      toolName: "harness-smoke",
      output: `promptLength=${input.prompt.length} agent=${input.agent?.id ?? input.binding.agentId} memory=${input.memory.state} hits=${input.memory.hitCount}`
    },
    {
      kind: "final",
      text: `Harness ready. Session ${sessionKey}. Agent ${input.agent?.id ?? input.binding.agentId}. Memory ${input.memory.state}.`
    }
  ];
  const events = rawEvents.map(redactHarnessEvent);
  const finalEvent = events[events.length - 1];
  const finalText = finalEvent?.kind === "final" ? finalEvent.text : "Harness dry run completed.";

  return {
    sessionKey,
    memoryState: input.memory.state,
    events,
    finalText: redactText(finalText)
  };
}
