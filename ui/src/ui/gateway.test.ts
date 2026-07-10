import { afterEach, describe, expect, it, vi } from "vitest";
import { NeonApiError, NeonControlClient } from "./gateway.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NeonControlClient", () => {
  it("GETs Workboard cards from /api/workboard/cards", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          cards: [{ id: "card-1", title: "Card", status: "ready", priority: "normal", labels: [], updatedAt: 1 }],
          statuses: ["ready", "done"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new NeonControlClient();
    const result = await client.workboardCards<{ readonly cards: readonly { readonly id: string }[] }>();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/workboard/cards");
    expect(result.cards[0]?.id).toBe("card-1");
  });

  it("POSTs the chat send to /api/neon-chat/send and returns the parsed result", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          state: "accepted",
          chat: {
            state: "queued-dry-run",
            runId: "run-1",
            candidateId: "cand-1",
            outboundSent: false,
            deliveryState: "suppressed",
            candidateVisibleInQueue: true,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new NeonControlClient();
    const result = await client.postChatSend({ channelId: "C1", text: "hello" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/neon-chat/send");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ channelId: "C1", text: "hello" });
    expect(result.chat.state).toBe("queued-dry-run");
    expect(result.chat.outboundSent).toBe(false);
  });

  it("throws a NeonApiError on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid-chat-send" }), { status: 400 })),
    );

    const client = new NeonControlClient();
    await expect(client.postChatSend({ channelId: "C1", text: "" })).rejects.toBeInstanceOf(NeonApiError);
  });
});
