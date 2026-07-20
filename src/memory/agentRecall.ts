// Agent-scoped memory recall over the shared Neon memory provider.
//
// Upstream scopes memory per agent with a dedicated SQLite store per agent
// (`src/agents/memory-search.ts:144` `resolveStorePath` -> `${agentId}.sqlite`)
// plus a per-agent config merge (`:431` `resolveMemorySearchConfig(cfg, agentId)`).
// Neonika uses ONE shared store behind the `memory-search` CLI, so the
// per-agent-store model is not portable. Strategy: rebuild-native — keep the
// single shared provider and scope recall by (a) folding the agent's
// `memoryQuerySeeds` (+ explicit focus terms) into the query and (b) tagging the
// result with the resolved agent id. This mirrors upstream's per-agent override
// intent without copying its storage layout.
//
// This module performs NO command execution and NO file I/O — it composes a
// query and delegates to the injected provider, so it stays deterministic and
// unit-testable with a fake provider. All redaction/excerpt handling is reused
// from `createNeonMemoryAttachment`.

import { resolveNeonAgentProfile, type INeonAgentProfile } from "../agents/registry.js";
import type { IMemoryAttachment } from "../harness/types.js";
import {
  createNeonMemoryAttachment,
  type INeonMemoryProvider,
  type INeonMemorySearchOptions,
  type INeonMemorySearchResult
} from "./neonMemory.js";
import { extractNeonQueryKeywords } from "./queryExpansion.js";

const defaultAgentRecallMaxHits = 5;

export interface INeonAgentRecallOptions {
  readonly maxHits?: number;
  /** Extra scope terms folded into the query alongside the agent's profile seeds. */
  readonly focus?: readonly string[];
  /** When false, the agent profile's `memoryQuerySeeds` are not folded in. Default true. */
  readonly useProfileSeeds?: boolean;
  /**
   * When true, the conversational query is reduced to its DE+EN keywords
   * (stopwords removed) before scope terms are folded in. Default false —
   * recall behaviour stays unchanged unless explicitly opted in.
   */
  readonly expandKeywords?: boolean;
  /**
   * Profiles to resolve the agent against. Omitted -> the built-in registry,
   * which is what every caller did before an operator roster existed. Pass the
   * loaded roster to give a configured agent its own `memoryQuerySeeds`.
   */
  readonly profiles?: readonly INeonAgentProfile[];
}

export interface INeonAgentScopedRecall extends INeonMemorySearchResult {
  readonly agentId: string;
  /** Canonical agent id resolved from id/alias, or null when the agent is unknown. */
  readonly resolvedAgentId: string | null;
  readonly scopedQuery: string;
  readonly scopeTerms: readonly string[];
}

export interface INeonAgentMemoryAttachment extends IMemoryAttachment {
  readonly agentId: string;
  readonly resolvedAgentId: string | null;
  readonly scopedQuery: string;
}

export async function recallNeonAgentMemory(
  provider: INeonMemoryProvider,
  agentId: string,
  query: string,
  options: INeonAgentRecallOptions = {}
): Promise<INeonAgentScopedRecall> {
  const profile =
    options.useProfileSeeds === false
      ? undefined
      : resolveNeonAgentProfile(agentId, options.profiles);
  const scopeTerms = dedupeScopeTerms([
    ...(profile?.memoryQuerySeeds ?? []),
    ...(options.focus ?? [])
  ]);
  const scopedQuery = composeScopedQuery(query, scopeTerms, options.expandKeywords === true);
  const result = await provider.search(scopedQuery, resolveSearchOptions(options.maxHits));

  return {
    ...result,
    agentId,
    resolvedAgentId: profile?.id ?? null,
    scopedQuery,
    scopeTerms
  };
}

export async function createNeonAgentMemoryAttachment(
  provider: INeonMemoryProvider,
  agentId: string,
  query: string,
  options: INeonAgentRecallOptions = {}
): Promise<INeonAgentMemoryAttachment> {
  const recall = await recallNeonAgentMemory(provider, agentId, query, options);
  // Reuse the shared excerpt/redaction/note builder by replaying the already
  // fetched result through a passthrough provider — the real provider is only
  // hit once (inside recallNeonAgentMemory).
  const passthrough: INeonMemoryProvider = { search: async () => recall };
  const attachment = await createNeonMemoryAttachment(
    passthrough,
    recall.scopedQuery,
    resolveSearchOptions(options.maxHits)
  );

  return {
    ...attachment,
    note: tagAttachmentNote(attachment.note, recall.resolvedAgentId ?? agentId),
    agentId,
    resolvedAgentId: recall.resolvedAgentId,
    scopedQuery: recall.scopedQuery
  };
}

function resolveSearchOptions(maxHits: number | undefined): INeonMemorySearchOptions {
  return { maxHits: maxHits ?? defaultAgentRecallMaxHits };
}

function composeScopedQuery(
  query: string,
  scopeTerms: readonly string[],
  expandKeywords: boolean
): string {
  const trimmed = query.trim();
  // Opt-in: collapse the conversational query to its keywords; fall back to the
  // full query when extraction yields nothing so we never search an empty term.
  const base = expandKeywords ? resolveExpandedQueryBase(trimmed) : trimmed;

  if (scopeTerms.length === 0) {
    return base;
  }

  return [base, ...scopeTerms].filter((part) => part.length > 0).join(" ");
}

function resolveExpandedQueryBase(trimmed: string): string {
  const keywords = extractNeonQueryKeywords(trimmed);
  return keywords.length > 0 ? keywords.join(" ") : trimmed;
}

function dedupeScopeTerms(terms: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const term of terms) {
    const trimmed = term.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function tagAttachmentNote(note: string, agentLabel: string): string {
  if (note.length === 0) {
    return `[agent ${agentLabel}]`;
  }

  return `[agent ${agentLabel}] ${note}`;
}
