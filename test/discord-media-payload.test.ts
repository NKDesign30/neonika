import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Client } from "discord.js";

import {
  buildNeonDiscordMediaPayload,
  classifyNeonDiscordMediaKind,
  createNeonDiscordOutboundTransport,
  fetchNeonMediaBuffer,
  isNeonDiscordVideoMedia,
  NEON_DISCORD_MEDIA_LIMITS,
  type INeonMediaFetchResponse,
  type INeonDeliveryQueueTarget,
  type TNeonDiscordMediaAttachment
} from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-123"
};

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(65);

describe("buildNeonDiscordMediaPayload (Z324)", () => {
  it("accepts an inline attachment and classifies it", () => {
    const result = buildNeonDiscordMediaPayload([
      { name: "report.txt", data: new TextEncoder().encode("hi"), contentType: "text/plain" }
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0]?.kind, "inline");
      assert.equal(result.attachments[0]?.name, "report.txt");
    }
  });

  it("accepts a public url attachment via the SSRF guard", () => {
    const result = buildNeonDiscordMediaPayload([{ name: "pic.png", url: "https://example.com/a.png" }]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const att = result.attachments[0];
      assert.equal(att?.kind, "url");
      if (att?.kind === "url") {
        assert.equal(att.host, "example.com");
      }
    }
  });

  it("rejects an empty list, too many attachments, empty data, and oversize data", () => {
    assert.equal(buildNeonDiscordMediaPayload([]).ok, false);

    const tooMany: TNeonDiscordMediaAttachment[] = Array.from(
      { length: NEON_DISCORD_MEDIA_LIMITS.maxAttachments + 1 },
      (_unused, index) => ({ name: `f${index}.bin`, data: bytes(2) })
    );
    assert.equal(buildNeonDiscordMediaPayload(tooMany).ok, false);

    assert.equal(buildNeonDiscordMediaPayload([{ name: "empty.bin", data: bytes(0) }]).ok, false);

    const oversize = buildNeonDiscordMediaPayload([{ name: "big.bin", data: bytes(2048) }], { maxFileBytes: 1024 });
    assert.equal(oversize.ok, false);
  });

  it("rejects unsafe filenames (path separators and traversal)", () => {
    assert.equal(buildNeonDiscordMediaPayload([{ name: "../escape.txt", data: bytes(2) }]).ok, false);
    assert.equal(buildNeonDiscordMediaPayload([{ name: "a/b.txt", data: bytes(2) }]).ok, false);
    assert.equal(buildNeonDiscordMediaPayload([{ name: "   ", data: bytes(2) }]).ok, false);
  });

  it("rejects SSRF-blocked url sources (loopback, private, link-local) and bad MIME", () => {
    assert.equal(buildNeonDiscordMediaPayload([{ name: "x.png", url: "http://localhost/a" }]).ok, false);
    assert.equal(buildNeonDiscordMediaPayload([{ name: "x.png", url: "http://127.0.0.1/a" }]).ok, false);
    assert.equal(buildNeonDiscordMediaPayload([{ name: "x.png", url: "http://169.254.169.254/latest" }]).ok, false);
    assert.equal(buildNeonDiscordMediaPayload([{ name: "x.png", url: "ftp://example.com/a" }]).ok, false);
    assert.equal(
      buildNeonDiscordMediaPayload([{ name: "x.png", data: bytes(2), contentType: "not-a-mime" }]).ok,
      false
    );
  });

  it("collects every validation error at once (bad name + oversize)", () => {
    const result = buildNeonDiscordMediaPayload([{ name: "a/b.txt", data: bytes(4096) }], { maxFileBytes: 1024 });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length >= 2, "expected filename and size errors");
    }
  });
});

describe("fetchNeonMediaBuffer (Z324, SSRF re-check + size cap)", () => {
  it("fetches bytes when the resolved IP is public", async () => {
    const buffer = await fetchNeonMediaBuffer("https://example.com/a.png", "example.com", {
      lookupImpl: async () => ["93.184.216.34"],
      fetchImpl: async (): Promise<INeonMediaFetchResponse> => ({
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
      })
    });
    assert.equal(buffer.byteLength, 3);
  });

  it("throws when a public host resolves to a private IP (DNS rebind)", async () => {
    await assert.rejects(
      () =>
        fetchNeonMediaBuffer("https://evil.example/a.png", "evil.example", {
          lookupImpl: async () => ["127.0.0.1"],
          fetchImpl: async (): Promise<INeonMediaFetchResponse> => ({
            status: 200,
            arrayBuffer: async () => new Uint8Array([1]).buffer
          })
        }),
      /resolved to blocked/i
    );
  });

  it("throws when the downloaded body exceeds the size cap", async () => {
    await assert.rejects(
      () =>
        fetchNeonMediaBuffer("https://example.com/big", "example.com", {
          maxFileBytes: 4,
          lookupImpl: async () => ["93.184.216.34"],
          fetchImpl: async (): Promise<INeonMediaFetchResponse> => ({
            status: 200,
            arrayBuffer: async () => new Uint8Array(16).buffer
          })
        }),
      /over the .* cap/i
    );
  });

  it("refuses a declared over-cap content-length BEFORE reading the body", async () => {
    let bodyRead = false;
    await assert.rejects(
      () =>
        fetchNeonMediaBuffer("https://example.com/huge", "example.com", {
          maxFileBytes: 8,
          lookupImpl: async () => ["93.184.216.34"],
          fetchImpl: async (): Promise<INeonMediaFetchResponse> => ({
            status: 200,
            contentLength: 1024,
            arrayBuffer: async () => {
              bodyRead = true;
              return new Uint8Array(1024).buffer;
            }
          })
        }),
      /declared .* over the .* cap/i
    );
    assert.equal(bodyRead, false, "body must not be read once content-length exceeds the cap");
  });

  it("aborts streamed downloads once the body exceeds the size cap", async () => {
    let arrayBufferRead = false;
    await assert.rejects(
      () =>
        fetchNeonMediaBuffer("https://example.com/stream", "example.com", {
          maxFileBytes: 8,
          lookupImpl: async () => ["93.184.216.34"],
          fetchImpl: async (): Promise<INeonMediaFetchResponse> => ({
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                controller.enqueue(new Uint8Array([5, 6, 7, 8, 9]));
                controller.close();
              }
            }),
            arrayBuffer: async () => {
              arrayBufferRead = true;
              return new Uint8Array(9).buffer;
            }
          })
        }),
      /exceeded the 8-byte cap/i
    );
    assert.equal(arrayBufferRead, false, "streamed responses must not fall back to arrayBuffer");
  });
});

