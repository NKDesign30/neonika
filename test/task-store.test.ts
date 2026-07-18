import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  readNeonTaskRecords,
  readNeonTasks,
  resolveNeonTaskStatePaths,
  writeNeonTask,
  type INeonTaskRecord
} from "../src/index.js";

describe("Neonika Task store", () => {
  it("writes and reads tasks from a Neon-owned JSONL store", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonTask(projectRoot, createTask("task-1", { status: "ready" }));
      await writeNeonTask(projectRoot, createTask("task-2", { status: "blocked" }));

      const tasks = await readNeonTasks(projectRoot);

      assert.equal(tasks.length, 2);
      assert.equal(tasks[0]?.taskId, "task-1");
      assert.equal(tasks[1]?.status, "blocked");
      assert.match(resolveNeonTaskStatePaths(projectRoot).tasksPath, /state\/tasks\/tasks\.jsonl$/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("collapses an append-only log to the latest record per taskId", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonTask(projectRoot, createTask("task-1", { status: "backlog", updatedAt: "2026-06-01T00:00:00.000Z" }));
      await writeNeonTask(projectRoot, createTask("task-1", { status: "in-progress", updatedAt: "2026-06-02T00:00:00.000Z" }));

      const records = await readNeonTaskRecords(projectRoot);
      const projected = await readNeonTasks(projectRoot);

      assert.equal(records.length, 2, "the raw log keeps every append");
      assert.equal(projected.length, 1, "the projection collapses to one record per id");
      assert.equal(projected[0]?.status, "in-progress");
      assert.equal(projected[0]?.updatedAt, "2026-06-02T00:00:00.000Z");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("redacts secrets in free-text fields on write and never leaks them on read", async () => {
    const projectRoot = await createTempProjectRoot();
    const paths = resolveNeonTaskStatePaths(projectRoot);

    try {
      await writeNeonTask(
        projectRoot,
        createTask("task-secret", {
          title: "Rotate token sk-live-0123456789abcdefghij",
          summary: "Bearer sk-live-0123456789abcdefghij must be cycled",
          links: [{ type: "url", ref: "https://x.test?token=sk-live-0123456789abcdefghij", label: "ref sk-live-0123456789abcdefghij" }],
          labels: ["token sk-live-0123456789abcdefghij"]
        })
      );

      const onDisk = await readFile(paths.tasksPath, "utf8");
      const tasks = await readNeonTasks(projectRoot);
      const serialized = JSON.stringify(tasks);

      assert.doesNotMatch(onDisk, /sk-live-0123456789abcdefghij/, "secret must not reach disk");
      assert.doesNotMatch(serialized, /sk-live-0123456789abcdefghij/, "secret must not reach a reader");
      assert.equal(tasks.length, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("re-redacts a hand-edited line on read so a tampered file cannot leak", async () => {
    const projectRoot = await createTempProjectRoot();
    const paths = resolveNeonTaskStatePaths(projectRoot);

    try {
      await mkdir(dirname(paths.tasksPath), { recursive: true });
      const tampered = {
        ...createTask("task-tampered", {}),
        title: "leak sk-live-0123456789abcdefghij"
      };
      await writeFile(paths.tasksPath, `${JSON.stringify(tampered)}\n`, "utf8");

      const tasks = await readNeonTasks(projectRoot);

      assert.equal(tasks.length, 1);
      assert.doesNotMatch(JSON.stringify(tasks), /sk-live-0123456789abcdefghij/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("skips corrupted and malformed lines while keeping valid tasks", async () => {
    const projectRoot = await createTempProjectRoot();
    const paths = resolveNeonTaskStatePaths(projectRoot);

    try {
      await mkdir(dirname(paths.tasksPath), { recursive: true });
      await writeFile(
        paths.tasksPath,
        [
          JSON.stringify(createTask("task-valid", {})),
          "not-json",
          JSON.stringify({ taskId: "task-no-status", title: "x", source: "operator", channel: "cli", ownerAgentId: "neo" }),
          ""
        ].join("\n"),
        "utf8"
      );

      const tasks = await readNeonTasks(projectRoot);

      assert.equal(tasks.length, 1);
      assert.equal(tasks[0]?.taskId, "task-valid");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("returns an empty list when the store does not exist yet", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const tasks = await readNeonTasks(projectRoot);

      assert.deepEqual(tasks, []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createTask(taskId: string, overrides: Partial<INeonTaskRecord>): INeonTaskRecord {
  return {
    taskId,
    title: "Sample task",
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

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-task-store-"));
}
