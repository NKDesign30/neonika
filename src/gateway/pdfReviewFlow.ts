import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { redactText } from "../harness/redaction.js";
import type { INeonGatewayShadowRun } from "./types.js";
import { readNeonGatewayRuns } from "./runStore.js";
import type { INeonDeliveryQueueTarget } from "./deliveryQueue.js";
import {
  createNeonDeliveryPayloadHash,
  executeNeonExactlyOnceDelivery
} from "./deliveryReceiptStore.js";
import type {
  INeonDiscordComponentActionContext,
  INeonDiscordComponentActionOutcome,
  INeonDiscordComponentActionRegistry
} from "./discordComponentActionRegistry.js";
import type { TNeonDiscordActionRow } from "./discordComponentPayload.js";
import {
  NEON_DISCORD_MEDIA_LIMITS,
  type INeonDiscordInlineAttachment
} from "./discordMediaPayload.js";
import type { INeonLocalMediaFile } from "./localMediaAttachment.js";
import type { INeonOutboundSendResult, INeonOutboundSender } from "./outboundSender.js";

export type TNeonPdfReviewStatus =
  | "preparing"
  | "pending"
  | "revision-requested"
  | "cancelled"
  | "finalized";

export interface INeonPdfReviewSession {
  readonly version: 1;
  readonly reviewId: string;
  readonly runId: string;
  readonly ownerUserId: string;
  readonly sessionKey: string;
  readonly target: INeonDeliveryQueueTarget;
  readonly artifactDirectory: string;
  readonly pdfName: string;
  readonly pdfSha256: string;
  readonly contactSheetName: string;
  readonly manifestSha256: string;
  readonly outputProfile: "screen-accessible" | "office-print";
  readonly pageCount: number;
  readonly revision: number;
  readonly status: TNeonPdfReviewStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revisionModalCustomId?: string;
  readonly finalizeCustomId?: string;
  readonly changeCustomId?: string;
  readonly cancelCustomId?: string;
  readonly contactMessageId?: string;
  readonly cardMessageId?: string;
  readonly finalMessageId?: string;
  readonly revisionRequest?: string;
  readonly revisionRunId?: string;
}

export interface INeonPdfReviewStartInput {
  readonly run: INeonGatewayShadowRun;
  readonly target: INeonDeliveryQueueTarget;
  readonly attachedFiles: readonly INeonLocalMediaFile[];
}

export type TNeonPdfReviewStartResult =
  | {
      readonly state: "not-applicable";
      readonly reason: "no-pdf";
    }
  | {
      readonly state: "blocked";
      readonly reason: "pdf-quality-gate-failed";
    }
  | {
      readonly state: "review-pending";
      readonly reviewId: string;
      readonly messageId: string;
    };

export interface INeonPdfReviewRevisionRequest {
  readonly reviewId: string;
  readonly run: INeonGatewayShadowRun;
  readonly request: string;
}

export interface INeonPdfReviewTransport {
  postComponents(
    target: INeonDeliveryQueueTarget,
    content: string,
    rows: readonly TNeonDiscordActionRow[]
  ): Promise<{ readonly messageId: string }>;
}

