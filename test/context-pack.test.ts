import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assembleNeonContextPack,
  createNeonContextPack,
  renderNeonContextPackReport,
  writeNeonGatewayRun,
  writeNeonTask,
  type IAssembleNeonContextPackInput,
  type IMemoryAttachment,
  type INeonGatewayShadowRun,
  type INeonTaskRecord
} from "../src/index.js";

const SECRET = "sk-live-0123456789abcdefghij";

describe("Neonika Context Engine — pack assembly", () => {
  it("assembles memory, runs, tasks, and an always-present channel section", () => {
    const pack = assembleNeonContextPack(baseInput({ memory: memoryWith("clean memory note") }));

    const ids = pack.sections.map((section) => section.id);
    assert.deepEqual(ids, ["memory", "runs", "tasks", "channel"]);
    assert.equal(pack.state, "ready");
    assert.equal(pack.sections.find((section) => section.id === "channel")?.items.length, 1);
    assert.ok((pack.sections.find((section) => section.id === "memory")?.items.length ?? 0) >= 1);
    assert.ok((pack.sections.find((section) => section.id === "runs")?.items.length ?? 0) >= 1);
    assert.ok((pack.sections.find((section) => section.id === "tasks")?.items.length ?? 0) >= 1);
    assert.equal(pack.safety.leakSafe, true);
  });

  it("redacts secrets across every section", () => {
    const pack = assembleNeonContextPack(
      baseInput({
        memory: memoryWith(`recall ${SECRET}`),
        runPreview: `inbound ${SECRET}`,
        taskTitle: `task ${SECRET}`,
        query: `triage ${SECRET}`
      })
    );

    assert.doesNotMatch(JSON.stringify(pack), new RegExp(SECRET));
    assert.doesNotMatch(renderNeonContextPackReport(pack), new RegExp(SECRET));
  });

  it("enforces the character budget and counts dropped items", () => {
    const tasks = Array.from({ length: 6 }, (_, index) =>
      makeTask(`task-${index}`, { title: `Task number ${index} with a fairly long descriptive title` })
    );

    const pack = assembleNeonContextPack({
      agentId: "neo",
      channel: "cli",
      tasks,
      runs: [],
      charBudget: 40,
      now: fixedNow
    });

    assert.ok(pack.totals.droppedForBudget > 0, "tight budget must drop items");
    assert.ok(pack.bounds.charsUsed <= 40);
    assert.ok(pack.sections.some((section) => section.truncated));
  });

  it("reports empty when only channel metadata is present", () => {
    const pack = assembleNeonContextPack({
      agentId: "neo",
      channel: "cli",
      runs: [],
      tasks: [],
      now: fixedNow
    });

    assert.equal(pack.state, "empty");
    assert.equal(pack.totals.items, 1, "only the channel metadata item remains");
    assert.equal(pack.sections.find((section) => section.id === "memory")?.note, "no memory provider attached");
  });

  it("populates the memory section from an attached provider and redacts it", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-context-mem-"));

    try {
      const pack = await createNeonContextPack(
        projectRoot,
        { agentId: "chaty", channel: "discord", channelId: "chan-1", query: "triage" },
        {
          now: fixedNow,
          memoryProvider: {
            search: async () => ({
              query: "triage",
              hits: [{ source: "semantic-memory", text: `prior decision ${SECRET}` }],
              diagnostics: []
            })
          }
        }
      );

      const memory = pack.sections.find((section) => section.id === "memory");
      assert.ok((memory?.items.length ?? 0) >= 1, "memory section populated from provider");
      assert.doesNotMatch(JSON.stringify(pack), new RegExp(SECRET));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("filters runs and tasks to the requested channel when gathered from stores", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-context-store-"));

    try {
      await writeNeonGatewayRun(projectRoot, makeRun("run-discord", "discord", "chan-1"));
      await writeNeonGatewayRun(projectRoot, makeRun("run-cli", "cli", "terminal"));
      await writeNeonTask(projectRoot, makeTask("task-discord", { channel: "discord", channelId: "chan-1" }));
      await writeNeonTask(projectRoot, makeTask("task-cli", { channel: "cli" }));

      const pack = await createNeonContextPack(
        projectRoot,
        { agentId: "chaty", channel: "discord", channelId: "chan-1" },
        { now: fixedNow }
      );

      const runs = pack.sections.find((section) => section.id === "runs");
      const tasks = pack.sections.find((section) => section.id === "tasks");
      assert.equal(runs?.items.length, 1, "only the discord run matches");
      assert.equal(tasks?.items.length, 1, "only the discord task matches");
      assert.match(runs?.items[0]?.source ?? "", /run-discord/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

interface IBaseInputOverrides {
  readonly memory?: IMemoryAttachment;
  readonly runPreview?: string;
  readonly taskTitle?: string;
  readonly query?: string;
}

function baseInput(overrides: IBaseInputOverrides): IAssembleNeonContextPackInput {
  return {
    agentId: "chaty",
    channel: "discord",
    channelId: "chan-1",
    ...(overrides.query ? { query: overrides.query } : {}),
    runs: [makeRun("run-1", "discord", "chan-1", overrides.runPreview)],
    tasks: [makeTask("task-1", { title: overrides.taskTitle ?? "Triage backlog", channel: "discord", channelId: "chan-1" })],
    ...(overrides.memory ? { memory: overrides.memory } : {}),
    now: fixedNow
  };
}

function memoryWith(text: string): IMemoryAttachment {
  return {
    state: "attached",
    hitCount: 1,
    note: "test memory",
    excerpts: [{ source: "semantic-memory", text }]
  };
}

function makeTask(taskId: string, overrides: Partial<INeonTaskRecord>): INeonTaskRecord {
  return {
    taskId,
    title: "Workboard task",
    source: "operator",
    channel: "cli",
    ownerAgentId: "neo",
    status: "in-progress",
    priority: "high",
    labels: [],
    links: [],
    runIds: [],
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides
  };
}

function makeRun(
  runId: string,
  channel: INeonGatewayShadowRun["request"]["channel"],
  channelId: string,
  preview?: string
): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel,
      accountId: "default",
      channelId,
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/neon",
      mode: "read-only",
      contentPreview: preview ?? "inbound message",
      receivedAt: "2026-06-02T09:00:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: `session-${runId}`,
    memoryState: "skipped",
    events: [],
    finalText: "ack",
    delivery: {
      state: "suppressed",
      targetChannel: channel,
      targetChannelId: channelId,
      reason: "shadow",
      finalText: "ack"
    },
    startedAt: "2026-06-02T09:00:00.000Z",
    completedAt: "2026-06-02T09:00:01.000Z"
  };
}

function fixedNow(): Date {
  return new Date("2026-06-02T12:00:00.000Z");
}