interface IFakeMediaState {
  loginCount: number;
  sent: { readonly content?: string; readonly fileCount: number; readonly firstName?: string }[];
  sendCount: number;
}

function createFakeMediaClient(): { readonly client: Client; readonly state: IFakeMediaState } {
  const state: IFakeMediaState = { loginCount: 0, sent: [], sendCount: 0 };
  const channel = {
    isSendable: () => true,
    send: async (payload: { content?: string; files?: readonly { readonly name: string }[] }) => {
      state.sendCount += 1;
      const first = payload.files?.[0]?.name;
      state.sent.push({
        ...(payload.content !== undefined ? { content: payload.content } : {}),
        fileCount: payload.files?.length ?? 0,
        ...(first !== undefined ? { firstName: first } : {})
      });
      return { id: `discord-message-${state.sendCount}` };
    }
  };
  const fake = {
    login: async (token: string) => {
      state.loginCount += 1;
      return token;
    },
    channels: { fetch: async (_id: string) => channel },
    destroy: async () => {}
  };
  return { client: fake as unknown as Client, state };
}

describe("transport.postMedia (Z324, gated)", () => {
  it("uploads an inline attachment via the injected client and returns the message id", async () => {
    const { client, state } = createFakeMediaClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    const result = await transport.postMedia(TARGET, "here you go", [
      { name: "out.txt", data: new TextEncoder().encode("payload") }
    ]);
    assert.equal(result.messageId, "discord-message-1");
    assert.equal(state.loginCount, 1);
    assert.equal(state.sent[0]?.fileCount, 1);
    assert.equal(state.sent[0]?.firstName, "out.txt");
    assert.equal(state.sent[0]?.content, "here you go");
    await transport.close();
  });

  it("fetches a url attachment itself (SSRF-guarded) and uploads the bytes", async () => {
    const { client, state } = createFakeMediaClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    const result = await transport.postMedia(TARGET, undefined, [{ name: "remote.png", url: "https://example.com/a.png" }], {
      lookupImpl: async () => ["93.184.216.34"],
      fetchImpl: async (): Promise<INeonMediaFetchResponse> => ({
        status: 200,
        arrayBuffer: async () => new Uint8Array([9, 8, 7, 6]).buffer
      })
    });
    assert.equal(result.messageId, "discord-message-1");
    assert.equal(state.sent[0]?.fileCount, 1);
    assert.equal(state.sent[0]?.firstName, "remote.png");
    assert.equal(state.sent[0]?.content, undefined);
    await transport.close();
  });

  it("rejects an invalid attachment BEFORE login, so nothing leaves suppressed", async () => {
    const { client, state } = createFakeMediaClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    await assert.rejects(
      () => transport.postMedia(TARGET, "x", [{ name: "../escape", data: new Uint8Array([1]) }]),
      /invalid media/i
    );
    assert.equal(state.loginCount, 0);
    assert.equal(state.sent.length, 0);
    await transport.close();
  });
});

describe("classifyNeonDiscordMediaKind", () => {
  it("classifies by MIME type first", () => {
    assert.equal(classifyNeonDiscordMediaKind("file.bin", "video/mp4"), "video");
    assert.equal(classifyNeonDiscordMediaKind("file.bin", "image/png"), "image");
    assert.equal(classifyNeonDiscordMediaKind("file.bin", "audio/mpeg"), "audio");
  });

  it("falls back to the extension when no MIME is given", () => {
    assert.equal(classifyNeonDiscordMediaKind("clip.MP4"), "video");
    assert.equal(classifyNeonDiscordMediaKind("pic.jpeg"), "image");
    assert.equal(classifyNeonDiscordMediaKind("song.flac"), "audio");
  });

  it("returns file for unknown, hidden, or extension-less names", () => {
    assert.equal(classifyNeonDiscordMediaKind("archive.zip"), "file");
    assert.equal(classifyNeonDiscordMediaKind("README"), "file");
    assert.equal(classifyNeonDiscordMediaKind(".env"), "file");
    assert.equal(classifyNeonDiscordMediaKind("trailingdot."), "file");
  });

  it("isNeonDiscordVideoMedia is true only for video", () => {
    assert.equal(isNeonDiscordVideoMedia("clip.mov"), true);
    assert.equal(isNeonDiscordVideoMedia("pic.png"), false);
    assert.equal(isNeonDiscordVideoMedia("file.bin", "video/webm"), true);
  });
});
