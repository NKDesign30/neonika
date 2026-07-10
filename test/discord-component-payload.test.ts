import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ButtonStyle, ComponentType, type Client } from "discord.js";

import {
  buildNeonDiscordComponentPayload,
  createNeonDiscordOutboundTransport,
  NEON_DISCORD_COMPONENT_LIMITS,
  type INeonDeliveryQueueTarget,
  type TNeonDiscordActionRow
} from "../src/index.js";

const TARGET: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "acct-1",
  channelId: "channel-123"
};

describe("buildNeonDiscordComponentPayload (Z321)", () => {
  it("builds a valid button action row with style + customId", () => {
    const result = buildNeonDiscordComponentPayload([
      {
        buttons: [
          { label: "Approve", style: "success", customId: "approve" },
          { label: "Docs", style: "link", url: "https://example.com/docs" }
        ]
      }
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.components.length, 1);
      assert.equal(result.components[0]?.type, ComponentType.ActionRow);
      const buttons = result.components[0]?.components ?? [];
      assert.equal(buttons.length, 2);
      const approve = buttons[0];
      assert.equal(approve?.type, ComponentType.Button);
      if (approve?.type === ComponentType.Button && "custom_id" in approve) {
        assert.equal(approve.custom_id, "approve");
        assert.equal(approve.style, ButtonStyle.Success);
      }
      const link = buttons[1];
      if (link?.type === ComponentType.Button && "url" in link) {
        assert.equal(link.url, "https://example.com/docs");
        assert.equal(link.style, ButtonStyle.Link);
      }
    }
  });

  it("builds a valid string-select action row", () => {
    const result = buildNeonDiscordComponentPayload([
      {
        select: {
          customId: "pick",
          placeholder: "Choose one",
          options: [
            { label: "Alpha", value: "a" },
            { label: "Beta", value: "b", description: "second" }
          ]
        }
      }
    ]);
    assert.equal(result.ok, true);
    if (result.ok) {
      const select = result.components[0]?.components[0];
      assert.equal(select?.type, ComponentType.StringSelect);
      if (select?.type === ComponentType.StringSelect) {
        assert.equal(select.custom_id, "pick");
        assert.equal(select.options.length, 2);
        assert.equal(select.placeholder, "Choose one");
      }
    }
  });

  it("rejects an empty row list and a button row with no buttons", () => {
    assert.equal(buildNeonDiscordComponentPayload([]).ok, false);
    assert.equal(buildNeonDiscordComponentPayload([{ buttons: [] }]).ok, false);
  });

  it("rejects too many rows and too many buttons per row", () => {
    const tooManyRows: TNeonDiscordActionRow[] = Array.from(
      { length: NEON_DISCORD_COMPONENT_LIMITS.rowsPerMessage + 1 },
      (_unused, index) => ({ buttons: [{ label: "b", style: "secondary", customId: `c${index}` }] })
    );
    assert.equal(buildNeonDiscordComponentPayload(tooManyRows).ok, false);

    const tooManyButtons: TNeonDiscordActionRow = {
      buttons: Array.from({ length: NEON_DISCORD_COMPONENT_LIMITS.buttonsPerRow + 1 }, (_unused, index) => ({
        label: `b${index}`,
        style: "secondary" as const,
        customId: `c${index}`
      }))
    };
    assert.equal(buildNeonDiscordComponentPayload([tooManyButtons]).ok, false);
  });

  it("rejects an over-limit label and customId", () => {
    const longLabel = "x".repeat(NEON_DISCORD_COMPONENT_LIMITS.buttonLabel + 1);
    assert.equal(
      buildNeonDiscordComponentPayload([{ buttons: [{ label: longLabel, style: "primary", customId: "c" }] }]).ok,
      false
    );
    const longId = "x".repeat(NEON_DISCORD_COMPONENT_LIMITS.customId + 1);
    assert.equal(
      buildNeonDiscordComponentPayload([{ buttons: [{ label: "ok", style: "primary", customId: longId }] }]).ok,
      false
    );
  });

  it("enforces the link vs custom-id contract (mutually exclusive)", () => {
    // Link button missing its url.
    assert.equal(buildNeonDiscordComponentPayload([{ buttons: [{ label: "L", style: "link" }] }]).ok, false);
    // Link button must not carry a customId.
    assert.equal(
      buildNeonDiscordComponentPayload([
        { buttons: [{ label: "L", style: "link", url: "https://x.dev", customId: "nope" }] }
      ]).ok,
      false
    );
    // Non-link button requires a customId.
    assert.equal(buildNeonDiscordComponentPayload([{ buttons: [{ label: "B", style: "primary" }] }]).ok, false);
    // Non-link button must not carry a url.
    assert.equal(
      buildNeonDiscordComponentPayload([{ buttons: [{ label: "B", style: "primary", customId: "c", url: "https://x.dev" }] }])
        .ok,
      false
    );
  });

  it("rejects select menus with no options, too many options, and maxValues over the option count", () => {
    assert.equal(buildNeonDiscordComponentPayload([{ select: { customId: "s", options: [] } }]).ok, false);

    const tooManyOptions = Array.from({ length: NEON_DISCORD_COMPONENT_LIMITS.selectOptions + 1 }, (_unused, index) => ({
      label: `o${index}`,
      value: `v${index}`
    }));
    assert.equal(buildNeonDiscordComponentPayload([{ select: { customId: "s", options: tooManyOptions } }]).ok, false);

    const overMax = buildNeonDiscordComponentPayload([
      { select: { customId: "s", options: [{ label: "a", value: "a" }], maxValues: 5 } }
    ]);
    assert.equal(overMax.ok, false);
  });

  it("collects every validation error at once (link button with customId AND no url)", () => {
    const result = buildNeonDiscordComponentPayload([{ buttons: [{ label: "L", style: "link", customId: "x" }] }]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.length >= 2, "expected both the customId and missing-url errors");
    }
  });
});

