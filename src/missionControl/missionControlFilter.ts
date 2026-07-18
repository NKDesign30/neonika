import type {
  INeonActivityEntry,
  TNeonActivityEntryKind,
  TNeonActivityStatus
} from "../gateway/activitySnapshot.js";

/**
 * Pure, read-only filter for the Mission-Control activity view.
 *
 * Upstream reference: the operator dashboard filters the live activity list by
 * free-text search plus tool / agent / status facets and shows how many rows
 * survive the filter. Neonika rebuilds this as a deterministic function over
 * the already-redacted `INeonActivityEntry[]` projection so it is testable
 * without a browser and exposes a real CLI entry point.
 *
 * The function adds no new data sink: entries arriving here have already passed
 * `redactText` in the activity snapshot, and the report prints only non-secret
 * labels (agent id, tool name, status) plus counts.
 */

const TOOL_TITLE_PREFIX = "Tool ";

export interface INeonMissionControlFilterCriteria {
  /** Free text matched case-insensitively across title/summary/preview/agent/run. */
  readonly search?: string;
  /** Exact agent id match. */
  readonly agentId?: string;
  /** Tool label match (case-insensitive) against tool activity entries. */
  readonly tool?: string;
  /** Activity status facet (running | done | error). */
  readonly status?: TNeonActivityStatus;
  /** Entry kind facet (inbound | run | tool | ...). */
  readonly kind?: TNeonActivityEntryKind;
}

export interface INeonMissionControlFacetOption {
  readonly value: string;
  readonly count: number;
}

export interface INeonMissionControlFilterFacets {
  readonly agents: readonly INeonMissionControlFacetOption[];
  readonly tools: readonly INeonMissionControlFacetOption[];
  readonly statuses: readonly INeonMissionControlFacetOption[];
}

export interface INeonMissionControlFilterResult {
  /** Entry count before any criterion was applied. */
  readonly totalCount: number;
  /** Entry count after all criteria were applied. */
  readonly visibleCount: number;
  /** The criteria that were actually applied (empty values dropped). */
  readonly appliedCriteria: INeonMissionControlFilterCriteria;
  /** Whether any criterion narrowed the result. */
  readonly filtered: boolean;
  readonly entries: readonly INeonActivityEntry[];
  /** Available facet options derived from the FULL input set, not the filtered subset. */
  readonly facets: INeonMissionControlFilterFacets;
}

/** Returns the tool label for a tool activity entry, or undefined for non-tool entries. */
export function deriveNeonActivityToolLabel(entry: INeonActivityEntry): string | undefined {
  if (entry.kind !== "tool") {
    return undefined;
  }

  const label = entry.title.startsWith(TOOL_TITLE_PREFIX)
    ? entry.title.slice(TOOL_TITLE_PREFIX.length).trim()
    : entry.title.trim();

  return label.length > 0 ? label : undefined;
}

function normalizeCriteria(
  criteria: INeonMissionControlFilterCriteria
): INeonMissionControlFilterCriteria {
  const search = criteria.search?.trim();
  const agentId = criteria.agentId?.trim();
  const tool = criteria.tool?.trim();

  return {
    ...(search ? { search } : {}),
    ...(agentId ? { agentId } : {}),
    ...(tool ? { tool } : {}),
    ...(criteria.status ? { status: criteria.status } : {}),
    ...(criteria.kind ? { kind: criteria.kind } : {})
  };
}

function matchesSearch(entry: INeonActivityEntry, needle: string): boolean {
  const haystack = [
    entry.title,
    entry.summary,
    entry.preview ?? "",
    entry.agentId,
    entry.runId,
    entry.sessionKey,
    deriveNeonActivityToolLabel(entry) ?? ""
  ]
    .join("\n")
    .toLowerCase();

  return haystack.includes(needle);
}

