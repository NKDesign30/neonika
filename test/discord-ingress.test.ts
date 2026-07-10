import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordIngressDecision,
  createDryRunHarness,
  createNeonSessionActorQueue,
  mapDiscordSlashInteractionToMessageEnvelope,
  readNeonGatewayRuns,
  readNeonGatewayStatus,
  readNeonCommitments,
  readNeonCronStoreEvents,
  readNeonTasks,
  runNeonDiscordShadowIngress,
  resolveNeonCommitmentCaptureGate,
  resolveNeonCommitmentStorePath,
  writeNeonGatewayRunLatest,
  type ICodexHarness,
  type ICodexHarnessInput,
  type ICodexHarnessResult,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type INeonDiscordSlashInteractionEnvelope
} from "../src/index.js";

const botUserId = "900000000000000010";
const allowedGuildId = "900000000000000001";
const allowedChannelId = "900000000000000005";

describe("Neon Discord ingress", () => {
  it("accepts an allowed guild message when the bot is mentioned", () => {
    const decision = createNeonDiscordIngressDecision(createDiscordEnvelope(), createPolicy());

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, true);
      assert.equal(decision.message.channel, "discord");
      assert.equal(decision.message.guildId, allowedGuildId);
      assert.equal(decision.message.channelId, allowedChannelId);
      assert.equal(decision.message.threadId, "900000000000000011");
      assert.equal(decision.message.content, "bau shadow bitte");
      assert.equal(decision.message.agentId, "chaty");
      assert.equal(decision.message.mode, "read-only");
    }
  });

  it("routes @neo alias commands to the Neo agent without requiring the Chaty bot mention", () => {
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: "@neo baus",
        mentionedUserIds: []
      }),
      createPolicy({
        mentionPolicy: "guild",
        agentMentionRoutes: [{ agentId: "neo", aliases: ["neo"] }]
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, true);
      assert.equal(decision.message.agentId, "neo");
      assert.equal(decision.message.content, "baus");
    }
  });

  it("routes configured Neo Discord mentions to the Neo agent", () => {
    const neoUserId = "900000000000000015";
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: `<@${neoUserId}> bau die PDF`,
        mentionedUserIds: [neoUserId]
      }),
      createPolicy({
        mentionPolicy: "guild",
        ignoredMentionedUserIds: [neoUserId],
        agentMentionRoutes: [{ agentId: "neo", mentionedUserIds: [neoUserId] }]
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, true);
      assert.equal(decision.message.agentId, "neo");
      assert.equal(decision.message.content, "bau die PDF");
    }
  });

  it("accepts attachment-only voice messages when mentions are not required", () => {
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: "",
        mentionedUserIds: [],
        attachments: [createVoiceAttachment()]
      }),
      createPolicy({
        mentionPolicy: "never"
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, false);
      assert.equal(decision.message.content, "");
      assert.equal(decision.message.attachments?.[0]?.kind, "audio");
      assert.equal(decision.message.attachments?.[0]?.voiceMessage, true);
    }
  });

  it("drops guild messages without a mention when guild mention policy is active", () => {
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: "bau shadow bitte",
        mentionedUserIds: []
      }),
      createPolicy()
    );

    assert.deepEqual(decision, {
      state: "dropped",
      reason: "mention-required",
      wasMentioned: false
    });
  });

  it("drops messages aimed at an ignored mentioned user while channel listening is open", () => {
    const lawBotUserId = "900000000000000015";
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: `<@${lawBotUserId}> was kannst du alles?`,
        mentionedUserIds: [lawBotUserId]
      }),
      createPolicy({
        mentionPolicy: "never",
        ignoredMentionedUserIds: [lawBotUserId]
      })
    );

    assert.deepEqual(decision, {
      state: "dropped",
      reason: "ignored-mentioned-user",
      wasMentioned: false
    });
  });

  it("drops messages aimed at Neo when Chaty is the open channel listener", () => {
    const neoBotUserId = "900000000000000002";
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: `<@${neoBotUserId}> bau die PDF`,
        mentionedUserIds: [neoBotUserId]
      }),
      createPolicy({
        mentionPolicy: "never",
        ignoredMentionedUserIds: [neoBotUserId]
      })
    );

    assert.deepEqual(decision, {
      state: "dropped",
      reason: "ignored-mentioned-user",
      wasMentioned: false
    });
  });

  it("drops @neo alias commands when Chaty is the open channel listener", () => {
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: "@neo bau die PDF",
        mentionedUserIds: []
      }),
      createPolicy({
        mentionPolicy: "never",
        ignoredMentionAliases: ["neo"]
      })
    );

    assert.deepEqual(decision, {
      state: "dropped",
      reason: "ignored-mentioned-user",
      wasMentioned: false
    });
  });

  it("lets an explicit self mention win over ignored mentioned users", () => {
    const lawBotUserId = "900000000000000015";
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: `<@${botUserId}> frag <@${lawBotUserId}> später`,
        mentionedUserIds: [botUserId, lawBotUserId]
      }),
      createPolicy({
        mentionPolicy: "never",
        ignoredMentionedUserIds: [lawBotUserId]
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, true);
      assert.equal(decision.message.content, "frag <@900000000000000015> später");
    }
  });

  it("lets an explicit self mention win over ignored mention aliases", () => {
    const decision = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        content: `<@${botUserId}> @neo soll später helfen`,
        mentionedUserIds: [botUserId]
      }),
      createPolicy({
        mentionPolicy: "never",
        ignoredMentionAliases: ["neo"]
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, true);
      assert.equal(decision.message.content, "@neo soll später helfen");
      assert.equal(decision.message.agentId, "chaty");
    }
  });

  it("maps slash interactions into deterministic Discord message envelopes", () => {
    const envelope = mapDiscordSlashInteractionToMessageEnvelope(
      createSlashInteractionEnvelope({
        commandName: " skill ",
        subcommandName: " run ",
        options: [
          {
            name: " query ",
            value: "memory search"
          },
          {
            name: "enabled",
            value: true
          },
          {
            name: "limit",
            value: 3
          }
        ]
      })
    );

    assert.deepEqual(envelope, {
      accountId: "default",
      guildId: allowedGuildId,
      channelId: allowedChannelId,
      threadId: "900000000000000011",
      messageId: "interaction:900000000000000013",
      author: {
        id: "operator",
        username: "operator",
        displayName: "Operator"
      },
      content: '/skill run query="memory search" enabled=true limit=3',
      createdAt: "2026-05-31T17:55:00.000Z",
      mentionedUserIds: []
    });

    assert.ok(envelope);

    const decision = createNeonDiscordIngressDecision(
      envelope,
      createPolicy({
        mentionPolicy: "never"
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, false);
      assert.equal(decision.message.messageId, "interaction:900000000000000013");
      assert.equal(decision.message.content, '/skill run query="memory search" enabled=true limit=3');
    }
  });

  it("drops empty slash commands before they reach Discord ingress policy", () => {
    const envelope = mapDiscordSlashInteractionToMessageEnvelope(
      createSlashInteractionEnvelope({
        commandName: "   "
      })
    );

    assert.equal(envelope, undefined);
  });

  it("accepts direct messages without a mention under guild mention policy", () => {
    const decision = createNeonDiscordIngressDecision(
      createDirectMessageEnvelope(),
      createPolicy({
        allowedGuildIds: []
      })
    );

    assert.equal(decision.state, "accepted");

    if (decision.state === "accepted") {
      assert.equal(decision.wasMentioned, false);
      assert.equal(decision.message.guildId, undefined);
      assert.equal(decision.message.content, "dm shadow bitte");
    }
  });

  it("drops messages outside the allowed guild or channel", () => {
    const wrongGuild = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        guildId: "other-guild"
      }),
      createPolicy()
    );
    const wrongChannel = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        channelId: "other-channel"
      }),
      createPolicy()
    );

    assert.equal(wrongGuild.state, "dropped");
    assert.equal(wrongGuild.reason, "guild-not-allowed");
    assert.equal(wrongChannel.state, "dropped");
    assert.equal(wrongChannel.reason, "channel-not-allowed");
  });

  it("drops bot authors and ignored users before creating a gateway message", () => {
    const botAuthor = createNeonDiscordIngressDecision(
      createDiscordEnvelope({
        author: {
          id: "service-bot",
          username: "service",
          bot: true
        }
      }),
      createPolicy()
    );
    const ignoredUser = createNeonDiscordIngressDecision(
      createDiscordEnvelope(),
      createPolicy({
        ignoredUserIds: ["operator"]
      })
    );

    assert.equal(botAuthor.state, "dropped");
    assert.equal(botAuthor.reason, "bot-author");
    assert.equal(ignoredUser.state, "dropped");
    assert.equal(ignoredUser.reason, "ignored-user");
  });

  it("runs accepted Discord messages through shadow mode and persists the run", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const result = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope(),
          policy: createPolicy({
            workspaceRoot: projectRoot
          }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "Discord ingress smoke"
          }
        },
        {
          projectRoot,
          harness: createDryRunHarness(),
          now: () => new Date("2026-05-31T18:00:00.000Z")
        }
      );

      assert.equal(result.state, "accepted");

      if (result.state === "accepted") {
        assert.equal(result.result.run.delivery.state, "suppressed");
        assert.equal(result.result.run.request.channel, "discord");
        assert.equal(result.result.run.request.contentPreview, "bau shadow bitte");
      }

      const status = await readNeonGatewayStatus(projectRoot);
      const tasks = await readNeonTasks(projectRoot);
      const workboard = result.state === "accepted" ? result.workboard : undefined;
      const task =
        workboard && (workboard.state === "created" || workboard.state === "existing")
          ? tasks.find((candidate) => candidate.taskId === workboard.dedupeKey)
          : undefined;

      assert.equal(status.runCount, 1);
      assert.equal(status.latestRun?.channel, "discord");
      assert.equal(status.latestRun?.agentId, "chaty");
      assert.equal(task?.status, "done");
      assert.deepEqual(task?.runIds, result.state === "accepted" ? [result.result.run.runId] : []);
      assert.equal(task?.channel, "discord");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("transcribes accepted Discord voice attachments before the harness run", async () => {
    const projectRoot = await createTempProjectRoot();
    const harness = new FixedFinalHarness("voice understood");

    try {
      const result = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: "",
            mentionedUserIds: [],
            attachments: [createVoiceAttachment()]
          }),
          policy: createPolicy({
            mentionPolicy: "never",
            workspaceRoot: projectRoot
          }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "Voice ingress smoke"
          }
        },
        {
          projectRoot,
          harness,
          voiceTranscription: {
            mode: "on",
            apiKey: "test-eleven-key",
            transcribe: async (input) => {
              assert.equal(input.attachment.name, "voice-message.ogg");
              assert.equal(input.apiKey, "test-eleven-key");
              return "Hallo Chaty, verstehst du das automatisch?";
            }
          },
          now: () => new Date("2026-05-31T18:00:00.000Z")
        }
      );

      assert.equal(result.state, "accepted");
      assert.match(harness.input?.prompt ?? "", /Voice transcript 1 \(voice-message\.ogg\): Hallo Chaty/u);

      if (result.state === "accepted") {
        assert.match(result.result.run.request.contentPreview, /Voice transcript 1/u);
        assert.equal(result.result.run.request.sourceHadVoiceAttachment, true);
        assert.equal(result.result.run.request.requestedVoiceReply, undefined);
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("marks voice replies only when the message or transcript explicitly asks for one", async () => {
    const projectRoot = await createTempProjectRoot();
    const harness = new FixedFinalHarness("voice reply requested");

    try {
      const result = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: "",
            mentionedUserIds: [],
            attachments: [createVoiceAttachment()]
          }),
          policy: createPolicy({
            mentionPolicy: "never",
            workspaceRoot: projectRoot
          }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "Explicit voice reply smoke"
          }
        },
        {
          projectRoot,
          harness,
          voiceTranscription: {
            mode: "on",
            apiKey: "test-eleven-key",
            transcribe: async () => "Bitte mit Sprachnachricht antworten."
          },
          now: () => new Date("2026-05-31T18:00:00.000Z")
        }
      );

      assert.equal(result.state, "accepted");

      if (result.state === "accepted") {
        assert.equal(result.result.run.request.sourceHadVoiceAttachment, true);
        assert.equal(result.result.run.request.requestedVoiceReply, true);
      }
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("handles /cron commands as control runs without starting the harness", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const result = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: `<@${botUserId}> /cron add deploy-check every-15m Check deploy`
          }),
          policy: createPolicy({
            workspaceRoot: projectRoot
          }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "Cron command smoke"
          }
        },
        {
          projectRoot,
          harness: new ThrowingHarness(),
          now: () => new Date("2026-05-31T18:00:00.000Z"),
          cronCommand: {
            env: { NEON_CRON_STORE_ENABLED: "ready" }
          }
        }
      );

      assert.equal(result.state, "accepted");
      if (result.state === "accepted") {
        assert.match(result.result.run.runId, /^discord-cron-/u);
        assert.equal(result.result.run.status, "completed");
        assert.equal(result.result.run.delivery.state, "suppressed");
        assert.equal(result.result.run.finalText.includes("deploy-check"), true);
        assert.equal(result.workboard.state, "skipped");
      }

      const events = await readNeonCronStoreEvents(projectRoot);
      const runs = await readNeonGatewayRuns(projectRoot);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.id, "deploy-check");
      assert.equal(events[0]?.deliveryTarget?.to, allowedChannelId);
      assert.equal(runs.length, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("captures explicit agent promises into the commitment store after a completed Discord run", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const result = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: `<@${botUserId}> check bitte später ob der Deploy grün ist`
          }),
          policy: createPolicy({
            workspaceRoot: projectRoot
          }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "Commitment capture smoke"
          }
        },
        {
          projectRoot,
          harness: new FixedFinalHarness("Ich erinnere dich in 15m daran und checke den Deploy nochmal."),
          now: () => new Date("2026-05-31T18:00:00.000Z"),
          commitmentCapture: {
            gate: resolveNeonCommitmentCaptureGate({ NEON_COMMITMENT_CAPTURE_ENABLED: "ready" })
          }
        }
      );

      assert.equal(result.state, "accepted");
      const commitments = await readNeonCommitments({
        storePath: resolveNeonCommitmentStorePath(projectRoot)
      });
      assert.equal(commitments.length, 1);
      assert.equal(commitments[0]?.agentId, "chaty");
      assert.equal(commitments[0]?.status, "pending");
      assert.equal(commitments[0]?.source, "agent_promise");
      assert.match(commitments[0]?.suggestedText ?? "", /Deploy/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("can persist a running run and replace it with the terminal run through the real ingress", async () => {
    const projectRoot = await createTempProjectRoot();
    const observedStatuses: string[] = [];
    const writeLatestObserved = async (root: string, run: Parameters<typeof writeNeonGatewayRunLatest>[1]) => {
      observedStatuses.push(run.status);
      await writeNeonGatewayRunLatest(root, run);
    };

    try {
      const result = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope(),
          policy: createPolicy({
            workspaceRoot: projectRoot
          }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "Discord live lifecycle substrate smoke"
          }
        },
        {
          projectRoot,
          harness: createDryRunHarness(),
          now: () => new Date("2026-05-31T18:01:00.000Z"),
          writeRun: writeLatestObserved,
          writeRunningRun: writeLatestObserved
        }
      );

      assert.equal(result.state, "accepted");
      assert.deepEqual(observedStatuses, ["running", "completed"]);

      const runs = await readNeonGatewayRuns(projectRoot);
      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.status, "completed");
      assert.equal(status.runCount, 1);
      assert.equal(status.runningCount, 0);
      assert.equal(status.completedCount, 1);
      assert.equal(status.latestRun?.runId, result.state === "accepted" ? result.result.run.runId : undefined);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("serializes accepted messages with the same session key through the injected actor queue", async () => {
    const projectRoot = await createTempProjectRoot();
    const firstGate = deferred<void>();
    const harness = new ControlledHarness([firstGate]);
    const sessionQueue = createNeonSessionActorQueue();

    try {
      const first = runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({ messageId: "message-one" }),
          policy: createPolicy({ workspaceRoot: projectRoot }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "first"
          }
        },
        { projectRoot, harness, sessionQueue }
      );
      const second = runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({ messageId: "message-two" }),
          policy: createPolicy({ workspaceRoot: projectRoot }),
          memory: {
            state: "skipped",
            hitCount: 0,
            note: "second"
          }
        },
        { projectRoot, harness, sessionQueue }
      );

      await harness.waitForStartCount(1);
      assert.equal(harness.starts, 1);
      assert.equal(sessionQueue.snapshot().pending, 2);

      firstGate.resolve();
      await first;
      await harness.waitForStartCount(2);

      assert.equal(harness.starts, 2);
      await second;
      assert.equal(sessionQueue.snapshot().pending, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("resolves memory only after Discord policy accepts the message", async () => {
    const projectRoot = await createTempProjectRoot();
    let resolverCalls = 0;

    try {
      const dropped = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope({
            content: "bau shadow bitte",
            mentionedUserIds: []
          }),
          policy: createPolicy({
            workspaceRoot: projectRoot
          }),
          resolveMemory: () => {
            resolverCalls += 1;

            return {
              state: "attached",
              hitCount: 1,
              note: "should not resolve for dropped messages"
            };
          }
        },
        {
          projectRoot,
          harness: createDryRunHarness()
        }
      );

      assert.equal(dropped.state, "dropped");
      assert.equal(resolverCalls, 0);

      const accepted = await runNeonDiscordShadowIngress(
        {
          message: createDiscordEnvelope(),
          policy: createPolicy({
            workspaceRoot: projectRoot
          }),
          resolveMemory: (message) => {
            resolverCalls += 1;
            assert.equal(message.content, "bau shadow bitte");

            return {
              state: "attached",
              hitCount: 1,
              note: "accepted memory"
            };
          }
        },
        {
          projectRoot,
          harness: createDryRunHarness()
        }
      );

      assert.equal(accepted.state, "accepted");
      assert.equal(resolverCalls, 1);

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.latestRun?.memoryState, "attached");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createPolicy(
  overrides: Partial<INeonDiscordIngressPolicy> = {}
): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: "/Users/operator/neon-projects/neon-core",
    mode: "read-only",
    botUserId,
    mentionPolicy: "guild",
    allowedGuildIds: [allowedGuildId],
    allowedChannelIds: [allowedChannelId],
    ignoredUserIds: [],
    ...overrides
  };
}

