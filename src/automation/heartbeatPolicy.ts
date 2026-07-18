// Read-only heartbeat-response classifier (parity gap row 404).
//
// Pure predicates over text — no timers, no wake-lane emission, no send, no I/O.
// Mirrors the shape of upstream `src/auto-reply/heartbeat-filter.ts` +
// `src/cron/heartbeat-policy.ts`: an agent woken by a heartbeat poll replies with a
// `HEARTBEAT_OK` token (or effectively-empty content) when nothing needs attention,
// and that response should be suppressed instead of delivered. Rebuilt native; the
// live wake lane / OK-suppression wiring stays gated (cron timer + cutover).

export const NEON_HEARTBEAT_OK_TOKEN = "HEARTBEAT_OK";
export const NEON_HEARTBEAT_POLL_MARKER = "[neon heartbeat poll]";

export type TNeonHeartbeatVerdict = "ok-suppress" | "actionable";

export type TNeonHeartbeatReason =
  | "empty"
  | "ok-token"
  | "ok-token-with-empty-remainder"
  | "markdown-skeleton"
  | "actionable-content";

export interface INeonHeartbeatClassification {
  readonly verdict: TNeonHeartbeatVerdict;
  readonly reason: TNeonHeartbeatReason;
  /** Length of the real content left after stripping the OK token + whitespace. */
  readonly residualLength: number;
}

const OK_TOKEN_PATTERN = new RegExp(`\\b${NEON_HEARTBEAT_OK_TOKEN}\\b`, "giu");

function stripOkToken(text: string): string {
  return text.replace(OK_TOKEN_PATTERN, " ").replace(/\s+/gu, " ").trim();
}

// A line that carries no real content: blank, a bare markdown header (`#`), an empty
// bullet/checkbox (`-`, `* [ ]`), or a code-fence delimiter. Mirrors upstream's
// `isHeartbeatContentEffectivelyEmpty`.
function isSkeletonLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (/^#+(\s|$)/u.test(trimmed)) return true;
  if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/u.test(trimmed)) return true;
  if (/^```[A-Za-z0-9_-]*$/u.test(trimmed)) return true;
  return false;
}

export function isNeonHeartbeatContentEffectivelyEmpty(content: string): boolean {
  return content.split("\n").every((line) => isSkeletonLine(line));
}

export function classifyNeonHeartbeatResponse(text: string): INeonHeartbeatClassification {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { verdict: "ok-suppress", reason: "empty", residualLength: 0 };
  }

  const hasOkToken = new RegExp(`\\b${NEON_HEARTBEAT_OK_TOKEN}\\b`, "iu").test(trimmed);
  if (hasOkToken) {
    const residual = stripOkToken(trimmed);
    if (residual.length === 0) {
      const reason: TNeonHeartbeatReason =
        trimmed.toUpperCase() === NEON_HEARTBEAT_OK_TOKEN ? "ok-token" : "ok-token-with-empty-remainder";
      return { verdict: "ok-suppress", reason, residualLength: 0 };
    }
    if (isNeonHeartbeatContentEffectivelyEmpty(residual)) {
      return { verdict: "ok-suppress", reason: "markdown-skeleton", residualLength: 0 };
    }
    return { verdict: "actionable", reason: "actionable-content", residualLength: residual.length };
  }

  if (isNeonHeartbeatContentEffectivelyEmpty(trimmed)) {
    return { verdict: "ok-suppress", reason: "markdown-skeleton", residualLength: 0 };
  }

  return { verdict: "actionable", reason: "actionable-content", residualLength: trimmed.length };
}

/** True when the agent's heartbeat response carries nothing to deliver (OK / no-op). */
export function isNeonHeartbeatOkResponse(text: string): boolean {
  return classifyNeonHeartbeatResponse(text).verdict === "ok-suppress";
}

/**
 * True when an inbound message is a synthetic heartbeat wake poll rather than a real
 * user message. An optional configured heartbeat prompt is matched exactly (trimmed)
 * in addition to the default poll marker.
 */
export function isNeonHeartbeatUserMessage(text: string, heartbeatPrompt?: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.toLowerCase() === NEON_HEARTBEAT_POLL_MARKER) {
    return true;
  }
  const prompt = heartbeatPrompt?.trim();
  return prompt !== undefined && prompt.length > 0 && trimmed === prompt;
}

export function renderNeonHeartbeatClassificationReport(classification: INeonHeartbeatClassification): string {
  return (
    `Neon heartbeat: ${classification.verdict} (${classification.reason}, ` +
    `residual=${classification.residualLength} char(s))`
  );
}
