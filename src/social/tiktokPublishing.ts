import type { INeonGatewayInboundAttachment } from "../gateway/types.js";

export const NEON_TIKTOK_OFFICIAL_DOCS = {
  contentPostingGetStarted: "https://developers.tiktok.com/doc/content-posting-api-get-started",
  directPost: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
  uploadVideo: "https://developers.tiktok.com/doc/content-posting-api-reference-upload-video"
} as const;

export type TNeonTikTokPostMode = "direct-post" | "inbox-upload";
export type TNeonTikTokTransferMethod = "FILE_UPLOAD" | "PULL_FROM_URL";
export type TNeonTikTokApiScope = "video.publish" | "video.upload";
export type TNeonTikTokPrivacyLevel =
  | "PUBLIC_TO_EVERYONE"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "SELF_ONLY";
export type TNeonTikTokWorkflowState = "ready" | "blocked";
export type TNeonTikTokStepState = "ready" | "planned" | "blocked";

export interface INeonTikTokVideoEditPlanInput {
  readonly sourcePath: string;
  readonly outputPath: string;
  readonly trimStartSeconds?: number;
  readonly trimEndSeconds?: number;
  readonly targetAspectRatio?: "9:16" | "source";
  readonly burnCaptions?: boolean;
}

export interface INeonTikTokVideoEditPlan {
  readonly tool: "ffmpeg";
  readonly args: readonly string[];
  readonly outputPath: string;
  readonly targetAspectRatio: "9:16" | "source";
  readonly burnCaptions: boolean;
}

export interface INeonTikTokPublishingGate {
  readonly mode: TNeonTikTokPostMode;
  readonly scope: TNeonTikTokApiScope;
  readonly ready: boolean;
  readonly missing: readonly string[];
}

export interface INeonTikTokDiscordVideoWorkflowInput {
  readonly attachment: INeonGatewayInboundAttachment;
  readonly caption?: string;
  readonly mode?: TNeonTikTokPostMode;
  readonly privacyLevel?: TNeonTikTokPrivacyLevel;
  readonly explicitConsent?: boolean;
  readonly verifiedPullUrl?: boolean;
  readonly edit?: Omit<INeonTikTokVideoEditPlanInput, "sourcePath" | "outputPath">;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface INeonTikTokWorkflowStep {
  readonly id: string;
  readonly label: string;
  readonly state: TNeonTikTokStepState;
  readonly detail: string;
}

export interface INeonTikTokDiscordVideoWorkflow {
  readonly state: TNeonTikTokWorkflowState;
  readonly mode: TNeonTikTokPostMode;
  readonly scope: TNeonTikTokApiScope;
  readonly transferMethod: TNeonTikTokTransferMethod;
  readonly attachmentName: string;
  readonly caption: string;
  readonly privacyLevel: TNeonTikTokPrivacyLevel;
  readonly editPlan: INeonTikTokVideoEditPlan;
  readonly gate: INeonTikTokPublishingGate;
  readonly blockers: readonly string[];
  readonly steps: readonly INeonTikTokWorkflowStep[];
}

export interface INeonTikTokPostInfo {
  readonly title?: string;
  readonly privacyLevel: TNeonTikTokPrivacyLevel;
  readonly disableDuet?: boolean;
  readonly disableComment?: boolean;
  readonly disableStitch?: boolean;
  readonly videoCoverTimestampMs?: number;
  readonly brandContentToggle?: boolean;
  readonly brandOrganicToggle?: boolean;
  readonly isAigc?: boolean;
}

export interface INeonTikTokFileUploadSourceInfo {
  readonly source: "FILE_UPLOAD";
  readonly videoSize: number;
  readonly chunkSize: number;
  readonly totalChunkCount: number;
}

export interface INeonTikTokPullFromUrlSourceInfo {
  readonly source: "PULL_FROM_URL";
  readonly videoUrl: string;
}

export type TNeonTikTokSourceInfo = INeonTikTokFileUploadSourceInfo | INeonTikTokPullFromUrlSourceInfo;

export interface INeonTikTokCreatorInfo {
  readonly creatorUsername: string;
  readonly creatorNickname?: string;
  readonly privacyLevelOptions: readonly TNeonTikTokPrivacyLevel[];
  readonly commentDisabled: boolean;
  readonly duetDisabled: boolean;
  readonly stitchDisabled: boolean;
  readonly maxVideoPostDurationSec?: number;
}

export interface INeonTikTokPublishInitData {
  readonly publishId: string;
  readonly uploadUrl?: string;
}

export type TNeonTikTokApiResult<TData> =
  | { readonly ok: true; readonly data: TData; readonly logId?: string }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly logId?: string };

