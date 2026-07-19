// Adapted from NK Design's Mission Control Workboard tests for Neonika.
// Copyright (c) NK Design; used with owner permission. See THIRD_PARTY_NOTICES.md.

import { describe, expect, it } from "vitest";

import { formatDetailMeta, pickReplayRun, type IReplayRun, type IReplaySnapshot } from "./workboard.js";

function run(overrides: Partial<IReplayRun> = {}): IReplayRun {
  return {
    runId: "neon-shadow-abc123",
    status: "completed",
    eventCount: 0,
    events: [],
    ...overrides,
  };
}

describe("pickReplayRun", () => {
  it("returns the first run when the snapshot has one", () => {
    const snapshot: IReplaySnapshot = { runs: [run({ runId: "a" }), run({ runId: "b" })] };
    expect(pickReplayRun(snapshot)?.runId).toBe("a");
  });

  it("returns undefined when the run fell out of the store", () => {
    const snapshot: IReplaySnapshot = { runs: [] };
    expect(pickReplayRun(snapshot)).toBeUndefined();
  });
});

describe("formatDetailMeta", () => {
  it("joins channel, agent, user, and rounded duration", () => {
    const meta = formatDetailMeta(
      run({ channel: "discord", agentId: "chaty", userDisplayName: "Operator", durationMs: 44_965 }),
    );
    expect(meta).toBe("discord · @chaty · Operator · 45s");
  });

  it("omits missing fields instead of leaving empty separators", () => {
    const meta = formatDetailMeta(run({ channel: "discord" }));
    expect(meta).toBe("discord");
  });

  it("returns an empty string when nothing is known about the run", () => {
    expect(formatDetailMeta(run())).toBe("");
  });
});
