import { redactText } from "../harness/redaction.js";
import {
  buildNeonCitationIndex,
  decorateNeonCitationText,
  shouldIncludeNeonCitations,
  type TNeonCitationsMode
} from "./neonCitations.js";
import type { IMemoryAttachment, TNeonChannel } from "../harness/types.js";
import { createNeonAgentMemoryAttachment } from "../memory/agentRecall.js";
import type { INeonMemoryProvider } from "../memory/neonMemory.js";
import { readNeonGatewayRuns } from "../gateway/runStore.js";
import type { INeonGatewayShadowRun } from "../gateway/types.js";
import { readNeonTasks } from "../tasks/taskStore.js";
import type { INeonTaskRecord } from "../tasks/taskModel.js";

/**
 * Neon Context Engine — bounded, leak-safe context packs.
 *
 * A context pack is a read-only bundle assembled for one agent turn from local
 * shadow state: recalled memory (optional, only when a provider is attached),
 * recent runs, open tasks, and the channel. The pack is bounded by a per-section
 * item cap and a total character budget, and every text field crosses through
 * `redactText` and a length clamp — so the pack is leak-safe by construction and
 * can never grow unbounded.
 *
 * Memory is never fabricated: when no provider is attached the memory section is
 * present but empty with an explanatory note, rather than inventing recall data.
 *
 * Shape reference: upstream's context-engine `assemble()` (src/context-engine/
 * types.ts) which returns a bounded, token-budgeted set of messages. Rebuilt
 * Neon-native: a redacted projection over local stores, not the model-message
 * lifecycle.
 */

export type TNeonContextPackState = "ready" | "empty";
export type TNeonContextSectionId = "memory" | "runs" | "tasks" | "channel";

export interface INeonContextItem {
  readonly kind: TNeonContextSectionId;
  readonly source: string;
  readonly text: string;
}

export interface INeonContextSection {
  readonly id: TNeonContextSectionId;
  readonly title: string;
  readonly items: readonly INeonContextItem[];
  /** True when at least one eligible item was dropped from this section (cap or budget). */
  readonly truncated: boolean;
  /** Present when the section is empty for a structural reason (e.g. no memory provider). */
  readonly note?: string;
}

export interface INeonContextPackBounds {
  readonly maxItems: number;
  readonly charBudget: number;
  readonly charsUsed: number;
}

export interface INeonContextPackTotals {
  readonly items: number;
  readonly sections: number;
  readonly droppedForBudget: number;
}

export interface INeonContextPackSafety {
  readonly leakSafe: true;
  readonly redacted: true;
}

export interface INeonContextPack {
  readonly state: TNeonContextPackState;
  readonly generatedAt: string;
  readonly agentId: string;
  readonly channel: TNeonChannel;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly query?: string;
  readonly bounds: INeonContextPackBounds;
  readonly totals: INeonContextPackTotals;
  readonly sections: readonly INeonContextSection[];
  readonly safety: INeonContextPackSafety;
}

export interface INeonContextPackRequest {
  readonly agentId: string;
  readonly channel: TNeonChannel;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly query?: string;
  readonly maxItems?: number;
  readonly charBudget?: number;
}

export interface IAssembleNeonContextPackInput extends INeonContextPackRequest {
  readonly runs: readonly INeonGatewayShadowRun[];
  readonly tasks: readonly INeonTaskRecord[];
  readonly memory?: IMemoryAttachment;
  readonly now?: () => Date;
}

export interface ICreateNeonContextPackOptions {
  readonly maxRuns?: number;
  readonly now?: () => Date;
  /** Optional memory provider; when omitted the memory section stays empty (never fabricated). */
  readonly memoryProvider?: INeonMemoryProvider;
}

const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_CHAR_BUDGET = 4000;
const MAX_ITEM_TEXT = 240;
const MAX_SOURCE_TEXT = 120;

const contextPackSafety: INeonContextPackSafety = {
  leakSafe: true,
  redacted: true
};

/**
 * Pure assembly: build a bounded, redacted pack from already-loaded inputs. The
 * memory/runs/tasks sections compete for the shared character budget in that
 * priority order; the channel section is tiny and always included. Items dropped
 * for the budget or the per-section cap are counted, never silently hidden.
 */
