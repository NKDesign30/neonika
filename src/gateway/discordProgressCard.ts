/**
 * Adapted in part from OpenClaw src/channels/streaming.ts and src/agents/tool-display-config.ts.
 * See THIRD_PARTY_NOTICES.md for attribution and license details.
 */
import type { TCodexHarnessEvent } from "../harness/types.js";
import type { TNeonGatewayRunStatus } from "./types.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import type { INeonDiscordComponentActionRegistry } from "./discordComponentActionRegistry.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import {
  registerNeonDiscordStopAction,
  type INeonDiscordRunControlRuntime
} from "./discordRunControl.js";

export interface INeonDiscordProgressCardTransport {
  post(
    target: INeonDeliveryQueueTarget,
    body: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }>;
  edit(
    target: INeonDeliveryQueueTarget,
    messageId: string,
    body: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<void>;
}

export interface INeonDiscordProgressCardStartInput {
  readonly target: INeonDeliveryQueueTarget;
  readonly ownerUserId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly sessionKey: string;
}

export interface INeonDiscordProgressCardFinishResult {
  readonly messageId: string;
  readonly updateCount: number;
  readonly errorCount: number;
}

export interface INeonDiscordProgressCardHandle {
  readonly messageId: string;
  observe(event: TCodexHarnessEvent): void;
  finish(status: TNeonGatewayRunStatus): Promise<INeonDiscordProgressCardFinishResult>;
}

export interface INeonDiscordProgressCardRuntime {
  start(input: INeonDiscordProgressCardStartInput): Promise<INeonDiscordProgressCardHandle>;
}

export interface INeonDiscordProgressCardRuntimeOptions {
  readonly transport: INeonDiscordProgressCardTransport;
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly runControl: INeonDiscordRunControlRuntime;
  readonly now?: () => Date;
  readonly minUpdateMs?: number;
  readonly actionLifetimeMs?: number;
}

const DEFAULT_MIN_UPDATE_MS = 1_000;
const DEFAULT_ACTION_LIFETIME_MS = 30 * 60 * 1_000;

export function shouldStartNeonDiscordProgressCard(event: TCodexHarnessEvent): boolean {
  switch (event.kind) {
    case "tool-start":
    case "tool-output":
      return event.hideFromChannelProgress !== true;
    case "file-write":
    case "command-exit":
      return true;
    case "assistant-delta":
    case "token-usage":
    case "final":
    case "failed":
      return false;
  }
}

export function createNeonDiscordProgressCardRuntime(
  options: INeonDiscordProgressCardRuntimeOptions
): INeonDiscordProgressCardRuntime {
  const now = options.now ?? (() => new Date());
  const minUpdateMs = normalizePositiveInteger(options.minUpdateMs, DEFAULT_MIN_UPDATE_MS, "minUpdateMs");
  const actionLifetimeMs = normalizePositiveInteger(
    options.actionLifetimeMs,
    DEFAULT_ACTION_LIFETIME_MS,
    "actionLifetimeMs"
  );

  return {
    async start(input) {
      const expiresAt = new Date(now().getTime() + actionLifetimeMs).toISOString();
      const stopAction = registerNeonDiscordStopAction({
        registry: options.registry,
        runControl: options.runControl,
        ownerUserId: input.ownerUserId,
        ...(input.guildId ? { guildId: input.guildId } : {}),
        channelId: input.channelId,
        sessionKey: input.sessionKey,
        expiresAt
      });
      const activeRows = createStopRows(stopAction.customId);
      const initialBody = renderNeonDiscordProgressCard("queued");
      const posted = await options.transport.post(input.target, initialBody, activeRows);

      return createProgressCardHandle({
        transport: options.transport,
        target: input.target,
        messageId: posted.messageId,
        activeRows,
        minUpdateMs,
        now,
        label: pickNeonProgressLabel(input.sessionKey)
      });
    }
  };
}

type TNeonDiscordProgressState =
  | "queued"
  | "working"
  | "writing"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";

export interface INeonDiscordProgressSteps {
  readonly count: number;
  readonly lines: readonly string[];
  readonly label?: string;
}

// Layout rebuilt after OpenClaw's channel progress draft
// (openclaw src/channels/streaming.ts formatChannelProgressDraftText):
// seed-stable personality label on top, then compacted per-tool lines.
const MAX_PROGRESS_STEP_LINES = 8;
const MAX_PROGRESS_LINE_CHARS = 120;

const NEON_PROGRESS_LABELS = [
  "Working",
  "Wiring",
  "Pulsing",
  "Glowing",
  "Beaming",
  "Syncing",
  "Weaving",
  "Forging",
  "Tracing",
  "Sparking",
  "Charging",
  "Flowing",
  "Booting",
  "Humming",
  "Orbiting",
  "Tuning",
  "Rendering",
  "Linking",
  "Dreaming",
  "Surging"
] as const;

export function pickNeonProgressLabel(seed: string): string {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 33 + seed.charCodeAt(index)) >>> 0;
  }
  return NEON_PROGRESS_LABELS[hash % NEON_PROGRESS_LABELS.length] ?? NEON_PROGRESS_LABELS[0];
}

