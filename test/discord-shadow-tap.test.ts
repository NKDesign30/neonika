import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDryRunHarness,
  mapDiscordJsMessageToEnvelope,
  readNeonDiscordRouteProbe,
  readNeonGatewayStatus,
  startNeonDiscordShadowTap,
  type ICodexHarness,
  type IDiscordJsMessageLike,
  type INeonDiscordIngressPolicy,
  type INeonDiscordMessageEnvelope,
  type INeonInboundDebounceScheduler,
  type INeonInboundDebounceTimer,
  type INeonDiscordProbeHeartbeatScheduler,
  type INeonDiscordTapAdapter,
  type INeonOutboundSender,
  type TNeonDiscordShadowTapEvent
} from "../src/index.js";

const botUserId = "900000000000000010";
const allowedGuildId = "900000000000000001";
const allowedChannelId = "900000000000000005";

describe("Neonika Discord shadow tap", () => {
  it("starts a tap, accepts Discord messages, and persists shadow runs", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const events: TNeonDiscordShadowTapEvent[] = [];
    let resolverCalls = 0;

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        resolveMemory: (message) => {
          resolverCalls += 1;
          assert.equal(message.content, "tap smoke");

          return {
            state: "attached",
            hitCount: 1,
            note: "Shadow tap memory"
          };
        },
        harness: createDryRunHarness(),
        now: () => new Date("2026-05-31T19:00:00.000Z"),
        onEvent: (event) => {
          events.push(event);
        }
      });

      await adapter.emit(createEnvelope());

      assert.equal(adapter.loginToken, "test-token");
      assert.equal(handle.stats.accepted, 1);
      assert.equal(handle.stats.dropped, 0);
      assert.equal(handle.stats.running, true);
      assert.equal(handle.stats.startedAt, "2026-05-31T19:00:00.000Z");
      assert.equal(handle.stats.lastProbeAt, "2026-05-31T19:00:00.000Z");
      assert.equal(resolverCalls, 1);
      assert.equal(events[0]?.kind, "accepted");

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 1);
      assert.equal(status.latestRun?.channel, "discord");
      assert.equal(status.latestRun?.agentId, "chaty");
      assert.equal(status.latestRun?.memoryState, "attached");

      const runningProbe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(runningProbe.state, "running");
      assert.equal(runningProbe.running, true);
      assert.equal(runningProbe.stats.accepted, 1);
      assert.equal(runningProbe.stats.lastRunId, status.latestRun?.runId);

      await handle.close();
      assert.equal(adapter.closed, true);

      const stoppedProbe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(stoppedProbe.state, "stopped");
      assert.equal(stoppedProbe.running, false);
      assert.equal(stoppedProbe.stats.accepted, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("coalesces rapid text-only messages from the same Discord sender", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const scheduler = new ManualInboundDebounceScheduler();
    const acceptedContents: string[] = [];
    const acceptedMessageIds: string[] = [];
    let closeTap: (() => Promise<void>) | undefined;

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        resolveMemory: (message) => {
          acceptedContents.push(message.content);
          if (message.messageId) {
            acceptedMessageIds.push(message.messageId);
          }

          return {
            state: "skipped",
            hitCount: 0,
            note: "Debounced text"
          };
        },
        harness: createDryRunHarness(),
        inboundDebounce: {
          debounceMs: 1500,
          scheduler
        }
      });
      closeTap = handle.close;

      await adapter.emit(
        createEnvelope({
          messageId: "message-one",
          content: `<@${botUserId}> Automatisch erstellen`
        })
      );
      await adapter.emit(
        createEnvelope({
          messageId: "message-two",
          content: "Nachfragen",
          mentionedUserIds: []
        })
      );

      assert.equal(handle.stats.accepted, 0);
      assert.equal(scheduler.delayMs, 1500);

      await scheduler.fire();

      assert.equal(handle.stats.accepted, 1);
      assert.deepEqual(acceptedMessageIds, ["message-two"]);
      assert.deepEqual(acceptedContents, ["Automatisch erstellen\nNachfragen"]);

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 1);

      await handle.close();
      closeTap = undefined;
    } finally {
      await closeTap?.();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("flushes pending text before processing a media message immediately", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const scheduler = new ManualInboundDebounceScheduler();
    const accepted: Array<{ readonly content: string; readonly attachments: number }> = [];
    let closeTap: (() => Promise<void>) | undefined;

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        resolveMemory: (message) => {
          accepted.push({
            content: message.content,
            attachments: message.attachments?.length ?? 0
          });

          return {
            state: "skipped",
            hitCount: 0,
            note: "Media flush"
          };
        },
        harness: createDryRunHarness(),
        inboundDebounce: {
          debounceMs: 1500,
          scheduler
        }
      });
      closeTap = handle.close;

      await adapter.emit(
        createEnvelope({
          messageId: "message-before-media",
          content: `<@${botUserId}> schau mal`
        })
      );
      await adapter.emit(
        createEnvelope({
          messageId: "message-media",
          content: "und das dazu",
          attachments: [
            {
              id: "file-1",
              kind: "file",
              name: "angebot.pdf",
              url: "https://cdn.discordapp.com/attachments/angebot.pdf",
              contentType: "application/pdf"
            }
          ]
        })
      );

      assert.equal(handle.stats.accepted, 2);
      assert.deepEqual(accepted, [
        { content: "schau mal", attachments: 0 },
        { content: "und das dazu", attachments: 1 }
      ]);

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 2);

      await handle.close();
      closeTap = undefined;
    } finally {
      await closeTap?.();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps media-first messages immediate and debounces following text separately", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const scheduler = new ManualInboundDebounceScheduler();
    const accepted: Array<{ readonly messageId: string | undefined; readonly content: string; readonly attachments: number }> = [];
    let closeTap: (() => Promise<void>) | undefined;

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot,
          mentionPolicy: "never"
        }),
        resolveMemory: (message) => {
          accepted.push({
            messageId: message.messageId,
            content: message.content,
            attachments: message.attachments?.length ?? 0
          });

          return {
            state: "skipped",
            hitCount: 0,
            note: "Media first"
          };
        },
        harness: createDryRunHarness(),
        inboundDebounce: {
          debounceMs: 1500,
          scheduler
        }
      });
      closeTap = handle.close;

      await adapter.emit(
        createEnvelope({
          messageId: "message-media-first",
          content: "",
          mentionedUserIds: [],
          attachments: [
            {
              id: "image-1",
              kind: "image",
              name: "screen.png",
              url: "https://cdn.discordapp.com/attachments/screen.png",
              contentType: "image/png"
            }
          ]
        })
      );

      assert.equal(handle.stats.accepted, 1);

      await adapter.emit(
        createEnvelope({
          messageId: "message-media-followup",
          content: "mach daraus bitte einen Entwurf",
          mentionedUserIds: []
        })
      );

      assert.equal(handle.stats.accepted, 1);

      await scheduler.fire();

      assert.equal(handle.stats.accepted, 2);
      assert.deepEqual(accepted, [
        { messageId: "message-media-first", content: "", attachments: 1 },
        { messageId: "message-media-followup", content: "mach daraus bitte einen Entwurf", attachments: 0 }
      ]);

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 2);

      await handle.close();
      closeTap = undefined;
    } finally {
      await closeTap?.();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("flushes pending debounced text when the Discord tap closes", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const scheduler = new ManualInboundDebounceScheduler();
    let acceptedMessageId: string | undefined;
    let closeTap: (() => Promise<void>) | undefined;

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        resolveMemory: (message) => {
          acceptedMessageId = message.messageId;

          return {
            state: "skipped",
            hitCount: 0,
            note: "Close flush"
          };
        },
        harness: createDryRunHarness(),
        inboundDebounce: {
          debounceMs: 1500,
          scheduler
        }
      });
      closeTap = handle.close;

      await adapter.emit(createEnvelope({ messageId: "message-pending" }));

      assert.equal(handle.stats.accepted, 0);

      await handle.close();

      assert.equal(handle.stats.accepted, 1);
      assert.equal(adapter.closed, true);

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 1);
      assert.equal(acceptedMessageId, "message-pending");
      closeTap = undefined;
    } finally {
      await closeTap?.();
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records drops without writing shadow runs", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Drop test"
        },
        harness: createDryRunHarness()
      });

      await adapter.emit(
        createEnvelope({
          content: "no mention",
          mentionedUserIds: []
        })
      );

      assert.equal(handle.stats.accepted, 0);
      assert.equal(handle.stats.dropped, 1);
      assert.equal(handle.stats.lastDropReason, "mention-required");

      const probe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(probe.state, "running");
      assert.equal(probe.stats.dropped, 1);
      assert.equal(probe.stats.lastDropReason, "mention-required");

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 0);

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("drops messages aimed at ignored mentioned users in open channel-listening mode", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const lawBotUserId = "900000000000000015";

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot,
          mentionPolicy: "never",
          ignoredMentionedUserIds: [lawBotUserId]
        }),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Ignored mention drop test"
        },
        harness: createDryRunHarness()
      });

      await adapter.emit(
        createEnvelope({
          content: `<@${lawBotUserId}> was kannst du alles?`,
          mentionedUserIds: [lawBotUserId]
        })
      );

      assert.equal(handle.stats.accepted, 0);
      assert.equal(handle.stats.dropped, 1);
      assert.equal(handle.stats.lastDropReason, "ignored-mentioned-user");

      const probe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(probe.state, "running");
      assert.equal(probe.stats.dropped, 1);
      assert.equal(probe.stats.lastDropReason, "ignored-mentioned-user");

      const status = await readNeonGatewayStatus(projectRoot);

      assert.equal(status.runCount, 0);

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("optionally delivers accepted runs through the gated canary reply sender", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const events: TNeonDiscordShadowTapEvent[] = [];
    const senderCalls: string[] = [];
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        senderCalls.push(`${target.channelId}:${message}`);
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message.slice(0, 24),
          cutoverStage: "canary",
          messageId: "reply-message-1",
          sentAt: "2026-05-31T19:00:02.000Z"
        });
      }
    };

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Reply loop test"
        },
        harness: createDryRunHarness(),
        canaryReplySender: sender,
        now: () => new Date("2026-05-31T19:00:00.000Z"),
        onEvent: (event) => {
          events.push(event);
        }
      });

      await adapter.emit(createEnvelope());

      assert.equal(handle.stats.accepted, 1);
      assert.equal(handle.stats.repliesDelivered, 1);
      assert.equal(handle.stats.repliesSuppressed, 0);
      assert.equal(handle.stats.lastReplyState, "delivered");
      assert.equal(handle.stats.lastReplyMessageId, "reply-message-1");
      assert.equal(senderCalls.length, 1);
      assert.match(senderCalls[0] ?? "", /^900000000000000005:/);
      assert.ok(events.some((event) => event.kind === "reply" && event.outboundSent === true));

      const probe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(probe.stats.repliesDelivered, 1);
      assert.equal(probe.stats.lastReplyState, "delivered");
      assert.equal(probe.stats.lastReplyMessageId, "reply-message-1");

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("starts typing as soon as a Discord message is accepted", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const events: TNeonDiscordShadowTapEvent[] = [];
    const calls: string[] = [];

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        resolveMemory: () => {
          calls.push("memory");

          return {
            state: "skipped",
            hitCount: 0,
            note: "Typing test"
          };
        },
        harness: createDryRunHarness(),
        startTyping: (_message, envelope) => {
          calls.push(`typing:${envelope.messageId}`);
        },
        onEvent: (event) => {
          events.push(event);
        }
      });

      await adapter.emit(createEnvelope({ messageId: "message-with-typing" }));

      assert.deepEqual(calls, ["typing:message-with-typing", "memory"]);
      assert.equal(handle.stats.accepted, 1);
      assert.equal(handle.stats.typingStarted, 1);
      assert.equal(handle.stats.typingErrors, 0);
      assert.equal(handle.stats.lastTypingState, "started");
      assert.ok(events.some((event) => event.kind === "typing" && event.state === "started"));

      const probe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(probe.stats.typingStarted, 1);
      assert.equal(probe.stats.typingErrors, 0);
      assert.equal(probe.stats.lastTypingState, "started");

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("sets status reactions before memory and after completed runs", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const events: TNeonDiscordShadowTapEvent[] = [];
    const calls: string[] = [];

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        resolveMemory: () => {
          calls.push("memory");

          return {
            state: "skipped",
            hitCount: 0,
            note: "Reaction test"
          };
        },
        harness: createDryRunHarness(),
        addStatusReaction: async (message, envelope, state, emoji) => {
          calls.push(`${state}:${emoji}:${envelope.messageId}`);
          await adapter.addReaction?.(message, emoji);
        },
        onEvent: (event) => {
          events.push(event);
        }
      });

      await adapter.emit(createEnvelope({ messageId: "message-with-reactions" }));

      assert.deepEqual(calls, [
        "queued:👀:message-with-reactions",
        "memory",
        "done:✅:message-with-reactions"
      ]);
      assert.deepEqual(adapter.reactions, ["👀", "✅"]);
      assert.equal(handle.stats.accepted, 1);
      assert.equal(handle.stats.reactionsSent, 2);
      assert.equal(handle.stats.reactionErrors, 0);
      assert.equal(handle.stats.lastReactionState, "done");
      assert.equal(handle.stats.lastReactionOutcome, "sent");
      assert.ok(events.some((event) => event.kind === "reaction" && event.state === "queued"));
      assert.ok(events.some((event) => event.kind === "reaction" && event.state === "done"));

      const probe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(probe.stats.reactionsSent, 2);
      assert.equal(probe.stats.reactionErrors, 0);
      assert.equal(probe.stats.lastReactionState, "done");
      assert.equal(probe.stats.lastReactionOutcome, "sent");

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("sets an error status reaction when the harness throws after acceptance", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const calls: string[] = [];
    const failingHarness: ICodexHarness = {
      id: "codex-app-server",
      async run() {
        throw new Error("harness failed");
      }
    };

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Reaction failure test"
        },
        harness: failingHarness,
        addStatusReaction: async (message, envelope, state, emoji) => {
          calls.push(`${state}:${emoji}:${envelope.messageId}`);
          await adapter.addReaction?.(message, emoji);
        }
      });

      await adapter.emit(createEnvelope({ messageId: "message-with-error-reaction" }));

      assert.deepEqual(calls, [
        "queued:👀:message-with-error-reaction",
        "error:❌:message-with-error-reaction"
      ]);
      assert.deepEqual(adapter.reactions, ["👀", "❌"]);
      assert.equal(handle.stats.accepted, 0);
      assert.equal(handle.stats.errors, 1);
      assert.equal(handle.stats.reactionsSent, 2);
      assert.equal(handle.stats.reactionErrors, 0);
      assert.equal(handle.stats.lastReactionState, "error");
      assert.equal(handle.stats.lastReactionOutcome, "sent");

      const probe = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(probe.stats.errors, 1);
      assert.equal(probe.stats.reactionsSent, 2);
      assert.equal(probe.stats.lastReactionState, "error");

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("records adapter errors without throwing from the tap", async () => {
    // The tap persists a route probe under projectRoot. A literal path here made
    // the test write into whatever real checkout happened to sit at that
    // location; a temp root keeps it hermetic.
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy(),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Error test"
        },
        harness: createDryRunHarness()
      });

      adapter.emitError(new Error("gateway closed"));

      assert.equal(handle.stats.errors, 1);
      assert.equal(handle.stats.lastErrorMessage, "gateway closed");

      await handle.close();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("persists a route-probe heartbeat while the tap is running", async () => {
    const projectRoot = await createTempProjectRoot();
    const adapter = new MemoryDiscordTapAdapter();
    const heartbeat = new ManualProbeHeartbeatScheduler();
    let now = new Date("2026-05-31T20:00:00.000Z");

    try {
      const handle = await startNeonDiscordShadowTap({
        token: "test-token",
        projectRoot,
        adapter,
        mapMessage: (message) => message,
        policy: createPolicy({
          workspaceRoot: projectRoot
        }),
        memory: {
          state: "skipped",
          hitCount: 0,
          note: "Heartbeat test"
        },
        harness: createDryRunHarness(),
        now: () => now,
        probeHeartbeat: {
          intervalMs: 5,
          scheduler: heartbeat
        }
      });

      assert.equal(heartbeat.intervalMs, 5);

      const initial = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(initial.state, "running");
      assert.equal(initial.lastProbeAt, "2026-05-31T20:00:00.000Z");

      now = new Date("2026-05-31T20:00:05.000Z");
      await heartbeat.fire();

      const updated = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(updated.state, "running");
      assert.equal(updated.lastProbeAt, "2026-05-31T20:00:05.000Z");

      await handle.close();
      assert.equal(heartbeat.cancelled, true);

      now = new Date("2026-05-31T20:00:10.000Z");
      await heartbeat.fire();

      const stopped = await readNeonDiscordRouteProbe(projectRoot, "default");

      assert.equal(stopped.state, "stopped");
      assert.equal(stopped.lastProbeAt, "2026-05-31T20:00:05.000Z");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("maps discord.js message shape into the Neonika Discord envelope", () => {
    const envelope = mapDiscordJsMessageToEnvelope(
      {
        id: "message-1",
        content: `<@${botUserId}> thread smoke`,
        createdTimestamp: Date.parse("2026-05-31T19:10:00.000Z"),
        guildId: allowedGuildId,
        channelId: "thread-channel",
        channel: {
          id: "thread-channel",
          parentId: allowedChannelId,
          isThread: () => true
        },
        author: {
          id: "operator",
          username: "operator",
          bot: false
        },
        member: {
          displayName: "Operator"
        },
        mentions: {
          users: new Map([[botUserId, "bot"]])
        },
        attachments: new Map([
          [
            "voice-1",
            {
              id: "voice-1",
              name: "voice-message.ogg",
              url: "https://cdn.discordapp.com/attachments/voice-message.ogg",
              contentType: "audio/ogg",
              size: 22445,
              duration: 6,
              waveform: "AAAA"
            }
          ]
        ])
      } satisfies IDiscordJsMessageLike,
      "default"
    );

    assert.equal(envelope.accountId, "default");
    assert.equal(envelope.guildId, allowedGuildId);
    assert.equal(envelope.channelId, allowedChannelId);
    assert.equal(envelope.threadId, "thread-channel");
    assert.deepEqual(envelope.mentionedUserIds, [botUserId]);
    assert.equal(envelope.author.displayName, "Operator");
    assert.equal(envelope.attachments?.length, 1);
    assert.equal(envelope.attachments?.[0]?.kind, "audio");
    assert.equal(envelope.attachments?.[0]?.voiceMessage, true);
    assert.equal(envelope.attachments?.[0]?.durationSeconds, 6);
  });

  it("preserves mixed discord.js attachment insertion order", () => {
    const envelope = mapDiscordJsMessageToEnvelope(
      {
        id: "message-mixed-media",
        content: `<@${botUserId}> vergleich die Medien`,
        createdTimestamp: Date.parse("2026-05-31T19:20:00.000Z"),
        guildId: allowedGuildId,
        channelId: allowedChannelId,
        channel: {
          id: allowedChannelId,
          isThread: () => false
        },
        author: {
          id: "operator",
          username: "operator",
          bot: false
        },
        member: {
          displayName: "Operator"
        },
        mentions: {
          users: new Map([[botUserId, "bot"]])
        },
        attachments: new Map([
          [
            "image-1",
            {
              id: "image-1",
              name: "first.png",
              url: "https://cdn.discordapp.com/attachments/first.png",
              contentType: "image/png"
            }
          ],
          [
            "audio-1",
            {
              id: "audio-1",
              name: "second.ogg",
              url: "https://cdn.discordapp.com/attachments/second.ogg",
              contentType: "audio/ogg",
              waveform: "AAAA"
            }
          ],
          [
            "video-1",
            {
              id: "video-1",
              name: "third.mp4",
              url: "https://cdn.discordapp.com/attachments/third.mp4",
              contentType: "video/mp4"
            }
          ]
        ])
      } satisfies IDiscordJsMessageLike,
      "default"
    );

    assert.deepEqual(
      envelope.attachments?.map((attachment) => `${attachment.id}:${attachment.kind}`),
      ["image-1:image", "audio-1:audio", "video-1:video"]
    );
    assert.equal(envelope.attachments?.[1]?.voiceMessage, true);
  });
});

class MemoryDiscordTapAdapter implements INeonDiscordTapAdapter<INeonDiscordMessageEnvelope> {
  loginToken: string | undefined;
  closed = false;
  reactions: string[] = [];
  private onMessage:
    | ((message: INeonDiscordMessageEnvelope) => void | Promise<void>)
    | undefined;
  private onError: ((error: Error) => void) | undefined;

  listen(
    onMessage: (message: INeonDiscordMessageEnvelope) => void | Promise<void>,
    onError: (error: Error) => void
  ): void {
    this.onMessage = onMessage;
    this.onError = onError;
  }

  async login(token: string): Promise<void> {
    this.loginToken = token;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async addReaction(_message: INeonDiscordMessageEnvelope, emoji: string): Promise<void> {
    this.reactions.push(emoji);
  }

  async emit(message: INeonDiscordMessageEnvelope): Promise<void> {
    await this.onMessage?.(message);
  }

  emitError(error: Error): void {
    this.onError?.(error);
  }
}

class ManualInboundDebounceScheduler implements INeonInboundDebounceScheduler {
  delayMs = 0;
  cancelled = false;
  private callback: (() => void | Promise<void>) | undefined;

  schedule(callback: () => void | Promise<void>, delayMs: number): INeonInboundDebounceTimer {
    this.callback = callback;
    this.delayMs = delayMs;
    this.cancelled = false;

    return {
      cancel: () => {
        this.cancelled = true;
      }
    };
  }

  async fire(): Promise<void> {
    if (this.cancelled) {
      return;
    }

    const callback = this.callback;
    this.callback = undefined;
    this.cancelled = true;
    await callback?.();
  }
}

class ManualProbeHeartbeatScheduler implements INeonDiscordProbeHeartbeatScheduler {
  intervalMs = 0;
  cancelled = false;
  private callback: (() => void | Promise<void>) | undefined;

  schedule(callback: () => void | Promise<void>, intervalMs: number): unknown {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return "manual-heartbeat";
  }

  cancel(): void {
    this.cancelled = true;
  }

  async fire(): Promise<void> {
    if (!this.cancelled) {
      await this.callback?.();
    }
  }
}

function createPolicy(
  overrides: Partial<INeonDiscordIngressPolicy> = {}
): INeonDiscordIngressPolicy {
  return {
    agentId: "chaty",
    workspaceRoot: "/Users/operator/neon-projects/neonika",
    mode: "read-only",
    botUserId,
    mentionPolicy: "guild",
    allowedGuildIds: [allowedGuildId],
    allowedChannelIds: [allowedChannelId],
    ignoredUserIds: [],
    ...overrides
  };
}

function createEnvelope(
  overrides: Partial<INeonDiscordMessageEnvelope> = {}
): INeonDiscordMessageEnvelope {
  return {
    accountId: "default",
    guildId: allowedGuildId,
    channelId: allowedChannelId,
    messageId: "900000000000000012",
    author: {
      id: "operator",
      username: "operator",
      displayName: "Operator"
    },
    content: `<@${botUserId}> tap smoke`,
    createdAt: "2026-05-31T19:00:00.000Z",
    mentionedUserIds: [botUserId],
    ...overrides
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-discord-shadow-tap-"));
}
