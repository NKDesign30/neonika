import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatNeonDiscordExpiryCountdown,
  NEON_DISCORD_ACCENT_COLOR,
  neonDiscordSeverityColors
} from "../src/index.js";

describe("Neon Discord UI colors", () => {
  it("keeps the brand accent and severity palette stable", () => {
    assert.equal(NEON_DISCORD_ACCENT_COLOR, 0xf28a4b);
    assert.equal(neonDiscordSeverityColors.critical, 0xed4245);
    assert.equal(neonDiscordSeverityColors.warning, 0xfaa61a);
    assert.equal(neonDiscordSeverityColors.info, 0x5865f2);
  });

  it("renders an ISO expiry as a Discord relative timestamp", () => {
    assert.equal(
      formatNeonDiscordExpiryCountdown("2026-07-10T20:00:00.000Z"),
      `<t:${Math.floor(Date.parse("2026-07-10T20:00:00.000Z") / 1000)}:R>`
    );
  });
});
