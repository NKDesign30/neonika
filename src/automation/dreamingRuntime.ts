import { createHash } from "node:crypto";

import { readReadyCutoverEnv } from "../core/cutover.js";
import { redactText } from "../harness/redaction.js";
import {
  writeNeonMemoryEntry,
  type INeonMemoryWriteGate,
  type INeonMemoryWriteRuntimeResult
} from "../memory/memoryWriteRuntime.js";
import { deriveNeonConceptTags } from "./conceptVocabulary.js";

/**
 * Dreaming reflection runtime (DP-10).
 *
 * Upstream runs light/deep/rem reflection that MUTATES memory
 * (`src/memory-host-sdk/dreaming.ts`). Neonika splits that into two independently
 * gated halves so nothing consolidates memory autonomously:
 *
 * 1. Reflection (`runNeonDreamingReflection`) is default-off (`NEON_DREAMING_ENABLED`)
 *    and, when armed, only EMITS read-only consolidation proposals — it never writes
 *    memory (`safety.memoryWritten:false, autoPromoted:false`).
 * 2. Promotion (`promoteNeonDreamProposal`) routes a single proposal through the
 *    DP-11 gated productive memory-write, so it requires the SEPARATE memory-write
 *    gate + an isolated store. A proposal never becomes a memory entry on its own.
 */
export type TNeonDreamingPhase = "light" | "deep" | "rem";
export type TNeonDreamingGateReason = "dreaming-disabled" | "dreaming-enabled";
export type TNeonDreamProposalKind = "promote" | "merge" | "prune-candidate";

const dreamingEnabledEnvKey = "NEON_DREAMING_ENABLED";
const summaryMaxLength = 200;
const lightPromoteMinAccess = 3;
// Deep-phase concept merge: two entries cluster when they share at least this
// many concept tags. 2 avoids merging on a single incidental shared word.
const conceptMergeMinSharedTags = 2;

export interface INeonDreamingGate {
  readonly enabled: boolean;
  readonly reason: TNeonDreamingGateReason;
  readonly envKey: typeof dreamingEnabledEnvKey;
}

export interface INeonDreamCandidate {
  readonly id: string;
  readonly content: string;
  readonly accessCount?: number;
}

export interface INeonDreamProposal {
  readonly id: string;
  readonly phase: TNeonDreamingPhase;
  readonly kind: TNeonDreamProposalKind;
  readonly summary: string;
  readonly sourceIds: readonly string[];
}

export interface INeonDreamingReflectionResult {
  readonly dreamed: boolean;
  readonly phase: TNeonDreamingPhase;
  readonly gate: INeonDreamingGate;
  readonly evaluatedAt: string;
  readonly proposals: readonly INeonDreamProposal[];
  readonly safety: { readonly memoryWritten: false; readonly autoPromoted: false };
  readonly diagnostics: readonly string[];
}

export interface IRunNeonDreamingReflectionOptions {
  readonly gate: INeonDreamingGate;
  readonly phase: TNeonDreamingPhase;
  readonly candidates: readonly INeonDreamCandidate[];
  /**
   * Opt-in (default off): in the deep phase, group near-duplicates by shared
   * concept tags instead of the lead-words prefix. Catches concept-equal entries
   * that differ in wording/order. Off keeps the original prefix behavior.
   */
  readonly conceptMerge?: boolean;
  readonly now?: () => Date;
}

export interface IPromoteNeonDreamProposalOptions {
  readonly proposal: INeonDreamProposal;
  readonly memoryGate: INeonMemoryWriteGate;
  readonly storePath?: string;
  readonly now?: () => Date;
}

export function resolveNeonDreamingGate(
  env: Readonly<Record<string, string | undefined>> = process.env
): INeonDreamingGate {
  const enabled = readReadyCutoverEnv(env, dreamingEnabledEnvKey);

  return {
    enabled,
    reason: enabled ? "dreaming-enabled" : "dreaming-disabled",
    envKey: dreamingEnabledEnvKey
  };
}

export function runNeonDreamingReflection(
  options: IRunNeonDreamingReflectionOptions
): INeonDreamingReflectionResult {
  const evaluatedAt = (options.now?.() ?? new Date()).toISOString();
  const safety = { memoryWritten: false, autoPromoted: false } as const;

  if (!options.gate.enabled) {
    return {
      dreamed: false,
      phase: options.phase,
      gate: options.gate,
      evaluatedAt,
      proposals: [],
      safety,
      diagnostics: [
        "Dreaming is disabled (default). No reflection ran; set NEON_DREAMING_ENABLED to arm read-only proposal generation.",
        "Even when armed, dreaming only emits proposals; promotion routes through the gated memory-write (DP-11)."
      ]
    };
  }

  const conceptMerge = options.conceptMerge ?? false;
  const proposals = buildProposals(options.phase, options.candidates, conceptMerge);

  const diagnostics = [
    `Dreaming armed (${options.phase}): generated ${proposals.length} read-only proposal(s) from ${options.candidates.length} candidate(s).`,
    "No memory was written; each proposal must pass the memory-write gate to be promoted."
  ];
  if (conceptMerge && options.phase === "deep") {
    diagnostics.push(
      "Deep merge grouped by shared concept tags (conceptMerge) instead of the lead-words prefix."
    );
  }

  return {
    dreamed: true,
    phase: options.phase,
    gate: options.gate,
    evaluatedAt,
    proposals,
    safety,
    diagnostics
  };
}

