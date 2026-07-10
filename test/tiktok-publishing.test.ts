import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonDiscordTikTokVideoWorkflow,
  createNeonTikTokFileUploadSourceInfo,
  createNeonTikTokUploadChunkRequest,
  createNeonTikTokVideoEditPlan,
  initializeNeonTikTokDirectPost,
  initializeNeonTikTokInboxVideoUpload,
  NEON_TIKTOK_API_RESPONSE_MAX_BYTES,
  queryNeonTikTokCreatorInfo,
  renderNeonTikTokDiscordVideoWorkflow
} from "../src/index.js";
import type { INeonGatewayInboundAttachment } from "../src/gateway/types.js";

const videoAttachment: INeonGatewayInboundAttachment = {
  id: "discord-video-1",
  name: "launch.mp4",
  url: "https://cdn.discordapp.com/attachments/channel/message/launch.mp4",
  contentType: "video/mp4",
  sizeBytes: 8_000_000,
  kind: "video"
};

describe("TikTok Discord video workflow", () => {
  it("blocks Direct Post until TikTok app approval, user scope, token, and explicit consent exist", () => {
    const workflow = createNeonDiscordTikTokVideoWorkflow({
      attachment: videoAttachment,
      caption: "Launch clip #neon",
      mode: "direct-post",
      env: {}
    });

    assert.equal(workflow.state, "blocked");
    assert.equal(workflow.scope, "video.publish");
    assert.equal(workflow.transferMethod, "FILE_UPLOAD");
    assert.deepEqual(workflow.blockers, [
      "NEON_TIKTOK_ACCESS_TOKEN",
      "NEON_TIKTOK_DIRECT_POST_APPROVED=ready",
      "NEON_TIKTOK_USER_VIDEO_PUBLISH_AUTHORIZED=ready",
      "explicit creator consent for TikTok Direct Post"
    ]);
    assert.match(renderNeonTikTokDiscordVideoWorkflow(workflow), /No TikTok request was made/u);
  });

  it("plans a ready Direct Post pipeline without leaking the access token", () => {
    const workflow = createNeonDiscordTikTokVideoWorkflow({
      attachment: videoAttachment,
      caption: "Launch clip #neon",
      mode: "direct-post",
      explicitConsent: true,
      env: {
        NEON_TIKTOK_ACCESS_TOKEN: "secret-token-value",
        NEON_TIKTOK_DIRECT_POST_APPROVED: "ready",
        NEON_TIKTOK_USER_VIDEO_PUBLISH_AUTHORIZED: "ready"
      }
    });

    const rendered = renderNeonTikTokDiscordVideoWorkflow(workflow);
    assert.equal(workflow.state, "ready");
    assert.equal(workflow.blockers.length, 0);
    assert.match(rendered, /POST \/v2\/post\/publish\/video\/init/u);
    assert.doesNotMatch(rendered, /secret-token-value/u);
  });

  it("models inbox upload as video.upload with manual TikTok completion", () => {
    const workflow = createNeonDiscordTikTokVideoWorkflow({
      attachment: videoAttachment,
      mode: "inbox-upload",
      env: {
        NEON_TIKTOK_ACCESS_TOKEN: "secret-token-value",
        NEON_TIKTOK_UPLOAD_APPROVED: "ready",
        NEON_TIKTOK_USER_VIDEO_UPLOAD_AUTHORIZED: "ready"
      }
    });

    assert.equal(workflow.state, "ready");
    assert.equal(workflow.scope, "video.upload");
    assert.match(workflow.steps.find((step) => step.id === "init")?.detail ?? "", /inbox\/video\/init/u);
    assert.match(workflow.steps.find((step) => step.id === "creator-info")?.detail ?? "", /Not required/u);
  });

  it("creates a deterministic ffmpeg edit plan for TikTok vertical video", () => {
    const plan = createNeonTikTokVideoEditPlan({
      sourcePath: "in.mp4",
      outputPath: "out.mp4",
      trimStartSeconds: 1,
      trimEndSeconds: 29,
      burnCaptions: true
    });

    assert.equal(plan.tool, "ffmpeg");
    assert.deepEqual(plan.args.slice(0, 6), ["-y", "-ss", "1", "-i", "in.mp4", "-to"]);
    assert.ok(plan.args.includes("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p"));
    assert.ok(plan.args.includes("neon_caption_burn_requested=true"));
  });
});