export interface ICreateNeonPdfReviewRuntimeOptions {
  readonly projectRoot: string;
  readonly registry: INeonDiscordComponentActionRegistry;
  readonly sender: INeonOutboundSender;
  readonly transport: INeonPdfReviewTransport;
  readonly requestRevision: (request: INeonPdfReviewRevisionRequest) => Promise<{ readonly runId: string }>;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export interface INeonPdfReviewRuntime {
  startReview(input: INeonPdfReviewStartInput): Promise<TNeonPdfReviewStartResult>;
  handleAction(context: INeonDiscordComponentActionContext): Promise<INeonDiscordComponentActionOutcome>;
}

interface IVerifiedPdfArtifacts {
  readonly directory: string;
  readonly relativeDirectory: string;
  readonly manifestSha256: string;
  readonly pdfName: string;
  readonly pdfPath: string;
  readonly pdfData: Uint8Array;
  readonly pdfSha256: string;
  readonly contactSheetName: string;
  readonly pages: readonly IVerifiedPdfPage[];
  readonly outputProfile: "screen-accessible" | "office-print";
  readonly pageCount: number;
}

interface IVerifiedPdfPage {
  readonly name: string;
  readonly data: Uint8Array;
}

interface IManifestArtifact {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface IVerifiedManifest {
  readonly outputProfile: "screen-accessible" | "office-print";
  readonly pageCount: number;
  readonly pdf: IManifestArtifact;
  readonly contactSheet: IManifestArtifact;
  readonly pages: readonly IManifestArtifact[];
}

const PDF_REVIEW_ACTION_PREFIX = "pdf-review:";
const PDF_REVIEW_TTL_MS = 30 * 60 * 1_000;
const PDF_REVIEW_REVISION_FIELD = "revision-request";

export function isNeonPdfReviewActionType(actionType: string): boolean {
  return actionType.startsWith(PDF_REVIEW_ACTION_PREFIX);
}

export function resolveNeonPdfReviewSessionPath(projectRoot: string, reviewId: string): string {
  return join(projectRoot, "state", "gateway", "pdf-reviews", `${requireOpaqueReviewId(reviewId)}.json`);
}

export function createNeonPdfReviewRuntime(
  options: ICreateNeonPdfReviewRuntimeOptions
): INeonPdfReviewRuntime {
  const now = options.now ?? (() => new Date());
  const ttlMs = normalizeTtl(options.ttlMs);

  const handleAction = async (
    context: INeonDiscordComponentActionContext
  ): Promise<INeonDiscordComponentActionOutcome> => {
    const reviewId = requireOpaqueReviewId(context.resourceRef ?? "");
    const session = await readNeonPdfReviewSession(options.projectRoot, reviewId);
    if (!session) {
      throw new Error("PDF review session is unavailable");
    }
    if (context.sessionKey !== session.sessionKey || context.interaction.userId !== session.ownerUserId) {
      throw new Error("PDF review session scope changed");
    }
    if (Date.parse(session.expiresAt) <= now().getTime()) {
      throw new Error("PDF review session expired");
    }

    if (context.actionType === `${PDF_REVIEW_ACTION_PREFIX}change`) {
      if (session.status !== "pending" || !session.revisionModalCustomId) {
        throw new Error("PDF review is not open for changes");
      }
      return {
        message: "Änderungsdialog geöffnet.",
        modal: {
          customId: session.revisionModalCustomId,
          title: "PDF ändern",
          inputs: [
            {
              customId: PDF_REVIEW_REVISION_FIELD,
              label: "Was soll geändert werden?",
              style: "paragraph",
              placeholder: "Kurz und konkret beschreiben",
              required: true,
              minLength: 3,
              maxLength: 1_000
            }
          ]
        }
      };
    }

    if (context.actionType === `${PDF_REVIEW_ACTION_PREFIX}revision-submit`) {
      if (session.status !== "pending") {
        throw new Error("PDF review is no longer pending");
      }
      const request = normalizeRevisionRequest(context.interaction.fields?.[PDF_REVIEW_REVISION_FIELD]);
      const revision = await options.requestRevision({ reviewId, run: await readReviewRun(options.projectRoot, session), request });
      await writeNeonPdfReviewSession(options.projectRoot, {
        ...session,
        status: "revision-requested",
        revisionRequest: request,
        revisionRunId: revision.runId,
        updatedAt: now().toISOString()
      });
      return { message: "Änderung übernommen. Eine neue Revision läuft." };
    }

    if (context.actionType === `${PDF_REVIEW_ACTION_PREFIX}cancel`) {
      if (session.status !== "pending") {
        throw new Error("PDF review is no longer pending");
      }
      await writeNeonPdfReviewSession(options.projectRoot, {
        ...session,
        status: "cancelled",
        updatedAt: now().toISOString()
      });
      return { message: "PDF-Review abgebrochen. Es wurde keine finale Datei gesendet." };
    }

    if (context.actionType !== `${PDF_REVIEW_ACTION_PREFIX}finalize`) {
      throw new Error("Unknown PDF review action");
    }
    if (session.status !== "pending") {
      throw new Error("PDF review is no longer pending");
    }

    const artifacts = await verifyPdfArtifacts(options.projectRoot, session.artifactDirectory);
    if (
      artifacts.manifestSha256 !== session.manifestSha256 ||
      artifacts.pdfSha256 !== session.pdfSha256 ||
      artifacts.pdfName !== session.pdfName
    ) {
      throw new Error("PDF review artifact integrity changed");
    }
    const finalText = `PDF finalisiert · ${session.pageCount} Seite${session.pageCount === 1 ? "" : "n"} · ${session.outputProfile}`;
    const delivery = await executeNeonExactlyOnceDelivery({
      projectRoot: options.projectRoot,
      intentId: `pdf-review-final:${session.reviewId}:r${session.revision}`,
      runId: session.runId,
      kind: "media",
      target: session.target,
      payloadHash: createNeonDeliveryPayloadHash([finalText, artifacts.pdfData]),
      send: async (target) => {
        const sender = options.sender.sendMedia;
        if (!sender) {
          throw new Error("PDF media sender is unavailable");
        }
        return await sender(target, finalText, [toAttachment(artifacts.pdfName, artifacts.pdfData, "application/pdf")]);
      }
    });
    if (delivery.state !== "delivered" && delivery.state !== "already-delivered") {
      throw new Error("PDF final delivery was not confirmed");
    }
    await writeNeonPdfReviewSession(options.projectRoot, {
      ...session,
      status: "finalized",
      ...(delivery.messageId ? { finalMessageId: delivery.messageId } : {}),
      updatedAt: now().toISOString()
    });
    return { message: "PDF finalisiert und genau einmal zugestellt." };
  };

  return {
    startReview: async (input) => {
      const pdfFiles = input.attachedFiles.filter((file) => file.contentType === "application/pdf");
      if (pdfFiles.length === 0) {
        return { state: "not-applicable", reason: "no-pdf" };
      }
      if (pdfFiles.length !== 1) {
        return { state: "blocked", reason: "pdf-quality-gate-failed" };
      }

      let artifacts: IVerifiedPdfArtifacts;
      try {
        artifacts = await verifyPdfArtifacts(options.projectRoot, dirname(pdfFiles[0]?.absolutePath ?? ""));
      } catch {
        return { state: "blocked", reason: "pdf-quality-gate-failed" };
      }
      if (artifacts.pdfPath !== resolve(pdfFiles[0]?.absolutePath ?? "")) {
        return { state: "blocked", reason: "pdf-quality-gate-failed" };
      }

      const reviewId = createReviewId(input.run.runId, artifacts.pdfSha256);
      const existing = await readNeonPdfReviewSession(options.projectRoot, reviewId);
      if (existing?.cardMessageId && existing.status === "pending") {
        return { state: "review-pending", reviewId, messageId: existing.cardMessageId };
      }

      const timestamp = now().toISOString();
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString();
      let session: INeonPdfReviewSession;
      if (existing?.status === "preparing") {
        if (!readPersistedReviewActions(existing)) {
          return { state: "blocked", reason: "pdf-quality-gate-failed" };
        }
        session = existing;
      } else {
        session = {
          version: 1,
          reviewId,
          runId: input.run.runId,
          ownerUserId: input.run.request.userId,
          sessionKey: input.run.harnessSessionKey,
          target: input.target,
          artifactDirectory: artifacts.relativeDirectory,
          pdfName: artifacts.pdfName,
          pdfSha256: artifacts.pdfSha256,
          contactSheetName: artifacts.contactSheetName,
          manifestSha256: artifacts.manifestSha256,
          outputProfile: artifacts.outputProfile,
          pageCount: artifacts.pageCount,
          revision: 1,
          status: "preparing",
          expiresAt,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        await writeNeonPdfReviewSession(options.projectRoot, session);

        const decisionKey = `pdf-review:${reviewId}:decision`;
        const modalAction = options.registry.register({
          ownerUserId: session.ownerUserId,
          ...(session.target.guildId ? { guildId: session.target.guildId } : {}),
          channelId: session.target.threadId ?? session.target.channelId,
          sessionKey: session.sessionKey,
          actionType: `${PDF_REVIEW_ACTION_PREFIX}revision-submit`,
          interactionKind: "modal-submit",
          consumptionKey: decisionKey,
          resourceRef: reviewId,
          expiresAt,
          handler: handleAction
        });
        const finalizeCustomId = registerReviewButton(options.registry, session, "finalize", decisionKey, handleAction);
        const changeCustomId = registerReviewButton(options.registry, session, "change", undefined, handleAction, "modal");
        const cancelCustomId = registerReviewButton(options.registry, session, "cancel", decisionKey, handleAction);
        session = {
          ...session,
          revisionModalCustomId: modalAction.customId,
          finalizeCustomId,
          changeCustomId,
          cancelCustomId,
          updatedAt: now().toISOString()
        };
        await writeNeonPdfReviewSession(options.projectRoot, session);
      }

      const actions = readPersistedReviewActions(session);
      if (!actions) {
        return { state: "blocked", reason: "pdf-quality-gate-failed" };
      }
      const rows: readonly TNeonDiscordActionRow[] = [
        {
          buttons: [
            { label: "Finalisieren", style: "success", customId: actions.finalizeCustomId },
            { label: "Änderung", style: "primary", customId: actions.changeCustomId },
            { label: "Abbrechen", style: "danger", customId: actions.cancelCustomId }
          ]
        }
      ];

      const contactText = `PDF-Vorschau · Revision ${session.revision} · ${session.pageCount} Seite${session.pageCount === 1 ? "" : "n"}`;
      const previewBatchCount = Math.ceil(artifacts.pages.length / NEON_DISCORD_MEDIA_LIMITS.maxAttachments);
      let contactMessageId: string | undefined;
      for (let batchIndex = 0; batchIndex < previewBatchCount; batchIndex += 1) {
        const batchStart = batchIndex * NEON_DISCORD_MEDIA_LIMITS.maxAttachments;
        const previewAttachments = artifacts.pages
          .slice(batchStart, batchStart + NEON_DISCORD_MEDIA_LIMITS.maxAttachments)
          .map((page) => toAttachment(page.name, page.data, "image/png"));
        const previewText = previewBatchCount === 1
          ? contactText
          : `${contactText} · Teil ${batchIndex + 1}/${previewBatchCount}`;
        const previewIntentId = previewBatchCount === 1
          ? `pdf-review-preview:${reviewId}:r${session.revision}`
          : `pdf-review-preview:${reviewId}:r${session.revision}:part${batchIndex + 1}-of-${previewBatchCount}`;
        const previewDelivery = await executeNeonExactlyOnceDelivery({
          projectRoot: options.projectRoot,
          intentId: previewIntentId,
          runId: session.runId,
          kind: "media",
          target: session.target,
          payloadHash: createNeonDeliveryPayloadHash([
            previewText,
            ...previewAttachments.flatMap((attachment) => [attachment.name, attachment.data])
          ]),
          send: async (target) => {
            const sender = options.sender.sendMedia;
            if (!sender) {
              throw new Error("PDF preview media sender is unavailable");
            }
            return await sender(target, previewText, previewAttachments);
          }
        });
        if (previewDelivery.state !== "delivered" && previewDelivery.state !== "already-delivered") {
          throw new Error("PDF preview delivery was not confirmed");
        }
        contactMessageId ??= previewDelivery.messageId;
      }

      const cardText = [
        "PDF-Review bereit",
        `Seiten: ${session.pageCount}`,
        `Profil: ${session.outputProfile}`,
        `Revision: ${session.revision}`,
        "Geprüft: Manifest, Hashes, Fonts und vollständiges Seitenraster."
      ].join("\n");
      const cardDelivery = await executeNeonExactlyOnceDelivery({
        projectRoot: options.projectRoot,
        intentId: `pdf-review-card:${reviewId}:r${session.revision}`,
        runId: session.runId,
        kind: "text",
        target: session.target,
        payloadHash: createNeonDeliveryPayloadHash([
          cardText,
          ...rows.flatMap((row) => "buttons" in row ? row.buttons.map((button) => button.customId ?? "") : [row.select.customId])
        ]),
        send: async (target) => {
          const sent = await options.transport.postComponents(target, cardText, rows);
          return toOutboundResult(target, cardText, sent.messageId, now());
        }
      });
      if (cardDelivery.state !== "delivered" && cardDelivery.state !== "already-delivered") {
        throw new Error("PDF review card delivery was not confirmed");
      }
      const cardMessageId = cardDelivery.messageId;
      if (!cardMessageId) {
        throw new Error("PDF review card message id is missing");
      }
      session = {
        ...session,
        status: "pending",
        ...(contactMessageId ? { contactMessageId } : {}),
        cardMessageId,
        updatedAt: now().toISOString()
      };
      await writeNeonPdfReviewSession(options.projectRoot, session);
      return { state: "review-pending", reviewId, messageId: cardMessageId };
    },
    handleAction
  };
}

function readPersistedReviewActions(session: INeonPdfReviewSession): {
  readonly revisionModalCustomId: string;
  readonly finalizeCustomId: string;
  readonly changeCustomId: string;
  readonly cancelCustomId: string;
} | undefined {
  return session.revisionModalCustomId &&
    session.finalizeCustomId &&
    session.changeCustomId &&
    session.cancelCustomId
    ? {
        revisionModalCustomId: session.revisionModalCustomId,
        finalizeCustomId: session.finalizeCustomId,
        changeCustomId: session.changeCustomId,
        cancelCustomId: session.cancelCustomId
      }
    : undefined;
}

export async function readNeonPdfReviewSession(
  projectRoot: string,
  reviewId: string
): Promise<INeonPdfReviewSession | undefined> {
  try {
    return parseReviewSession(JSON.parse(await readFile(resolveNeonPdfReviewSessionPath(projectRoot, reviewId), "utf8")));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function registerReviewButton(
  registry: INeonDiscordComponentActionRegistry,
  session: INeonPdfReviewSession,
  action: "finalize" | "change" | "cancel",
  consumptionKey: string | undefined,
  handler: (context: INeonDiscordComponentActionContext) => Promise<INeonDiscordComponentActionOutcome>,
  responseMode?: "modal"
): string {
  return registry.register({
    ownerUserId: session.ownerUserId,
    ...(session.target.guildId ? { guildId: session.target.guildId } : {}),
    channelId: session.target.threadId ?? session.target.channelId,
    sessionKey: session.sessionKey,
    actionType: `${PDF_REVIEW_ACTION_PREFIX}${action}`,
    interactionKind: "button",
    ...(responseMode ? { responseMode } : {}),
    ...(consumptionKey ? { consumptionKey } : {}),
    resourceRef: session.reviewId,
    expiresAt: session.expiresAt,
    handler
  }).customId;
}

async function verifyPdfArtifacts(projectRoot: string, artifactDirectory: string): Promise<IVerifiedPdfArtifacts> {
  const project = resolve(projectRoot);
  const directory = isAbsolute(artifactDirectory)
    ? resolve(artifactDirectory)
    : resolve(project, artifactDirectory);
  const relativeDirectory = relative(project, directory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    !relativeDirectory.startsWith(join("state", "gateway", "pdf-outbox"))
  ) {
    throw new Error("PDF review artifacts must stay inside the Gateway PDF outbox");
  }
  const manifestPath = join(directory, "manifest.json");
  const manifestData = await readFile(manifestPath);
  const manifest = parseVerifiedManifest(JSON.parse(manifestData.toString("utf8")));
  const pdfPath = resolveArtifactPath(directory, manifest.pdf.name);
  const contactSheetPath = resolveArtifactPath(directory, manifest.contactSheet.name);
  const pagePaths = manifest.pages.map((page) => resolvePageArtifactPath(directory, page.name));
  const [pdfData, contactSheetData, ...pageData] = await Promise.all([
    readFile(pdfPath),
    readFile(contactSheetPath),
    ...pagePaths.map(async (path) => await readFile(path))
  ]);
  const pages = manifest.pages.map((page, index) => {
    const data = pageData[index];
    if (!data || data.byteLength !== page.bytes || sha256(data) !== page.sha256) {
      throw new Error("PDF review page artifact hash validation failed");
    }
    return { name: page.name, data };
  });
  if (
    pdfData.byteLength !== manifest.pdf.bytes ||
    sha256(pdfData) !== manifest.pdf.sha256 ||
    contactSheetData.byteLength !== manifest.contactSheet.bytes ||
    sha256(contactSheetData) !== manifest.contactSheet.sha256
  ) {
    throw new Error("PDF review artifact hash validation failed");
  }
  return {
    directory,
    relativeDirectory,
    manifestSha256: sha256(manifestData),
    pdfName: manifest.pdf.name,
    pdfPath,
    pdfData,
    pdfSha256: manifest.pdf.sha256,
    contactSheetName: manifest.contactSheet.name,
    pages,
    outputProfile: manifest.outputProfile,
    pageCount: manifest.pageCount
  };
}

function parseVerifiedManifest(value: unknown): IVerifiedManifest {
  if (!isRecord(value) || value["version"] !== 1 || value["state"] !== "verified") {
    throw new Error("PDF manifest is not verified");
  }
  const profile = value["outputProfile"];
  const pageCount = value["pageCount"];
  const checks = value["checks"];
  const artifacts = value["artifacts"];
  if (
    (profile !== "screen-accessible" && profile !== "office-print") ||
    !Number.isSafeInteger(pageCount) ||
    Number(pageCount) < 1 ||
    !isRecord(checks) ||
    Object.values(checks).length === 0 ||
    !Object.values(checks).every((check) => check === "passed") ||
    !isRecord(artifacts)
  ) {
    throw new Error("PDF manifest quality checks are incomplete");
  }
  return {
    outputProfile: profile,
    pageCount: Number(pageCount),
    pdf: parseManifestArtifact(artifacts["pdf"], ".pdf"),
    contactSheet: parseManifestArtifact(artifacts["contactSheet"], ".png"),
    pages: parseManifestPages(artifacts["pages"], Number(pageCount))
  };
}

function parseManifestPages(value: unknown, pageCount: number): readonly IManifestArtifact[] {
  if (!Array.isArray(value) || value.length !== pageCount) {
    throw new Error("PDF manifest page artifacts are incomplete");
  }
  const pageNumberWidth = String(pageCount).length;
  return value.map((page, index) => {
    const artifact = parseManifestArtifact(page, ".png");
    const pageNumber = String(index + 1).padStart(pageNumberWidth, "0");
    if (artifact.name !== `page-${pageNumber}.png`) {
      throw new Error("PDF manifest page artifacts are out of order");
    }
    return artifact;
  });
}

function parseManifestArtifact(value: unknown, suffix: string): IManifestArtifact {
  if (!isRecord(value)) {
    throw new Error("PDF manifest artifact is invalid");
  }
  const name = value["name"];
  const bytes = value["bytes"];
  const hash = value["sha256"];
  if (
    typeof name !== "string" ||
    basename(name) !== name ||
    !name.toLowerCase().endsWith(suffix) ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) < 1 ||
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(hash)
  ) {
    throw new Error("PDF manifest artifact fields are invalid");
  }
  return { name, bytes: Number(bytes), sha256: hash };
}

function resolveArtifactPath(directory: string, name: string): string {
  const path = resolve(directory, name);
  if (dirname(path) !== directory) {
    throw new Error("PDF manifest artifact escaped its directory");
  }
  return path;
}

function resolvePageArtifactPath(directory: string, name: string): string {
  const pagesDirectory = resolve(directory, "pages");
  const path = resolve(pagesDirectory, name);
  if (dirname(path) !== pagesDirectory) {
    throw new Error("PDF manifest page artifact escaped its directory");
  }
  return path;
}

async function writeNeonPdfReviewSession(projectRoot: string, session: INeonPdfReviewSession): Promise<void> {
  const path = resolveNeonPdfReviewSessionPath(projectRoot, session.reviewId);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

function parseReviewSession(value: unknown): INeonPdfReviewSession {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["target"])) {
    throw new Error("PDF review session is invalid");
  }
  const reviewId = requireStoredString(value, "reviewId", 32);
  requireOpaqueReviewId(reviewId);
  const status = readReviewStatus(value["status"]);
  const outputProfile = readOutputProfile(value["outputProfile"]);
  const pageCount = readStoredPositiveInteger(value, "pageCount");
  const revision = readStoredPositiveInteger(value, "revision");
  const target = parseStoredTarget(value["target"]);
  if (
    !status ||
    !outputProfile ||
    !target ||
    !pageCount ||
    !revision
  ) {
    throw new Error("PDF review session status is invalid");
  }
  const session: INeonPdfReviewSession = {
    version: 1,
    reviewId,
    runId: requireStoredString(value, "runId", 200),
    ownerUserId: requireStoredString(value, "ownerUserId", 100),
    sessionKey: requireStoredString(value, "sessionKey", 500),
    target,
    artifactDirectory: requireStoredString(value, "artifactDirectory", 1_000),
    pdfName: requireStoredFilename(value, "pdfName", ".pdf"),
    pdfSha256: requireStoredHash(value, "pdfSha256"),
    contactSheetName: requireStoredFilename(value, "contactSheetName", ".png"),
    manifestSha256: requireStoredHash(value, "manifestSha256"),
    outputProfile,
    pageCount,
    revision,
    status,
    expiresAt: requireStoredTimestamp(value, "expiresAt"),
    createdAt: requireStoredTimestamp(value, "createdAt"),
    updatedAt: requireStoredTimestamp(value, "updatedAt"),
    ...readOptionalStoredString(value, "revisionModalCustomId", 100),
    ...readOptionalStoredString(value, "finalizeCustomId", 100),
    ...readOptionalStoredString(value, "changeCustomId", 100),
    ...readOptionalStoredString(value, "cancelCustomId", 100),
    ...readOptionalStoredString(value, "contactMessageId", 100),
    ...readOptionalStoredString(value, "cardMessageId", 100),
    ...readOptionalStoredString(value, "finalMessageId", 100),
    ...readOptionalStoredString(value, "revisionRequest", 1_000),
    ...readOptionalStoredString(value, "revisionRunId", 200)
  };
  return session;
}

function parseStoredTarget(value: Record<string, unknown>): INeonDeliveryQueueTarget | undefined {
  if (value["channel"] !== "discord") {
    return undefined;
  }
  const accountId = readStoredString(value["accountId"], 100);
  const channelId = readStoredString(value["channelId"], 100);
  if (!accountId || !channelId) {
    return undefined;
  }
  const guildId = readStoredString(value["guildId"], 100);
  const threadId = readStoredString(value["threadId"], 100);
  const replyToMessageId = readStoredString(value["replyToMessageId"], 100);
  return {
    channel: "discord",
    accountId,
    channelId,
    ...(guildId ? { guildId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {})
  };
}

function readReviewStatus(value: unknown): TNeonPdfReviewStatus | undefined {
  return value === "preparing" ||
    value === "pending" ||
    value === "revision-requested" ||
    value === "cancelled" ||
    value === "finalized"
    ? value
    : undefined;
}

function readOutputProfile(value: unknown): "screen-accessible" | "office-print" | undefined {
  return value === "screen-accessible" || value === "office-print" ? value : undefined;
}

function requireStoredString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = readStoredString(record[key], maxLength);
  if (!value) {
    throw new Error(`PDF review session ${key} is invalid`);
  }
  return value;
}

function readStoredString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function readOptionalStoredString(
  record: Record<string, unknown>,
  key:
    | "revisionModalCustomId"
    | "finalizeCustomId"
    | "changeCustomId"
    | "cancelCustomId"
    | "contactMessageId"
    | "cardMessageId"
    | "finalMessageId"
    | "revisionRequest"
    | "revisionRunId",
  maxLength: number
): Partial<Pick<INeonPdfReviewSession, typeof key>> {
  if (record[key] === undefined) {
    return {};
  }
  const value = requireStoredString(record, key, maxLength);
  return { [key]: value };
}

function readStoredPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function requireStoredFilename(record: Record<string, unknown>, key: string, suffix: string): string {
  const value = requireStoredString(record, key, 255);
  if (basename(value) !== value || !value.toLowerCase().endsWith(suffix)) {
    throw new Error(`PDF review session ${key} is invalid`);
  }
  return value;
}

function requireStoredHash(record: Record<string, unknown>, key: string): string {
  const value = requireStoredString(record, key, 64);
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`PDF review session ${key} is invalid`);
  }
  return value;
}

function requireStoredTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireStoredString(record, key, 40);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`PDF review session ${key} is invalid`);
  }
  return new Date(Date.parse(value)).toISOString();
}

