import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findLatestNeonTaskForSessionKey,
  findNeonTaskByRunId,
  listNeonTasksForFlowId,
  listNeonTasksForOwner,
  resolveNeonTaskForLookupToken,
  scopeNeonTaskToOwner,
  type INeonTaskRecord
} from "../src/index.js";

function makeTask(overrides: Partial<INeonTaskRecord> & { taskId: string }): INeonTaskRecord {
  return {
    title: "Base task",
    source: "operator",
    channel: "discord",
    ownerAgentId: "neo",
    status: "ready",
    priority: "normal",
    labels: [],
    links: [],
    runIds: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

const tasks: readonly INeonTaskRecord[] = [
  makeTask({
    taskId: "t1",
    runIds: ["run-A"],
    ownerAgentId: "neo",
    flowId: "flow-1",
    updatedAt: "2026-06-01T10:00:00.000Z",
    links: [{ type: "session", ref: "sess-1" }]
  }),
  makeTask({
    taskId: "t2",
    runIds: ["run-A", "run-B"],
    ownerAgentId: "rex",
    flowId: "flow-1",
    updatedAt: "2026-06-02T10:00:00.000Z",
    links: [{ type: "session", ref: "sess-1" }]
  }),
  makeTask({
    taskId: "t3",
    runIds: ["run-C"],
    ownerAgentId: "neo",
    flowId: "flow-2",
    updatedAt: "2026-06-03T10:00:00.000Z"
  })
];

test("findNeonTaskByRunId returns the latest task referencing the run", () => {
  // run-A is in t1 and t2; t2 has the later updatedAt.
  assert.equal(findNeonTaskByRunId(tasks, "run-A")?.taskId, "t2");
  assert.equal(findNeonTaskByRunId(tasks, "run-B")?.taskId, "t2");
  assert.equal(findNeonTaskByRunId(tasks, "run-C")?.taskId, "t3");
});

test("findNeonTaskByRunId returns undefined for no match or empty id", () => {
  assert.equal(findNeonTaskByRunId(tasks, "run-X"), undefined);
  assert.equal(findNeonTaskByRunId(tasks, ""), undefined);
});

test("findLatestNeonTaskForSessionKey resolves via session links, latest wins", () => {
  assert.equal(findLatestNeonTaskForSessionKey(tasks, "sess-1")?.taskId, "t2");
  assert.equal(findLatestNeonTaskForSessionKey(tasks, "sess-none"), undefined);
  assert.equal(findLatestNeonTaskForSessionKey(tasks, ""), undefined);
});

test("listNeonTasksForOwner returns all tasks for the agent", () => {
  assert.deepEqual(
    listNeonTasksForOwner(tasks, "neo").map((t) => t.taskId),
    ["t1", "t3"]
  );
  assert.deepEqual(
    listNeonTasksForOwner(tasks, "rex").map((t) => t.taskId),
    ["t2"]
  );
  assert.equal(listNeonTasksForOwner(tasks, "ghost").length, 0);
});

test("listNeonTasksForFlowId returns all tasks for the flow", () => {
  assert.deepEqual(
    listNeonTasksForFlowId(tasks, "flow-1").map((t) => t.taskId),
    ["t1", "t2"]
  );
  assert.deepEqual(
    listNeonTasksForFlowId(tasks, "flow-2").map((t) => t.taskId),
    ["t3"]
  );
  assert.equal(listNeonTasksForFlowId(tasks, "flow-none").length, 0);
});

test("resolveNeonTaskForLookupToken tries taskId, then runId, then session", () => {
  assert.equal(resolveNeonTaskForLookupToken(tasks, "t1")?.taskId, "t1");
  assert.equal(resolveNeonTaskForLookupToken(tasks, "run-C")?.taskId, "t3");
  assert.equal(resolveNeonTaskForLookupToken(tasks, "sess-1")?.taskId, "t2");
  assert.equal(resolveNeonTaskForLookupToken(tasks, "nope"), undefined);
  assert.equal(resolveNeonTaskForLookupToken(tasks, ""), undefined);
});

test("scopeNeonTaskToOwner returns the task only for its owner agent", () => {
  assert.equal(scopeNeonTaskToOwner(tasks[0], "neo")?.taskId, "t1");
  assert.equal(scopeNeonTaskToOwner(tasks[0], "rex"), undefined);
  assert.equal(scopeNeonTaskToOwner(undefined, "neo"), undefined);
  // fail-closed on an empty owner id
  assert.equal(scopeNeonTaskToOwner(tasks[0], ""), undefined);
});

test("owner-scoped single-access blocks cross-owner lookup by run id", () => {
  // run-A resolves to t2 (owner rex); neo must not reach it through run-A.
  assert.equal(scopeNeonTaskToOwner(findNeonTaskByRunId(tasks, "run-A"), "rex")?.taskId, "t2");
  assert.equal(scopeNeonTaskToOwner(findNeonTaskByRunId(tasks, "run-A"), "neo"), undefined);
  // run-C resolves to t3 (owner neo).
  assert.equal(scopeNeonTaskToOwner(findNeonTaskByRunId(tasks, "run-C"), "neo")?.taskId, "t3");
});
