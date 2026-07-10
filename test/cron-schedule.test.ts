import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeNeonNextRunAtMs,
  describeNeonCronSchedule,
  isNeonCronScheduleDue,
  parseNeonCronSchedule
} from "../src/index.js";

const MINUTE_MS = 60_000;
// 2026-06-03 is a Wednesday (dow 3); 06-04 Thu, 06-05 Fri, 06-08 Mon.

test("parseNeonCronSchedule classifies manual / interval / cron / invalid", () => {
  assert.deepEqual(parseNeonCronSchedule("manual-only"), { kind: "manual" });

  const interval = parseNeonCronSchedule("every-15m");
  assert.equal(interval.kind, "interval");
  if (interval.kind === "interval") {
    assert.equal(interval.intervalMs, 15 * MINUTE_MS);
  }

  const cron = parseNeonCronSchedule("30 9 * * 1-5");
  assert.equal(cron.kind, "cron");

  assert.equal(parseNeonCronSchedule("").kind, "invalid");
  assert.equal(parseNeonCronSchedule("* * *").kind, "invalid");
  assert.equal(parseNeonCronSchedule("99 * * * *").kind, "invalid");
  assert.equal(parseNeonCronSchedule("every-0m").kind, "invalid");
});

test("interval units resolve to minutes/hours/days", () => {
  const h = parseNeonCronSchedule("every-2h");
  assert.equal(h.kind === "interval" && h.intervalMs, 2 * 3_600_000);
  const d = parseNeonCronSchedule("every-1d");
  assert.equal(d.kind === "interval" && d.intervalMs, 86_400_000);
});

test("computeNeonNextRunAtMs: interval adds the interval to afterMs", () => {
  assert.equal(computeNeonNextRunAtMs("every-15m", 1_000), 1_000 + 15 * MINUTE_MS);
});

test("computeNeonNextRunAtMs: manual / invalid return undefined", () => {
  assert.equal(computeNeonNextRunAtMs("manual-only", Date.UTC(2026, 5, 3)), undefined);
  assert.equal(computeNeonNextRunAtMs("nonsense", Date.UTC(2026, 5, 3)), undefined);
});

test("computeNeonNextRunAtMs: step minute lands on next boundary strictly after", () => {
  // 09:07 -> 09:15
  assert.equal(
    computeNeonNextRunAtMs("*/15 * * * *", Date.UTC(2026, 5, 3, 9, 7, 0)),
    Date.UTC(2026, 5, 3, 9, 15, 0)
  );
  // exactly on a boundary -> the NEXT one (strictly after)
  assert.equal(
    computeNeonNextRunAtMs("*/15 * * * *", Date.UTC(2026, 5, 3, 9, 15, 0)),
    Date.UTC(2026, 5, 3, 9, 30, 0)
  );
});

test("computeNeonNextRunAtMs: weekday range fires same day then skips weekend", () => {
  // Wed 08:00 -> Wed 09:30 (same day, dow 3 in 1-5)
  assert.equal(
    computeNeonNextRunAtMs("30 9 * * 1-5", Date.UTC(2026, 5, 3, 8, 0, 0)),
    Date.UTC(2026, 5, 3, 9, 30, 0)
  );
  // Wed 10:00 -> Thu 09:30 (next day)
  assert.equal(
    computeNeonNextRunAtMs("30 9 * * 1-5", Date.UTC(2026, 5, 3, 10, 0, 0)),
    Date.UTC(2026, 5, 4, 9, 30, 0)
  );
  // Fri 10:00 -> Mon 09:30 (skip Sat/Sun)
  assert.equal(
    computeNeonNextRunAtMs("30 9 * * 1-5", Date.UTC(2026, 5, 5, 10, 0, 0)),
    Date.UTC(2026, 5, 8, 9, 30, 0)
  );
});

test("computeNeonNextRunAtMs: day-of-month only restricted", () => {
  // 15th at 00:00, from 06-03 -> 06-15
  assert.equal(
    computeNeonNextRunAtMs("0 0 15 * *", Date.UTC(2026, 5, 3, 0, 0, 0)),
    Date.UTC(2026, 5, 15, 0, 0, 0)
  );
});

test("computeNeonNextRunAtMs: Vixie OR semantics when both dom and dow restricted", () => {
  // "0 0 1 * 1" = midnight on the 1st OR on Monday.
  // From Wed 06-03 00:00 the soonest is Mon 06-08 (sooner than Jul 1).
  assert.equal(
    computeNeonNextRunAtMs("0 0 1 * 1", Date.UTC(2026, 5, 3, 0, 0, 0)),
    Date.UTC(2026, 5, 8, 0, 0, 0)
  );
});

test("computeNeonNextRunAtMs: dow 0 and 7 both mean Sunday", () => {
  // From Wed 06-03, next Sunday is 06-07.
  const fromZero = computeNeonNextRunAtMs("0 12 * * 0", Date.UTC(2026, 5, 3, 0, 0, 0));
  const fromSeven = computeNeonNextRunAtMs("0 12 * * 7", Date.UTC(2026, 5, 3, 0, 0, 0));
  assert.equal(fromZero, Date.UTC(2026, 5, 7, 12, 0, 0));
  assert.equal(fromSeven, Date.UTC(2026, 5, 7, 12, 0, 0));
});

test("computeNeonNextRunAtMs: impossible date returns undefined within the bound", () => {
  // Feb 30 never exists.
  assert.equal(
    computeNeonNextRunAtMs("* * 30 2 *", Date.UTC(2026, 5, 3, 0, 0, 0)),
    undefined
  );
});

test("isNeonCronScheduleDue: cron due only once the scheduled minute has passed", () => {
  // last run Wed 08:00, next is Wed 09:30
  const last = Date.UTC(2026, 5, 3, 8, 0, 0);
  assert.equal(
    isNeonCronScheduleDue("30 9 * * 1-5", Date.UTC(2026, 5, 3, 9, 0, 0), last),
    false
  );
  assert.equal(
    isNeonCronScheduleDue("30 9 * * 1-5", Date.UTC(2026, 5, 3, 9, 31, 0), last),
    true
  );
});

test("isNeonCronScheduleDue: no last run -> cron waits, interval fires", () => {
  assert.equal(isNeonCronScheduleDue("30 9 * * 1-5", Date.UTC(2026, 5, 3, 12, 0, 0)), false);
  assert.equal(isNeonCronScheduleDue("every-5m", Date.UTC(2026, 5, 3, 12, 0, 0)), true);
  assert.equal(isNeonCronScheduleDue("manual-only", Date.UTC(2026, 5, 3, 12, 0, 0), 1), false);
});

test("describeNeonCronSchedule renders each kind", () => {
  assert.match(describeNeonCronSchedule("manual-only"), /manual-only/);
  assert.match(describeNeonCronSchedule("every-15m"), /interval: every 15m/);
  assert.match(describeNeonCronSchedule("30 9 * * 1-5"), /cron \(UTC\): 30 9 \* \* 1-5/);
  assert.match(describeNeonCronSchedule("bad"), /invalid:/);
});