export function assembleNeonContextPack(input: IAssembleNeonContextPackInput): INeonContextPack {
  const maxItems = clampPositive(input.maxItems, DEFAULT_MAX_ITEMS, 50);
  const charBudget = clampPositive(input.charBudget, DEFAULT_CHAR_BUDGET, 64_000);
  const budget = { charsUsed: 0, dropped: 0 };

  const memorySection = buildMemorySection(input.memory, maxItems, charBudget, budget);
  const runsSection = buildRunsSection(input, maxItems, charBudget, budget);
  const tasksSection = buildTasksSection(input, maxItems, charBudget, budget);
  const channelSection = buildChannelSection(input);

  const sections = [memorySection, runsSection, tasksSection, channelSection];
  const items = sections.reduce((total, section) => total + section.items.length, 0);
  // The channel section is always present as bounded metadata, so it never makes
  // a pack "ready" on its own: state reflects whether any recall/run/task content
  // was assembled.
  const contentItems = items - channelSection.items.length;

  return {
    state: contentItems > 0 ? "ready" : "empty",
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    agentId: input.agentId,
    channel: input.channel,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.query ? { query: clampText(redactText(input.query), MAX_ITEM_TEXT) } : {}),
    bounds: {
      maxItems,
      charBudget,
      charsUsed: budget.charsUsed
    },
    totals: {
      items,
      sections: sections.length,
      droppedForBudget: budget.dropped
    },
    sections,
    safety: contextPackSafety
  };
}

/**
 * Gather local shadow state and assemble a pack. Runs and tasks are read from the
 * project stores and filtered to the requested channel/channelId/task. Memory is
 * recalled only when a provider is attached.
 */
export async function createNeonContextPack(
  projectRoot: string,
  request: INeonContextPackRequest,
  options: ICreateNeonContextPackOptions = {}
): Promise<INeonContextPack> {
  const runs = await readNeonGatewayRuns(
    projectRoot,
    options.maxRuns ? { maxRuns: options.maxRuns } : {}
  );
  const tasks = await readNeonTasks(projectRoot);
  const memory = await recallMemory(request, options);

  return assembleNeonContextPack({
    ...request,
    runs: filterRunsForRequest(runs, request),
    tasks: orderTasksForRequest(tasks, request),
    ...(memory ? { memory } : {}),
    ...(options.now ? { now: options.now } : {})
  });
}

export interface INeonContextPackReportOptions {
  readonly citationsMode?: TNeonCitationsMode;
}

export function renderNeonContextPackReport(
  pack: INeonContextPack,
  options: INeonContextPackReportOptions = {}
): string {
  const citationsMode = options.citationsMode ?? "off";
  const citationIndex = shouldIncludeNeonCitations(citationsMode)
    ? buildNeonCitationIndex(pack.sections.flatMap((section) => section.items))
    : null;

  const header = [
    `Neon Context Pack: ${pack.state}`,
    `Agent: ${pack.agentId} · channel: ${pack.channel}${pack.channelId ? `/${pack.channelId}` : ""}`,
    `Items: ${pack.totals.items} · dropped(budget): ${pack.totals.droppedForBudget} · chars: ${pack.bounds.charsUsed}/${pack.bounds.charBudget}`
  ];

  const sectionLines = pack.sections.flatMap((section) => {
    const title = `${section.title} (${section.items.length})${section.truncated ? " [truncated]" : ""}`;
    const itemLines = section.items.map((item) =>
      citationIndex
        ? `   - ${item.source}: ${decorateNeonCitationText(item.text, item.source, citationIndex)}`
        : `   - ${item.source}: ${item.text}`
    );
    const noteLine = section.note ? [`   (${section.note})`] : [];

    return [title, ...itemLines, ...noteLine];
  });

  return [...header, ...sectionLines].join("\n");
}

async function recallMemory(
  request: INeonContextPackRequest,
  options: ICreateNeonContextPackOptions
): Promise<IMemoryAttachment | undefined> {
  if (!options.memoryProvider) {
    return undefined;
  }

  const query = request.query?.trim();

  if (!query) {
    return undefined;
  }

  const maxItems = clampPositive(request.maxItems, DEFAULT_MAX_ITEMS, 50);

  return createNeonAgentMemoryAttachment(options.memoryProvider, request.agentId, query, {
    maxHits: maxItems
  });
}

