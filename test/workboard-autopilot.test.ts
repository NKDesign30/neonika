import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  createNeonDryRunWorkboardExecutor,
  createNeonGatewayShadowWorkboardExecutor,
  createNeonWorkboardCard,
  readNeonGatewayRuns,
  readNeonTasks,
  readNeonWorkboardCards,
  runNeonWorkboardAutoDispatchOnce
} from "../src/index.js";

describe("Neon Workboard autopilot", () => {
  it("claims a ready card and completes it through an executor", async () => {
    const projectRoot = await createTempProjectRoot();
    const now = createClock("2026-06-05T13:00:00.000Z");

    try {
      const card = await createNeonWorkboardCard(
        projectRoot,
        {
          title: "Build Katapuldra page",
          status: "ready",
          priority: "urgent",
          agentId: "chaty",
          taskId: "task-katapuldra"
        },
        now().getTime()
      );
      const result = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
        ownerId: "chaty",
        maxCards: 1,
        now,
        executor: async (input) => ({
          state: "completed",
          summary: `Built ${input.card.title}`,
          proof: { status: "passed", command: "npm test", label: "unit" }
        })
      });
      const cards = await readNeonWorkboardCards(projectRoot);
      const tasks = await readNeonTasks(projectRoot);
      const completed = cards.find((candidate) => candidate.id === card.id);
      const task = tasks.find((candidate) => candidate.taskId === "task-katapuldra");

      assert.equal(result.state, "processed");
      assert.equal(result.completed, 1);
      assert.equal(completed?.status, "done");
      assert.equal(completed?.metadata?.claim, undefined);
      assert.equal(completed?.metadata?.proof?.at(-1)?.command, "npm test");
      assert.equal(task?.status, "done");
      assert.equal(task?.priority, "urgent");
      assert.equal(task?.ownerAgentId, "chaty");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("blocks a claimed card when the executor fails", async () => {
    const projectRoot = await createTempProjectRoot();
    const now = createClock("2026-06-05T13:10:00.000Z");

    try {
      const card = await createNeonWorkboardCard(
        projectRoot,
        {
          title: "Failing card sk-live-SHOULD-REDACT",
          status: "ready",
          priority: "normal",
          taskId: "task-failing"
        },
        now().getTime()
      );
      const result = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
        ownerId: "chaty",
        now,
        executor: async () => {
          throw new Error("executor broke sk-live-SHOULD-REDACT");
        }
      });
      const cards = await readNeonWorkboardCards(projectRoot);
      const tasks = await readNeonTasks(projectRoot);
      const blocked = cards.find((candidate) => candidate.id === card.id);
      const task = tasks.find((candidate) => candidate.taskId === "task-failing");
      const serialized = JSON.stringify(cards);

      assert.equal(result.blocked, 1);
      assert.equal(blocked?.status, "blocked");
      assert.equal(blocked?.metadata?.failureCount, 1);
      assert.equal(task?.status, "blocked");
      assert.match(task?.summary ?? "", /\[REDACTED_SECRET\]/u);
      assert.doesNotMatch(serialized, /sk-live-SHOULD-REDACT/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("returns empty without mutating when no ready cards exist", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const result = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
        executor: createNeonDryRunWorkboardExecutor()
      });
      const cards = await readNeonWorkboardCards(projectRoot);

      assert.equal(result.state, "empty");
      assert.equal(result.processed, 0);
      assert.equal(cards.length, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("can execute a card through the Gateway shadow run path and persist proof", async () => {
    const projectRoot = await createTempProjectRoot();
    const now = createClock("2026-06-05T13:20:00.000Z");

    try {
      const card = await createNeonWorkboardCard(
        projectRoot,
        {
          title: "Gateway Workboard executor",
          status: "ready",
          priority: "high",
          agentId: "chaty",
          taskId: "task-gateway-executor",
          source: {
            kind: "discord-message",
            channel: "discord",
            accountId: "default",
            guildId: "900000000000000001",
            channelId: "900000000000000005",
            messageId: "gateway-workboard-executor"
          }
        },
        now().getTime()
      );
      const result = await runNeonWorkboardAutoDispatchOnce(projectRoot, {
        ownerId: "chaty",
        now,
        executor: createNeonGatewayShadowWorkboardExecutor({
          harness: createDryRunHarness(),
          now,
          mode: "write"
        })
      });
      const cards = await readNeonWorkboardCards(projectRoot);
      const tasks = await readNeonTasks(projectRoot);
      const runs = await readNeonGatewayRuns(projectRoot);
      const completed = cards.find((candidate) => candidate.id === card.id);
      const task = tasks.find((candidate) => candidate.taskId === "task-gateway-executor");

      assert.equal(result.completed, 1);
      assert.equal(completed?.status, "done");
      assert.equal(completed?.metadata?.proof?.at(-1)?.label, "gateway-shadow-run");
      assert.equal(task?.status, "done");
      assert.deepEqual(task?.runIds, [runs[0]?.runId]);
      assert.equal(task?.links.some((link) => link.type === "run" && link.ref === runs[0]?.runId), true);
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.request.channel, "discord");
      assert.equal(runs[0]?.request.messageId, `workboard:${card.id}:gateway-workboard-executor`);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "neonika-workboard-autopilot-"));
}

function createClock(startIso: string): () => Date {
  let current = Date.parse(startIso);

  return () => {
    current += 1000;
    return new Date(current);
  };
}