export interface INeonTikTokApiRequestOptions {
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
}

export interface IQueryNeonTikTokCreatorInfoOptions extends INeonTikTokApiRequestOptions {}

export interface IInitializeNeonTikTokDirectPostOptions extends INeonTikTokApiRequestOptions {
  readonly postInfo: INeonTikTokPostInfo;
  readonly sourceInfo: TNeonTikTokSourceInfo;
}

export interface IInitializeNeonTikTokInboxUploadOptions extends INeonTikTokApiRequestOptions {
  readonly sourceInfo: TNeonTikTokSourceInfo;
}

export interface INeonTikTokUploadChunkInput {
  readonly uploadUrl: string;
  readonly chunk: Uint8Array;
  readonly firstByte: number;
  readonly totalBytes: number;
  readonly contentType: "video/mp4" | "video/quicktime" | "video/webm";
}

export interface INeonTikTokUploadChunkRequest {
  readonly url: string;
  readonly init: {
    readonly method: "PUT";
    readonly headers: Record<string, string>;
    readonly body: Uint8Array;
  };
}

const defaultCaption = "";
const defaultPrivacyLevel: TNeonTikTokPrivacyLevel = "SELF_ONLY";
const defaultEditedOutputPath = "state/gateway/tiktok-outbox/discord-video.mp4";
const defaultDownloadedSourcePath = "state/gateway/tiktok-inbox/discord-video-source.mp4";
const defaultChunkSizeBytes = 10_000_000;
export const NEON_TIKTOK_API_RESPONSE_MAX_BYTES = 64 * 1024;

export function resolveNeonTikTokPublishingGate(
  mode: TNeonTikTokPostMode,
  env: Readonly<Record<string, string | undefined>> = process.env,
  explicitConsent = false
): INeonTikTokPublishingGate {
  const scope: TNeonTikTokApiScope = mode === "direct-post" ? "video.publish" : "video.upload";
  const missing: string[] = [];

  if (!env["NEON_TIKTOK_ACCESS_TOKEN"]?.trim()) {
    missing.push("NEON_TIKTOK_ACCESS_TOKEN");
  }

  if (mode === "direct-post") {
    if (!isReadyLike(env["NEON_TIKTOK_DIRECT_POST_APPROVED"])) {
      missing.push("NEON_TIKTOK_DIRECT_POST_APPROVED=ready");
    }
    if (!isReadyLike(env["NEON_TIKTOK_USER_VIDEO_PUBLISH_AUTHORIZED"])) {
      missing.push("NEON_TIKTOK_USER_VIDEO_PUBLISH_AUTHORIZED=ready");
    }
    if (!explicitConsent) {
      missing.push("explicit creator consent for TikTok Direct Post");
    }
  } else {
    if (!isReadyLike(env["NEON_TIKTOK_UPLOAD_APPROVED"])) {
      missing.push("NEON_TIKTOK_UPLOAD_APPROVED=ready");
    }
    if (!isReadyLike(env["NEON_TIKTOK_USER_VIDEO_UPLOAD_AUTHORIZED"])) {
      missing.push("NEON_TIKTOK_USER_VIDEO_UPLOAD_AUTHORIZED=ready");
    }
  }

  return { mode, scope, ready: missing.length === 0, missing };
}

export function createNeonTikTokVideoEditPlan(input: INeonTikTokVideoEditPlanInput): INeonTikTokVideoEditPlan {
  const targetAspectRatio = input.targetAspectRatio ?? "9:16";
  const burnCaptions = input.burnCaptions ?? false;
  const args: string[] = ["-y"];

  if (typeof input.trimStartSeconds === "number" && Number.isFinite(input.trimStartSeconds) && input.trimStartSeconds > 0) {
    args.push("-ss", String(input.trimStartSeconds));
  }

  args.push("-i", input.sourcePath);

  if (typeof input.trimEndSeconds === "number" && Number.isFinite(input.trimEndSeconds) && input.trimEndSeconds > 0) {
    args.push("-to", String(input.trimEndSeconds));
  }

  if (targetAspectRatio === "9:16") {
    args.push(
      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p"
    );
  }

  args.push("-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart");

  if (burnCaptions) {
    args.push("-metadata", "neon_caption_burn_requested=true");
  }

  args.push(input.outputPath);
  return { tool: "ffmpeg", args, outputPath: input.outputPath, targetAspectRatio, burnCaptions };
}

