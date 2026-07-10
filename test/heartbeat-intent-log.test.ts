import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  appendNeonHeartbeatIntentLog,
  buildNeonHeartbeatIntentEntries,
  readNeonHeartbeatIntentLog,
  resolveNeonHeartbeatTimerGate,
  runNeonHeartbeatDaemonTick,
  type INeonHeartbeatAgentState,
  type INeonHeartbeatIntentLogEntry
} from "../src/index.js";

const tickNow = new Date("2026-06-02T12:00:00.000Z");
const armedGate = resolveNeonHeartbeatTimerGate({ NEON_HEARTBEAT_TIMER_ENABLED: "1" });
const offGate = resolveNeonHeartbeatTimerGate({});

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neon-core-heartbeat-intent-test-"));
}

async function armedTickWithTwoAgents(dir: string) {
  const agents: readonly INeonHeartbeatAgentState[] = [
    { agentId: "neo", intervalMs: 900_000 },
    { agentId: "busy", intervalMs: 900_000, lastRunStartedAtMs: tickNow.getTime() - 5000 }
  ];
  return runNeonHeartbeatDaemonTick({
    cursorPath: join(dir, "cursor.json"),
    schedulerSeed: "neon-core",
    agents,
    gate: armedGate,
    now: () => tickNow
  });
}

describe("Neon heartbeat intent log (gated JSONL)", () => {
  it("blocks the append when the gate is disabled and writes no file", async () => {
    const dir = await tempDir();
    const storePath = join(dir, "heartbeat-intents.jsonl");
    try {
      const result = await appendNeonHeartbeatIntentLog({
        entries: [{ recordedAt: tickNow.toISOString(), agentId: "neo", status: "emitted" }],
        gate: offGate,
        storePath
      });
      assert.equal(result.state, "blocked");
      assert.equal(result.count, 0);
      const entries = await readNeonHeartbeatIntentLog({ storePath });
      assert.equal(entries.length, 0, "no file should have been written");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("blocks the append when armed but the storePath is missing (double-gate)", async () => {
    const result = await appendNeonHeartbeatIntentLog({
      entries: [{ recordedAt: tickNow.toISOString(), agentId: "neo", status: "emitted" }],
      gate: armedGate
    });
    assert.equal(result.state, "blocked");
  });

  it("appends, round-trips, and slices to the newest with a limit", async () => {
    const dir = await tempDir();
    const storePath = join(dir, "heartbeat-intents.jsonl");
    try {
      const entries: INeonHeartbeatIntentLogEntry[] = [
        { recordedAt: tickNow.toISOString(), agentId: "a", status: "emitted", window: "w1" },
        { recordedAt: tickNow.toISOString(), agentId: "b", status: "deferred" },
        { recordedAt: tickNow.toISOString(), agentId: "c", status: "deduped" }
      ];
      const appended = await appendNeonHeartbeatIntentLog({ entries, gate: armedGate, storePath });
      assert.equal(appended.state, "appended");
      assert.equal(appended.count, 3);

      const all = await readNeonHeartbeatIntentLog({ storePath });
      assert.equal(all.length, 3);
      const newest = await readNeonHeartbeatIntentLog({ storePath, limit: 1 });
      assert.equal(newest.length, 1);
      assert.equal(newest[0]?.agentId, "c");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("maps a daemon tick result to emitted/deferred statuses", async () => {
    const dir = await tempDir();
    try {
      const tick = await armedTickWithTwoAgents(dir);
      const entries = buildNeonHeartbeatIntentEntries(tick, () => tickNow);
      const emitted = entries.filter((entry) => entry.status === "emitted");
      const deferred = entries.filter((entry) => entry.status === "deferred");
      assert.equal(emitted.length, 1, "neo emitted");
      assert.ok(emitted[0]?.window, "emitted entries carry a window");
      assert.equal(deferred.length, 1, "busy deferred");
      assert.equal(deferred[0]?.window, undefined, "deferred entries carry no window");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("drops corrupt JSONL lines on read without throwing", async () => {
    const dir = await tempDir();
    const storePath = join(dir, "heartbeat-intents.jsonl");
    try {
      await appendNeonHeartbeatIntentLog({
        entries: [{ recordedAt: tickNow.toISOString(), agentId: "a", status: "emitted" }],
        gate: armedGate,
        storePath
      });
      await appendFile(storePath, "this is not json\n", "utf8");
      const entries = await readNeonHeartbeatIntentLog({ storePath });
      assert.equal(entries.length, 1);
      assert.doesNotMatch(JSON.stringify(entries), /secret/iu);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