async function readReviewRun(projectRoot: string, session: INeonPdfReviewSession): Promise<INeonGatewayShadowRun> {
  const run = (await readNeonGatewayRuns(projectRoot)).find((candidate) => candidate.runId === session.runId);
  if (!run) {
    throw new Error("PDF review source run is unavailable");
  }
  return run;
}

function toAttachment(name: string, data: Uint8Array, contentType: string): INeonDiscordInlineAttachment {
  return { name, data, contentType };
}

function toOutboundResult(
  target: INeonDeliveryQueueTarget,
  body: string,
  messageId: string,
  sentAt: Date
): INeonOutboundSendResult {
  return {
    outboundSent: true,
    target,
    bodyPreview: redactText(body).slice(0, 280),
    cutoverStage: "canary",
    messageId,
    sentAt: sentAt.toISOString()
  };
}

function createReviewId(runId: string, pdfSha256: string): string {
  return createHash("sha256").update(`${runId}:${pdfSha256}`).digest("hex").slice(0, 32);
}

function requireOpaqueReviewId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-f0-9]{32}$/u.test(normalized)) {
    throw new Error("PDF review id is invalid");
  }
  return normalized;
}

function normalizeRevisionRequest(value: string | undefined): string {
  const normalized = redactText(value ?? "").replace(/\s+/gu, " ").trim();
  if (normalized.length < 3 || normalized.length > 1_000) {
    throw new Error("PDF revision request must contain 3-1000 characters");
  }
  return normalized;
}

function normalizeTtl(value: number | undefined): number {
  if (value === undefined) {
    return PDF_REVIEW_TTL_MS;
  }
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("PDF review ttlMs must be between 1 minute and 24 hours");
  }
  return value;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
