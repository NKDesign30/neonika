import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonWorkboardSnapshot,
  renderNeonMissionControlWorkboardPanel,
  writeNeonTask,
  type INeonTaskRecord
} from "../src/index.js";

describe("Mission Control Workboard panel", () => {
  it("renders the loading state when no snapshot is supplied", () => {
    const html = renderNeonMissionControlWorkboardPanel();

    assert.match(html, /Neon Arbeitsbereich/);
    assert.match(html, /data-workboard-state="loading"/);
  });

  it("renders columns, totals, and task rows from a live snapshot", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-workboard-panel-"));

    try {
      await writeNeonTask(projectRoot, makeTask("t-prog", { status: "in-progress", priority: "high", title: "Triage inbox" }));
      await writeNeonTask(projectRoot, makeTask("t-block", { status: "blocked", priority: "urgent", title: "Await approval" }));

      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });
      const html = renderNeonMissionControlWorkboardPanel(snapshot);

      assert.match(html, /data-workboard-state="ready"/);
      assert.match(html, /In Progress/);
      assert.match(html, /Blocked/);
      assert.match(html, /data-workboard-column="in-progress"/);
      assert.match(html, /Triage inbox/);
      assert.match(html, /data-workboard-blocked="1"/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("shows an explicit empty state for an empty board, never fabricated rows", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-workboard-panel-empty-"));

    try {
      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });
      const html = renderNeonMissionControlWorkboardPanel(snapshot);

      assert.match(html, /data-workboard-empty="true"/);
      assert.match(html, /Keine Aufgaben/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("escapes HTML in task titles and never leaks a secret", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-workboard-panel-escape-"));

    try {
      await writeNeonTask(
        projectRoot,
        makeTask("t-xss", {
          status: "ready",
          title: "<script>alert(1)</script> token sk-live-0123456789abcdefghij"
        })
      );

      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });
      const html = renderNeonMissionControlWorkboardPanel(snapshot);

      assert.doesNotMatch(html, /<script>alert/);
      assert.match(html, /&lt;script&gt;/);
      assert.doesNotMatch(html, /sk-live-0123456789abcdefghij/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function makeTask(taskId: string, overrides: Partial<INeonTaskRecord>): INeonTaskRecord {
  return {
    taskId,
    title: "Workboard task",
    source: "operator",
    channel: "cli",
    ownerAgentId: "neo",
    status: "ready",
    priority: "normal",
    labels: [],
    links: [],
    runIds: [],
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides
  };
}

function fixedNow(): Date {
  return new Date("2026-06-02T12:00:00.000Z");
}
