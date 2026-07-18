// Read-only static security scan for skill bodies.
//
// Ported from OpenClaw's skill scanner (`src/skills/security/scanner.ts`,
// `scanSource`). OpenClaw scans sibling skill *scripts* (`.js`/`.ts`); Neonika
// currently only ingests `SKILL.md` bodies, so this slice applies the same
// pattern set to the SKILL.md body that the inventory already reads. Scanning
// bundled skill scripts is a deliberately separate, larger slice (would need a
// directory walk). This module performs NO code execution and NO file I/O — it
// only matches text patterns against a string already in hand.
//
// Leak boundary: the per-finding result carries the rule id, severity, the
// skill's own file path and a 1-based line number plus a static rule message —
// never the matched source text (no `evidence`). The aggregated summary that the
// inventory embeds carries only `{ ruleId, severity, count }`, matching the
// established `suspiciousFindings` convention so no raw body content reaches a
// snapshot.
// See THIRD_PARTY_NOTICES.md for attribution.

export type TNeonSkillScanSeverity = "info" | "warn" | "critical";

export type TNeonSkillScanRuleId =
  | "dangerous-exec"
  | "dynamic-code-execution"
  | "crypto-mining"
  | "suspicious-network"
  | "potential-exfiltration"
  | "obfuscated-code"
  | "env-harvesting";

