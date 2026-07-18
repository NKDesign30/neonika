import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonReplaySnapshot,
  paginateNeonReplayEvents,
  renderNeonReplayEventPageReport,
  renderNeonReplayReport,
  writeNeonGatewayRun,
  type INeonGatewayShadowRun
} from "../src/index.js";

describe("Neon Replay snapshot", () => {
  it("builds a redacted run replay from Gateway history", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-replay-1", "session-a"));
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-replay-2", "session-b"));

      const snapshot = await createNeonReplaySnapshot(projectRoot, {
        runId: "run-replay-1",
        now: () => new Date("2026-06-01T09:00:00.000Z")
      });
      const run = snapshot.runs[0];
      const serialized = JSON.stringify(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.filters.runId, "run-replay-1");
      assert.equal(snapshot.totals.sourceRuns, 2);
      assert.equal(snapshot.totals.filteredRuns, 1);
      assert.equal(run?.runId, "run-replay-1");
      assert.equal(run?.mode, "read-only");
      assert.equal(run?.memoryState, "attached");
      assert.equal(run?.deliveryState, "suppressed");
      assert.equal(run?.eventCount, run?.events.length);
      assert.equal(run?.startedAt, "2026-06-01T08:58:00.000Z");
      assert.equal(run?.completedAt, "2026-06-01T08:58:02.000Z");
      assert.equal(run?.durationMs, 2000);
      assert.equal(run?.inboundPreview, "Replay bitte");
      assert.equal(run?.conversationId.startsWith("chat-"), true);
      assert.deepEqual(
        run?.events.map((event) => event.messageSeq),
        [
          "run-replay-1:000000",
          "run-replay-1:000001",
          "run-replay-1:000002",
          "run-replay-1:000003",
          "run-replay-1:000004",
          "run-replay-1:000005",
          "run-replay-1:000006"
        ]
      );
      assert.equal(run?.events[0]?.kind, "lifecycle");
      assert.equal(run?.events[0]?.title, "Session started");
      assert.ok(run?.events.some((event) => event.kind === "inbound"));
      assert.ok(run?.events.some((event) => event.kind === "tool-output"));
      assert.ok(run?.events.some((event) => event.kind === "delivery"));
      assert.doesNotMatch(serialized, /sk-replay-unit-secret/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("truncates replay previews without splitting UTF-16 surrogate pairs", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const run = createReplayRun("run-replay-emoji", "session-emoji");
      const flagged: INeonGatewayShadowRun = {
        ...run,
        request: {
          ...run.request,
          contentPreview: `${"a".repeat(897)}🙂tail`
        },
        finalText: `${"b".repeat(897)}🙂tail`,
        events: [
          {
            kind: "assistant-delta",
            text: `${"c".repeat(897)}🙂tail`
          }
        ]
      };
      await writeNeonGatewayRun(projectRoot, flagged);

      const snapshot = await createNeonReplaySnapshot(projectRoot, { runId: "run-replay-emoji" });
      const replayRun = snapshot.runs[0];
      const assistantEvent = replayRun?.events.find((event) => event.kind === "assistant-delta");

      assert.equal(replayRun?.inboundPreview, `${"a".repeat(897)}...`);
      assert.equal(replayRun?.finalPreview, `${"b".repeat(897)}...`);
      assert.equal(assistantEvent?.preview, `${"c".repeat(897)}...`);
      assert.equal(replayRun?.inboundPreview.includes("\uD83D"), false);
      assert.equal(replayRun?.finalPreview.includes("\uD83D"), false);
      assert.equal(assistantEvent?.preview?.includes("\uD83D"), false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("hides internal channel progress tool events from replay events", async () => {
    const projectRoot = await createTempProjectRoot();
    const baseRun = createReplayRun("run-replay-hidden", "session-hidden");
    const run: INeonGatewayShadowRun = {
      ...baseRun,
      events: [
        {
          kind: "tool-output",
          toolName: "codex-app-server",
          output: "turn.completed turn-1 status=completed",
          hideFromChannelProgress: true
        },
        {
          kind: "tool-output",
          output: "visible result",
          toolName: "codex"
        },
        {
          kind: "final",
          text: "Replay fertig"
        }
      ]
    };

    try {
      await writeNeonGatewayRun(projectRoot, run);

      const snapshot = await createNeonReplaySnapshot(projectRoot, { runId: "run-replay-hidden" });
      const replayRun = snapshot.runs[0];
      const serialized = JSON.stringify(snapshot);

      assert.doesNotMatch(serialized, /turn\.completed/u);
      assert.equal(replayRun?.eventCount, 6);
      assert.ok(replayRun?.events.some((event) => event.title === "Tool codex"));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps replay messageSeq stable when events are bounded", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-replay-cursor", "session-cursor"));

      const snapshot = await createNeonReplaySnapshot(projectRoot, {
        maxEventsPerRun: 3,
        runId: "run-replay-cursor"
      });

      assert.deepEqual(
        snapshot.runs[0]?.events.map((event) => event.messageSeq),
        ["run-replay-cursor:000000", "run-replay-cursor:000001", "run-replay-cursor:000002"]
      );
      assert.equal(snapshot.runs[0]?.eventCount, 7);
      assert.equal(snapshot.runs[0]?.events.length, 3);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("surfaces the persisted suspicious content tag in the selected run detail", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const run = createReplayRun("run-replay-suspicious", "session-c");
      const flagged: INeonGatewayShadowRun = {
        ...run,
        request: {
          ...run.request,
          contentPreview: "Replay bitte [suspicious: ignore-previous-instructions x1]"
        }
      };
      await writeNeonGatewayRun(projectRoot, flagged);

      const snapshot = await createNeonReplaySnapshot(projectRoot, {
        runId: "run-replay-suspicious"
      });
      const selected = snapshot.runs[0];

      assert.equal(selected?.runId, "run-replay-suspicious");
      assert.match(selected?.inboundPreview ?? "", /\[suspicious: ignore-previous-instructions x1\]/u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("projects persisted suspicious findings onto the replay run detail", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const run = createReplayRun("run-replay-findings", "session-d");
      const flagged: INeonGatewayShadowRun = {
        ...run,
        request: {
          ...run.request,
          suspiciousFindings: [{ id: "ignore-previous-instructions", severity: "warn", count: 3 }]
        }
      };
      await writeNeonGatewayRun(projectRoot, flagged);

      const snapshot = await createNeonReplaySnapshot(projectRoot, {
        runId: "run-replay-findings"
      });
      const selected = snapshot.runs[0];

      assert.deepEqual(selected?.suspiciousFindings, [
        { id: "ignore-previous-instructions", severity: "warn", count: 3 }
      ]);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("defaults suspicious findings to an empty list for legacy runs", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-replay-empty", "session-e"));

      const snapshot = await createNeonReplaySnapshot(projectRoot, {
        runId: "run-replay-empty"
      });

      assert.deepEqual(snapshot.runs[0]?.suspiciousFindings, []);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reports not-found when filters do not match stored runs", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-replay-1", "session-a"));

      const snapshot = await createNeonReplaySnapshot(projectRoot, {
        sessionKey: "missing-session"
      });
      const report = renderNeonReplayReport(snapshot);

      assert.equal(snapshot.state, "not-found");
      assert.equal(snapshot.totals.sourceRuns, 1);
      assert.equal(snapshot.totals.filteredRuns, 0);
      assert.match(report, /Filters: sessionKey=missing-session/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

describe("Neon Replay event pagination", () => {
  it("walks the full event stream with a stable messageSeq cursor", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-page-1", "session-page"));
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-page-other", "session-other"));

      const snapshot = await createNeonReplaySnapshot(projectRoot, { runId: "run-page-1" });

      const first = paginateNeonReplayEvents(snapshot, { limit: 3 });
      assert.equal(first.state, "ready");
      assert.equal(first.totalEvents, 7);
      assert.equal(first.returned, 3);
      assert.equal(first.hasMore, true);
      assert.equal(first.nextCursor, "run-page-1:000002");
      assert.deepEqual(
        first.items.map((item) => item.messageSeq),
        ["run-page-1:000000", "run-page-1:000001", "run-page-1:000002"]
      );
      assert.equal(first.items[0]?.runId, "run-page-1");
      assert.equal(first.items[0]?.position, 0);

      const second = paginateNeonReplayEvents(snapshot, { limit: 3, afterMessageSeq: first.nextCursor });
      assert.equal(second.returned, 3);
      assert.equal(second.hasMore, true);
      assert.equal(second.nextCursor, "run-page-1:000005");
      assert.equal(second.items[0]?.messageSeq, "run-page-1:000003");
      assert.equal(second.items[0]?.position, 3);

      const third = paginateNeonReplayEvents(snapshot, { limit: 3, afterMessageSeq: second.nextCursor });
      assert.equal(third.returned, 1);
      assert.equal(third.hasMore, false);
      assert.equal(third.nextCursor, undefined);
      assert.equal(third.items[0]?.messageSeq, "run-page-1:000006");

      assert.doesNotMatch(JSON.stringify([first, second, third]), /sk-rep…cret/u);
      assert.match(renderNeonReplayEventPageReport(first), /Events: 3\/7 \(limit 3\)/);
      assert.match(renderNeonReplayEventPageReport(first), /HasMore: yes/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("falls back to the default page size for unsafe numeric limits", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-page-unsafe", "session-page"));
      const snapshot = await createNeonReplaySnapshot(projectRoot, { runId: "run-page-unsafe" });
      const unsafe = paginateNeonReplayEvents(snapshot, { limit: Number.MAX_SAFE_INTEGER + 1 });

      assert.equal(unsafe.limit, 50);
      assert.equal(unsafe.returned, 7);
      assert.equal(unsafe.hasMore, false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reports cursor-not-found for an unknown cursor and empty for no runs", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      await writeNeonGatewayRun(projectRoot, createReplayRun("run-page-1", "session-page"));
      const ready = await createNeonReplaySnapshot(projectRoot, { runId: "run-page-1" });

      const missing = paginateNeonReplayEvents(ready, { afterMessageSeq: "run-page-1:999999" });
      assert.equal(missing.state, "cursor-not-found");
      assert.equal(missing.returned, 0);
      assert.equal(missing.hasMore, false);

      const empty = await createNeonReplaySnapshot(projectRoot, { runId: "does-not-exist" });
      const page = paginateNeonReplayEvents(empty);
      assert.equal(page.state, "empty");
      assert.equal(page.totalEvents, 0);
      assert.equal(page.limit, 50);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function createReplayRun(runId: string, sessionKey: string): INeonGatewayShadowRun {
  return {
    runId,
    mode: "shadow",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "900000000000000001",
      channelId: "900000000000000005",
      threadId: "operator-privat",
      messageId: `${runId}-message`,
      userId: "operator",
      userDisplayName: "Operator",
      agentId: "chaty",
      workspaceRoot: "/Users/operator/neon-projects/neonika",
      mode: "read-only",
      contentPreview: "Replay bitte",
      receivedAt: "2026-06-01T08:58:00.000Z"
    },
    harnessId: "codex-app-server",
    harnessSessionKey: sessionKey,
    memoryState: "attached",
    events: [
      {
        kind: "tool-start",
        toolName: "codex"
      },
      {
        kind: "tool-output",
        output: "result sk-replay-unit-secret",
        toolName: "codex"
      },
      {
        kind: "final",
        text: "Replay fertig sk-replay-unit-secret"
      }
    ],
    finalText: "Replay fertig sk-replay-unit-secret",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "900000000000000005",
      reason: "shadow-mode",
      finalText: "Replay fertig sk-replay-unit-secret"
    },
    startedAt: "2026-06-01T08:58:00.000Z",
    completedAt: "2026-06-01T08:58:02.000Z"
  };
}

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neonika-replay-snapshot-"));
}
