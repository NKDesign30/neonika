// Adapted from NK Design's Neon runtime for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

// Neon Transcript Indexer — the summary quality gate as a callable entry point.
//
// The gate itself (summaryQualityGate.ts) is pure and has tests. This module
// exists so a caller outside this process can reach the same rule: the Python
// live-indexer used to carry its own copy, which drifted — the hollow-summary
// rule lived only in Python, the boilerplate/codefence rules only here. One
// rule, one place, two callers.
//
// Reading stdin stays in the CLI wrapper; this function takes the text it was
// given, so the decision is testable without a process.

import {
  evaluateNeonSummaryQuality,
  type INeonSummaryQualityResult
} from "./summaryQualityGate.js";

export interface INeonSummaryQualityCliOutcome {
  /** JSON line for stdout: the full quality result, verbatim. */
  readonly output: string;
  /** 0 when the summary passed, 1 when it was rejected. */
  readonly exitCode: number;
  readonly result: INeonSummaryQualityResult;
}

/**
 * Evaluate a summary handed in as text, rendering the verdict as one JSON line.
 *
 * `argv` is the argument tail after the command name. The only flag is
 * `--header <value>`, mirroring the gate's `requiredHeader` option; an unknown
 * flag is a caller mistake and throws rather than being silently ignored, so a
 * typo cannot quietly disable a check.
 */
export function runNeonSummaryQualityCheck(
  raw: string,
  argv: readonly string[] = []
): INeonSummaryQualityCliOutcome {
  let requiredHeader: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--header") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--header needs a value");
      }
      requiredHeader = value;
      index += 1;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--header=")) {
      requiredHeader = arg.slice("--header=".length);
      continue;
    }
    throw new Error(`unknown flag: ${String(arg)}`);
  }

  const result = evaluateNeonSummaryQuality(
    raw,
    requiredHeader !== undefined ? { requiredHeader } : {}
  );

  return {
    output: JSON.stringify({
      passed: result.passed,
      cleaned: result.cleaned,
      issues: result.issues
    }),
    exitCode: result.passed ? 0 : 1,
    result
  };
}