function matchesCriteria(
  entry: INeonActivityEntry,
  criteria: INeonMissionControlFilterCriteria
): boolean {
  if (criteria.search && !matchesSearch(entry, criteria.search.toLowerCase())) {
    return false;
  }

  if (criteria.agentId && entry.agentId !== criteria.agentId) {
    return false;
  }

  if (criteria.status && entry.status !== criteria.status) {
    return false;
  }

  if (criteria.kind && entry.kind !== criteria.kind) {
    return false;
  }

  if (criteria.tool) {
    const label = deriveNeonActivityToolLabel(entry);
    if (!label || label.toLowerCase() !== criteria.tool.toLowerCase()) {
      return false;
    }
  }

  return true;
}

function countFacet(values: readonly string[]): readonly INeonMissionControlFacetOption[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.value.localeCompare(right.value);
    });
}

function buildFacets(
  entries: readonly INeonActivityEntry[]
): INeonMissionControlFilterFacets {
  const agentValues: string[] = [];
  const toolValues: string[] = [];
  const statusValues: string[] = [];

  for (const entry of entries) {
    agentValues.push(entry.agentId);
    statusValues.push(entry.status);
    const tool = deriveNeonActivityToolLabel(entry);
    if (tool) {
      toolValues.push(tool);
    }
  }

  return {
    agents: countFacet(agentValues),
    tools: countFacet(toolValues),
    statuses: countFacet(statusValues)
  };
}

/**
 * Applies search/agent/tool/status/kind criteria to an activity projection and
 * reports how many rows remain visible plus the facet options available in the
 * full input set. Deterministic and side-effect free.
 */
export function filterNeonMissionControlActivity(
  entries: readonly INeonActivityEntry[],
  criteria: INeonMissionControlFilterCriteria = {}
): INeonMissionControlFilterResult {
  const applied = normalizeCriteria(criteria);
  const hasCriteria =
    applied.search !== undefined ||
    applied.agentId !== undefined ||
    applied.tool !== undefined ||
    applied.status !== undefined ||
    applied.kind !== undefined;

  const visible = hasCriteria
    ? entries.filter((entry) => matchesCriteria(entry, applied))
    : entries;

  return {
    totalCount: entries.length,
    visibleCount: visible.length,
    appliedCriteria: applied,
    filtered: hasCriteria,
    entries: visible,
    facets: buildFacets(entries)
  };
}

function renderFacetLine(label: string, options: readonly INeonMissionControlFacetOption[]): string {
  if (options.length === 0) {
    return `${label}: -`;
  }
  const rendered = options
    .slice(0, 8)
    .map((option) => `${option.value} (${option.count})`)
    .join(", ");
  return `${label}: ${rendered}`;
}

/** Renders a leak-safe text report for the `mission-control-filter` CLI smoke. */
export function renderNeonMissionControlFilterReport(
  result: INeonMissionControlFilterResult
): string {
  const criteriaParts = [
    result.appliedCriteria.search ? `search="${result.appliedCriteria.search}"` : undefined,
    result.appliedCriteria.agentId ? `agent=${result.appliedCriteria.agentId}` : undefined,
    result.appliedCriteria.tool ? `tool=${result.appliedCriteria.tool}` : undefined,
    result.appliedCriteria.status ? `status=${result.appliedCriteria.status}` : undefined,
    result.appliedCriteria.kind ? `kind=${result.appliedCriteria.kind}` : undefined
  ].filter((part): part is string => part !== undefined);

  const sample = result.entries
    .slice(0, 10)
    .map((entry, index) => `${index + 1}. [${entry.status}] ${entry.title} (${entry.agentId})`);

  return [
    "Neon Mission-Control Filter",
    `Criteria: ${criteriaParts.length > 0 ? criteriaParts.join(" ") : "(none)"}`,
    `Visible: ${result.visibleCount}/${result.totalCount}`,
    renderFacetLine("Agents", result.facets.agents),
    renderFacetLine("Tools", result.facets.tools),
    renderFacetLine("Status", result.facets.statuses),
    ...sample
  ].join("\n");
}
