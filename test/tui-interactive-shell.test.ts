import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";

import {
  runNeonOperatorShell,
  type INeonTuiDashboard,
  type INeonTuiPanelView,
  type TNeonTuiPanelId
} from "../src/index.js";

describe("Neon Operator Shell — interactive REPL", () => {
  it("routes scripted commands through the loop and quits cleanly", async () => {
    const requestedPanels: TNeonTuiPanelId[] = [];
    let dashboardCalls = 0;

    const output = createCaptureStream();
    const result = await runNeonOperatorShell({
      projectRoot: "/tmp/neon-core-tui",
      input: createScriptedInput(["status", "help", "frobnicate", "all", "quit"]),
      output: output.stream,
      loadPanel: async (_projectRoot, panelId) => {
        requestedPanels.push(panelId);

        return stubPanel(panelId);
      },
      loadDashboard: async () => {
        dashboardCalls += 1;

        return stubDashboard();
      }
    });

    const text = output.text();

    assert.equal(result.quitReason, "quit");
    assert.equal(result.commandsHandled, 5);
    assert.deepEqual(requestedPanels, ["status"]);
    assert.equal(dashboardCalls, 1);

    assert.match(text, /Neon Operator Shell/u);
    assert.match(text, /Panels: status, gateway/u);
    assert.match(text, /STUB-PANEL status/u);
    assert.match(text, /Neon Operator Shell — commands/u);
    assert.match(text, /Unknown command: frobnicate/u);
    assert.match(text, /STUB-DASHBOARD/u);
    assert.match(text, /Neon Operator Shell: closed\./u);
    // The stub bodies are leak-safe; nothing secret-shaped leaves the loop.
    assert.doesNotMatch(text, /sk-[a-z0-9]/u);
  });

  it("ends on end-of-input without an explicit quit", async () => {
    const output = createCaptureStream();
    const result = await runNeonOperatorShell({
      projectRoot: "/tmp/neon-core-tui",
      input: createScriptedInput(["gateway"]),
      output: output.stream,
      loadPanel: async (_projectRoot, panelId) => stubPanel(panelId),
      loadDashboard: async () => stubDashboard()
    });

    assert.equal(result.quitReason, "eof");
    assert.equal(result.commandsHandled, 1);
    assert.match(output.text(), /Neon Operator Shell: input ended\./u);
  });
});

function createScriptedInput(lines: readonly string[]): Readable {
  const input = new Readable({ read() {} });

  for (const line of lines) {
    input.push(`${line}\n`);
  }

  input.push(null);

  return input;
}

function createCaptureStream(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback): void {
      chunks.push(typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8"));
      callback();
    }
  });

  return { stream, text: () => chunks.join("") };
}

function stubPanel(panelId: TNeonTuiPanelId): INeonTuiPanelView {
  return {
    id: panelId,
    title: panelId,
    command: panelId,
    state: "ready",
    lines: [`STUB-PANEL ${panelId}`]
  };
}

function stubDashboard(): INeonTuiDashboard {
  return {
    generatedAt: "2026-06-02T11:00:00.000Z",
    projectRoot: "/tmp/neon-core-tui",
    panels: [
      {
        id: "status",
        title: "Status",
        command: "status",
        state: "ready",
        lines: ["STUB-DASHBOARD body"]
      }
    ]
  };
}
