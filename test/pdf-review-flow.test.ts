import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDiscordComponentActionRegistry,
  createNeonPdfReviewRuntime,
  NEON_DISCORD_MEDIA_LIMITS,
  readNeonPdfReviewSession,
  writeNeonGatewayRunLatest,
  type INeonDiscordComponentActionRegistry,
  type INeonDeliveryQueueTarget,
  type INeonGatewayShadowRun,
  type INeonOutboundSender,
  type TNeonDiscordActionRow,
  type TNeonDiscordMediaAttachment
} from "../src/index.js";

const NOW = new Date("2026-07-10T10:00:00.000Z");
const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "default",
  guildId: "guild-1",
  channelId: "channel-1",
  replyToMessageId: "message-1"
};

describe("Neon PDF review flow", () => {
  it("sends separate verified page previews and an owner-bound review card", async () => {
    const fixture = await createFixture();
    try {
      const harness = createReviewHarness(fixture.projectRoot);
      const result = await harness.runtime.startReview(createStartInput(fixture));

      assert.equal(result.state, "review-pending");
      assert.equal(harness.mediaCalls.length, 1);
      assert.deepEqual(
        harness.mediaCalls[0]?.attachments.map((attachment) => attachment.name),
        ["page-1.png", "page-2.png"]
      );
      assert.equal(harness.cardRows.length, 1);
      const row = harness.cardRows[0];
      assert.ok(row && "buttons" in row);
      assert.deepEqual(row.buttons.map((button) => button.label), ["Finalisieren", "Änderung", "Abbrechen"]);
      assert.ok(row.buttons.every((button) => !button.customId?.includes(fixture.pdfName)));

      if (result.state === "review-pending") {
        const session = await readNeonPdfReviewSession(fixture.projectRoot, result.reviewId);
        assert.equal(session?.status, "pending");
        assert.equal(session?.cardMessageId, "card-message-1");
        assert.doesNotMatch(JSON.stringify(session), /\/Users\//u);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("binds review actions to the Discord thread where the card is posted", async () => {
    const fixture = await createFixture();
    try {
      const harness = createReviewHarness(fixture.projectRoot);
      const result = await harness.runtime.startReview({
        ...createStartInput(fixture),
        target: { ...TARGET, threadId: "thread-1" }
      });
      assert.equal(result.state, "review-pending");
      const row = harness.cardRows[0];
      assert.ok(row && "buttons" in row);
      const finalizeId = row.buttons[0]?.customId ?? "";
      const parent = await harness.registry.dispatch(createInteraction(finalizeId));
      const thread = await harness.registry.dispatch({
        ...createInteraction(finalizeId, "button", undefined, "thread-interaction"),
        channelId: "thread-1"
      });
      assert.equal(parent.state, "rejected");
      assert.equal(parent.state === "rejected" ? parent.reason : "", "scope-mismatch");
      assert.equal(thread.state, "completed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("opens a modal without consuming finalization, then starts one revision on submit", async () => {
    const fixture = await createFixture();
    try {
      const harness = createReviewHarness(fixture.projectRoot);
      const started = await harness.runtime.startReview(createStartInput(fixture));
      assert.equal(started.state, "review-pending");
      const row = harness.cardRows[0];
      assert.ok(row && "buttons" in row);
      const changeId = row.buttons[1]?.customId ?? "";
      const finalizeId = row.buttons[0]?.customId ?? "";

      assert.equal(harness.registry.resolveResponseMode(changeId), "modal");
      const change = await harness.registry.dispatch(createInteraction(changeId));
      assert.equal(change.state, "completed");
      assert.equal(change.state === "completed" ? change.modal?.title : undefined, "PDF ändern");
      const modalId = change.state === "completed" ? change.modal?.customId ?? "" : "";
      const revision = await harness.registry.dispatch(
        createInteraction(modalId, "modal-submit", { "revision-request": "Titel kürzen und CTA schärfen" })
      );
      const finalizeAfterRevision = await harness.registry.dispatch(createInteraction(finalizeId));

      assert.equal(revision.state, "completed");
      assert.equal(finalizeAfterRevision.state, "rejected");
      assert.equal(finalizeAfterRevision.state === "rejected" ? finalizeAfterRevision.reason : "", "already-consumed");
      assert.deepEqual(harness.revisionRequests, ["Titel kürzen und CTA schärfen"]);
      if (started.state === "review-pending") {
        const session = await readNeonPdfReviewSession(fixture.projectRoot, started.reviewId);
        assert.equal(session?.status, "revision-requested");
        assert.equal(session?.revisionRunId, "revision-run-1");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("finalizes once under parallel clicks and persists the confirmed message id", async () => {
    const fixture = await createFixture();
    try {
      const harness = createReviewHarness(fixture.projectRoot);
      const started = await harness.runtime.startReview(createStartInput(fixture));
      assert.equal(started.state, "review-pending");
      const row = harness.cardRows[0];
      assert.ok(row && "buttons" in row);
      const finalizeId = row.buttons[0]?.customId ?? "";

      const [first, second] = await Promise.all([
        harness.registry.dispatch(createInteraction(finalizeId)),
        harness.registry.dispatch(createInteraction(finalizeId, "button", undefined, "interaction-2"))
      ]);

      assert.equal(first.state, "completed");
      assert.equal(second.state, "rejected");
      assert.equal(harness.mediaCalls.filter((call) => call.attachments[0]?.name.endsWith(".pdf")).length, 1);
      if (started.state === "review-pending") {
        const session = await readNeonPdfReviewSession(fixture.projectRoot, started.reviewId);
        assert.equal(session?.status, "finalized");
        assert.equal(session?.finalMessageId, "media-message-2");
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks final delivery when the PDF changes after preview", async () => {
    const fixture = await createFixture();
    try {
      const harness = createReviewHarness(fixture.projectRoot);
      await harness.runtime.startReview(createStartInput(fixture));
      const row = harness.cardRows[0];
      assert.ok(row && "buttons" in row);
      await writeFile(fixture.pdfPath, new Uint8Array([9, 9, 9]));
      const result = await harness.registry.dispatch(createInteraction(row.buttons[0]?.customId ?? ""));

      assert.equal(result.state, "failed");
      assert.equal(harness.mediaCalls.filter((call) => call.attachments[0]?.name.endsWith(".pdf")).length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks preview delivery when a rendered page changed after publication", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(fixture.pageOnePath, new Uint8Array([9, 9, 9]));
      const harness = createReviewHarness(fixture.projectRoot);
      const result = await harness.runtime.startReview(createStartInput(fixture));

      assert.deepEqual(result, { state: "blocked", reason: "pdf-quality-gate-failed" });
      assert.equal(harness.mediaCalls.length, 0);
      assert.equal(harness.cardRows.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("blocks a PDF without a verified manifest before any Discord side effect", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.artifactDirectory, "manifest.json"), "{}\n", "utf8");
      const harness = createReviewHarness(fixture.projectRoot);
      const result = await harness.runtime.startReview(createStartInput(fixture));

      assert.deepEqual(result, { state: "blocked", reason: "pdf-quality-gate-failed" });
      assert.equal(harness.mediaCalls.length, 0);
      assert.equal(harness.cardRows.length, 0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("sends every canonical zero-padded page across bounded preview messages", async () => {
    const fixture = await createFixture({ pageCount: 12, zeroPadPageNames: true });
    try {
      const harness = createReviewHarness(fixture.projectRoot);
      const result = await harness.runtime.startReview(createStartInput(fixture));

      assert.equal(result.state, "review-pending");
      assert.deepEqual(harness.mediaCalls.map((call) => call.attachments.length), [10, 2]);
      assert.ok(
        harness.mediaCalls.every(
          (call) => call.attachments.length <= NEON_DISCORD_MEDIA_LIMITS.maxAttachments
        )
      );
      assert.deepEqual(
        harness.mediaCalls.flatMap((call) => call.attachments.map((attachment) => attachment.name)),
        Array.from({ length: 12 }, (_, index) => `page-${String(index + 1).padStart(2, "0")}.png`)
      );
      if (result.state === "review-pending") {
        assert.deepEqual(
          harness.mediaCalls.map((call) => call.target.deliveryIntentId),
          [
            `pdf-review-preview:${result.reviewId}:r1:part1-of-2`,
            `pdf-review-preview:${result.reviewId}:r1:part2-of-2`
          ]
        );
        const session = await readNeonPdfReviewSession(fixture.projectRoot, result.reviewId);
        assert.equal(session?.contactMessageId, "media-message-1");
      }
    } finally {
      await fixture.cleanup();
    }
  });
});

function createReviewHarness(projectRoot: string): {
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly runtime: ReturnType<typeof createNeonPdfReviewRuntime>;
  readonly mediaCalls: Array<{
    readonly target: INeonDeliveryQueueTarget;
    readonly attachments: readonly TNeonDiscordMediaAttachment[];
  }>;
  readonly cardRows: TNeonDiscordActionRow[];
  readonly revisionRequests: string[];
} {
  let actionSequence = 0;
  const registry = createNeonDiscordComponentActionRegistry({
    now: () => NOW,
    createActionId: () => `pdf-action-${actionSequence += 1}`
  });
  const mediaCalls: Array<{
    readonly target: INeonDeliveryQueueTarget;
    readonly attachments: readonly TNeonDiscordMediaAttachment[];
  }> = [];
  const cardRows: TNeonDiscordActionRow[] = [];
  const revisionRequests: string[] = [];
  const sender: INeonOutboundSender = {
    sendText() {
      throw new Error("PDF review should not send plain text through this seam");
    },
    sendMedia(target, message, attachments) {
      mediaCalls.push({ target, attachments });
      return Promise.resolve({
        outboundSent: true,
        target,
        bodyPreview: message ?? "",
        cutoverStage: "canary",
        messageId: `media-message-${mediaCalls.length}`,
        sentAt: NOW.toISOString()
      });
    }
  };
  const runtime = createNeonPdfReviewRuntime({
    projectRoot,
    registry,
    sender,
    transport: {
      postComponents(_target, _content, rows) {
        cardRows.push(...rows);
        return Promise.resolve({ messageId: "card-message-1" });
      }
    },
    requestRevision: async (request) => {
      revisionRequests.push(request.request);
      return { runId: "revision-run-1" };
    },
    now: () => NOW
  });
  return { registry, runtime, mediaCalls, cardRows, revisionRequests };
}

async function createFixture(
  options: { readonly pageCount?: number; readonly zeroPadPageNames?: boolean } = {}
): Promise<{
  readonly projectRoot: string;
  readonly artifactDirectory: string;
  readonly pdfName: string;
  readonly pdfPath: string;
  readonly pageOnePath: string;
  readonly run: INeonGatewayShadowRun;
  readonly cleanup: () => Promise<void>;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-pdf-review-"));
  const artifactDirectory = join(projectRoot, "state", "gateway", "pdf-outbox", "proof", "proof-1.0.0");
  const pdfName = "proof-1.0.0.pdf";
  const pdfPath = join(artifactDirectory, pdfName);
  const contactPath = join(artifactDirectory, "contact-sheet.png");
  const pdfData = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
  const contactData = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const pageCount = options.pageCount ?? 2;
  const pageNumberWidth = options.zeroPadPageNames ? String(pageCount).length : 1;
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const number = String(index + 1).padStart(pageNumberWidth, "0");
    return {
      name: `page-${number}.png`,
      data: new Uint8Array([137, 80, 78, 71, index + 1])
    };
  });
  const pageOne = pages[0];
  if (!pageOne) {
    throw new Error("PDF review fixture requires at least one page");
  }
  const pageOnePath = join(artifactDirectory, "pages", pageOne.name);
  await mkdir(join(artifactDirectory, "pages"), { recursive: true });
  await writeFile(pdfPath, pdfData);
  await writeFile(contactPath, contactData);
  await Promise.all(
    pages.map(async (page) => await writeFile(join(artifactDirectory, "pages", page.name), page.data))
  );
  await writeFile(
    join(artifactDirectory, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      state: "verified",
      outputProfile: "screen-accessible",
      pageCount,
      checks: { qpdf: "passed", embeddedFonts: "passed", completeRaster: "passed" },
      artifacts: {
        pdf: { name: pdfName, bytes: pdfData.byteLength, sha256: sha256(pdfData) },
        contactSheet: {
          name: "contact-sheet.png",
          bytes: contactData.byteLength,
          sha256: sha256(contactData)
        },
        pages: pages.map((page) => ({
          name: page.name,
          bytes: page.data.byteLength,
          sha256: sha256(page.data)
        }))
      }
    }, null, 2)}\n`,
    "utf8"
  );
  const run = createRun(projectRoot);
  await writeNeonGatewayRunLatest(projectRoot, run);
  return {
    projectRoot,
    artifactDirectory,
    pdfName,
    pdfPath,
    pageOnePath,
    run,
    cleanup: async () => await rm(projectRoot, { force: true, recursive: true })
  };
}

function createStartInput(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return {
    run: fixture.run,
    target: TARGET,
    visibleText: "PDF-Entwurf fertig.",
    attachedFiles: [
      { name: fixture.pdfName, absolutePath: fixture.pdfPath, contentType: "application/pdf" }
    ]
  };
}

function createInteraction(
  customId: string,
  kind: "button" | "modal-submit" = "button",
  fields?: Readonly<Record<string, string>>,
  interactionId = "interaction-1"
) {
  return {
    interactionId,
    kind,
    customId,
    userId: "operator",
    guildId: "guild-1",
    channelId: "channel-1",
    ...(fields ? { fields } : {}),
    createdAt: NOW.toISOString()
  };
}

function createRun(projectRoot: string): INeonGatewayShadowRun {
  return {
    runId: "run-pdf-review-1",
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "operator",
      userDisplayName: "the operator",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "write",
      contentPreview: "Erstelle eine PDF",
      receivedAt: NOW.toISOString()
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "discord:default:channel-1:operator",
    memoryState: "attached",
    events: [],
    finalText: "PDF fertig",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "shadow-mode",
      finalText: "PDF fertig"
    },
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString()
  };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
