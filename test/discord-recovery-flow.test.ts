import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordComponentActionRegistry,
  createNeonDiscordRecoveryRuntime,
  isNeonDiscordRecoveryActionType,
  readNeonDiscordRecoverySession,
  resolveNeonDiscordComponentActionStatePath,
  resolveNeonDiscordRecoverySessionPath,
  writeNeonGatewayRunLatest,
  type INeonDiscordRecoveryRuntime,
  type INeonDeliveryQueueTarget,
  type INeonGatewayShadowRun,
  type TNeonDiscordActionRow
} from "../src/index.js";

const nowIso = "2026-07-10T09:00:00.000Z";

describe("Discord recovery flow", () => {
  it("posts one thread-scoped card and executes an owner retry once across a restart", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-recovery-"));
    const run = failedRun(projectRoot, true);
    const transport = new RecordingRecoveryTransport();
    const statePath = resolveNeonDiscordComponentActionStatePath(projectRoot);
    let actionSequence = 0;
    const firstRegistry = createNeonDiscordComponentActionRegistry({
      statePath,
      now: () => new Date(nowIso),
      createActionId: () => `recovery-${actionSequence += 1}`
    });
    const executions: string[] = [];
    const createRuntime = (registry: ReturnType<typeof createNeonDiscordComponentActionRegistry>) =>
      createNeonDiscordRecoveryRuntime({
        projectRoot,
        registry,
        transport,
        canContinue: () => Promise.resolve(true),
        execute: async ({ action }) => {
          executions.push(action);
          return { runId: "recovery-run-1", status: "completed" as const };
        },
        now: () => new Date(nowIso)
      });

    try {
      await writeNeonGatewayRunLatest(projectRoot, run);
      const firstRuntime = createRuntime(firstRegistry);
      const first = await firstRuntime.start(run);
      assert.equal(first.state, "recovery-pending");
      if (first.state !== "recovery-pending") {
        throw new Error("Recovery fixture did not start");
      }
      const recoveryPath = resolveNeonDiscordRecoverySessionPath(projectRoot, first.recoveryId);
      const interruptedState = JSON.parse(await readFile(recoveryPath, "utf8")) as {
        status: string;
        cardMessageId?: string;
      };
      interruptedState.status = "preparing";
      delete interruptedState.cardMessageId;
      await writeFile(recoveryPath, `${JSON.stringify(interruptedState, null, 2)}\n`, { mode: 0o600 });
      const resumed = await createRuntime(firstRegistry).start(run);
      const duplicate = await firstRuntime.start(run);
      assert.equal(resumed.state, "recovery-pending");
      assert.equal(duplicate.state, "recovery-pending");
      assert.equal(transport.posts.length, 1);
      assert.deepEqual(buttonLabels(transport.rows), ["Erneut versuchen", "Fortsetzen", "Schließen"]);
      assert.equal(transport.target?.threadId, "thread-1");

      let restartedRuntime: INeonDiscordRecoveryRuntime | undefined;
      const restartedRegistry = createNeonDiscordComponentActionRegistry({
        statePath,
        now: () => new Date(nowIso),
        resolveHandler: (actionType) => isNeonDiscordRecoveryActionType(actionType)
          ? async (context) => {
              if (!restartedRuntime) {
                throw new Error("recovery runtime missing");
              }
              return await restartedRuntime.handleAction(context);
            }
          : undefined
      });
      restartedRuntime = createRuntime(restartedRegistry);
      const retryId = readButtonCustomId(transport.rows, "Erneut versuchen");
      const foreign = await restartedRegistry.dispatch(interaction(retryId, "other", "thread-1"));
      const wrongScope = await restartedRegistry.dispatch(interaction(retryId, "operator", "channel-1"));
      const [owner, replay] = await Promise.all([
        restartedRegistry.dispatch(interaction(retryId, "operator", "thread-1", "owner")),
        restartedRegistry.dispatch(interaction(retryId, "operator", "thread-1", "replay"))
      ]);

      assert.equal(foreign.state, "rejected");
      assert.equal(foreign.reason, "owner-mismatch");
      assert.equal(wrongScope.state, "rejected");
      assert.equal(wrongScope.reason, "scope-mismatch");
      assert.equal(owner.state, "completed");
      assert.equal(replay.state, "rejected");
      assert.deepEqual(executions, ["retry"]);
      if (first.state === "recovery-pending") {
        const session = await readNeonDiscordRecoverySession(projectRoot, first.recoveryId);
        assert.equal(session?.status, "recovered");
        assert.equal(session?.recoveryRunId, "recovery-run-1");
        assert.equal((await stat(resolveNeonDiscordRecoverySessionPath(projectRoot, first.recoveryId))).mode & 0o777, 0o600);
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("offers only Close when neither retry nor continuation is safe", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-recovery-close-"));
    const run = failedRun(projectRoot, false);
    const transport = new RecordingRecoveryTransport();
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(nowIso),
      createActionId: () => "recovery-close"
    });
    const runtime = createNeonDiscordRecoveryRuntime({
      projectRoot,
      registry,
      transport,
      canContinue: () => Promise.resolve(false),
      execute: () => Promise.reject(new Error("must not execute")),
      now: () => new Date(nowIso)
    });

    try {
      await writeNeonGatewayRunLatest(projectRoot, run);
      const started = await runtime.start(run);
      assert.equal(started.state, "recovery-pending");
      assert.deepEqual(buttonLabels(transport.rows), ["Schließen"]);
      const closed = await registry.dispatch(
        interaction(readButtonCustomId(transport.rows, "Schließen"), "operator", "thread-1")
      );
      assert.equal(closed.state, "completed");
      if (started.state === "recovery-pending") {
        assert.equal((await readNeonDiscordRecoverySession(projectRoot, started.recoveryId))?.status, "closed");
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

class RecordingRecoveryTransport {
  readonly posts: Array<{ readonly body: string }> = [];
  rows: readonly TNeonDiscordActionRow[] = [];
  target?: INeonDeliveryQueueTarget;

  postComponents(
    target: INeonDeliveryQueueTarget,
    body: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }> {
    this.target = target;
    this.rows = rows;
    this.posts.push({ body });
    return Promise.resolve({ messageId: "recovery-card-1" });
  }
}

function buttonLabels(rows: readonly TNeonDiscordActionRow[]): readonly string[] {
  const row = rows[0];
  return row && "buttons" in row ? row.buttons.map((button) => button.label) : [];
}

function readButtonCustomId(rows: readonly TNeonDiscordActionRow[], label: string): string {
  const row = rows[0];
  if (!row || !("buttons" in row)) {
    throw new Error("Expected recovery buttons");
  }
  const customId = row.buttons.find((button) => button.label === label)?.customId;
  if (!customId) {
    throw new Error(`Missing recovery button: ${label}`);
  }
  return customId;
}

function interaction(customId: string, userId: string, channelId: string, interactionId = "interaction") {
  return {
    interactionId,
    kind: "button" as const,
    customId,
    userId,
    guildId: "guild-1",
    channelId,
    createdAt: nowIso
  };
}

function failedRun(projectRoot: string, hasMessageId: boolean): INeonGatewayShadowRun {
  return {
    runId: hasMessageId ? "failed-run-1" : "failed-run-close",
    mode: "shadow",
    status: "failed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      threadId: "thread-1",
      ...(hasMessageId ? { messageId: "message-1" } : {}),
      userId: "operator",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "write",
      contentPreview: "Auftrag",
      receivedAt: nowIso
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-1",
    memoryState: "skipped",
    events: [{ kind: "failed", message: "runtime failed" }],
    finalText: "runtime failed",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "runtime failed"
    },
    startedAt: nowIso,
    completedAt: "2026-07-10T09:00:10.000Z"
  };
}