interface IDeferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): IDeferred<T> {
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

interface IStartWaiter {
  readonly expected: number;
  readonly resolve: () => void;
}

class ControlledHarness implements ICodexHarness {
  readonly id = "codex-app-server";
  starts = 0;
  private startWaiters: IStartWaiter[] = [];

  constructor(private readonly gates: IDeferred<void>[]) {}

  waitForStartCount(expected: number): Promise<void> {
    if (this.starts >= expected) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.startWaiters.push({ expected, resolve });
    });
  }

  async run(input: ICodexHarnessInput): Promise<ICodexHarnessResult> {
    this.starts += 1;
    const startNumber = this.starts;
    this.resolveReadyStartWaiters();
    const gate = this.gates.shift();
    if (gate) {
      await gate.promise;
    }
    return {
      sessionKey: `controlled:${startNumber}`,
      memoryState: input.memory.state,
      events: [{ kind: "final", text: `controlled ${startNumber}` }],
      finalText: `controlled ${startNumber}`
    };
  }

  private resolveReadyStartWaiters(): void {
    const ready: IStartWaiter[] = [];
    const pending: IStartWaiter[] = [];

    for (const waiter of this.startWaiters) {
      if (this.starts >= waiter.expected) {
        ready.push(waiter);
      } else {
        pending.push(waiter);
      }
    }

    this.startWaiters = pending;
    for (const waiter of ready) {
      waiter.resolve();
    }
  }
}

