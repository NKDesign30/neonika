import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NEON_BLOCKED_ROW_READINESS,
  createNeonBlockedRowReadinessSnapshot,
  renderNeonBlockedRowReadinessReport,
  renderNeonMissionControlBlockedReadinessPanel
} from "../src/index.js";

describe("Neon blocked-row readiness", () => {
  it("catalogs exactly the 13 blocked matrix rows with complete decision fields", () => {
    assert.equal(NEON_BLOCKED_ROW_READINESS.length, 13);
    for (const row of NEON_BLOCKED_ROW_READINESS) {
      assert.ok(row.id && row.title && row.area, `row ${row.id} has identity`);
      assert.ok(row.whyBlocked.length > 0, `${row.id} has whyBlocked`);
      assert.ok(row.liveEffect.length > 0, `${row.id} has liveEffect`);
      assert.ok(row.rollback.length > 0, `${row.id} has rollback`);
      assert.match(row.verifyCommand, /^(node dist\/src\/cli\.js |npm )/, `${row.id} verify is real`);
    }
    // Unique ids.
    const ids = new Set(NEON_BLOCKED_ROW_READINESS.map((r) => r.id));
    assert.equal(ids.size, 13);
  });

  it("flags operator approval only for live-target and product-decision rows", () => {
    const snapshot = createNeonBlockedRowReadinessSnapshot({ env: {} });
    for (const row of snapshot.rows) {
      const expected =
        row.approval === "operator-live-target" || row.approval === "operator-product-decision";
      assert.equal(row.operatorApprovalNeeded, expected, `${row.id} operator flag`);
    }
    // Non-goal and upstream-protocol rows never need Operator.
    const nonGoal = snapshot.rows.find((r) => r.category === "non-goal");
    assert.ok(nonGoal && !nonGoal.operatorApprovalNeeded);
    const upstream = snapshot.rows.filter((r) => r.category === "upstream-protocol");
    assert.ok(upstream.length === 2 && upstream.every((r) => !r.operatorApprovalNeeded));
  });

  it("computes missing env live against the provided env (presence check)", () => {
    const empty = createNeonBlockedRowReadinessSnapshot({ env: {} });
    const sendRow = empty.rows.find((r) => r.id === "handle-send-chat");
    assert.ok(sendRow);
    assert.ok(sendRow.missingEnv.includes("NEON_CUTOVER_STAGE"));
    assert.ok(sendRow.missingEnv.includes("NEON_CHAT_SEND_CHANNELS"));
    assert.equal(sendRow.requiredEnvSatisfied, false);

    const armed = createNeonBlockedRowReadinessSnapshot({
      env: {
        NEON_CUTOVER_STAGE: "canary",
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
        NEON_CUTOVER_CANARY_CHANNELS: "123",
        NEON_CHAT_SEND_CHANNELS: "123"
      }
    });
    const armedSend = armed.rows.find((r) => r.id === "handle-send-chat");
    assert.ok(armedSend);
    assert.deepEqual(armedSend.missingEnv, []);
    assert.equal(armedSend.requiredEnvSatisfied, true);
  });

  it("treats blank env values as missing (whitespace is not set)", () => {
    const snapshot = createNeonBlockedRowReadinessSnapshot({
      env: { NEON_CUTOVER_STAGE: "   " }
    });
    const primary = snapshot.rows.find((r) => r.id === "primary-switch-default-routing");
    assert.ok(primary);
    assert.ok(primary.missingEnv.includes("NEON_CUTOVER_STAGE"));
  });

  it("totals the categories and renders a report", () => {
    const snapshot = createNeonBlockedRowReadinessSnapshot({ env: {} });
    assert.equal(snapshot.totals.total, 13);
    assert.equal(snapshot.totals.nonGoal, 1);
    assert.equal(snapshot.totals.upstreamProtocol, 2);
    assert.ok(snapshot.totals.operatorApprovalNeeded >= 1);
    assert.equal(
      snapshot.totals.liveSessionRuntime + snapshot.totals.upstreamProtocol + snapshot.totals.nonGoal +
        snapshot.rows.filter(
          (r) => r.category === "outbound-live-target" || r.category === "primary-cutover"
        ).length,
      13
    );

    const report = renderNeonBlockedRowReadinessReport(snapshot);
    assert.match(report, /Neonika Blocked-Row Readiness/);
    assert.match(report, /handleSendChat/);
    assert.match(report, /verify: node dist\/src\/cli\.js/);
  });

  it("renders a server-side panel from the snapshot without leaking env values", () => {
    const snapshot = createNeonBlockedRowReadinessSnapshot({
      env: { NEON_CUTOVER_CANARY_CHANNELS: "secret-channel-id-999" }
    });
    const html = renderNeonMissionControlBlockedReadinessPanel(snapshot);
    assert.match(html, /Blocked-Row Readiness/);
    assert.match(html, /\/api\/neon-blocked-readiness/);
    assert.match(html, /OPERATOR-FREIGABE/);
    // The panel shows env KEY names, never the operator's env VALUES.
    assert.doesNotMatch(html, /secret-channel-id-999/);
  });
});
