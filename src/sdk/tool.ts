// Neon SDK — Tool surface.
//
// Curated, stable contract for tool execution and tool-call projection: the
// persisted harness event union (assistant-delta / tool-start / tool-output /
// file-write / command-exit / token-usage / final / failed), the harness
// run contract and its input/result/attachment shapes, the read-only
// skill->tool invocation derivation, and the leak-safe chat tool-card render.
// Thin re-export facade over `harness/types.ts`, `skills/skillInvocation.ts`,
// and `gateway/chatTranscript.ts` — no behavior, no code moved.

// Harness run + event contract.
export type {
  IAgentAttachment,
  ICodexHarness,
  ICodexHarnessInput,
  ICodexHarnessResult,
  ICodexSessionBinding,
  IMemoryAttachment,
  IMemoryExcerpt,
  TAgentRuntime,
  TCodexHarnessEvent,
  THarnessRunMode,
  TMemoryAttachmentState
} from "../harness/types.js";

// Read-only skill -> tool invocation derivation.
export { deriveNeonSkillInvocation } from "../skills/skillInvocation.js";

export type {
  INeonSkillInvocation,
  INeonSkillInvocationInput,
  TNeonSkillInvocationState
} from "../skills/skillInvocation.js";

// Leak-safe tool-card render for chat transcripts.
export { renderNeonChatToolCard } from "../gateway/chatTranscript.js";

export type { INeonChatToolEvent } from "../gateway/chatTranscript.js";

// Tool-capability/catalog/policy/inventory domain. Bundled wholesale via
// `export *` so this surface stays the one tool contract import and tracks the
// domain modules without per-symbol coupling to their churn.
export * from "../tools/toolCapabilities.js";
export * from "../tools/toolCatalog.js";
export * from "../tools/toolPolicy.js";
export * from "../tools/neonTools.js";
