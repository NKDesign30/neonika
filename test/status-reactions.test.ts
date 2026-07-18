import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { INeonDeliveryQueueTarget } from "../src/gateway/deliveryQueue.js";
import {
  createNeonDryRunReactionSender,
  type INeonReactionSender
} from "../src/gateway/reactionSender.js";
import {
  applyNeonStatusReaction,
  isNeonTerminalStatusReaction,
  NEON_STATUS_REACTION_DEBOUNCE_MS,
  neonStatusReactionEmojis,
  planNeonStatusReactionEmit,
  resolveNeonStatusReactionEmoji,
  resolveNeonToolReactionState,
  shouldEmitNeonStatusReaction,
  type INeonStatusReactionPlan
} from "../src/channels/statusReactions.js";

const target: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "chan-1"
};

describe("Neon status reaction policy", () => {
  it("resolves default emojis per state and honours overrides", () => {
    assert.equal(resolveNeonStatusReactionEmoji("queued"), neonStatusReactionEmojis.queued);
    assert.equal(resolveNeonStatusReactionEmoji("done"), "✅");
    assert.equal(resolveNeonStatusReactionEmoji("tool", { tool: "🔧" }), "🔧");
    // Blank override falls back to the default.
    assert.equal(resolveNeonStatusReactionEmoji("tool", { tool: "  " }), neonStatusReactionEmojis.tool);
  });

  it("classifies tool names into reaction states", () => {
    assert.equal(resolveNeonToolReactionState("deploy-prod"), "deploy");
    assert.equal(resolveNeonToolReactionState("npm-build"), "build");
    assert.equal(resolveNeonToolReactionState("web_fetch"), "web");
    assert.equal(resolveNeonToolReactionState("bash"), "coding");
    assert.equal(resolveNeonToolReactionState("some-unknown-tool"), "tool");
    assert.equal(resolveNeonToolReactionState(undefined), "tool");
  });

  it("gates emission behind channel capability AND enablement", () => {
    assert.equal(
      shouldEmitNeonStatusReaction({ channelSupportsReactions: true, statusReactionsEnabled: true }),
      true
    );
    assert.equal(
      shouldEmitNeonStatusReaction({ channelSupportsReactions: false, statusReactionsEnabled: true }),
      false
    );
    assert.equal(
      shouldEmitNeonStatusReaction({ channelSupportsReactions: true, statusReactionsEnabled: false }),
      false
    );
  });

  it("marks done/error as terminal and others as non-terminal", () => {
    assert.equal(isNeonTerminalStatusReaction("done"), true);
    assert.equal(isNeonTerminalStatusReaction("error"), true);
    assert.equal(isNeonTerminalStatusReaction("thinking"), false);
    assert.equal(isNeonTerminalStatusReaction("tool"), false);
  });

  it("emits a terminal state immediately, even inside the debounce window", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "done",
      currentEmoji: "🧠",
      finished: false,
      lastIntermediateEmitAt: 10_000,
      now: 10_050,
      debounceMs: 700
    });

    assert.equal(plan.action, "emit");
    assert.equal(plan.emoji, "✅");
  });

  it("skips any transition once finished", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "thinking",
      currentEmoji: "✅",
      finished: true,
      lastIntermediateEmitAt: null,
      now: 50_000
    });

    assert.equal(plan.action, "skip-finished");
  });

  it("reports unchanged when the resolved emoji already shows", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "thinking",
      currentEmoji: neonStatusReactionEmojis.thinking,
      finished: false,
      lastIntermediateEmitAt: null,
      now: 1_000
    });

    assert.equal(plan.action, "unchanged");
  });

  it("holds an intermediate transition inside the debounce window and reports remaining time", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "tool",
      currentEmoji: "🧠",
      finished: false,
      lastIntermediateEmitAt: 10_000,
      now: 10_300,
      debounceMs: 700
    });

    assert.equal(plan.action, "hold");
    assert.equal(plan.holdRemainingMs, 400);
  });

  it("emits an intermediate transition once the debounce window passed", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "tool",
      currentEmoji: "🧠",
      finished: false,
      lastIntermediateEmitAt: 10_000,
      now: 10_800,
      debounceMs: 700
    });

    assert.equal(plan.action, "emit");
    assert.equal(plan.emoji, "🛠️");
  });

  it("emits the first intermediate transition with no prior emit timestamp", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "thinking",
      currentEmoji: "",
      finished: false,
      lastIntermediateEmitAt: null,
      now: 0
    });

    assert.equal(plan.action, "emit");
    assert.equal(plan.emoji, "🧠");
  });

  it("uses the default debounce constant when none is provided", () => {
    const plan = planNeonStatusReactionEmit({
      nextState: "tool",
      currentEmoji: "🧠",
      finished: false,
      lastIntermediateEmitAt: 0,
      now: NEON_STATUS_REACTION_DEBOUNCE_MS - 1
    });

    assert.equal(plan.action, "hold");
  });

  it("routes an emit plan through the dry-run sender as no-send", async () => {
    const sender = createNeonDryRunReactionSender({ now: () => new Date("2026-06-03T01:00:00.000Z") });
    const plan: INeonStatusReactionPlan = { action: "emit", state: "done", emoji: "✅" };

    const result = await applyNeonStatusReaction({ sender, target, messageId: "msg-1", plan });

    assert.notEqual(result, null);
    assert.equal(result?.reactionSent, false);
  });

  it("never calls the sender for non-emit plans", async () => {
    let calls = 0;
    const sender: INeonReactionSender = {
      setReaction(reactionTarget, messageId, emoji) {
        calls += 1;
        return Promise.resolve({
          reactionSent: false,
          target: reactionTarget,
          messageId,
          emoji,
          reason: "dry-run-no-send",
          cutoverStage: "shadow",
          attemptedAt: "2026-06-03T01:00:00.000Z"
        });
      }
    };

    for (const action of ["hold", "unchanged", "skip-finished"] as const) {
      const plan: INeonStatusReactionPlan = { action, state: "thinking", emoji: "🧠" };
      const result = await applyNeonStatusReaction({ sender, target, messageId: "msg-1", plan });
      assert.equal(result, null);
    }

    assert.equal(calls, 0);
  });
});