export interface INeonSkillScanFinding {
  readonly ruleId: TNeonSkillScanRuleId;
  readonly severity: TNeonSkillScanSeverity;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface INeonSkillSecurityFinding {
  readonly ruleId: TNeonSkillScanRuleId;
  readonly severity: TNeonSkillScanSeverity;
  readonly count: number;
}

export type TNeonSkillSecurityState = "clean" | "flagged" | "unscanned";

/** Structural shape of a sibling-script scan result (see `skillScriptScan.ts`). */
export interface INeonSkillScriptScanInput {
  readonly scannedFiles: number;
  readonly truncated: boolean;
  readonly findings: readonly INeonSkillScanFinding[];
}

export interface INeonSkillSecuritySummary {
  readonly state: TNeonSkillSecurityState;
  readonly critical: number;
  readonly warn: number;
  readonly info: number;
  /** Number of sibling script files scanned (the SKILL.md body is always scanned). */
  readonly scannedScripts: number;
  readonly scriptsTruncated: boolean;
  readonly findings: readonly INeonSkillSecurityFinding[];
}

interface ILineRule {
  readonly ruleId: TNeonSkillScanRuleId;
  readonly severity: TNeonSkillScanSeverity;
  readonly message: string;
  readonly pattern: RegExp;
  /** If set, the rule only fires when the full source also matches this pattern. */
  readonly requiresContext?: RegExp;
}

interface ISourceRule {
  readonly ruleId: TNeonSkillScanRuleId;
  readonly severity: TNeonSkillScanSeverity;
  readonly message: string;
  /** Primary pattern tested against the full (comment-stripped) source. */
  readonly pattern: RegExp;
  /** Secondary context pattern; both must match for the rule to fire. */
  readonly requiresContext?: RegExp;
  /** If set, secondary context must be within this many lines of the primary match. */
  readonly requiresContextWindowLines?: number;
}

const STANDARD_PORTS = new Set([80, 443, 8080, 8443, 3000]);
const NETWORK_SEND_CONTEXT_PATTERN = /\bfetch\s*\(|\bpost\s*\(|\.\s*post\s*\(|http\.request\s*\(/i;

const LINE_RULES: readonly ILineRule[] = [
  {
    ruleId: "dangerous-exec",
    severity: "critical",
    message: "Shell command execution detected (child_process)",
    pattern: /\b(exec|execSync|spawn|spawnSync|execFile|execFileSync)\s*\(/,
    requiresContext: /child_process/
  },
  {
    ruleId: "dynamic-code-execution",
    severity: "critical",
    message: "Dynamic code execution detected",
    pattern: /\beval\s*\(|new\s+Function\s*\(/
  },
  {
    ruleId: "crypto-mining",
    severity: "critical",
    message: "Possible crypto-mining reference detected",
    pattern: /stratum\+tcp|stratum\+ssl|coinhive|cryptonight|xmrig/i
  },
  {
    ruleId: "suspicious-network",
    severity: "warn",
    message: "WebSocket connection to non-standard port",
    pattern: /new\s+WebSocket\s*\(\s*["']wss?:\/\/[^"']*:(\d+)/
  }
];

const SOURCE_RULES: readonly ISourceRule[] = [
  {
    ruleId: "potential-exfiltration",
    severity: "warn",
    message: "File read combined with network send — possible data exfiltration",
    pattern: /readFileSync|readFile/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN
  },
  {
    ruleId: "obfuscated-code",
    severity: "warn",
    message: "Hex-encoded string sequence detected (possible obfuscation)",
    pattern: /(\\x[0-9a-fA-F]{2}){6,}/
  },
  {
    ruleId: "obfuscated-code",
    severity: "warn",
    message: "Large base64 payload with decode call detected (possible obfuscation)",
    pattern: /(?:atob|Buffer\.from)\s*\(\s*["'][A-Za-z0-9+/=]{200,}["']/
  },
  {
    ruleId: "env-harvesting",
    severity: "critical",
    message:
      "Environment variable access combined with network send — possible credential harvesting",
    pattern: /process\.env/,
    requiresContext: NETWORK_SEND_CONTEXT_PATTERN,
    requiresContextWindowLines: 8
  }
];

/**
 * Scan a skill body for dangerous static patterns. Pure: no I/O, no eval.
 * Returns one finding per matched rule; never includes the matched source text.
 */
export function scanNeonSkillSource(
  source: string,
  filePath: string
): readonly INeonSkillScanFinding[] {
  const findings: INeonSkillScanFinding[] = [];
  const lines = source.split("\n");
  const heuristicSource = stripCommentsForHeuristics(source);
  const heuristicLines = heuristicSource.split("\n");

  // Line rules run on raw lines so the critical detections survive the
  // comment-stripping heuristic. One finding per line-rule per body.
  const matchedLineRules = new Set<TNeonSkillScanRuleId>();
  for (const rule of LINE_RULES) {
    if (matchedLineRules.has(rule.ruleId)) {
      continue;
    }
    if (rule.requiresContext && !rule.requiresContext.test(source)) {
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const match = rule.pattern.exec(line);
      if (!match) {
        continue;
      }
      if (rule.ruleId === "dangerous-exec" && isBenignMemberExecMatch(line, match)) {
        continue;
      }
      if (rule.ruleId === "suspicious-network") {
        const port = Number.parseInt(match[1] ?? "", 10);
        if (Number.isNaN(port) || STANDARD_PORTS.has(port)) {
          continue;
        }
      }

      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        file: filePath,
        line: i + 1,
        message: rule.message
      });
      matchedLineRules.add(rule.ruleId);
      break;
    }
  }

  // Source rules run on the comment-stripped source; dedupe exact ruleId+message.
  const matchedSourceRules = new Set<string>();
  for (const rule of SOURCE_RULES) {
    const ruleKey = `${rule.ruleId}::${rule.message}`;
    if (matchedSourceRules.has(ruleKey)) {
      continue;
    }

    const match = findSourceRuleMatch(rule, heuristicSource, heuristicLines);
    if (!match) {
      continue;
    }

    findings.push({
      ruleId: rule.ruleId,
      severity: rule.severity,
      file: filePath,
      line: match.line,
      message: rule.message
    });
    matchedSourceRules.add(ruleKey);
  }

  return findings;
}

/**
 * Aggregate raw findings into a leak-safe summary for snapshot embedding:
 * counts per rule id plus severity totals and a closed state. The optional
 * `scripts` result merges sibling-script findings (scanned the same way) into the
 * same posture and records how many script files were scanned.
 */
export function summarizeNeonSkillFindings(
  findings: readonly INeonSkillScanFinding[],
  scripts?: INeonSkillScriptScanInput
): INeonSkillSecuritySummary {
  const counts = new Map<TNeonSkillScanRuleId, INeonSkillSecurityFinding>();
  let critical = 0;
  let warn = 0;
  let info = 0;

  const combined = scripts ? [...findings, ...scripts.findings] : findings;
  for (const finding of combined) {
    if (finding.severity === "critical") {
      critical += 1;
    } else if (finding.severity === "warn") {
      warn += 1;
    } else {
      info += 1;
    }

    const existing = counts.get(finding.ruleId);
    if (existing) {
      counts.set(finding.ruleId, { ...existing, count: existing.count + 1 });
    } else {
      counts.set(finding.ruleId, {
        ruleId: finding.ruleId,
        severity: finding.severity,
        count: 1
      });
    }
  }

  const aggregated = [...counts.values()].sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId)
  );

  return {
    state: aggregated.length > 0 ? "flagged" : "clean",
    critical,
    warn,
    info,
    scannedScripts: scripts?.scannedFiles ?? 0,
    scriptsTruncated: scripts?.truncated ?? false,
    findings: aggregated
  };
}

/** Summary for a skill whose body was not scanned (invalid, unreadable, oversized). */
export function unscannedNeonSkillSecuritySummary(): INeonSkillSecuritySummary {
  return {
    state: "unscanned",
    critical: 0,
    warn: 0,
    info: 0,
    scannedScripts: 0,
    scriptsTruncated: false,
    findings: []
  };
}

function findSourceRuleMatch(
  rule: ISourceRule,
  source: string,
  lines: readonly string[]
): { readonly line: number } | null {
  if (!rule.pattern.test(source)) {
    return null;
  }
  if (rule.requiresContext && !rule.requiresContext.test(source)) {
    return null;
  }

  for (let i = 0; i < lines.length; i++) {
    if (!rule.pattern.test(lines[i] ?? "")) {
      continue;
    }

    if (rule.requiresContext && rule.requiresContextWindowLines !== undefined) {
      const start = Math.max(0, i - rule.requiresContextWindowLines);
      const end = Math.min(lines.length, i + rule.requiresContextWindowLines + 1);
      const windowSource = lines.slice(start, end).join("\n");
      if (!rule.requiresContext.test(windowSource)) {
        continue;
      }
    }

    return { line: i + 1 };
  }

  // A windowed rule that matched the whole source but no single line satisfied
  // the proximity window is not a finding.
  if (rule.requiresContextWindowLines !== undefined) {
    return null;
  }

  return { line: 1 };
}

/**
 * `cp.exec(...)`-style member calls are flagged by `dangerous-exec` only when the
 * member chain names child_process; a bare `something.exec(...)` (e.g. a regex
 * `.exec`) on a line without child_process is benign.
 */
function isBenignMemberExecMatch(line: string, match: RegExpExecArray): boolean {
  const command = match[1];
  if (command !== "exec") {
    return false;
  }

  const matchIndex = match.index;
  if (matchIndex <= 0 || line[matchIndex - 1] !== ".") {
    return false;
  }

  return !/\b(?:cp|childProcess|child_process)\s*\.\s*exec\s*\(/.test(line);
}

/**
 * Remove `//` and block comments so commented-out code does not trigger source
 * rules, while preserving string contents and newlines (so line numbers and
 * critical line-rule matches on raw lines stay aligned).
 */
function stripCommentsForHeuristics(source: string): string {
  let stripped = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
        continue;
      }
      if (ch === "\n") {
        stripped += "\n";
      }
      continue;
    }

    if (quote) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      stripped += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      if (source[i] === "\n") {
        stripped += "\n";
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }

    stripped += ch;
  }

  return stripped;
}
