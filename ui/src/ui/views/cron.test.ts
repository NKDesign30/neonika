import { describe, expect, it } from "vitest";

import {
  cronBadgeStatus,
  cronCursorLabel,
  cronGateLabel,
  cronStateLabel,
  cronTickSummary,
  type CronSnapshot,
} from "./cron.js";

function snapshot(overrides: Partial<CronSnapshot> = {}): CronSnapshot {
  return {
    gate: { enabled: false, reason: "timer-disabled", envKey: "NEON_CRON_TIMER_ENABLED" },
    cursorPresent: false,
    cursor: { ticks: 0, emitted: {} },
    jobs: [],
    daemonStale: false,
    safety: { agentExecuted: false, outboundSent: false, wroteLiveRun: false },
    ...overrides,
  };
}

describe("cron daemon operator copy", () => {
  it("reports a not-running daemon as an idle optional loop", () => {
    const cron = snapshot();
    expect(cronStateLabel(cron)).toBe("not running");
    expect(cronBadgeStatus(cron)).toBe("idle");
    expect(cronTickSummary(cron)).toBe("no ticks yet");
    expect(cronGateLabel(cron)).toBe("shadow");
    expect(cronCursorLabel(cron)).toBe("absent · never ticked");
  });

  it("reports an alive daemon with tick/run counts and an armed gate", () => {
    const cron = snapshot({
      gate: { enabled: true, reason: "timer-enabled", envKey: "NEON_CRON_TIMER_ENABLED" },
      cursorPresent: true,
      cursor: { ticks: 3, lastTickAt: "2026-06-05T13:00:00.000Z", emitted: { demo: "2026-06-05T12:45:00.000Z" } },
      daemon: {
        pid: 4242,
        alive: true,
        gateEnabled: true,
        intervalMs: 900_000,
        startedAt: "2026-06-05T12:00:00.000Z",
        lastTickAt: "2026-06-05T13:00:00.000Z",
        nextTickAt: "2026-06-05T13:15:00.000Z",
        tickCount: 3,
        dueIntentsLastTick: 2,
        catchupIntentsLastTick: 1,
        createdRunsTotal: 6,
        createdWorkspaceNotesTotal: 4,
      },
    });
    expect(cronStateLabel(cron)).toBe("alive");
    expect(cronBadgeStatus(cron)).toBe("ok");
    expect(cronGateLabel(cron)).toBe("armed");
    expect(cronTickSummary(cron)).toBe("3 tick(s) · 2 due last tick · 1 catch-up last tick · 6 shadow run(s) created · 4 workspace note(s)");
    expect(cronCursorLabel(cron)).toBe("present · tick #3 · last 2026-06-05T13:00:00.000Z");
  });

  it("flags a stale daemon as a warning, not a healthy one", () => {
    const cron = snapshot({
      daemonStale: true,
      daemon: {
        pid: 1,
        alive: true,
        gateEnabled: true,
        intervalMs: 900_000,
        startedAt: "2026-06-05T12:00:00.000Z",
        nextTickAt: "2026-06-05T12:30:00.000Z",
        tickCount: 1,
        dueIntentsLastTick: 0,
        catchupIntentsLastTick: 0,
        createdRunsTotal: 0,
        createdWorkspaceNotesTotal: 0,
      },
    });
    expect(cronStateLabel(cron)).toBe("alive · stale");
    expect(cronBadgeStatus(cron)).toBe("warn");
  });

  it("prefers the running daemon's own gate over the status reader's env", () => {
    const cron = snapshot({
      gate: { enabled: false, reason: "timer-disabled", envKey: "NEON_CRON_TIMER_ENABLED" },
      daemon: {
        pid: 7,
        alive: true,
        gateEnabled: true,
        intervalMs: 900_000,
        startedAt: "2026-06-05T12:00:00.000Z",
        tickCount: 4,
        dueIntentsLastTick: 0,
        catchupIntentsLastTick: 0,
        createdRunsTotal: 2,
        createdWorkspaceNotesTotal: 2,
      },
    });
    expect(cronGateLabel(cron)).toBe("armed");
  });

  it("reports a cleanly stopped daemon as idle", () => {
    const cron = snapshot({
      daemon: {
        pid: 1,
        alive: false,
        gateEnabled: true,
        intervalMs: 900_000,
        startedAt: "2026-06-05T12:00:00.000Z",
        tickCount: 2,
        dueIntentsLastTick: 0,
        catchupIntentsLastTick: 0,
        createdRunsTotal: 4,
        createdWorkspaceNotesTotal: 4,
        stoppedAt: "2026-06-05T12:40:00.000Z",
      },
    });
    expect(cronStateLabel(cron)).toBe("stopped");
    expect(cronBadgeStatus(cron)).toBe("idle");
  });
});
