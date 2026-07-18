import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  neonTuiPanelDescriptors,
  neonTuiPanelOrder,
  renderNeonTuiBanner,
  renderNeonTuiDashboard,
  renderNeonTuiGoodbye,
  renderNeonTuiHelp,
  renderNeonTuiHelpHint,
  renderNeonTuiPanel,
  renderNeonTuiUnknownCommand,
  resolveNeonTuiPanelDescriptor,
  routeNeonTuiCommand,
  type INeonTuiDashboard,
  type INeonTuiPanelView
} from "../src/index.js";

describe("Neonika Operator Shell — command routing", () => {
  it("routes every panel command to its panel id", () => {
    for (const descriptor of neonTuiPanelDescriptors) {
      const command = routeNeonTuiCommand(descriptor.command);

      assert.equal(command.kind, "panel");
      if (command.kind === "panel") {
        assert.equal(command.panelId, descriptor.id);
        assert.equal(command.descriptor.id, descriptor.id);
      }
    }
  });

  it("is case-insensitive and ignores trailing arguments", () => {
    const upper = routeNeonTuiCommand("STATUS");
    const trailing = routeNeonTuiCommand("  gateway extra args  ");

    assert.equal(upper.kind, "panel");
    assert.equal(upper.kind === "panel" ? upper.panelId : "", "status");
    assert.equal(trailing.kind, "panel");
    assert.equal(trailing.kind === "panel" ? trailing.panelId : "", "gateway");
  });

  it("routes dashboard aliases", () => {
    for (const alias of ["all", "dashboard", "refresh", "r", "ALL"]) {
      assert.equal(routeNeonTuiCommand(alias).kind, "dashboard");
    }
  });

  it("routes quit and help aliases", () => {
    for (const alias of ["quit", "exit", "q"]) {
      assert.equal(routeNeonTuiCommand(alias).kind, "quit");
    }

    for (const alias of ["help", "h", "?"]) {
      assert.equal(routeNeonTuiCommand(alias).kind, "help");
    }
  });

  it("treats blank input as empty and gibberish as unknown", () => {
    assert.equal(routeNeonTuiCommand("").kind, "empty");
    assert.equal(routeNeonTuiCommand("   ").kind, "empty");

    const unknown = routeNeonTuiCommand("frobnicate");
    assert.equal(unknown.kind, "unknown");
    assert.equal(unknown.kind === "unknown" ? unknown.input : "", "frobnicate");
  });

  it("keeps the descriptor registry consistent", () => {
    assert.equal(neonTuiPanelDescriptors.length, 7);
    assert.deepEqual(
      neonTuiPanelOrder,
      neonTuiPanelDescriptors.map((descriptor) => descriptor.id)
    );

    for (const descriptor of neonTuiPanelDescriptors) {
      assert.equal(descriptor.command, descriptor.id);
      assert.ok(descriptor.summary.length > 0);
      assert.equal(resolveNeonTuiPanelDescriptor(descriptor.id)?.id, descriptor.id);
    }

    assert.equal(resolveNeonTuiPanelDescriptor("nope"), undefined);
  });
});

describe("Neonika Operator Shell — rendering", () => {
  it("renders a single panel with header, state, and indented body", () => {
    const view: INeonTuiPanelView = {
      id: "gateway",
      title: "Gateway",
      command: "gateway",
      state: "ready",
      lines: ["Gateway: ready", "Runs: 2"]
    };

    const rendered = renderNeonTuiPanel(view);

    assert.match(rendered, /Gateway · gateway · ready/u);
    assert.match(rendered, /\n {2}Gateway: ready/u);
    assert.match(rendered, /\n {2}Runs: 2/u);
  });

  it("renders an empty panel body as a placeholder", () => {
    const rendered = renderNeonTuiPanel({
      id: "status",
      title: "Status",
      command: "status",
      state: "ready",
      lines: []
    });

    assert.match(rendered, /\(no data\)/u);
  });

  it("renders a full dashboard with header, all panels, and footer hint", () => {
    const dashboard: INeonTuiDashboard = {
      generatedAt: "2026-06-02T11:00:00.000Z",
      projectRoot: "/tmp/neonika",
      panels: neonTuiPanelDescriptors.map((descriptor) => ({
        id: descriptor.id,
        title: descriptor.title,
        command: descriptor.command,
        state: "ready",
        lines: [`${descriptor.title} body`]
      }))
    };

    const rendered = renderNeonTuiDashboard(dashboard);

    assert.match(rendered, /Neonika Operator Shell — dashboard/u);
    assert.match(rendered, /Generated: 2026-06-02T11:00:00\.000Z/u);
    assert.match(rendered, /Panels: 7/u);
    for (const descriptor of neonTuiPanelDescriptors) {
      assert.ok(rendered.includes(`${descriptor.title} · ${descriptor.command} · ready`));
    }
    assert.ok(rendered.includes(renderNeonTuiHelpHint()));
  });

  it("renders banner, help, unknown-command, and goodbye text", () => {
    assert.match(renderNeonTuiBanner(), /Neonika Operator Shell/u);
    assert.match(renderNeonTuiBanner(), /shadow mode/u);

    const help = renderNeonTuiHelp();
    for (const descriptor of neonTuiPanelDescriptors) {
      assert.ok(help.includes(descriptor.command));
    }
    assert.match(help, /read-only/u);

    const unknown = renderNeonTuiUnknownCommand("xyz");
    assert.match(unknown, /Unknown command: xyz/u);
    assert.ok(unknown.includes(renderNeonTuiHelpHint()));

    assert.match(renderNeonTuiGoodbye("quit"), /closed/u);
    assert.match(renderNeonTuiGoodbye("eof"), /input ended/u);
  });
});