interface IFakeComponentState {
  loginCount: number;
  sent: { readonly content?: string; readonly componentRows: number }[];
  sendCount: number;
}

function createFakeComponentClient(): { readonly client: Client; readonly state: IFakeComponentState } {
  const state: IFakeComponentState = { loginCount: 0, sent: [], sendCount: 0 };
  const channel = {
    isSendable: () => true,
    send: async (payload: { content?: string; components?: readonly unknown[] }) => {
      state.sendCount += 1;
      state.sent.push({
        ...(payload.content !== undefined ? { content: payload.content } : {}),
        componentRows: payload.components?.length ?? 0
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

describe("transport.postComponents (Z321, gated)", () => {
  it("sends validated components + body via the injected client and returns the message id", async () => {
    const { client, state } = createFakeComponentClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    const result = await transport.postComponents(TARGET, "Approve this run?", [
      { buttons: [{ label: "Approve", style: "success", customId: "approve" }] }
    ]);
    assert.equal(result.messageId, "discord-message-1");
    assert.equal(state.loginCount, 1);
    assert.equal(state.sent.length, 1);
    assert.equal(state.sent[0]?.content, "Approve this run?");
    assert.equal(state.sent[0]?.componentRows, 1);
    await transport.close();
  });

  it("rejects invalid components AND empty body BEFORE login, so nothing leaves suppressed", async () => {
    const { client, state } = createFakeComponentClient();
    const transport = createNeonDiscordOutboundTransport({ token: "tok", createClient: () => client });
    await assert.rejects(
      () => transport.postComponents(TARGET, "has body", [{ buttons: [{ label: "B", style: "primary" }] }]),
      /invalid component/i
    );
    await assert.rejects(
      () => transport.postComponents(TARGET, "   ", [{ buttons: [{ label: "B", style: "primary", customId: "c" }] }]),
      /without body text/i
    );
    assert.equal(state.loginCount, 0);
    assert.equal(state.sent.length, 0);
    await transport.close();
  });
});
