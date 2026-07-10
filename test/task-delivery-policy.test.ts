import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isNeonTerminalTaskStatus,
  decideNeonTaskTerminalDelivery,
  formatNeonTaskTerminalMessage
} from "../src/index.js";
import type { INeonTaskRecord } from "../src/index.js";

const BASE = "2026-06-02T10:00:00.000Z";

function makeTask(
  status: INeonTaskRecord["status"],
  overrides: Partial<INeonTaskRecord> = {}
): INeonTaskRecord {
  return {
    taskId: "t-1",
    title: "Reindex memory store",
    source: "flow",
    channel: "cli",
    ownerAgentId: "neo",
    status,
    priority: "normal",
    labels: [],
    links: [],
    runIds: [],
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides
  };
}

test("isNeonTerminalTaskStatus marks done and cancelled terminal, others open", () => {
  assert.equal(isNeonTerminalTaskStatus("done"), true);
  assert.equal(isNeonTerminalTaskStatus("cancelled"), true);
  for (const open of ["backlog", "ready", "in-progress", "blocked"] as const) {
    assert.equal(isNeonTerminalTaskStatus(open), false);
  }
});

test("decideNeonTaskTerminalDelivery delivers a pending terminal task", () => {
  const decision = decideNeonTaskTerminalDelivery({ task: makeTask("done") });
  assert.deepEqual(decision, { deliver: true, reason: "terminal-update" });
});

test("decideNeonTaskTerminalDelivery skips silent policy before anything else", () => {
  const decision = decideNeonTaskTerminalDelivery({ task: makeTask("done"), notifyPolicy: "silent" });
  assert.deepEqual(decision, { deliver: false, reason: "silent-policy" });
});

test("decideNeonTaskTerminalDelivery skips non-terminal status", () => {
  const decision = decideNeonTaskTerminalDelivery({ task: makeTask("in-progress") });
  assert.deepEqual(decision, { deliver: false, reason: "not-terminal" });
});

test("decideNeonTaskTerminalDelivery skips an already-delivered terminal task", () => {
  const decision = decideNeonTaskTerminalDelivery({
    task: makeTask("done"),
    deliveryState: "delivered"
  });
  assert.deepEqual(decision, { deliver: false, reason: "already-delivered" });
});

test("formatNeonTaskTerminalMessage renders done with a short run label", () => {
  const message = formatNeonTaskTerminalMessage(makeTask("done", { runIds: ["run-abcd1234ef"] }));
  assert.match(message, /^Background task done: Reindex memory store \(run run-abcd\)\./);
});

test("formatNeonTaskTerminalMessage renders cancelled without a summary", () => {
  const message = formatNeonTaskTerminalMessage(
    makeTask("cancelled", { summary: "ignored for cancelled" })
  );
  assert.match(message, /^Background task cancelled: Reindex memory store\.$/);
});

test("formatNeonTaskTerminalMessage is leak-safe: redacts secrets in title and summary", () => {
  const message = formatNeonTaskTerminalMessage(
    makeTask("done", {
      title: "Deploy sk-livedeadbeef0123456789",
      summary: "ok sk-livecafebabe9876543210 done"
    })
  );
  assert.doesNotMatch(message, /sk-livedeadbeef0123456789/);
  assert.doesNotMatch(message, /sk-livecafebabe9876543210/);
  assert.match(message, /\[REDACTED_SECRET\]/);
});
