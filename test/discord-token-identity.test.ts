import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonGatewayRouteInspectionSnapshot,
  parseDiscordApplicationIdFromToken,
  renderNeonGatewayRouteInspectionReport,
  resolveDiscordBotIdentityConsistency
} from "../src/index.js";

const APP_ID = "123456789012345678";
// A distinctive sentinel for the HMAC segment; the test asserts it never leaks.
const HMAC_SENTINEL = "LEAKCANARY9876thisisthesecrethmacsegment";
const SYNTHETIC_TOKEN = `${Buffer.from(APP_ID, "utf8").toString("base64url")}.Gw7zRq.${HMAC_SENTINEL}`;

describe("parseDiscordApplicationIdFromToken (Z480)", () => {
  it("decodes the public application id from segment 0 of a well-formed bot token", () => {
    assert.equal(parseDiscordApplicationIdFromToken(SYNTHETIC_TOKEN), APP_ID);
  });

  it("returns undefined for absent / empty / single-segment / mfa input", () => {
    assert.equal(parseDiscordApplicationIdFromToken(undefined), undefined);
    assert.equal(parseDiscordApplicationIdFromToken(""), undefined);
    assert.equal(parseDiscordApplicationIdFromToken("   "), undefined);
    assert.equal(parseDiscordApplicationIdFromToken("singlesegment"), undefined);
    assert.equal(parseDiscordApplicationIdFromToken("mfa.abcdef"), undefined);
  });

  it("returns undefined when segment 0 decodes to a non-snowflake", () => {
    const notASnowflake = `${Buffer.from("hello world", "utf8").toString("base64url")}.x.y`;
    assert.equal(parseDiscordApplicationIdFromToken(notASnowflake), undefined);
  });

  it("never returns the secret HMAC segment", () => {
    const result = parseDiscordApplicationIdFromToken(SYNTHETIC_TOKEN) ?? "";
    assert.doesNotMatch(result, /LEAKCANARY/);
  });
});

describe("resolveDiscordBotIdentityConsistency (Z480)", () => {
  it("matches identical ids, flags mismatches, stays unknown without both sides", () => {
    assert.equal(resolveDiscordBotIdentityConsistency(APP_ID, APP_ID), "match");
    assert.equal(resolveDiscordBotIdentityConsistency(APP_ID, "999999999999999999"), "mismatch");
    assert.equal(resolveDiscordBotIdentityConsistency(undefined, APP_ID), "unknown");
    assert.equal(resolveDiscordBotIdentityConsistency(APP_ID, undefined), "unknown");
  });
});

describe("route inspection bot identity (Z480)", () => {
  it("surfaces the derived application id and consistency without leaking the token", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-token-identity-"));
    try {
      const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
        env: {
          NEON_DISCORD_BOT_TOKEN: SYNTHETIC_TOKEN,
          NEON_DISCORD_BOT_USER_ID: APP_ID,
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
        },
        now: () => new Date("2026-06-03T00:00:00.000Z")
      });

      assert.equal(snapshot.discord.applicationId, APP_ID);
      assert.equal(snapshot.discord.botIdentityConsistency, "match");

      const report = renderNeonGatewayRouteInspectionReport(snapshot);
      assert.match(report, new RegExp(`applicationId=${APP_ID}`));
      assert.match(report, /consistency=match/);

      // Leak-safety: the secret HMAC segment must never cross a boundary.
      assert.doesNotMatch(JSON.stringify(snapshot), /LEAKCANARY/);
      assert.doesNotMatch(report, /LEAKCANARY/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("flags a token/bot-user-id mismatch as a needs-config recovery item", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-token-mismatch-"));
    try {
      const snapshot = await createNeonGatewayRouteInspectionSnapshot(projectRoot, {
        env: {
          NEON_DISCORD_BOT_TOKEN: SYNTHETIC_TOKEN,
          NEON_DISCORD_BOT_USER_ID: "999999999999999999",
          NEON_DISCORD_ALLOWED_GUILDS: "900000000000000001",
          NEON_DISCORD_ALLOWED_CHANNELS: "900000000000000005"
        },
        now: () => new Date("2026-06-03T00:00:00.000Z")
      });

      assert.equal(snapshot.discord.botIdentityConsistency, "mismatch");
      assert.equal(snapshot.state, "needs-config");
      assert.ok(
        snapshot.recovery.some((step) => step.includes("does not match the application id")),
        "expected a mismatch recovery hint"
      );
      assert.doesNotMatch(JSON.stringify(snapshot), /LEAKCANARY/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
