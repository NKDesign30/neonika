import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import {
  createNeonDiscordVoiceReplyAttachment,
  deliverNeonCanaryReplyForRun,
  NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES,
  type INeonGatewayShadowRun,
  type INeonOutboundSender,
  type TNeonDiscordMediaAttachment
} from "../src/index.js";

describe("Neonika Canary reply loop", () => {
  it("delivers a completed Discord run through the injected sender", async () => {
    const calls: string[] = [];
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        calls.push(message);
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message.slice(0, 20),
          cutoverStage: "canary",
          messageId: "reply-message-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRun(),
      sender
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.outboundSent, true);
    assert.equal(result.messageId, "reply-message-1");
    assert.equal(result.cutoverStage, "canary");
    assert.equal(result.target?.channelId, "channel-1");
    assert.equal(result.target?.replyToMessageId, "message-1");
    assert.deepEqual(calls, ["Neon reply body"]);
  });

  it("can deliver as a normal channel message without Discord reply metadata", async () => {
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message,
          cutoverStage: "canary",
          messageId: "channel-message-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRun(),
      replyMode: "channel",
      sender
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.target?.channelId, "channel-1");
    assert.equal(result.target?.replyToMessageId, undefined);
  });

  it("preserves Canary stage evidence across a marker-only poll receipt replay", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-canary-poll-stage-"));
    let sendCalls = 0;
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("marker-only poll must not send text");
      },
      sendPoll(target, poll) {
        sendCalls += 1;
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: poll.question,
          cutoverStage: "canary",
          messageId: "poll-message-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };
    const marker = '<NEON_POLL question="Ship it?">Yes|No</NEON_POLL>';

    try {
      const first = await deliverNeonCanaryReplyForRun({
        run: createRun({ finalText: marker }),
        projectRoot,
        sender
      });
      const replay = await deliverNeonCanaryReplyForRun({
        run: createRun({ finalText: marker }),
        projectRoot,
        sender
      });

      assert.equal(first.state, "delivered");
      assert.equal(first.cutoverStage, "canary");
      assert.equal(replay.state, "delivered");
      assert.equal(replay.cutoverStage, "canary");
      assert.equal(sendCalls, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("formats long Discord summary replies before sending", async () => {
    const calls: string[] = [];
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        calls.push(message);
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message.slice(0, 80),
          cutoverStage: "canary",
          messageId: "formatted-message-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const finalText =
      "1. Upstream macht Discord lesbar.\n2. Nummern bleiben stabil.\n\nKurzfassung: Neonika soll genauso antworten.";

    const result = await deliverNeonCanaryReplyForRun({
      run: createRun({
        finalText
      }),
      sender
    });

    assert.equal(result.state, "delivered");
    assert.equal(calls.length, 1);
    assert.equal(calls[0], finalText);
    assert.doesNotMatch(calls[0] ?? "", /\*\*Kurzfassung:\*\*/u);
  });

  it("turns local media paths in finalText into Discord attachments without leaking paths", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-local-media-"));
    const capturesDir = join(projectRoot, "state", "gateway", "peekaboo-captures");
    await mkdir(capturesDir, { recursive: true });
    const screenshotPath = join(capturesDir, "screen.png");
    await writeFile(screenshotPath, new Uint8Array([137, 80, 78, 71]));

    try {
      const mediaCalls: Array<{
        readonly message: string | undefined;
        readonly attachments: readonly TNeonDiscordMediaAttachment[];
      }> = [];
      const sender: INeonOutboundSender = {
        sendText() {
          throw new Error("sendText should not be used for local media");
        },
        sendMedia(target, message, attachments) {
          mediaCalls.push({ message, attachments });
          return Promise.resolve({
            outboundSent: true,
            target,
            bodyPreview: message ?? "",
            cutoverStage: "canary",
            messageId: "media-message-1",
            sentAt: "2026-06-04T11:00:00.000Z"
          });
        }
      };

      const result = await deliverNeonCanaryReplyForRun({
        run: createRun({
          finalText: `Fertig:\n1. Screenshot gemacht: \`${screenshotPath}\`\n2. Zahlen bleiben Zahlen.`
        }),
        projectRoot,
        sender
      });

      assert.equal(result.state, "delivered");
      assert.equal(result.messageId, "media-message-1");
      assert.equal(mediaCalls.length, 1);
      assert.equal(mediaCalls[0]?.message, "Fertig:\n1. Screenshot gemacht: screen.png\n2. Zahlen bleiben Zahlen.");
      assert.equal(mediaCalls[0]?.attachments.length, 1);
      assert.equal(mediaCalls[0]?.attachments[0]?.name, "screen.png");
      assert.doesNotMatch(mediaCalls[0]?.message ?? "", /\/Users|state\/gateway|peekaboo-captures/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("sends a synthesized voice attachment when voice replies are explicitly requested", async () => {
    const mediaCalls: Array<{
      readonly message: string | undefined;
      readonly attachments: readonly TNeonDiscordMediaAttachment[];
    }> = [];
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("sendText should not be used for voice replies");
      },
      sendMedia(target, message, attachments) {
        mediaCalls.push({ message, attachments });
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message ?? "",
          cutoverStage: "canary",
          messageId: "voice-message-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRequestedVoiceReplyRun(),
      sender,
      voiceReply: {
        mode: "explicit",
        apiKey: "test-eleven-key",
        synthesize: async (input) => {
          assert.equal(input.text, "Neon reply body");
          assert.equal(input.apiKey, "test-eleven-key");
          return {
            name: "chaty-reply.mp3",
            data: new Uint8Array([1, 2, 3]),
            contentType: "audio/mpeg"
          };
        }
      }
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.messageId, "voice-message-1");
    assert.equal(mediaCalls.length, 1);
    assert.equal(mediaCalls[0]?.message, "Neon reply body");
    assert.equal(mediaCalls[0]?.attachments.length, 1);
    assert.equal(mediaCalls[0]?.attachments[0]?.name, "chaty-reply.mp3");
  });

  it("drops provider TTS audio when the declared body exceeds the Discord media cap", async () => {
    let requestedProvider = false;
    const attachment = await createNeonDiscordVoiceReplyAttachment("Neon reply body", {
      mode: "always",
      apiKey: "test-eleven-key",
      fetchImpl: async (): Promise<Response> => {
        requestedProvider = true;
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            "content-length": String(NEON_DISCORD_VOICE_REPLY_MAX_AUDIO_BYTES + 1),
            "content-type": "audio/mpeg"
          }
        });
      }
    });

    assert.equal(requestedProvider, true);
    assert.equal(attachment, undefined);
  });

  it("falls back to OpenAI gpt-4o-mini-tts when ElevenLabs cannot synthesize", async () => {
    const mediaCalls: Array<{
      readonly message: string | undefined;
      readonly attachments: readonly TNeonDiscordMediaAttachment[];
    }> = [];
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("sendText should not be used for OpenAI fallback voice replies");
      },
      sendMedia(target, message, attachments) {
        mediaCalls.push({ message, attachments });
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message ?? "",
          cutoverStage: "canary",
          messageId: "voice-message-openai",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRequestedVoiceReplyRun(),
      sender,
      voiceReply: {
        mode: "explicit",
        apiKey: "test-eleven-key",
        openAiApiKey: "test-openai-key",
        synthesize: async () => undefined,
        synthesizeOpenAi: async (input) => {
          assert.equal(input.text, "Neon reply body");
          assert.equal(input.apiKey, "test-openai-key");
          assert.equal(input.modelId, "gpt-4o-mini-tts");
          assert.equal(input.voice, "marin");
          assert.equal(input.outputFormat, "mp3");
          return {
            name: "chaty-reply-openai.mp3",
            data: new Uint8Array([4, 5, 6]),
            contentType: "audio/mpeg"
          };
        }
      }
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.messageId, "voice-message-openai");
    assert.equal(mediaCalls.length, 1);
    assert.equal(mediaCalls[0]?.message, "Neon reply body");
    assert.equal(mediaCalls[0]?.attachments.length, 1);
    assert.equal(mediaCalls[0]?.attachments[0]?.name, "chaty-reply-openai.mp3");
  });

  it("falls back to local macOS TTS when paid TTS providers cannot synthesize", async () => {
    const mediaCalls: Array<{
      readonly message: string | undefined;
      readonly attachments: readonly TNeonDiscordMediaAttachment[];
    }> = [];
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("sendText should not be used for local voice fallback replies");
      },
      sendMedia(target, message, attachments) {
        mediaCalls.push({ message, attachments });
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message ?? "",
          cutoverStage: "canary",
          messageId: "voice-message-local",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRequestedVoiceReplyRun(),
      sender,
      voiceReply: {
        mode: "explicit",
        apiKey: "test-eleven-key",
        openAiApiKey: "test-openai-key",
        macOsTtsEnabled: true,
        synthesize: async () => undefined,
        synthesizeOpenAi: async () => undefined,
        synthesizeMacOs: async (input) => {
          assert.equal(input.text, "Neon reply body");
          assert.equal(input.voice, "Anna");
          return {
            name: "chaty-reply-local.m4a",
            data: new Uint8Array([7, 8, 9]),
            contentType: "audio/mp4"
          };
        }
      }
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.messageId, "voice-message-local");
    assert.equal(mediaCalls.length, 1);
    assert.equal(mediaCalls[0]?.message, "Neon reply body");
    assert.equal(mediaCalls[0]?.attachments.length, 1);
    assert.equal(mediaCalls[0]?.attachments[0]?.name, "chaty-reply-local.m4a");
  });

  it("normalizes numeric TTS pronunciation without changing the visible Discord text", async () => {
    const mediaCalls: Array<{
      readonly message: string | undefined;
      readonly attachments: readonly TNeonDiscordMediaAttachment[];
    }> = [];
    const visibleText = "Aktuell sind 22°C, morgen -5°C, 40% Akku, 3,2s Latenz und um 14:30 Uhr geht es weiter.";
    const spokenText = "Aktuell sind zweiundzwanzig Grad Celsius, morgen minus fünf Grad Celsius, vierzig Prozent Akku, drei Komma zwei Sekunden Latenz und um vierzehn Uhr dreißig geht es weiter.";
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("sendText should not be used for voice replies");
      },
      sendMedia(target, message, attachments) {
        mediaCalls.push({ message, attachments });
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message ?? "",
          cutoverStage: "canary",
          messageId: "voice-message-2",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRequestedVoiceReplyRun({ finalText: visibleText }),
      sender,
      voiceReply: {
        mode: "explicit",
        apiKey: "test-eleven-key",
        synthesize: async (input) => {
          assert.equal(input.text, spokenText);
          return {
            name: "chaty-reply.mp3",
            data: new Uint8Array([1, 2, 3]),
            contentType: "audio/mpeg"
          };
        }
      }
    });

    assert.equal(result.state, "delivered");
    assert.equal(mediaCalls[0]?.message, visibleText);
  });

  it("keeps text inbound replies text-only even when voice replies are configured", async () => {
    const calls: string[] = [];
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        calls.push(message);
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message,
          cutoverStage: "canary",
          messageId: "text-message-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      },
      sendMedia() {
        throw new Error("sendMedia should not be used for text inbound replies");
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRun(),
      sender,
      voiceReply: {
        mode: "explicit",
        apiKey: "test-eleven-key",
        openAiApiKey: "test-openai-key",
        macOsTtsEnabled: true,
        synthesize: async () => {
          throw new Error("synthesize should not run for text inbound replies");
        },
        synthesizeOpenAi: async () => {
          throw new Error("OpenAI synthesize should not run for text inbound replies");
        },
        synthesizeMacOs: async () => {
          throw new Error("macOS synthesize should not run for text inbound replies");
        }
      }
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.messageId, "text-message-1");
    assert.deepEqual(calls, ["Neon reply body"]);
  });

  it("keeps voice inbound replies text-only unless a voice reply was requested", async () => {
    const calls: string[] = [];
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        calls.push(message);
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message,
          cutoverStage: "canary",
          messageId: "voice-in-text-out-1",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      },
      sendMedia() {
        throw new Error("sendMedia should not be used for voice inbound replies without explicit request");
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createVoiceRun(),
      sender,
      voiceReply: {
        mode: "explicit",
        apiKey: "test-eleven-key",
        synthesize: async () => {
          throw new Error("synthesize should not run without explicit voice reply request");
        }
      }
    });

    assert.equal(result.state, "delivered");
    assert.equal(result.messageId, "voice-in-text-out-1");
    assert.deepEqual(calls, ["Neon reply body"]);
  });

  it("stays suppressed when the sender gate stays closed", async () => {
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        return Promise.resolve({
          outboundSent: false,
          target,
          bodyPreview: message,
          reason: "canary-gate-closed",
          cutoverStage: "shadow",
          attemptedAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRun(),
      sender
    });

    assert.equal(result.state, "suppressed");
    assert.equal(result.outboundSent, false);
    assert.equal(result.reason, "canary-gate-closed");
  });

  it("skips unsupported, non-terminal, and empty replies before any send", async () => {
    let calls = 0;
    const sender: INeonOutboundSender = {
      sendText(target, message) {
        calls += 1;
        return Promise.resolve({
          outboundSent: true,
          target,
          bodyPreview: message,
          cutoverStage: "canary",
          messageId: "unexpected",
          sentAt: "2026-06-04T11:00:00.000Z"
        });
      }
    };

    const unsupported = await deliverNeonCanaryReplyForRun({
      run: createRun({ request: { ...createRun().request, channel: "webchat" } }),
      sender
    });
    const running = await deliverNeonCanaryReplyForRun({
      run: createRun({ status: "running" }),
      sender
    });
    const empty = await deliverNeonCanaryReplyForRun({
      run: createRun({ finalText: "   " }),
      sender
    });

    assert.equal(unsupported.state, "skipped");
    assert.equal(unsupported.reason, "unsupported-channel");
    assert.equal(running.state, "skipped");
    assert.equal(running.reason, "run-not-completed");
    assert.equal(empty.state, "skipped");
    assert.equal(empty.reason, "empty-final-text");
    assert.equal(calls, 0);
  });

  it("collapses transport exceptions to a leak-safe transport-error", async () => {
    const sender: INeonOutboundSender = {
      sendText() {
        throw new Error("raw discord details with token-shaped sk-secret-1234567890");
      }
    };

    const result = await deliverNeonCanaryReplyForRun({
      run: createRun(),
      sender
    });

    assert.equal(result.state, "transport-error");
    assert.equal(result.reason, "transport-error");
    assert.equal(result.outboundSent, false);
  });
});

function createRun(overrides: Partial<INeonGatewayShadowRun> = {}): INeonGatewayShadowRun {
  const base = {
    runId: "run-1",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/tmp/neonika",
      mode: "read-only",
      contentPreview: "ping",
      receivedAt: "2026-06-04T10:59:59.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "discord:channel-1",
    memoryState: "attached",
    events: [],
    finalText: "Neon reply body",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "Neon reply body"
    },
    startedAt: "2026-06-04T11:00:00.000Z",
    completedAt: "2026-06-04T11:00:01.000Z"
  } satisfies INeonGatewayShadowRun;

  return { ...base, ...overrides };
}

function createVoiceRun(overrides: Partial<INeonGatewayShadowRun> = {}): INeonGatewayShadowRun {
  const base = createRun(overrides);
  return {
    ...base,
    request: {
      ...base.request,
      sourceHadVoiceAttachment: true
    }
  };
}

function createRequestedVoiceReplyRun(overrides: Partial<INeonGatewayShadowRun> = {}): INeonGatewayShadowRun {
  const base = createVoiceRun(overrides);
  return {
    ...base,
    request: {
      ...base.request,
      requestedVoiceReply: true
    }
  };
}
