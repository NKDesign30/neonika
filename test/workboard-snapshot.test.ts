import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonWorkboardSnapshot,
  renderNeonWorkboardReport,
  writeNeonTask,
  type INeonTaskRecord
} from "../src/index.js";

describe("Neon Workboard snapshot", () => {
  it("reports an empty board when no tasks exist", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });

      assert.equal(snapshot.state, "empty");
      assert.equal(snapshot.totals.tasks, 0);
      assert.equal(snapshot.columns.length, 6);
      assert.deepEqual(
        snapshot.columns.map((column) => column.status),
        ["backlog", "ready", "in-progress", "blocked", "done", "cancelled"]
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("groups tasks into status columns and derives totals", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonTask(projectRoot, makeTask("t-ready", { status: "ready", priority: "normal" }));
      await writeNeonTask(projectRoot, makeTask("t-prog", { status: "in-progress", priority: "high", runIds: ["run-1"] }));
      await writeNeonTask(projectRoot, makeTask("t-blocked", { status: "blocked", priority: "urgent" }));
      await writeNeonTask(projectRoot, makeTask("t-done", { status: "done", priority: "low", runIds: ["run-2"] }));

      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.tasks, 4);
      assert.equal(snapshot.totals.open, 3, "ready + in-progress + blocked are open");
      assert.equal(snapshot.totals.blocked, 1);
      assert.equal(snapshot.totals.done, 1);
      assert.equal(snapshot.totals.linkedRuns, 2);
      assert.equal(snapshot.totals.byStatus["in-progress"], 1);
      assert.equal(snapshot.totals.byPriority.urgent, 1);

      const inProgress = snapshot.columns.find((column) => column.status === "in-progress");
      assert.equal(inProgress?.count, 1);
      assert.equal(inProgress?.title, "In Progress");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("counts overdue only for non-terminal tasks with a past due date", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonTask(projectRoot, makeTask("t-overdue", { status: "ready", due: "2026-05-01T00:00:00.000Z" }));
      await writeNeonTask(projectRoot, makeTask("t-future", { status: "ready", due: "2026-07-01T00:00:00.000Z" }));
      await writeNeonTask(projectRoot, makeTask("t-done-late", { status: "done", due: "2026-05-01T00:00:00.000Z" }));

      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });

      assert.equal(snapshot.totals.overdue, 1, "only the open past-due task is overdue");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("orders tasks within a column by priority then recency", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonTask(projectRoot, makeTask("t-low", { status: "ready", priority: "low", updatedAt: "2026-06-02T12:00:00.000Z" }));
      await writeNeonTask(projectRoot, makeTask("t-urgent", { status: "ready", priority: "urgent", updatedAt: "2026-06-01T00:00:00.000Z" }));
      await writeNeonTask(projectRoot, makeTask("t-high", { status: "ready", priority: "high", updatedAt: "2026-06-02T00:00:00.000Z" }));

      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });
      const ready = snapshot.columns.find((column) => column.status === "ready");

      assert.deepEqual(
        ready?.tasks.map((task) => task.taskId),
        ["t-urgent", "t-high", "t-low"]
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps the snapshot leak-safe and renders a readable report", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonTask(
        projectRoot,
        makeTask("t-secret", { status: "in-progress", title: "Leak sk-live-0123456789abcdefghij now" })
      );

      const snapshot = await createNeonWorkboardSnapshot(projectRoot, { now: fixedNow });
      const report = renderNeonWorkboardReport(snapshot);

      assert.doesNotMatch(JSON.stringify(snapshot), /sk-live-0123456789abcdefghij/);
      assert.doesNotMatch(report, /sk-live-0123456789abcdefghij/);
      assert.match(report, /Neon Workboard: ready/);
      assert.match(report, /In Progress \(1\)/);
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

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-workboard-"));
}