export function createNeonDiscordTikTokVideoWorkflow(
  input: INeonTikTokDiscordVideoWorkflowInput
): INeonTikTokDiscordVideoWorkflow {
  const mode = input.mode ?? "direct-post";
  const gate = resolveNeonTikTokPublishingGate(mode, input.env, input.explicitConsent ?? false);
  const blockers = [...gate.missing];
  const isVideo = input.attachment.kind === "video";
  const hasRemoteUrl = input.attachment.url.trim().length > 0;
  const transferMethod: TNeonTikTokTransferMethod = input.verifiedPullUrl ? "PULL_FROM_URL" : "FILE_UPLOAD";

  if (!isVideo) {
    blockers.push("Discord attachment must be kind=video");
  }
  if (!hasRemoteUrl) {
    blockers.push("Discord attachment URL is missing");
  }
  if (mode === "direct-post" && transferMethod === "PULL_FROM_URL" && !input.verifiedPullUrl) {
    blockers.push("PULL_FROM_URL requires a TikTok-verified domain or URL prefix");
  }

  const editPlan = createNeonTikTokVideoEditPlan({
    sourcePath: defaultDownloadedSourcePath,
    outputPath: defaultEditedOutputPath,
    ...(input.edit ?? {})
  });

  const initDetail =
    mode === "direct-post"
      ? "Query creator info, render TikTok metadata/visibility options, then POST /v2/post/publish/video/init/."
      : "POST /v2/post/publish/inbox/video/init/; creator finishes from TikTok inbox notification.";

  const steps: INeonTikTokWorkflowStep[] = [
    {
      id: "discord-ingest",
      label: "Read Discord video attachment",
      state: isVideo && hasRemoteUrl ? "ready" : "blocked",
      detail: `${input.attachment.name} (${input.attachment.contentType ?? "unknown"})`
    },
    {
      id: "download",
      label: "Download Discord media into Neon staging",
      state: isVideo && hasRemoteUrl ? "planned" : "blocked",
      detail: "Discord CDN URLs are not assumed to be TikTok-verified; default path is local staging plus FILE_UPLOAD."
    },
    {
      id: "edit",
      label: "Cut/transcode TikTok-ready MP4",
      state: isVideo && hasRemoteUrl ? "planned" : "blocked",
      detail: `ffmpeg ${editPlan.args.join(" ")}`
    },
    {
      id: "creator-info",
      label: "Fetch TikTok creator posting constraints",
      state: mode === "direct-post" && gate.ready ? "planned" : mode === "direct-post" ? "blocked" : "ready",
      detail: mode === "direct-post" ? "Required before Direct Post so privacy/comment/duet/stitch UI matches TikTok." : "Not required for inbox upload."
    },
    {
      id: "init",
      label: "Initialize TikTok Content Posting API request",
      state: gate.ready && isVideo && hasRemoteUrl ? "planned" : "blocked",
      detail: initDetail
    },
    {
      id: "upload",
      label: "Upload edited video bytes",
      state: gate.ready && isVideo && hasRemoteUrl ? "planned" : "blocked",
      detail:
        transferMethod === "FILE_UPLOAD"
          ? "PUT chunks to TikTok upload_url using Content-Length and Content-Range."
          : "TikTok pulls from the verified video URL."
    }
  ];

  return {
    state: blockers.length === 0 ? "ready" : "blocked",
    mode,
    scope: gate.scope,
    transferMethod,
    attachmentName: input.attachment.name,
    caption: input.caption ?? defaultCaption,
    privacyLevel: input.privacyLevel ?? defaultPrivacyLevel,
    editPlan,
    gate,
    blockers,
    steps
  };
}