function compactProgressLine(line: string): string {
  const collapsed = line.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_PROGRESS_LINE_CHARS
    ? `${collapsed.slice(0, MAX_PROGRESS_LINE_CHARS - 1)}…`
    : collapsed;
}

function createProgressCardHandle(input: {
  readonly transport: INeonDiscordProgressCardTransport;
  readonly target: INeonDeliveryQueueTarget;
  readonly messageId: string;
  readonly activeRows: readonly TNeonDiscordActionRow[];
  readonly minUpdateMs: number;
  readonly now: () => Date;
  readonly label: string;
}): INeonDiscordProgressCardHandle {
  let desiredState: TNeonDiscordProgressState = "queued";
  let currentBody = renderNeonDiscordProgressCard("queued");
  let stepCount = 0;
  const stepLines: string[] = [];
  let lastEditAtMs = input.now().getTime();
  let updateCount = 0;
  let errorCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let editChain = Promise.resolve();
  let finished = false;
  let finishResultPromise: Promise<INeonDiscordProgressCardFinishResult> | undefined;

  const desiredBody = (): string =>
    renderNeonDiscordProgressCard(desiredState, {
      count: stepCount,
      lines: stepLines,
      label: input.label
    });

  const queueEdit = (body: string, rows: readonly TNeonDiscordActionRow[]): void => {
    currentBody = body;
    lastEditAtMs = input.now().getTime();
    editChain = editChain.then(
      async () => {
        try {
          await input.transport.edit(input.target, input.messageId, body, rows);
          updateCount += 1;
        } catch {
          errorCount += 1;
        }
      },
      async () => {
        errorCount += 1;
      }
    );
  };

  const flushDesired = (): void => {
    timer = undefined;
    if (finished) {
      return;
    }
    const body = desiredBody();
    if (body === currentBody) {
      return;
    }
    queueEdit(body, input.activeRows);
  };

  return {
    messageId: input.messageId,
    observe(event) {
      if (finished) {
        return;
      }
      desiredState = progressStateFromHarnessEvent(event);
      const line = progressLineFromHarnessEvent(event);
      if (line) {
        // Merge-by-identity like OpenClaw's draft lines: a completed event
        // ("… ✓") replaces its started line instead of appending a new step.
        const base = line.replace(/ ✓$/u, "");
        const lastBase = stepLines.at(-1)?.replace(/ ✓$/u, "");
        if (lastBase === base) {
          stepLines[stepLines.length - 1] = line;
        } else {
          stepCount += 1;
          stepLines.push(line);
          if (stepLines.length > MAX_PROGRESS_STEP_LINES) {
            stepLines.shift();
          }
        }
      }
      if (desiredBody() === currentBody) {
        return;
      }
      const waitMs = Math.max(0, input.minUpdateMs - (input.now().getTime() - lastEditAtMs));
      if (waitMs === 0) {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        flushDesired();
        return;
      }
      if (!timer) {
        timer = setTimeout(flushDesired, waitMs);
      }
    },
    finish(status) {
      if (finishResultPromise) {
        return finishResultPromise;
      }
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const terminalState = progressStateFromRunStatus(status);
      queueEdit(renderNeonDiscordProgressCard(terminalState), []);
      finishResultPromise = editChain.then(() => ({
        messageId: input.messageId,
        updateCount,
        errorCount
      }));
      return finishResultPromise;
    }
  };
}

