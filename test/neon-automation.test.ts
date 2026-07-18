import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonAutomationSnapshot,
  renderNeonAutomationCronJobReport,
  renderNeonAutomationCronListReport,
  renderNeonAutomationReport
} from "../src/index.js";

describe("Neon Automation", () => {
  it("models cron, hooks, and dreams as read-only disabled inventory", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:00:00.000Z")
    });

    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.generatedAt, "2026-06-01T00:00:00.000Z");
    assert.equal(snapshot.policy, "shadow-read-only");
    assert.equal(snapshot.totals.enabled, 0);
    assert.equal(snapshot.totals.disabled, 7);
    assert.ok(
      snapshot.dreams.some(
        (dream) => dream.id === "memory-consolidation" && dream.state === "disabled" && dream.phase === "off"
      )
    );
    const heartbeat = snapshot.jobs.find((job) => job.id === "heartbeat-review");

    assert.equal(heartbeat?.state, "disabled");
    assert.equal(heartbeat?.schedule, "every-15m");
    assert.equal(heartbeat?.nextRunAt, "2026-06-01T00:00:00.000Z");
    assert.ok(snapshot.hooks.some((hook) => hook.event === "gateway:startup" && hook.policy === "read-only"));
    assert.ok(
      snapshot.hooks.some((hook) => hook.event === "message:received" && hook.policy === "read-only"),
      "message:received is a read-only catalog hook"
    );
    assert.equal(snapshot.hookRegistry.state, "read-only");
    assert.deepEqual(snapshot.hookRegistry.eventKeys, [
      "gateway:startup",
      "message:received",
      "session:compact:after"
    ]);
    assert.deepEqual(snapshot.hookRegistry.byEvent, [
      { event: "gateway:startup", hookIds: ["gateway-start"] },
      { event: "message:received", hookIds: ["message-received"] },
      { event: "session:compact:after", hookIds: ["session-memory"] }
    ]);
    assert.equal(snapshot.hookRegistry.handlerCount, 0);
    assert.equal(snapshot.hookRegistry.dispatchEnabled, false);
    assert.equal(snapshot.dreams[0]?.policy, "operator-approval-required");
    assert.equal(snapshot.dreams[0]?.phase, "off");
    assert.equal(snapshot.dreams[0]?.lastReflectionAt, null);
    assert.equal(snapshot.dreams[0]?.reflectionEnabled, false);
    // Public URLs, never local checkout paths: these strings are served over HTTP.
    assert.match(
      snapshot.source.referenceCronDocs,
      /^https:\/\/github\.com\/openclaw\/openclaw\/.+\/docs\/automation\/cron-jobs\.md$/
    );
    assert.match(
      snapshot.source.referenceHooksDocs,
      /^https:\/\/github\.com\/openclaw\/openclaw\/.+\/docs\/automation\/hooks\.md$/
    );
    for (const reference of Object.values(snapshot.source)) {
      assert.doesNotMatch(reference, /^\/Users\/|^\/home\//);
    }
    assert.equal(snapshot.runIntent.jobId, "heartbeat-review");
    assert.equal(snapshot.runIntent.state, "blocked");
    assert.equal(snapshot.runIntent.reason, "scheduler-disabled");
    assert.equal(snapshot.runIntent.action, "none");
    assert.equal(snapshot.runIntent.due, true);
  });

  it("renders a compact operator report that keeps the scheduler off", () => {
    const report = renderNeonAutomationReport(
      createNeonAutomationSnapshot({
        generatedAt: new Date("2026-06-01T00:00:00.000Z")
      })
    );

    assert.match(report, /Neon Automation: ready/);
    assert.match(report, /Policy: shadow-read-only/);
    assert.match(report, /enabled=0/);
    assert.match(report, /Run Intent: heartbeat-review \/ blocked \/ scheduler-disabled/);
    assert.match(report, /Hook Registry: 3 event\(s\) \/ dispatch=off/);
    assert.match(report, /gateway-start: disabled/);
    assert.match(report, /neon-dreaming: disabled \/ operator-approval-required \/ phase=off \/ reflection=off/);
  });

  it("evaluates one cron job with force without creating a live run", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:10:00.000Z"),
      evaluateCronJobId: "heartbeat-review",
      forceCronJobId: "heartbeat-review",
      lastRunAtByJobId: {
        "heartbeat-review": "2026-06-01T00:00:00.000Z"
      }
    });

    assert.equal(snapshot.runIntent.jobId, "heartbeat-review");
    assert.equal(snapshot.runIntent.evaluatedAt, "2026-06-01T00:10:00.000Z");
    assert.equal(snapshot.runIntent.dueAt, "2026-06-01T00:15:00.000Z");
    assert.equal(snapshot.runIntent.forced, true);
    assert.equal(snapshot.runIntent.due, true);
    assert.equal(snapshot.runIntent.state, "blocked");
    assert.equal(snapshot.runIntent.reason, "scheduler-disabled");
    assert.equal(snapshot.runIntent.action, "none");
    assert.ok(snapshot.runIntent.diagnostics.every((diagnostic) => !diagnostic.includes("runId")));
  });

  it("blocks unknown cron run intent requests without side effects", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:00:00.000Z"),
      evaluateCronJobId: "missing-cron"
    });

    assert.equal(snapshot.runIntent.jobId, "missing-cron");
    assert.equal(snapshot.runIntent.state, "blocked");
    assert.equal(snapshot.runIntent.reason, "job-not-found");
    assert.equal(snapshot.runIntent.due, false);
    assert.equal(snapshot.runIntent.action, "none");
  });

  it("keeps hook registration read-only and handler-free", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:00:00.000Z")
    });

    assert.equal(snapshot.hookRegistry.registrations.length, snapshot.hooks.length);
    assert.ok(
      snapshot.hookRegistry.registrations.every((registration) =>
        snapshot.hooks.some((hook) => hook.id === registration.hookId && hook.event === registration.event)
      )
    );
    assert.equal(snapshot.hookRegistry.handlerCount, 0);
    assert.equal(snapshot.hookRegistry.dispatchEnabled, false);
    assert.ok(snapshot.hookRegistry.diagnostics.some((diagnostic) => diagnostic.includes("No hook handlers")));
  });

  it("renders a single read-only cron job detail with its evaluated run intent", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:10:00.000Z"),
      evaluateCronJobId: "heartbeat-review",
      lastRunAtByJobId: { "heartbeat-review": "2026-06-01T00:00:00.000Z" }
    });

    const report = renderNeonAutomationCronJobReport(snapshot, "heartbeat-review");

    assert.match(report, /Neon Cron Job: heartbeat-review/);
    assert.match(report, /State: disabled \/ policy=operator-approval-required/);
    assert.match(report, /Run intent: blocked \/ scheduler-disabled \/ action=none/);
    assert.match(report, /read-only due evaluation/);
  });

  it("renders a cron-only list with richer per-job fields than the full report", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:00:00.000Z")
    });

    const report = renderNeonAutomationCronListReport(snapshot);

    assert.match(report, /Neon Cron Jobs: \d+ \(policy=shadow-read-only\)/);
    assert.match(report, /Scheduler: disabled \(read-only shadow inventory\)/);
    assert.match(report, /- heartbeat-review \[disabled\] policy=.* schedule=every-15m.*next=.* last=.* source=/);
    // cron-only: the hooks/dreams/recovery sections from the full report are absent.
    assert.doesNotMatch(report, /Hooks:/);
    assert.doesNotMatch(report, /Dreams:/);
  });

  it("renders a forced cron job detail that stays gated (forced=true, action=none)", () => {
    const snapshot = createNeonAutomationSnapshot({
      generatedAt: new Date("2026-06-01T00:10:00.000Z"),
      evaluateCronJobId: "heartbeat-review",
      forceCronJobId: "heartbeat-review"
    });

    const report = renderNeonAutomationCronJobReport(snapshot, "heartbeat-review");

    assert.match(report, /forced=true/);
    assert.match(report, /Run intent: blocked \/ scheduler-disabled \/ action=none/);
  });

  it("reports a not-found cron job with the available job ids", () => {
    const report = renderNeonAutomationCronJobReport(
      createNeonAutomationSnapshot({ generatedAt: new Date("2026-06-01T00:00:00.000Z") }),
      "missing-cron"
    );

    assert.match(report, /Neon Cron job not found: missing-cron/);
    assert.match(report, /Available jobs: .*heartbeat-review/);
  });
});
