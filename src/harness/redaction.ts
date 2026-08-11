import type { TCodexHarnessEvent } from "./types.js";
import { truncateUtf16Safe } from "../text/utf16Safe.js";

interface IRedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const redactionRules: readonly IRedactionRule[] = [
  {
    // KEY=VALUE / KEY: VALUE for token/secret/key/password-shaped keys. The `:`
    // alternation also catches `password: hunter2` and `API_KEY: foo`.
    pattern: /\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|APIKEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)[^\s"'`]+/gi,
    replacement: "$1[REDACTED]"
  },
  {
    // URL-embedded credentials: proto://user:pass@host (postgres/https/redis/...).
    // Keeps the scheme + host, drops the userinfo. Runs before bare-token rules so
    // the password segment is gone before any sub-pattern can echo it.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replacement: "$1[REDACTED]@"
  },
  {
    // GitHub personal access tokens: classic ghp_/gho_/ghu_/ghs_/ghr_ + fine-grained github_pat_.
    pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    // Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs-...
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    // Google API keys: AIza + url-safe payload. Lengths vary across Google key families.
    pattern: /\bAIza[0-9A-Za-z_-]{30,50}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    // Bare 3-segment base64url JWTs (header starts with eyJ = base64 of `{"`).
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    pattern: /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    pattern: /\b(M[TA][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})\b/g,
    replacement: "[REDACTED_SECRET]"
  },
  {
    pattern: /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~+/=-]{16,}(?=$|[\s"'`,;])/gi,
    replacement: "$1[REDACTED]"
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{18,}(?=$|[\s"'`,;])/gi,
    replacement: "Bearer [REDACTED]"
  },
  {
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_AWS_ACCESS_KEY_ID]"
  },
  {
    pattern: /\bop:\/\/[^\s"'`]+/gi,
    replacement: "[REDACTED_SECRET_REF]"
  },
  {
    pattern: /\b(Item\s+`)[A-Za-z0-9_-]{16,}(`)/gi,
    replacement: "$1[REDACTED_SECRET_REF]$2"
  },
  {
    pattern: /\b(Vault\s+`)[^`]+(`)/gi,
    replacement: "$1[REDACTED_SECRET_REF]$2"
  }
];

export function redactText(value: string): string {
  return redactionRules.reduce(
    (currentValue, rule) => currentValue.replace(rule.pattern, rule.replacement),
    value
  );
}

// Filesystem roots / path-shaped strings are NOT caught by redactText (they are
// not secret-shaped), but they leak machine layout and usernames, so snapshot
// previews strip them too. Shared by every snapshot projector (activity, indexer,
// transcript) so the path-strip rule lives in exactly one place.
const SNAPSHOT_PATH_PATTERN =
  /(^|[\s"'`=])(?:\/Users\/|\/home\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|[A-Za-z]:\\)[^\s"'`,;]+/g;

export interface IRedactSnapshotTextOptions {
  /** Max length of the returned preview; longer values are truncated with a trailing "...". */
  readonly previewLimit: number;
}

// Leak-safe preview builder for snapshot projections: redactText (secret shapes)
// -> strip filesystem paths -> trim -> truncate to previewLimit. The single source
// of truth for the previously-duplicated redactIndexerText/redactActivityText
// helpers; each call site passes its own previewLimit to keep byte-identical output.
export function redactSnapshotText(value: string, options: IRedactSnapshotTextOptions): string {
  const redacted = redactText(value).replace(SNAPSHOT_PATH_PATTERN, "$1[REDACTED_PATH]").trim();

  if (redacted.length <= options.previewLimit) {
    return redacted;
  }

  return `${truncateUtf16Safe(redacted, options.previewLimit - 3)}...`;
}

export function redactHarnessEvent(event: TCodexHarnessEvent): TCodexHarnessEvent {
  switch (event.kind) {
    case "assistant-delta":
      return { ...event, text: redactText(event.text) };
    case "tool-start":
      return event.toolCallId ? { ...event, toolCallId: redactText(event.toolCallId) } : event;
    case "tool-output":
      return {
        ...event,
        ...(event.toolCallId ? { toolCallId: redactText(event.toolCallId) } : {}),
        output: redactText(event.output)
      };
    case "file-write":
      return event;
    case "command-exit":
      return { ...event, command: redactText(event.command) };
    case "token-usage":
      return event;
    case "final":
      return { ...event, text: redactText(event.text) };
    case "failed":
      return { ...event, message: redactText(event.message) };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