class FixedFinalHarness implements ICodexHarness {
  readonly id = "codex-app-server";
  input: ICodexHarnessInput | undefined;

  constructor(private readonly finalText: string) {}

  async run(input: ICodexHarnessInput): Promise<ICodexHarnessResult> {
    this.input = input;

    return {
      sessionKey: "fixed-final",
      memoryState: input.memory.state,
      events: [{ kind: "final", text: this.finalText }],
      finalText: this.finalText
    };
  }
}

class ThrowingHarness implements ICodexHarness {
  readonly id = "codex-app-server";

  async run(): Promise<ICodexHarnessResult> {
    throw new Error("Harness should not run for cron control commands");
  }
}

function createVoiceAttachment() {
  return {
    id: "voice-1",
    name: "voice-message.ogg",
    url: "https://cdn.discordapp.com/attachments/voice-message.ogg",
    contentType: "audio/ogg",
    sizeBytes: 22445,
    durationSeconds: 6,
    kind: "audio",
    voiceMessage: true
  } as const;
}

function createDiscordEnvelope(
  overrides: Partial<INeonDiscordMessageEnvelope> = {}
): INeonDiscordMessageEnvelope {
  return {
    accountId: "default",
    guildId: allowedGuildId,
    channelId: allowedChannelId,
    threadId: "900000000000000011",
    messageId: "900000000000000012",
    author: {
      id: "operator",
      username: "operator",
      displayName: "Operator"
    },
    content: `<@${botUserId}> bau shadow bitte`,
    createdAt: "2026-05-31T17:50:00.000Z",
    mentionedUserIds: [botUserId],
    ...overrides
  };
}

function createSlashInteractionEnvelope(
  overrides: Partial<INeonDiscordSlashInteractionEnvelope> = {}
): INeonDiscordSlashInteractionEnvelope {
  return {
    accountId: "default",
    guildId: allowedGuildId,
    channelId: allowedChannelId,
    threadId: "900000000000000011",
    interactionId: "900000000000000013",
    commandName: "skill",
    author: {
      id: "operator",
      username: "operator",
      displayName: "Operator"
    },
    createdAt: "2026-05-31T17:55:00.000Z",
    ...overrides
  };
}

function createDirectMessageEnvelope(): INeonDiscordMessageEnvelope {
  const { guildId: _guildId, threadId: _threadId, ...envelope } = createDiscordEnvelope({
    content: "dm shadow bitte",
    mentionedUserIds: []
  });

  return envelope;
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-discord-ingress-"));
}
