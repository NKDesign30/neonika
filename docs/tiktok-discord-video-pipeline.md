# Discord to TikTok Video Pipeline

## Official Surface

TikTok has an official Content Posting API:

- Direct Post: `/v2/post/publish/video/init/`, scope `video.publish`.
- Inbox Upload: `/v2/post/publish/inbox/video/init/`, scope `video.upload`.
- Creator info must be queried before Direct Post so the app renders TikTok's current privacy/comment/duet/stitch options.
- `FILE_UPLOAD` returns an `upload_url`; Neon must upload video chunks with `Content-Length` and `Content-Range`.
- `PULL_FROM_URL` requires a TikTok-verified domain or URL prefix, so Discord CDN URLs are not treated as directly postable.

Sources:

- https://developers.tiktok.com/doc/content-posting-api-get-started
- https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- https://developers.tiktok.com/doc/content-posting-api-reference-upload-video

## Neonika Flow

1. Discord message contains a video attachment.
2. Neon stages the Discord media locally.
3. Neon creates an `ffmpeg` cut/transcode plan for TikTok-ready MP4.
4. Neon queries TikTok creator info for Direct Post.
5. Neon initializes Direct Post or Inbox Upload through TikTok's API.
6. Neon uploads edited bytes to TikTok's `upload_url`.

Live upload remains gated by TikTok app approval, user OAuth scope, access token presence, and explicit creator consent for Direct Post.