export async function promoteNeonDreamProposal(
  options: IPromoteNeonDreamProposalOptions
): Promise<INeonMemoryWriteRuntimeResult> {
  return await writeNeonMemoryEntry({
    request: {
      content: options.proposal.summary,
      category: `dream:${options.proposal.phase}:${options.proposal.kind}`,
      source: `dream-proposal:${options.proposal.id}`
    },
    gate: options.memoryGate,
    mode: "productive",
    ...(options.storePath ? { storePath: options.storePath } : {}),
    ...(options.now ? { now: options.now } : {})
  });
}

export function renderNeonDreamingReflectionReport(result: INeonDreamingReflectionResult): string {
  const lines = [
    `Neon Dreaming: ${result.dreamed ? "armed" : "disabled"} / ${result.phase} (${result.gate.reason}, env ${result.gate.envKey})`,
    `Evaluated: ${result.evaluatedAt}`,
    `Proposals: ${result.proposals.length}`,
    `Safety: memoryWritten=${result.safety.memoryWritten} autoPromoted=${result.safety.autoPromoted}`
  ];

  for (const proposal of result.proposals) {
    lines.push(`- ${proposal.kind} [${proposal.sourceIds.join(",")}]: ${proposal.summary}`);
  }

  for (const diagnostic of result.diagnostics) {
    lines.push(`• ${diagnostic}`);
  }

  return lines.join("\n");
}

function buildProposals(
  phase: TNeonDreamingPhase,
  candidates: readonly INeonDreamCandidate[],
  conceptMerge: boolean
): readonly INeonDreamProposal[] {
  if (phase === "light") {
    // Light: surface frequently-recalled entries as promote proposals.
    return candidates
      .filter((candidate) => (candidate.accessCount ?? 0) >= lightPromoteMinAccess)
      .map((candidate) =>
        createProposal(phase, "promote", [candidate.id], `Promote frequently recalled entry: ${candidate.content}`)
      );
  }

  if (phase === "deep") {
    // Deep: merge near-duplicates. Default groups by the lead-words prefix; the
    // opt-in concept path clusters by shared concept tags (catches reworded dupes).
    const groups = conceptMerge ? groupByConceptOverlap(candidates) : groupByNormalizedPrefix(candidates);
    return groups
      .filter((group) => group.length > 1)
      .map((group) =>
        createProposal(
          phase,
          "merge",
          group.map((candidate) => candidate.id),
          `Merge ${group.length} near-duplicate entries: ${group[0]?.content ?? ""}`
        )
      );
  }

  // REM: flag never-recalled entries as prune candidates (proposal only, no delete).
  return candidates
    .filter((candidate) => (candidate.accessCount ?? 0) === 0)
    .map((candidate) =>
      createProposal(phase, "prune-candidate", [candidate.id], `Never-recalled entry, prune candidate: ${candidate.content}`)
    );
}

function createProposal(
  phase: TNeonDreamingPhase,
  kind: TNeonDreamProposalKind,
  sourceIds: readonly string[],
  summary: string
): INeonDreamProposal {
  const redacted = redactText(summary.replace(/\s+/g, " ").trim()).slice(0, summaryMaxLength);
  const id = `dream-${phase}-${createHash("sha256").update(`${kind}:${sourceIds.join(",")}`).digest("hex").slice(0, 12)}`;

  return { id, phase, kind, summary: redacted, sourceIds: [...sourceIds] };
}

function groupByNormalizedPrefix(
  candidates: readonly INeonDreamCandidate[]
): readonly (readonly INeonDreamCandidate[])[] {
  const groups = new Map<string, INeonDreamCandidate[]>();

  for (const candidate of candidates) {
    const key = normalizedLeadWords(candidate.content);
    const group = groups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  return [...groups.values()];
}

/**
 * Concept-overlap clustering (greedy single-link): a candidate joins the first
 * existing cluster it shares >= conceptMergeMinSharedTags concept tags with,
 * otherwise it seeds a new cluster. Deterministic for a given input order and
 * O(candidates * clusters) — fine for the small dreaming candidate sets. Catches
 * reworded near-duplicates that the lead-words prefix key misses.
 */
function groupByConceptOverlap(
  candidates: readonly INeonDreamCandidate[]
): readonly (readonly INeonDreamCandidate[])[] {
  const clusters: { readonly tags: Set<string>; readonly members: INeonDreamCandidate[] }[] = [];

  for (const candidate of candidates) {
    const tags = new Set(deriveNeonConceptTags(candidate.content));
    const match = clusters.find(
      (cluster) => countSharedTags(cluster.tags, tags) >= conceptMergeMinSharedTags
    );
    if (match) {
      match.members.push(candidate);
      for (const tag of tags) {
        match.tags.add(tag);
      }
    } else {
      clusters.push({ tags, members: [candidate] });
    }
  }

  return clusters.map((cluster) => cluster.members);
}

function countSharedTags(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let shared = 0;
  for (const tag of left) {
    if (right.has(tag)) {
      shared += 1;
    }
  }
  return shared;
}

/** Near-duplicate key: the first three lowercased words of the entry. */
function normalizedLeadWords(content: string): string {
  return content
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .slice(0, 3)
    .join(" ");
}