describe("TikTok Content Posting API client", () => {
  it("queries creator info through the official endpoint", async () => {
    let requestUrl = "";
    let authHeader = "";
    const result = await queryNeonTikTokCreatorInfo({
      accessToken: "secret-token-value",
      fetchImpl: async (url, init) => {
        assert.ok(init);
        requestUrl = String(url);
        authHeader = new Headers(init.headers).get("Authorization") ?? "";
        return new Response(
          JSON.stringify({
            data: {
              creator_username: "operator",
              creator_nickname: "Operator",
              privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"],
              comment_disabled: false,
              duet_disabled: true,
              stitch_disabled: false,
              max_video_post_duration_sec: 300
            },
            error: { code: "ok", message: "", log_id: "log-1" }
          }),
          { status: 200 }
        );
      }
    });

    assert.equal(requestUrl, "https://open.tiktokapis.com/v2/post/publish/creator_info/query/");
    assert.equal(authHeader, "Bearer secret-token-value");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.creatorUsername, "operator");
      assert.deepEqual(result.data.privacyLevelOptions, ["SELF_ONLY", "PUBLIC_TO_EVERYONE"]);
    }
  });

  it("initializes Direct Post with post_info and FILE_UPLOAD source_info", async () => {
    let requestBody = "";
    const result = await initializeNeonTikTokDirectPost({
      accessToken: "secret-token-value",
      postInfo: {
        title: "Launch #neon",
        privacyLevel: "SELF_ONLY",
        disableComment: true,
        isAigc: true
      },
      sourceInfo: createNeonTikTokFileUploadSourceInfo(25_000_000),
      fetchImpl: async (_url, init) => {
        assert.ok(init);
        requestBody = String(init.body);
        return new Response(
          JSON.stringify({
            data: { publish_id: "v_pub_file~v2.123", upload_url: "https://open-upload.tiktokapis.com/video/?upload_id=1" },
            error: { code: "ok", message: "", log_id: "log-2" }
          }),
          { status: 200 }
        );
      }
    });

    assert.match(requestBody, /"privacy_level":"SELF_ONLY"/u);
    assert.match(requestBody, /"source":"FILE_UPLOAD"/u);
    assert.match(requestBody, /"brand_content_toggle":false/u);
    assert.match(requestBody, /"brand_organic_toggle":false/u);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.publishId, "v_pub_file~v2.123");
      assert.match(result.data.uploadUrl ?? "", /^https:\/\/open-upload\.tiktokapis\.com/u);
    }
  });

  it("initializes inbox upload with video.upload shape", async () => {
    let requestUrl = "";
    const result = await initializeNeonTikTokInboxVideoUpload({
      accessToken: "secret-token-value",
      sourceInfo: { source: "PULL_FROM_URL", videoUrl: "https://videos.example.com/clip.mp4" },
      fetchImpl: async (url) => {
        requestUrl = String(url);
        return new Response(
          JSON.stringify({
            data: { publish_id: "v_inbox_url~v2.456" },
            error: { code: "ok", message: "", log_id: "log-3" }
          }),
          { status: 200 }
        );
      }
    });

    assert.equal(requestUrl, "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.publishId, "v_inbox_url~v2.456");
    }
  });

  it("bounds TikTok API responses without using Response.json", async () => {
    let jsonCalled = false;
    const response = new Response("x".repeat(NEON_TIKTOK_API_RESPONSE_MAX_BYTES + 1), { status: 500 });
    Object.defineProperty(response, "json", {
      value: () => {
        jsonCalled = true;
        return Promise.reject(new Error("unexpected Response.json call"));
      }
    });

    const result = await queryNeonTikTokCreatorInfo({
      accessToken: "secret-token-value",
      fetchImpl: async () => response
    });

    assert.equal(jsonCalled, false);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 500);
      assert.equal(result.code, "response-too-large");
      assert.match(result.message, /exceeded/u);
    }
  });

  it("returns a fail-closed API result for malformed TikTok JSON", async () => {
    const result = await initializeNeonTikTokDirectPost({
      accessToken: "secret-token-value",
      postInfo: {
        title: "Launch #neon",
        privacyLevel: "SELF_ONLY"
      },
      sourceInfo: createNeonTikTokFileUploadSourceInfo(25_000_000),
      fetchImpl: async () => new Response("{", { status: 502 })
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 502);
      assert.equal(result.code, "malformed-json");
      assert.equal(result.message, "TikTok API returned malformed JSON");
    }
  });

  it("builds the exact PUT chunk headers TikTok expects", () => {
    const request = createNeonTikTokUploadChunkRequest({
      uploadUrl: "https://open-upload.tiktokapis.com/video/?upload_id=1&upload_token=2",
      chunk: new Uint8Array([1, 2, 3, 4]),
      firstByte: 10,
      totalBytes: 20,
      contentType: "video/mp4"
    });

    assert.equal(request.init.method, "PUT");
    assert.equal(request.init.headers["Content-Type"], "video/mp4");
    assert.equal(request.init.headers["Content-Length"], "4");
    assert.equal(request.init.headers["Content-Range"], "bytes 10-13/20");
  });

  it("refuses a zero-byte FILE_UPLOAD source", () => {
    assert.throws(() => createNeonTikTokFileUploadSourceInfo(0), /positive video size/u);
  });
});
