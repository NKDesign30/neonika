import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listNeonTaskAuditFindings,
  renderNeonTaskAuditReport,
  summarizeNeonTaskAuditFindings,
  type INeonTaskRecord
} from "../src/index.js";

const iso = (year: number, monthIndex: number, day: number, hour = 0, minute = 0): string =>
  new Date(Date.UTC(year, monthIndex, day, hour, minute)).toISOString();

// Fixed clock: 2026-06-03T12:00:00Z.
const now = (): Date => new Date(Date.UTC(2026, 5, 3, 12, 0, 0));

function task(overrides: Partial<INeonTaskRecord> & { taskId: string }): INeonTaskRecord {
  return {
    title: "Task",
    source: "operator",
    channel: "cli",
    ownerAgentId: "neo",
    status: "ready",
    priority: "normal",
    labels: [],
    links: [],
    runIds: [],
    createdAt: iso(2026, 5, 1),
    updatedAt: iso(2026, 5, 3, 11),
    ...overrides
  };
}

test("listNeonTaskAuditFindings returns nothing for a clean board", () => {
  const findings = listNeonTaskAuditFindings(
    [
      task({ taskId: "t-ready", status: "ready", updatedAt: iso(2026, 5, 3, 11, 55) }),
      task({ taskId: "t-done", status: "done", due: iso(2026, 5, 1), updatedAt: iso(2026, 5, 3, 11, 55) })
    ],
    { now }
  );
  assert.equal(findings.length, 0);

  const summary = summarizeNeonTaskAuditFindings(findings);
  assert.equal(summary.total, 0);
  assert.match(renderNeonTaskAuditReport(findings, summary), /Neonika Task Audit: clean/);
});

test("overdue fires for non-terminal past-due tasks but never for terminal ones", () => {
  const findings = listNeonTaskAuditFindings(
    [
      task({ taskId: "t-overdue", status: "in-progress", due: iso(2026, 5, 2), updatedAt: iso(2026, 5, 3, 11, 55) }),
      task({ taskId: "t-done-overdue", status: "done", due: iso(2026, 5, 2), updatedAt: iso(2026, 5, 3, 11, 55) })
    ],
    { now }
  );
  const overdue = findings.filter((finding) => finding.code === "overdue");
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0]?.taskId, "t-overdue");
  assert.equal(overdue[0]?.severity, "warn");
});

test("stale-in-progress fires once the updatedAt age crosses the threshold", () => {
  const stale = listNeonTaskAuditFindings(
    [task({ taskId: "t-stuck", status: "in-progress", updatedAt: iso(2026, 5, 3, 10) })],
    { now }
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.code, "stale-in-progress");
  assert.ok((stale[0]?.ageMs ?? 0) >= 30 * 60_000);

  const fresh = listNeonTaskAuditFindings(
    [task({ taskId: "t-fresh", status: "in-progress", updatedAt: iso(2026, 5, 3, 11, 55) })],
    { now }
  );
  assert.equal(fresh.length, 0);
});

test("stale-blocked fires only after the long blocked window", () => {
  const stale = listNeonTaskAuditFindings(
    [task({ taskId: "t-blocked", status: "blocked", createdAt: iso(2026, 4, 1), updatedAt: iso(2026, 4, 20) })],
    { now }
  );
  assert.deepEqual(
    stale.map((finding) => finding.code),
    ["stale-blocked"]
  );

  const recentBlocked = listNeonTaskAuditFindings(
    [task({ taskId: "t-blocked-recent", status: "blocked", updatedAt: iso(2026, 5, 3, 9) })],
    { now }
  );
  assert.equal(recentBlocked.length, 0);
});

test("inconsistent-timestamps is an error when updatedAt precedes createdAt", () => {
  const findings = listNeonTaskAuditFindings(
    [task({ taskId: "t-corrupt", createdAt: iso(2026, 5, 3), updatedAt: iso(2026, 5, 1) })],
    { now }
  );
  const corrupt = findings.find((finding) => finding.code === "inconsistent-timestamps");
  assert.ok(corrupt);
  assert.equal(corrupt?.severity, "error");
});

test("orphaned-run-link only fires with known run ids and an active task", () => {
  const activeOrphan = task({
    taskId: "t-orphan",
    status: "in-progress",
    runIds: ["run-gone"],
    updatedAt: iso(2026, 5, 3, 11, 55)
  });
  const doneOrphan = task({
    taskId: "t-done-orphan",
    status: "done",
    runIds: ["run-gone"],
    updatedAt: iso(2026, 5, 3, 11, 55)
  });

  const withKnown = listNeonTaskAuditFindings([activeOrphan, doneOrphan], {
    now,
    knownRunIds: new Set(["run-here"])
  });
  const orphaned = withKnown.filter((finding) => finding.code === "orphaned-run-link");
  assert.equal(orphaned.length, 1);
  assert.equal(orphaned[0]?.taskId, "t-orphan");

  const withoutKnown = listNeonTaskAuditFindings([activeOrphan], { now });
  assert.equal(
    withoutKnown.filter((finding) => finding.code === "orphaned-run-link").length,
    0
  );

  const presentRun = listNeonTaskAuditFindings([activeOrphan], {
    now,
    knownRunIds: new Set(["run-gone"])
  });
  assert.equal(
    presentRun.filter((finding) => finding.code === "orphaned-run-link").length,
    0
  );
});

test("summary counts severities and codes, errors sort before warnings", () => {
  const findings = listNeonTaskAuditFindings(
    [
      task({ taskId: "t-corrupt", createdAt: iso(2026, 5, 3), updatedAt: iso(2026, 5, 1) }),
      task({ taskId: "t-stuck", status: "in-progress", updatedAt: iso(2026, 5, 3, 10) })
    ],
    { now }
  );
  const summary = summarizeNeonTaskAuditFindings(findings);
  assert.equal(summary.total, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.warnings, 1);
  assert.equal(summary.byCode["inconsistent-timestamps"], 1);
  assert.equal(summary.byCode["stale-in-progress"], 1);

  // error severity sorts first
  assert.equal(findings[0]?.severity, "error");

  const report = renderNeonTaskAuditReport(findings, summary);
  assert.match(report, /2 finding\(s\)/);
  assert.match(report, /Errors: 1/);
});