function buildMemorySection(
  memory: IMemoryAttachment | undefined,
  maxItems: number,
  charBudget: number,
  budget: { charsUsed: number; dropped: number }
): INeonContextSection {
  if (!memory) {
    return {
      id: "memory",
      title: "Memory",
      items: [],
      truncated: false,
      note: "no memory provider attached"
    };
  }

  const excerpts = memory.excerpts ?? [];
  const candidates = excerpts.map((excerpt) => ({
    kind: "memory" as const,
    source: clampText(redactText(excerpt.source), MAX_SOURCE_TEXT),
    text: clampText(redactText(excerpt.text), MAX_ITEM_TEXT)
  }));

  return finalizeSection("memory", "Memory", candidates, maxItems, charBudget, budget);
}

function buildRunsSection(
  input: IAssembleNeonContextPackInput,
  maxItems: number,
  charBudget: number,
  budget: { charsUsed: number; dropped: number }
): INeonContextSection {
  const candidates = input.runs.map((run) => ({
    kind: "runs" as const,
    source: clampText(`run:${run.runId}`, MAX_SOURCE_TEXT),
    text: clampText(
      redactText(
        `${run.request.channel}/${run.request.channelId} ${run.request.agentId} ${run.status} ${run.request.contentPreview}`
      ),
      MAX_ITEM_TEXT
    )
  }));

  return finalizeSection("runs", "Recent runs", candidates, maxItems, charBudget, budget);
}

function buildTasksSection(
  input: IAssembleNeonContextPackInput,
  maxItems: number,
  charBudget: number,
  budget: { charsUsed: number; dropped: number }
): INeonContextSection {
  const candidates = input.tasks.map((task) => ({
    kind: "tasks" as const,
    source: clampText(`task:${task.taskId}`, MAX_SOURCE_TEXT),
    text: clampText(
      redactText(`[${task.status}/${task.priority}] ${task.title} @${task.ownerAgentId}`),
      MAX_ITEM_TEXT
    )
  }));

  return finalizeSection("tasks", "Open tasks", candidates, maxItems, charBudget, budget);
}

function buildChannelSection(input: IAssembleNeonContextPackInput): INeonContextSection {
  const text = input.channelId ? `${input.channel}/${input.channelId}` : input.channel;

  return {
    id: "channel",
    title: "Channel",
    items: [
      {
        kind: "channel",
        source: `channel:${input.channel}`,
        text: clampText(redactText(text), MAX_ITEM_TEXT)
      }
    ],
    truncated: false
  };
}

function finalizeSection(
  id: TNeonContextSectionId,
  title: string,
  candidates: readonly INeonContextItem[],
  maxItems: number,
  charBudget: number,
  budget: { charsUsed: number; dropped: number }
): INeonContextSection {
  const capped = candidates.slice(0, maxItems);
  const cappedDrop = candidates.length - capped.length;
  const items: INeonContextItem[] = [];
  let budgetDrop = 0;

  for (const item of capped) {
    if (budget.charsUsed + item.text.length > charBudget) {
      budgetDrop += 1;
      continue;
    }

    budget.charsUsed += item.text.length;
    items.push(item);
  }

  budget.dropped += cappedDrop + budgetDrop;

  return {
    id,
    title,
    items,
    truncated: cappedDrop + budgetDrop > 0
  };
}

function filterRunsForRequest(
  runs: readonly INeonGatewayShadowRun[],
  request: INeonContextPackRequest
): readonly INeonGatewayShadowRun[] {
  const matching = runs.filter((run) => {
    if (run.request.channel !== request.channel) {
      return false;
    }

    return request.channelId ? run.request.channelId === request.channelId : true;
  });

  return [...matching].reverse();
}

function orderTasksForRequest(
  tasks: readonly INeonTaskRecord[],
  request: INeonContextPackRequest
): readonly INeonTaskRecord[] {
  const matching = tasks.filter((task) => {
    if (task.channel !== request.channel) {
      return false;
    }

    return request.channelId ? task.channelId === request.channelId : true;
  });

  return [...matching].sort((left, right) => {
    if (request.taskId) {
      if (left.taskId === request.taskId) {
        return -1;
      }
      if (right.taskId === request.taskId) {
        return 1;
      }
    }

    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function clampPositive(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(value), max);
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
