import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildNeonDiscordComponentPayload } from "../src/gateway/discordComponentPayload.js";
import {
  buildNeonMailDraftReviewCustomId,
  buildNeonMailDraftReviewPrompt,
  parseNeonMailDraftReviewCustomId,
  runNeonMailDraftReviewAction,
  type INeonMailDraftReviewActionHandlers,
  type INeonMailDraftReviewSelection
} from "../src/gateway/mailDraftReviewFlow.js";

describe("mail draft review flow", () => {
  it("builds a review prompt with Senden/Bearbeiten/Verwerfen buttons", () => {
    const prompt = buildNeonMailDraftReviewPrompt({
      reviewId: "review-1",
      from: "Ada Lovelace <ada@example.com>",
      to: "operator@example.com",
      subject: "Recording slot",
      receivedAt: "2026-07-05T14:54:00+02:00",
      inboundPreview: "Hello, when is the recording scheduled?",
      draftPreview: "Hello Ada, the recording is Thursday morning. I will confirm the exact time."
    });

    assert.match(prompt.content, /Neue Mail/);
    assert.match(prompt.content, /Entwurf:/);
    assert.match(prompt.content, /OK raus\?/);
    assert.equal(prompt.components.length, 1);

    const payload = buildNeonDiscordComponentPayload(prompt.components);
    assert.equal(payload.ok, true);

    const row = prompt.components[0];
    assert.ok(row !== undefined && "buttons" in row);
    assert.deepEqual(
      row.buttons.map((button) => [button.label, button.style]),
      [
        ["Senden", "success"],
        ["Bearbeiten", "primary"],
        ["Verwerfen", "danger"]
      ]
    );

    const selections = row.buttons.map((button) =>
      button.customId ? parseNeonMailDraftReviewCustomId(button.customId) : null
    );
    assert.deepEqual(selections, [
      { reviewId: "review-1", action: "send" },
      { reviewId: "review-1", action: "edit" },
      { reviewId: "review-1", action: "discard" }
    ]);
  });

  it("neutralizes mentions and clamps long mail text before Discord delivery", () => {
    const prompt = buildNeonMailDraftReviewPrompt({
      reviewId: "safe-card",
      from: "@everyone <noise@example.com>",
      to: "operator@example.com",
      subject: "x".repeat(500),
      inboundPreview: "@here " + "mail ".repeat(300),
      draftPreview: "draft ".repeat(500)
    });

    assert.ok(!prompt.content.includes("@everyone"));
    assert.ok(!prompt.content.includes("@here"));
    assert.ok(prompt.content.length < 2_000);
  });

  it("round-trips compact custom ids and rejects foreign ids", () => {
    const customId = buildNeonMailDraftReviewCustomId({ reviewId: "r900000000000000042", action: "send" });

    assert.deepEqual(parseNeonMailDraftReviewCustomId(customId), {
      reviewId: "r900000000000000042",
      action: "send"
    });
    assert.equal(parseNeonMailDraftReviewCustomId("occomp:cid=other:send:r1"), null);
    assert.equal(parseNeonMailDraftReviewCustomId("garbage"), null);
    assert.throws(
      () => buildNeonMailDraftReviewCustomId({ reviewId: "x".repeat(49), action: "send" }),
      /exceeds 48 chars/
    );
  });

  it("routes button actions to send, edit request, and discard handlers", async () => {
    const calls: string[] = [];
    const handlers: INeonMailDraftReviewActionHandlers = {
      sendDraft: (selection: INeonMailDraftReviewSelection) => {
        calls.push(`send:${selection.reviewId}`);
      },
      requestEdit: (selection: INeonMailDraftReviewSelection) => {
        calls.push(`edit:${selection.reviewId}`);
      },
      discardDraft: (selection: INeonMailDraftReviewSelection) => {
        calls.push(`discard:${selection.reviewId}`);
      }
    };

    const sendId = buildNeonMailDraftReviewCustomId({ reviewId: "draft-1", action: "send" });
    const editId = buildNeonMailDraftReviewCustomId({ reviewId: "draft-1", action: "edit" });
    const discardId = buildNeonMailDraftReviewCustomId({ reviewId: "draft-1", action: "discard" });

    assert.equal((await runNeonMailDraftReviewAction(sendId, handlers)).state, "sent");
    assert.equal((await runNeonMailDraftReviewAction(editId, handlers)).state, "edit-requested");
    assert.equal((await runNeonMailDraftReviewAction(discardId, handlers)).state, "discarded");
    assert.deepEqual(calls, ["send:draft-1", "edit:draft-1", "discard:draft-1"]);
  });

  it("returns ignored for unrelated button ids and failed when an adapter throws", async () => {
    const failedId = buildNeonMailDraftReviewCustomId({ reviewId: "draft-2", action: "send" });
    const handlers: INeonMailDraftReviewActionHandlers = {
      sendDraft: () => {
        throw new Error("gmail send failed");
      },
      requestEdit: () => undefined,
      discardDraft: () => undefined
    };

    assert.equal((await runNeonMailDraftReviewAction("occomp:cid=other", handlers)).state, "ignored");
    const failed = await runNeonMailDraftReviewAction(failedId, handlers);
    assert.equal(failed.state, "failed");
    assert.match(failed.message, /gmail send failed/);
  });
});