export function renderNeonTikTokDiscordVideoWorkflow(workflow: INeonTikTokDiscordVideoWorkflow): string {
  const lines = [
    `Neon TikTok Discord Video Pipeline: ${workflow.state}`,
    `Mode: ${workflow.mode}`,
    `Scope: ${workflow.scope}`,
    `Transfer: ${workflow.transferMethod}`,
    `Attachment: ${workflow.attachmentName}`,
    `Privacy: ${workflow.privacyLevel}`,
    `Caption chars: ${workflow.caption.length}`,
    "Steps:",
    ...workflow.steps.map((step) => `- ${step.id}: ${step.state} — ${step.detail}`)
  ];

  if (workflow.blockers.length > 0) {
    lines.push("Blockers:", ...workflow.blockers.map((blocker) => `- ${blocker}`));
  }

  lines.push(
    "Official API:",
    `- ${NEON_TIKTOK_OFFICIAL_DOCS.contentPostingGetStarted}`,
    `- ${workflow.mode === "direct-post" ? NEON_TIKTOK_OFFICIAL_DOCS.directPost : NEON_TIKTOK_OFFICIAL_DOCS.uploadVideo}`,
    "No TikTok request was made by this planner."
  );

  return lines.join("\n");
}

export async function queryNeonTikTokCreatorInfo(
  options: IQueryNeonTikTokCreatorInfoOptions
): Promise<TNeonTikTokApiResult<INeonTikTokCreatorInfo>> {
  const result = await postTikTokJson(
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    options.accessToken,
    undefined,
    options.fetchImpl
  );
  if (!result.ok) {
    return result;
  }

  const data = asRecord(result.data);
  const privacyLevelOptions = parsePrivacyOptions(data["privacy_level_options"]);
  const creatorUsername = typeof data["creator_username"] === "string" ? data["creator_username"] : "";
  return {
    ok: true,
    data: {
      creatorUsername,
      ...(typeof data["creator_nickname"] === "string" ? { creatorNickname: data["creator_nickname"] } : {}),
      privacyLevelOptions,
      commentDisabled: data["comment_disabled"] === true,
      duetDisabled: data["duet_disabled"] === true,
      stitchDisabled: data["stitch_disabled"] === true,
      ...(typeof data["max_video_post_duration_sec"] === "number"
        ? { maxVideoPostDurationSec: data["max_video_post_duration_sec"] }
        : {})
    },
    ...(result.logId ? { logId: result.logId } : {})
  };
}

export async function initializeNeonTikTokDirectPost(
  options: IInitializeNeonTikTokDirectPostOptions
): Promise<TNeonTikTokApiResult<INeonTikTokPublishInitData>> {
  const result = await postTikTokJson(
    "https://open.tiktokapis.com/v2/post/publish/video/init/",
    options.accessToken,
    {
      post_info: buildTikTokPostInfoBody(options.postInfo),
      source_info: buildTikTokSourceInfoBody(options.sourceInfo)
    },
    options.fetchImpl
  );
  return mapPublishInitResult(result);
}

export async function initializeNeonTikTokInboxVideoUpload(
  options: IInitializeNeonTikTokInboxUploadOptions
): Promise<TNeonTikTokApiResult<INeonTikTokPublishInitData>> {
  const result = await postTikTokJson(
    "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
    options.accessToken,
    {
      source_info: buildTikTokSourceInfoBody(options.sourceInfo)
    },
    options.fetchImpl
  );
  return mapPublishInitResult(result);
}

export function createNeonTikTokUploadChunkRequest(
  input: INeonTikTokUploadChunkInput
): INeonTikTokUploadChunkRequest {
  if (input.firstByte < 0 || input.totalBytes <= 0 || input.chunk.byteLength === 0) {
    throw new Error("TikTok upload chunk requires positive byte bounds and non-empty chunk data.");
  }
  const lastByte = input.firstByte + input.chunk.byteLength - 1;
  if (lastByte >= input.totalBytes) {
    throw new Error("TikTok upload chunk exceeds total byte length.");
  }

  return {
    url: input.uploadUrl,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": input.contentType,
        "Content-Length": String(input.chunk.byteLength),
        "Content-Range": `bytes ${input.firstByte}-${lastByte}/${input.totalBytes}`
      },
      body: input.chunk
    }
  };
}

export function createNeonTikTokFileUploadSourceInfo(videoSize: number): INeonTikTokFileUploadSourceInfo {
  if (!Number.isFinite(videoSize) || videoSize <= 0) {
    throw new Error("TikTok FILE_UPLOAD source requires a positive video size.");
  }

  const chunkSize = Math.min(videoSize, defaultChunkSizeBytes);
  return {
    source: "FILE_UPLOAD",
    videoSize,
    chunkSize,
    totalChunkCount: Math.ceil(videoSize / chunkSize)
  };
}

