/**
 * Neon Operator Shell — pure contract.
 *
 * A textual, read-only operator surface that is the terminal-native sibling of
 * Neon Mission Control. This module holds ONLY pure logic: the panel registry,
 * command routing, and rendering. All I/O (snapshot loading) lives in
 * `operatorShellData.ts`; the interactive REPL lives in `interactiveShell.ts`.
 *
 * Shadow-contract note: every panel renders an existing read-only snapshot
 * builder's output. The shell never sends, mutates, or executes anything. The
 * command union is intentionally extensible (see `TNeonTuiCommand`) so a later
 * slice can add gated `approve`/`ack`/`send` verbs behind the cutover gate
 * without reshaping the router.
 *
 * Upstream reference: `src/tui/*` (Ink/PTY interactive client) and
 * `src/tui/tui-status-summary.ts` (status text aggregation). Strategy:
 * rebuild-native — Neon ships a minimal line-oriented operator shell over the
 * existing snapshot projections, not the full React/PTY terminal app.
 */

/** Stable identifier for each operator panel. */
export type TNeonTuiPanelId =
  | "status"
  | "gateway"
  | "routes"
  | "sessions"
  | "delivery"
  | "cutover"
  | "doctor";

/** Static description of one operator panel. */
export interface INeonTuiPanelDescriptor {
  readonly id: TNeonTuiPanelId;
  /** Human-facing title shown in the panel header. */
  readonly title: string;
  /** Command word that selects this panel in the shell. */
  readonly command: TNeonTuiPanelId;
  /** One-line summary shown in help and the dashboard footer. */
  readonly summary: string;
}

/** A rendered panel: its descriptor plus a resolved state label and body lines. */
export interface INeonTuiPanelView {
  readonly id: TNeonTuiPanelId;
  readonly title: string;
  readonly command: TNeonTuiPanelId;
  /** Short state label, e.g. `ready`, `empty`, `warn`, `error`. */
  readonly state: string;
  /** Already-redacted body lines from the underlying snapshot render. */
  readonly lines: readonly string[];
}

/** A full dashboard snapshot: all panels resolved at one point in time. */
export interface INeonTuiDashboard {
  readonly generatedAt: string;
  readonly projectRoot: string;
  readonly panels: readonly INeonTuiPanelView[];
}

/**
 * Result of routing one line of operator input. Discriminated on `kind` so the
 * REPL can `switch` exhaustively and so future gated verbs slot in cleanly.
 */
export type TNeonTuiCommand =
  | { readonly kind: "panel"; readonly panelId: TNeonTuiPanelId; readonly descriptor: INeonTuiPanelDescriptor }
  | { readonly kind: "dashboard" }
  | { readonly kind: "help" }
  | { readonly kind: "quit" }
  | { readonly kind: "empty" }
  | { readonly kind: "unknown"; readonly input: string };

/** The operator panels in display order. */
export const neonTuiPanelDescriptors: readonly INeonTuiPanelDescriptor[] = [
  {
    id: "status",
    title: "Status",
    command: "status",
    summary: "Neon Core product manifest and layers."
  },
  {
    id: "gateway",
    title: "Gateway",
    command: "gateway",
    summary: "Persisted Gateway run totals and the latest run."
  },
  {
    id: "routes",
    title: "Routes",
    command: "routes",
    summary: "Discord route and allowlist inspection (no secrets)."
  },
  {
    id: "sessions",
    title: "Sessions",
    command: "sessions",
    summary: "Sessions projected from Gateway runs."
  },
  {
    id: "delivery",
    title: "Delivery",
    command: "delivery",
    summary: "Queued delivery dry-runs (outbound stays suppressed)."
  },
  {
    id: "cutover",
    title: "Cutover",
    command: "cutover",
    summary: "Shadow/Mirror/Canary/Primary/Retire gate readiness."
  },
  {
    id: "doctor",
    title: "Doctor",
    command: "doctor",
    summary: "Local health checks against Gateway state."
  }
];

/** The panel ids in display order. */
export const neonTuiPanelOrder: readonly TNeonTuiPanelId[] = neonTuiPanelDescriptors.map(
  (descriptor) => descriptor.id
);

const panelDescriptorById: ReadonlyMap<TNeonTuiPanelId, INeonTuiPanelDescriptor> = new Map(
  neonTuiPanelDescriptors.map((descriptor) => [descriptor.id, descriptor])
);

