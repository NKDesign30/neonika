import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonCanaryOutboundSender,
  executeNeonScheduledAgentRun,
  readNeonGatewayRuns,
  resolveNeonScheduledAgentExecutionGate,
  writeNeonGatewayRunLatest,
  type IAgentAttachment,
  type ICodexHarness,
  type ICodexHarnessInput,
  type INeonGatewayShadowRun,
  type IMemoryAttachment
} from "../src/index.js";

const agent: IAgentAttachment = {
  id: "chaty",
  displayName: "Chaty",
  role: "Senior Dev",
  runtime: "codex",
  instructions: ["Ship verified slices."],
  memoryQuerySeeds: ["scheduled runtime"]
};

const memory: IMemoryAttachment = {
  state: "attached",
  hitCount: 1,
  note: "agent-scoped memory",
  excerpts: [{ source: "memory", text: "Prior scheduler decision." }]
};

describe("Neon scheduled agent execution", () => {
  it("is default-off and requires an explicit ready gate", () => {
    assert.deepEqual(resolveNeonScheduledAgentExecutionGate({}), {
      enabled: false,
      reason: "execution-disabled",
      envKey: "NEON_SCHEDULED_AGENT_EXECUTION_ENABLED"
    });
    assert.equal(
      resolveNeonScheduledAgentExecutionGate({
        NEON_SCHEDULED_AGENT_EXECUTION_ENABLED: "ready"
      }).enabled,
      true
    );
  });

  it("does not invoke a harness or sender when the execution gate is closed", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-scheduled-agent-off-"));
    const harness: ICodexHarness = {
      id: "codex-app-server",
      async run() {
        throw new Error("gate-off harness must not run");
      }
    };

    try {
      const result = await executeNeonScheduledAgentRun({
        projectRoot,
        specification: {
          runId: "heartbeat-chaty-window",
          source: "heartbeat",
          sourceId: "chaty",
          agentId: "chaty",
          goal: "heartbeat wake",
          content: "Review the heartbeat.",
          receivedAt: "2026-08-11T10:00:00.000Z",
          deliveryTarget: {
            channel: "discord",
            to: "private-canary"
          }
        },
        runtime: {
          gate: resolveNeonScheduledAgentExecutionGate({}),
          resolveAgent: () => agent,
          resolveHarness: () => harness,
          resolveMemory: async () => {
            throw new Error("gate-off memory must not resolve");
          },
          sender: {
            async sendText() {
              throw new Error("gate-off sender must not run");
            }
          }
        }
      });

      assert.equal(result.state, "blocked");
      assert.equal(result.attempts, 0);
      assert.equal(result.outboundSent, false);
      const stored = await readNeonGatewayRuns(projectRoot);
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.status, "completed");
      assert.equal(stored[0]?.delivery.state, "suppressed");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("does not retry a permanent harness failure", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-scheduled-agent-permanent-"));
    let harnessCalls = 0;
    try {
      const result = await executeNeonScheduledAgentRun({
        projectRoot,
        specification: {
          runId: "cron-invalid-window",
          source: "cron",
          sourceId: "invalid",
          agentId: "chaty",
          goal: "cron invalid",
          content: "Run a permanently invalid job.",
          receivedAt: "2026-08-11T10:00:00.000Z"
        },
        runtime: {
          gate: resolveNeonScheduledAgentExecutionGate({
            NEON_SCHEDULED_AGENT_EXECUTION_ENABLED: "ready"
          }),
          resolveAgent: () => agent,
          resolveHarness: () => ({
            id: "codex-app-server",
            async run(input) {
              harnessCalls += 1;
              return {
                sessionKey: "scheduled:chaty",
                memoryState: input.memory.state,
                events: [{ kind: "failed", message: "invalid request" }],
                finalText: "invalid request"
              };
            }
          }),
          resolveMemory: async () => memory,
          maxAttempts: 3,
          delay: async () => {
            throw new Error("permanent failures must not enter retry delay");
          }
        }
      });

      assert.equal(result.state, "failed");
      assert.equal(result.attempts, 1);
      assert.equal(result.retryCount, 0);
      assert.equal(harnessCalls, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("persists a Canary-policy suppression reason for a targeted completed run", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-scheduled-agent-suppressed-"));
    try {
      const result = await executeNeonScheduledAgentRun({
        projectRoot,
        specification: {
          runId: "cron-suppressed-window",
          source: "cron",
          sourceId: "suppressed",
          agentId: "chaty",
          goal: "cron suppressed",
          content: "Run the gated job.",
          receivedAt: "2026-08-11T10:00:00.000Z",
          deliveryTarget: {
            channel: "discord",
            to: "private-canary"
          }
        },
        runtime: {
          gate: resolveNeonScheduledAgentExecutionGate({
            NEON_SCHEDULED_AGENT_EXECUTION_ENABLED: "ready"
          }),
          resolveAgent: () => agent,
          resolveHarness: () => ({
            id: "codex-app-server",
            async run(input) {
              return {
                sessionKey: "scheduled:chaty",
                memoryState: input.memory.state,
                events: [{ kind: "final", text: "Completed without live outbound." }],
                finalText: "Completed without live outbound."
              };
            }
          }),
          resolveMemory: async () => memory,
          sender: createNeonCanaryOutboundSender({ env: {} }),
          maxAttempts: 1
        }
      });

      assert.equal(result.state, "executed");
      assert.equal(result.outboundSent, false);
      assert.equal(result.run.delivery.state, "suppressed");
      assert.equal(result.run.delivery.reason, "scheduled-outbound-canary-gate-closed");
      const stored = await readNeonGatewayRuns(projectRoot);
      assert.equal(stored[0]?.delivery.reason, "scheduled-outbound-canary-gate-closed");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("persists running and terminal evidence, retries one transient failure, attaches memory, and delivers through the Canary sender", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-scheduled-agent-"));
    const observedStatuses: INeonGatewayShadowRun["status"][] = [];
    const observedInputs: ICodexHarnessInput[] = [];
    let attempts = 0;
    const harness: ICodexHarness = {
      id: "codex-app-server",
      async run(input) {
        observedInputs.push(input);
        attempts += 1;
        if (attempts === 1) {
          return {
            sessionKey: "scheduled:chaty",
            memoryState: input.memory.state,
            events: [{ kind: "failed", message: "service unavailable (503)" }],
            finalText: "service unavailable"
          };
        }
        return {
          sessionKey: "scheduled:chaty",
          memoryState: input.memory.state,
          events: [{ kind: "final", text: "Scheduled check complete." }],
          finalText: "Scheduled check complete."
        };
      }
    };
    const sender = createNeonCanaryOutboundSender({
      gateFacts: {
        cutoverStage: "canary",
        canaryApproved: true,
        outboundEnabled: true
      },
      channelAllowlist: { channels: new Set(["private-canary"]), configured: true },
      transport: {
        async postMessage() {
          return { messageId: "scheduled-message-1" };
        }
      },
      now: () => new Date("2026-08-11T10:00:03.000Z")
    });

    try {
      const result = await executeNeonScheduledAgentRun({
        projectRoot,
        specification: {
          runId: "cron-demo-2026-08-11T10-00-current",
          source: "cron",
          sourceId: "demo",
          agentId: "chaty",
          goal: "cron demo",
          content: "Run the configured demo job for its due window.",
          receivedAt: "2026-08-11T10:00:00.000Z",
          deliveryTarget: {
            channel: "discord",
            accountId: "default",
            to: "private-canary",
            chatType: "channel"
          }
        },
        runtime: {
          gate: resolveNeonScheduledAgentExecutionGate({
            NEON_SCHEDULED_AGENT_EXECUTION_ENABLED: "ready"
          }),
          resolveAgent: () => agent,
          resolveHarness: () => harness,
          resolveMemory: async () => memory,
          sender,
          maxAttempts: 2,
          delay: async () => undefined,
          now: createClock()
        },
        writeRun: async (root, run) => {
          observedStatuses.push(run.status);
          await writeNeonGatewayRunLatest(root, run);
        }
      });

      assert.equal(result.state, "executed");
      assert.equal(result.attempts, 2);
      assert.equal(result.retryCount, 1);
      assert.equal(result.run.status, "completed");
      assert.equal(result.run.memoryState, "attached");
      assert.equal(result.run.mode, "live");
      assert.equal(result.run.delivery.state, "delivered");
      assert.equal(result.outboundSent, true);
      assert.deepEqual(observedStatuses, ["running", "failed", "running", "completed", "completed"]);
      assert.equal(observedInputs.length, 2);
      assert.ok(observedInputs.every((input) => input.memory.state === "attached"));
      assert.ok(
        result.run.events.some(
          (event) => event.kind === "tool-output" && event.toolName === "scheduled-agent-retry"
        )
      );

      const stored = await readNeonGatewayRuns(projectRoot);
      assert.equal(stored.length, 1, "latest writer keeps one logical run per due window");
      assert.equal(stored[0]?.runId, result.run.runId);
      assert.equal(stored[0]?.delivery.state, "delivered");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createClock(): () => Date {
  const values = [
    "2026-08-11T10:00:00.000Z",
    "2026-08-11T10:00:01.000Z",
    "2026-08-11T10:00:02.000Z",
    "2026-08-11T10:00:03.000Z"
  ];
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? values[values.length - 1];
    index += 1;
    return new Date(value ?? "2026-08-11T10:00:03.000Z");
  };
}
