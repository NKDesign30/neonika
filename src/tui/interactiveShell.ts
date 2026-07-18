/**
 * Neonika Operator Shell — interactive REPL.
 *
 * The imperative entry point: a line-oriented loop that reads operator input,
 * routes it through the pure `operatorShell` router, and prints read-only panel
 * renders. Streams and loaders are injectable so the loop is testable without a
 * TTY and without touching the real `process.stdin`.
 *
 * The loop never sends, mutates, or executes. It is the terminal sibling of
 * Mission Control and the seam where future gated `approve`/`ack`/`send` verbs
 * would attach (each behind the cutover gate, never autonomously).
 */

import { createInterface } from "node:readline";

import {
  loadNeonTuiDashboard,
  loadNeonTuiPanel,
  type ILoadNeonTuiDashboardOptions
} from "./operatorShellData.js";
import {
  renderNeonTuiBanner,
  renderNeonTuiDashboard,
  renderNeonTuiGoodbye,
  renderNeonTuiHelp,
  renderNeonTuiHelpHint,
  renderNeonTuiPanel,
  renderNeonTuiUnknownCommand,
  routeNeonTuiCommand
} from "./operatorShell.js";

/** Options for running the interactive operator shell. */
export interface IRunNeonOperatorShellOptions {
  readonly projectRoot?: string;
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Injectable clock forwarded to the panel loaders. */
  readonly now?: () => Date;
  /** Injectable dashboard loader (defaults to the live read-only loader). */
  readonly loadDashboard?: typeof loadNeonTuiDashboard;
  /** Injectable single-panel loader (defaults to the live read-only loader). */
  readonly loadPanel?: typeof loadNeonTuiPanel;
  /** Prompt string printed before each input line. */
  readonly prompt?: string;
}

/** Summary of one operator shell session. */
export interface INeonOperatorShellResult {
  readonly commandsHandled: number;
  readonly quitReason: "quit" | "eof";
}

const DEFAULT_PROMPT = "neon> ";

/** Run the interactive operator shell until `quit` or end-of-input. */
export async function runNeonOperatorShell(
  options: IRunNeonOperatorShellOptions = {}
): Promise<INeonOperatorShellResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const loadDashboard = options.loadDashboard ?? loadNeonTuiDashboard;
  const loadPanel = options.loadPanel ?? loadNeonTuiPanel;
  const prompt = options.prompt ?? DEFAULT_PROMPT;
  const loaderOptions: ILoadNeonTuiDashboardOptions = options.now ? { now: options.now } : {};

  const writeLine = (text: string): void => {
    output.write(`${text}\n`);
  };
  const writePrompt = (): void => {
    output.write(prompt);
  };

  writeLine(renderNeonTuiBanner());
  writeLine(renderNeonTuiHelpHint());

  const rl = createInterface({ input, terminal: false });

  let commandsHandled = 0;
  let quitReason: "quit" | "eof" = "eof";

  writePrompt();

  try {
    for await (const line of rl) {
      const command = routeNeonTuiCommand(line);

      if (command.kind === "empty") {
        writePrompt();
        continue;
      }

      commandsHandled += 1;

      if (command.kind === "quit") {
        quitReason = "quit";
        break;
      }

      if (command.kind === "help") {
        writeLine(renderNeonTuiHelp());
        writePrompt();
        continue;
      }

      if (command.kind === "unknown") {
        writeLine(renderNeonTuiUnknownCommand(command.input));
        writePrompt();
        continue;
      }

      if (command.kind === "dashboard") {
        const dashboard = await loadDashboard(projectRoot, loaderOptions);
        writeLine(renderNeonTuiDashboard(dashboard));
        writePrompt();
        continue;
      }

      const view = await loadPanel(projectRoot, command.panelId, loaderOptions);
      writeLine(renderNeonTuiPanel(view));
      writePrompt();
    }
  } finally {
    rl.close();
  }

  writeLine(renderNeonTuiGoodbye(quitReason));

  return { commandsHandled, quitReason };
}