const QUIT_WORDS: ReadonlySet<string> = new Set(["quit", "exit", "q"]);
const HELP_WORDS: ReadonlySet<string> = new Set(["help", "h", "?"]);
const DASHBOARD_WORDS: ReadonlySet<string> = new Set(["dashboard", "all", "refresh", "r"]);

/** Resolve a panel descriptor by its id, or `undefined` if unknown. */
export function resolveNeonTuiPanelDescriptor(
  id: string
): INeonTuiPanelDescriptor | undefined {
  return panelDescriptorById.get(id as TNeonTuiPanelId);
}

/**
 * Route one raw input line to a command. Pure and case-insensitive; only the
 * first whitespace-delimited token is interpreted (trailing args are reserved
 * for future gated verbs and ignored here).
 */
export function routeNeonTuiCommand(rawInput: string): TNeonTuiCommand {
  const trimmed = rawInput.trim();

  if (trimmed.length === 0) {
    return { kind: "empty" };
  }

  const token = trimmed.split(/\s+/)[0] ?? "";
  const word = token.toLowerCase();

  if (QUIT_WORDS.has(word)) {
    return { kind: "quit" };
  }

  if (HELP_WORDS.has(word)) {
    return { kind: "help" };
  }

  if (DASHBOARD_WORDS.has(word)) {
    return { kind: "dashboard" };
  }

  const descriptor = resolveNeonTuiPanelDescriptor(word);
  if (descriptor) {
    return { kind: "panel", panelId: descriptor.id, descriptor };
  }

  return { kind: "unknown", input: trimmed };
}

/** Render a single resolved panel as an indented, headed block. */
export function renderNeonTuiPanel(view: INeonTuiPanelView): string {
  const header = `── ${view.title} · ${view.command} · ${view.state} ──`;
  const body =
    view.lines.length > 0
      ? view.lines.map((line) => (line.length > 0 ? `  ${line}` : "")).join("\n")
      : "  (no data)";

  return `${header}\n${body}`;
}

/** Render the full dashboard: banner, every panel, and a footer hint. */
export function renderNeonTuiDashboard(dashboard: INeonTuiDashboard): string {
  const head = [
    "Neon Operator Shell — dashboard",
    `Project: ${dashboard.projectRoot}`,
    `Generated: ${dashboard.generatedAt}`,
    `Panels: ${dashboard.panels.length}`
  ].join("\n");
  const panels = dashboard.panels.map((view) => renderNeonTuiPanel(view)).join("\n\n");

  return [head, "", panels, "", renderNeonTuiFooter()].join("\n");
}

/** Render the welcome banner shown when the interactive shell starts. */
export function renderNeonTuiBanner(): string {
  return [
    "Neon Operator Shell",
    "Read-only terminal surface over live Neon snapshots (shadow mode).",
    "Type a panel name, `all` for the full dashboard, `help`, or `quit`."
  ].join("\n");
}

/** Render the one-line prompt hint. */
export function renderNeonTuiHelpHint(): string {
  const commands = neonTuiPanelOrder.join(", ");

  return `Panels: ${commands} · all · help · quit`;
}

/** Render the help screen listing every command. */
export function renderNeonTuiHelp(): string {
  const panelLines = neonTuiPanelDescriptors.map(
    (descriptor) => `  ${descriptor.command.padEnd(9)} ${descriptor.summary}`
  );

  return [
    "Neon Operator Shell — commands",
    ...panelLines,
    "  all       Render every panel as one dashboard.",
    "  help      Show this help.",
    "  quit      Leave the operator shell.",
    "",
    "All panels are read-only. Outbound delivery stays suppressed in shadow mode."
  ].join("\n");
}

/** Render the message for an unrecognized command. */
export function renderNeonTuiUnknownCommand(input: string): string {
  return `Unknown command: ${input}\n${renderNeonTuiHelpHint()}`;
}

/** Render the goodbye line printed when the shell closes. */
export function renderNeonTuiGoodbye(reason: "quit" | "eof"): string {
  return reason === "quit" ? "Neon Operator Shell: closed." : "Neon Operator Shell: input ended.";
}

function renderNeonTuiFooter(): string {
  return renderNeonTuiHelpHint();
}