export function renderNeonDiscordProgressCard(
  state: TNeonDiscordProgressState,
  steps?: INeonDiscordProgressSteps
): string {
  const terminal: Readonly<Record<string, string>> = {
    completed: "✅ Auftrag abgeschlossen.",
    failed: "❌ Auftrag fehlgeschlagen.",
    cancelled: "⏹️ Auftrag gestoppt."
  };
  const terminalBody = terminal[state];
  if (terminalBody) {
    return terminalBody;
  }

  if (state === "queued" || !steps || steps.count === 0 || steps.lines.length === 0) {
    return "⏳ Auftrag angenommen\nStatus: Wird vorbereitet …\n\nDu kannst diesen Lauf hier stoppen.";
  }

  const label = steps.label ?? "Working";
  const suffix = state === "finalizing" ? " · ✍️ Antwort entsteht" : "";
  const header = `**${label} …** · Schritt ${steps.count}${suffix}`;
  const lines = steps.lines.slice(-MAX_PROGRESS_STEP_LINES).map(compactProgressLine).join("\n");
  return `${header}\n${lines}\n\nDu kannst diesen Lauf hier stoppen.`;
}

// Per-tool emoji+title registry rebuilt after OpenClaw's tool-display-config
// (openclaw src/agents/tool-display-config.ts). Details arrive pre-redacted
// from the harness; raw payloads never reach the card. Unknown tool names
// collapse to the 🧩 fallback like OpenClaw's fallback spec.
export function progressLineFromHarnessEvent(event: TCodexHarnessEvent): string | undefined {
  switch (event.kind) {
    case "tool-start":
    case "tool-output": {
      if (event.hideFromChannelProgress === true) {
        return undefined;
      }
      // Claude tool_result events carry the generic "claude-cli" name and no
      // per-tool identity; rendering them would break merge-by-identity with
      // the named tool-start line, so they stay off the card.
      if (event.toolName === "claude-cli") {
        return undefined;
      }
      const registry: Readonly<Record<string, { emoji: string; title: string }>> = {
        // Codex item categories (threadRun.ts projection).
        "web-search": { emoji: "🌐", title: "Recherche" },
        command: { emoji: "🛠️", title: "Kommando" },
        "file-change": { emoji: "📝", title: "Dateien" },
        "mcp-tool": { emoji: "🧩", title: "Tool" },
        reasoning: { emoji: "🧠", title: "Denkt nach" },
        "image-view": { emoji: "🖼️", title: "Bild" },
        // Claude CLI tool names (claudeStreamProtocol.ts passes them verbatim).
        Bash: { emoji: "🛠️", title: "Kommando" },
        Read: { emoji: "📖", title: "Liest" },
        Edit: { emoji: "📝", title: "Dateien" },
        Write: { emoji: "📝", title: "Dateien" },
        MultiEdit: { emoji: "📝", title: "Dateien" },
        NotebookEdit: { emoji: "📝", title: "Dateien" },
        Grep: { emoji: "🔎", title: "Suche" },
        Glob: { emoji: "🔎", title: "Suche" },
        WebSearch: { emoji: "🌐", title: "Recherche" },
        WebFetch: { emoji: "🌐", title: "Recherche" },
        Task: { emoji: "🤖", title: "Agent" },
        TodoWrite: { emoji: "🗒️", title: "Plan" }
      };
      const spec = registry[event.toolName] ?? { emoji: "🧩", title: "Arbeitsschritt" };
      const done = event.kind === "tool-output" ? " ✓" : "";
      return event.detail
        ? `${spec.emoji} ${spec.title}: ${event.detail}${done}`
        : `${spec.emoji} ${spec.title}${done}`;
    }
    case "file-write":
      return "✍️ Datei geschrieben";
    case "command-exit":
      return event.exitCode === 0
        ? "✅ Kommando fertig (exit 0)"
        : `⚠️ Kommando-Fehler (exit ${event.exitCode})`;
    case "assistant-delta":
      // Fires per streamed token; the finalizing header already covers this
      // phase, and counting deltas would spam edits and inflate the step count.
      return undefined;
    case "token-usage":
    case "final":
    case "failed":
      return undefined;
  }
}

function progressStateFromHarnessEvent(event: TCodexHarnessEvent): TNeonDiscordProgressState {
  switch (event.kind) {
    case "tool-start":
    case "tool-output":
    case "command-exit":
      return "working";
    case "file-write":
      return "writing";
    case "assistant-delta":
    case "token-usage":
    case "final":
    case "failed":
      return "finalizing";
  }
}

function progressStateFromRunStatus(status: TNeonGatewayRunStatus): TNeonDiscordProgressState {
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return status === "completed" ? "completed" : "working";
}

function createStopRows(customId: string): readonly TNeonDiscordActionRow[] {
  return [
    {
      buttons: [
        {
          label: "Stoppen",
          style: "danger",
          customId,
          emoji: "⏹️"
        }
      ]
    }
  ];
}

function normalizePositiveInteger(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Discord progress card ${field} must be positive`);
  }
  return Math.trunc(value);
}
