import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isWithinNeonHeartbeatActiveHours,
  parseNeonHeartbeatActiveHoursTime
} from "../src/index.js";

// 2026-06-02T12:00:00Z -> 12:00 UTC, 2026-06-02T03:00:00Z -> 03:00 UTC.
const noonUtc = Date.parse("2026-06-02T12:00:00.000Z");
const threeAmUtc = Date.parse("2026-06-02T03:00:00.000Z");
const elevenPmUtc = Date.parse("2026-06-02T23:00:00.000Z");

describe("Neon heartbeat active-hours (pure, UTC)", () => {
  it("returns true when no window is configured", () => {
    assert.equal(isWithinNeonHeartbeatActiveHours(undefined, noonUtc), true);
  });

  it("handles a normal window (09:00-17:00)", () => {
    const window = { start: "09:00", end: "17:00" };
    assert.equal(isWithinNeonHeartbeatActiveHours(window, noonUtc), true);
    assert.equal(isWithinNeonHeartbeatActiveHours(window, threeAmUtc), false);
  });

  it("handles a midnight-wrap window (22:00-06:00)", () => {
    const window = { start: "22:00", end: "06:00" };
    assert.equal(isWithinNeonHeartbeatActiveHours(window, elevenPmUtc), true);
    assert.equal(isWithinNeonHeartbeatActiveHours(window, threeAmUtc), true);
    assert.equal(isWithinNeonHeartbeatActiveHours(window, noonUtc), false);
  });

  it("treats a null window (start === end) as always inactive", () => {
    assert.equal(isWithinNeonHeartbeatActiveHours({ start: "09:00", end: "09:00" }, noonUtc), false);
  });

  it("fails open on an invalid window string", () => {
    assert.equal(isWithinNeonHeartbeatActiveHours({ start: "9:00", end: "17:00" }, noonUtc), true);
  });

  it("parses 24h HH:MM with the 24:00 end sentinel", () => {
    assert.equal(parseNeonHeartbeatActiveHoursTime({ allow24: false }, "00:00"), 0);
    assert.equal(parseNeonHeartbeatActiveHoursTime({ allow24: false }, "23:59"), 1439);
    assert.equal(parseNeonHeartbeatActiveHoursTime({ allow24: true }, "24:00"), 1440);
    assert.equal(parseNeonHeartbeatActiveHoursTime({ allow24: false }, "24:00"), null);
    assert.equal(parseNeonHeartbeatActiveHoursTime({ allow24: false }, "9:00"), null);
    assert.equal(parseNeonHeartbeatActiveHoursTime({ allow24: false }, undefined), null);
  });
});
