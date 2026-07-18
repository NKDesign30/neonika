import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordComponentActionRegistry,
  resolveNeonDiscordComponentActionStatePath,
  type INeonDiscordComponentInteraction
} from "../src/gateway/discordComponentActionRegistry.js";

const baseNowMs = Date.parse("2026-07-09T20:00:00.000Z");

describe("Discord component action registry", () => {
  it("keeps action data server-side and dispatches a typed button once", async () => {
    let nowMs = baseNowMs;
    const handled: string[] = [];
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(nowMs),
      createActionId: () => "opaque-action-1"
    });
    const registered = registry.register({
      ownerUserId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-secret",
      actionType: "approve",
      interactionKind: "button",
      resourceRef: "draft-secret",
      expiresAt: new Date(nowMs + 60_000).toISOString(),
      handler: (context) => {
        handled.push(`${context.actionType}:${context.resourceRef}:${context.interaction.kind}`);
        return { message: "Freigabe übernommen." };
      }
    });

    assert.match(registered.customId, /^occomp:cid=action:opaque-action-1$/u);
    assert.ok(!registered.customId.includes("draft-secret"));
    assert.ok(!registered.customId.includes("session-secret"));

    const first = await registry.dispatch(
      createInteraction({ customId: registered.customId, kind: "button" })
    );
    const replay = await registry.dispatch(
      createInteraction({ customId: registered.customId, kind: "button", interactionId: "interaction-2" })
    );

    assert.equal(first.state, "completed");
    assert.equal(first.message, "Freigabe übernommen.");
    assert.equal(replay.state, "rejected");
    assert.equal(replay.reason, "already-consumed");
    assert.deepEqual(handled, ["approve:draft-secret:button"]);
  });

  it("rejects a foreign owner without consuming the action", async () => {
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(baseNowMs),
      createActionId: () => "owner-bound"
    });
    let calls = 0;
    const registered = registry.register({
      ownerUserId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-1",
      actionType: "approve",
      interactionKind: "button",
      expiresAt: new Date(baseNowMs + 60_000).toISOString(),
      handler: () => {
        calls += 1;
        return { message: "OK" };
      }
    });

    const denied = await registry.dispatch(
      createInteraction({ customId: registered.customId, userId: "stranger" })
    );
    const owner = await registry.dispatch(createInteraction({ customId: registered.customId }));

    assert.equal(denied.state, "rejected");
    assert.equal(denied.reason, "owner-mismatch");
    assert.equal(owner.state, "completed");
    assert.equal(calls, 1);
  });

  it("allows every user in the registered channel for channel-wide actions", async () => {
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(baseNowMs),
      createActionId: () => "channel-wide"
    });
    const actors: string[] = [];
    const registered = registry.register({
      ownerUserId: "operator",
      audience: "channel",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-1",
      actionType: "plan-approval:approve",
      interactionKind: "button",
      expiresAt: new Date(baseNowMs + 60_000).toISOString(),
      handler: (context) => {
        actors.push(context.interaction.userId);
        return { message: "OK" };
      }
    });

    const wrongChannel = await registry.dispatch(
      createInteraction({
        customId: registered.customId,
        userId: "operator-a",
        channelId: "channel-2"
      })
    );
    const sameChannel = await registry.dispatch(
      createInteraction({ customId: registered.customId, userId: "operator-b" })
    );

    assert.equal(wrongChannel.state, "rejected");
    assert.equal(wrongChannel.reason, "scope-mismatch");
    assert.equal(sameChannel.state, "completed");
    assert.deepEqual(actors, ["operator-b"]);
  });

  it("rejects expired, scope-mismatched, kind-mismatched, and forged actions", async () => {
    let nowMs = baseNowMs;
    let sequence = 0;
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(nowMs),
      createActionId: () => `guard-${sequence += 1}`
    });
    const register = (interactionKind: "button" | "string-select" | "modal-submit") =>
      registry.register({
        ownerUserId: "operator",
        guildId: "guild-1",
        channelId: "channel-1",
        sessionKey: "session-1",
        actionType: "guard",
        interactionKind,
        expiresAt: new Date(baseNowMs + 1_000).toISOString(),
        handler: () => ({ message: "should not run" })
      });

    const scope = register("button");
    const kind = register("string-select");
    const expired = register("button");

    const scopeResult = await registry.dispatch(
      createInteraction({ customId: scope.customId, channelId: "other-channel" })
    );
    const kindResult = await registry.dispatch(
      createInteraction({ customId: kind.customId, kind: "button" })
    );
    nowMs += 2_000;
    const expiredResult = await registry.dispatch(createInteraction({ customId: expired.customId }));
    const forgedResult = await registry.dispatch(
      createInteraction({ customId: "occomp:cid=action:not-registered" })
    );
    const foreignResult = await registry.dispatch(
      createInteraction({ customId: "occomp:cid=maildraft:send:draft-1" })
    );

    assert.equal(scopeResult.state, "rejected");
    assert.equal(scopeResult.reason, "scope-mismatch");
    assert.equal(kindResult.state, "rejected");
    assert.equal(kindResult.reason, "interaction-kind-mismatch");
    assert.equal(expiredResult.state, "rejected");
    assert.equal(expiredResult.reason, "expired");
    assert.equal(forgedResult.state, "rejected");
    assert.equal(forgedResult.reason, "unknown-action");
    assert.equal(foreignResult.state, "rejected");
    assert.equal(foreignResult.reason, "invalid-custom-id");
  });

  it("passes select values and modal fields through typed interaction data", async () => {
    let sequence = 0;
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(baseNowMs),
      createActionId: () => `typed-${sequence += 1}`
    });
    const observed: string[] = [];
    const select = registry.register({
      ownerUserId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-1",
      actionType: "select-model",
      interactionKind: "string-select",
      expiresAt: new Date(baseNowMs + 60_000).toISOString(),
      handler: (context) => {
        observed.push(context.interaction.values?.join(",") ?? "missing-values");
        return { message: "Auswahl übernommen." };
      }
    });
    const modal = registry.register({
      ownerUserId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-1",
      actionType: "edit-request",
      interactionKind: "modal-submit",
      expiresAt: new Date(baseNowMs + 60_000).toISOString(),
      handler: (context) => {
        observed.push(context.interaction.fields?.["request"] ?? "missing-field");
        return { message: "Änderung übernommen." };
      }
    });

    await registry.dispatch(
      createInteraction({
        customId: select.customId,
        kind: "string-select",
        values: ["gpt-5.6", "high"]
      })
    );
    await registry.dispatch(
      createInteraction({
        customId: modal.customId,
        kind: "modal-submit",
        fields: { request: "Titel kürzen" }
      })
    );

    assert.deepEqual(observed, ["gpt-5.6,high", "Titel kürzen"]);
  });

  it("consumes before awaiting the handler so concurrent clicks execute once", async () => {
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let calls = 0;
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(baseNowMs),
      createActionId: () => "concurrent"
    });
    const registered = registry.register({
      ownerUserId: "operator",
      guildId: "guild-1",
      channelId: "channel-1",
      sessionKey: "session-1",
      actionType: "approve",
      interactionKind: "button",
      expiresAt: new Date(baseNowMs + 60_000).toISOString(),
      handler: async () => {
        calls += 1;
        await handlerGate;
        return { message: "OK" };
      }
    });

    const firstPromise = registry.dispatch(createInteraction({ customId: registered.customId }));
    const secondPromise = registry.dispatch(
      createInteraction({ customId: registered.customId, interactionId: "interaction-2" })
    );
    releaseHandler?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(first.state, "completed");
    assert.equal(second.state, "rejected");
    assert.equal(second.reason, "already-consumed");
    assert.equal(calls, 1);
  });

  it("consumes every sibling action that shares one review decision key", async () => {
    let sequence = 0;
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(baseNowMs),
      createActionId: () => `review-${sequence += 1}`
    });
    const calls: string[] = [];
    const register = (actionType: "send" | "discard") =>
      registry.register({
        ownerUserId: "operator",
        guildId: "guild-1",
        channelId: "channel-1",
        sessionKey: "session-1",
        actionType,
        interactionKind: "button",
        consumptionKey: "mail-review:draft-1",
        expiresAt: new Date(baseNowMs + 60_000).toISOString(),
        handler: () => {
          calls.push(actionType);
          return { message: "OK" };
        }
      });
    const send = register("send");
    const discard = register("discard");

    const first = await registry.dispatch(createInteraction({ customId: send.customId }));
    const sibling = await registry.dispatch(
      createInteraction({ customId: discard.customId, interactionId: "interaction-2" })
    );

    assert.equal(first.state, "completed");
    assert.equal(sibling.state, "rejected");
    assert.equal(sibling.reason, "already-consumed");
    assert.deepEqual(calls, ["send"]);
  });

  it("scopes shared consumption keys to owner and session and rejects mixed expiries", async () => {
    let sequence = 0;
    const registry = createNeonDiscordComponentActionRegistry({
      now: () => new Date(baseNowMs),
      createActionId: () => `scope-${sequence += 1}`
    });
    const register = (ownerUserId: string, sessionKey: string, expiresAtMs: number) =>
      registry.register({
        ownerUserId,
        guildId: "guild-1",
        channelId: "channel-1",
        sessionKey,
        actionType: "approve",
        interactionKind: "button",
        consumptionKey: "review-1",
        expiresAt: new Date(expiresAtMs).toISOString(),
        handler: () => ({ message: "OK" })
      });
    const operator = register("operator", "session-1", baseNowMs + 60_000);
    const otherOwner = register("other", "session-1", baseNowMs + 60_000);

    const operatorResult = await registry.dispatch(createInteraction({ customId: operator.customId }));
    const otherResult = await registry.dispatch(
      createInteraction({ customId: otherOwner.customId, userId: "other" })
    );

    assert.equal(operatorResult.state, "completed");
    assert.equal(otherResult.state, "completed");
    assert.throws(
      () => register("operator", "session-1", baseNowMs + 120_000),
      /must share expiresAt/u
    );
  });

  it("restores owner, scope, handler binding, and consumption after a runtime restart", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-component-actions-"));
    const statePath = resolveNeonDiscordComponentActionStatePath(projectRoot);
    const now = () => new Date(baseNowMs);
    let calls = 0;
    let actionSequence = 0;
    const resolveHandler = (actionType: string) =>
      actionType === "run-control:stop"
        ? () => {
            calls += 1;
            return { message: "Gestoppt." };
          }
        : undefined;

    try {
      const firstRuntime = createNeonDiscordComponentActionRegistry({
        statePath,
        now,
        createActionId: () => `restart-safe-${actionSequence += 1}`
      });
      const registered = firstRuntime.register({
        ownerUserId: "operator",
        guildId: "guild-1",
        channelId: "channel-1",
        sessionKey: "session-1",
        actionType: "run-control:stop",
        interactionKind: "button",
        expiresAt: new Date(baseNowMs + 60_000).toISOString(),
        handler: resolveHandler("run-control:stop") ?? (() => ({ message: "missing" }))
      });
      const modalRegistered = firstRuntime.register({
        ownerUserId: "operator",
        guildId: "guild-1",
        channelId: "channel-1",
        sessionKey: "session-1",
        actionType: "pdf-review:change",
        interactionKind: "button",
        responseMode: "modal",
        expiresAt: new Date(baseNowMs + 60_000).toISOString(),
        handler: () => ({ message: "Dialog" })
      });
      const secondRuntime = createNeonDiscordComponentActionRegistry({
        statePath,
        now,
        resolveHandler
      });
      const foreign = await secondRuntime.dispatch(
        createInteraction({ customId: registered.customId, userId: "other" })
      );
      assert.equal(secondRuntime.resolveResponseMode(modalRegistered.customId), "modal");
      const owner = await secondRuntime.dispatch(
        createInteraction({ customId: registered.customId, interactionId: "owner" })
      );
      const thirdRuntime = createNeonDiscordComponentActionRegistry({
        statePath,
        now,
        resolveHandler
      });
      const replay = await thirdRuntime.dispatch(
        createInteraction({ customId: registered.customId, interactionId: "replay" })
      );
      const raw = await readFile(statePath, "utf8");

      assert.equal(foreign.state, "rejected");
      assert.equal(foreign.reason, "owner-mismatch");
      assert.equal(owner.state, "completed");
      assert.equal(owner.message, "Gestoppt.");
      assert.equal(replay.state, "rejected");
      assert.equal(replay.reason, "already-consumed");
      assert.equal(calls, 1);
      assert.doesNotMatch(raw, /function|=>|\/Users|secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("restores channel-wide access after a runtime restart", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-channel-action-"));
    const statePath = resolveNeonDiscordComponentActionStatePath(projectRoot);
    const now = () => new Date(baseNowMs);
    let calls = 0;
    const handler = () => {
      calls += 1;
      return { message: "Genehmigt." };
    };

    try {
      const firstRuntime = createNeonDiscordComponentActionRegistry({
        statePath,
        now,
        createActionId: () => "persisted-channel-action"
      });
      const registered = firstRuntime.register({
        ownerUserId: "operator",
        audience: "channel",
        guildId: "guild-1",
        channelId: "channel-1",
        sessionKey: "session-1",
        actionType: "plan-approval:approve",
        interactionKind: "button",
        expiresAt: new Date(baseNowMs + 60_000).toISOString(),
        handler
      });
      const secondRuntime = createNeonDiscordComponentActionRegistry({
        statePath,
        now,
        resolveHandler: (actionType) =>
          actionType === "plan-approval:approve" ? handler : undefined
      });

      const result = await secondRuntime.dispatch(
        createInteraction({ customId: registered.customId, userId: "operator-b" })
      );

      assert.equal(result.state, "completed");
      assert.equal(calls, 1);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("compacts expired persistent actions and fails closed without a rebound handler", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-component-action-ttl-"));
    const statePath = resolveNeonDiscordComponentActionStatePath(projectRoot);
    let nowMs = baseNowMs;

    try {
      const registry = createNeonDiscordComponentActionRegistry({
        statePath,
        now: () => new Date(nowMs),
        createActionId: () => "expires"
      });
      const registered = registry.register({
        ownerUserId: "operator",
        channelId: "channel-1",
        sessionKey: "session-1",
        actionType: "unknown-after-restart",
        interactionKind: "button",
        expiresAt: new Date(baseNowMs + 1_000).toISOString(),
        handler: () => ({ message: "in-memory only" })
      });
      const restarted = createNeonDiscordComponentActionRegistry({
        statePath,
        now: () => new Date(nowMs)
      });
      const unavailable = await restarted.dispatch(
        createInteraction({ customId: registered.customId })
      );
      nowMs += 2_000;
      const removed = registry.cleanupExpired();
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        readonly actions?: readonly unknown[];
      };

      assert.equal(unavailable.state, "rejected");
      assert.equal(unavailable.reason, "handler-unavailable");
      assert.equal(removed, 1);
      assert.deepEqual(persisted.actions, []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createInteraction(
  overrides: Partial<INeonDiscordComponentInteraction> = {}
): INeonDiscordComponentInteraction {
  return {
    interactionId: "interaction-1",
    kind: "button",
    customId: "occomp:cid=action:default",
    userId: "operator",
    guildId: "guild-1",
    channelId: "channel-1",
    createdAt: "2026-07-09T20:00:00.000Z",
    ...overrides
  };
}