async function postTikTokJson(
  url: string,
  accessToken: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<TNeonTikTokApiResult<unknown>> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    }
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetchImpl(url, init);
  const responseBody = await readTikTokResponseTextLimited(response, NEON_TIKTOK_API_RESPONSE_MAX_BYTES);
  if (responseBody.state === "oversize") {
    return {
      ok: false,
      status: response.status,
      code: "response-too-large",
      message: `TikTok API response exceeded ${NEON_TIKTOK_API_RESPONSE_MAX_BYTES} bytes`
    };
  }

  const payload = parseTikTokJson(responseBody.text);
  if (!isRecord(payload)) {
    return {
      ok: false,
      status: response.status,
      code: "malformed-json",
      message: "TikTok API returned malformed JSON"
    };
  }

  const payloadRecord = asRecord(payload);
  const error = asRecord(payloadRecord["error"]);
  const code = typeof error["code"] === "string" ? error["code"] : response.ok ? "ok" : "unknown";
  const message = typeof error["message"] === "string" ? error["message"] : "";
  const logId = typeof error["log_id"] === "string" ? error["log_id"] : undefined;

  if (!response.ok || code !== "ok") {
    return {
      ok: false,
      status: response.status,
      code,
      message,
      ...(logId ? { logId } : {})
    };
  }

  return { ok: true, data: payloadRecord["data"], ...(logId ? { logId } : {}) };
}

async function readTikTokResponseTextLimited(
  response: Response,
  maxBytes: number
): Promise<{ readonly state: "ok"; readonly text: string } | { readonly state: "oversize" }> {
  const body = response.body;
  if (!body) {
    return { state: "ok", text: "" };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { state: "oversize" };
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  return { state: "ok", text: new TextDecoder().decode(concatUint8Arrays(chunks, totalBytes)) };
}

function concatUint8Arrays(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseTikTokJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function mapPublishInitResult(
  result: TNeonTikTokApiResult<unknown>
): TNeonTikTokApiResult<INeonTikTokPublishInitData> {
  if (!result.ok) {
    return result;
  }

  const data = asRecord(result.data);
  const publishId = typeof data["publish_id"] === "string" ? data["publish_id"] : "";
  const uploadUrl = typeof data["upload_url"] === "string" ? data["upload_url"] : undefined;
  return {
    ok: true,
    data: {
      publishId,
      ...(uploadUrl ? { uploadUrl } : {})
    },
    ...(result.logId ? { logId: result.logId } : {})
  };
}

function buildTikTokPostInfoBody(postInfo: INeonTikTokPostInfo): Record<string, unknown> {
  return stripUndefined({
    title: postInfo.title,
    privacy_level: postInfo.privacyLevel,
    disable_duet: postInfo.disableDuet,
    disable_comment: postInfo.disableComment,
    disable_stitch: postInfo.disableStitch,
    video_cover_timestamp_ms: postInfo.videoCoverTimestampMs,
    brand_content_toggle: postInfo.brandContentToggle ?? false,
    brand_organic_toggle: postInfo.brandOrganicToggle ?? false,
    is_aigc: postInfo.isAigc
  });
}

function buildTikTokSourceInfoBody(sourceInfo: TNeonTikTokSourceInfo): Record<string, unknown> {
  if (sourceInfo.source === "PULL_FROM_URL") {
    return {
      source: sourceInfo.source,
      video_url: sourceInfo.videoUrl
    };
  }
  return {
    source: sourceInfo.source,
    video_size: sourceInfo.videoSize,
    chunk_size: sourceInfo.chunkSize,
    total_chunk_count: sourceInfo.totalChunkCount
  };
}

function parsePrivacyOptions(value: unknown): readonly TNeonTikTokPrivacyLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isTikTokPrivacyLevel);
}

function isTikTokPrivacyLevel(value: unknown): value is TNeonTikTokPrivacyLevel {
  return (
    value === "PUBLIC_TO_EVERYONE" ||
    value === "MUTUAL_FOLLOW_FRIENDS" ||
    value === "FOLLOWER_OF_CREATOR" ||
    value === "SELF_ONLY"
  );
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isReadyLike(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "ready" || normalized === "on" || normalized === "1" || normalized === "true";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
