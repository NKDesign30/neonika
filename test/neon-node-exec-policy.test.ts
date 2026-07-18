import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonNodeActionRequestSnapshot,
  createNeonNodeExecPolicySnapshot,
  renderNeonNodeExecPolicyReport,
  resolveNeonNodeExecPolicy
} from "../src/index.js";

describe("neonNodeExecPolicy", () => {
  it("blocks system.run with execution disabled and no allowlist coverage", () => {
    const decision = resolveNeonNodeExecPolicy("system.run");

    assert.equal(decision.kind, "system.run");
    assert.equal(decision.state, "blocked");
    assert.equal(decision.reason, "not-allowlisted");
    assert.equal(decision.executed, false);
  });

  it("keeps an allowlisted kind blocked while execution is disabled", () => {
    const decision = resolveNeonNodeExecPolicy("system.run", ["system.run"]);

    assert.equal(decision.state, "blocked");
    assert.equal(decision.reason, "execution-disabled");
    assert.equal(decision.executed, false);
  });

  it("builds a read-only snapshot that never enables execution", () => {
    const snapshot = createNeonNodeExecPolicySnapshot();

    assert.equal(snapshot.state, "read-only");
    assert.equal(snapshot.executionEnabled, false);
    assert.deepEqual(
      snapshot.decisions.map((decision) => decision.kind),
      ["system.run"]
    );
    assert.ok(snapshot.decisions.every((decision) => decision.executed === false));

    const report = renderNeonNodeExecPolicyReport(snapshot);
    assert.match(report, /Neonika Node Exec Policy: read-only/);
    assert.match(report, /system\.run: blocked/);
  });

  it("is surfaced read-only in the node action-requests snapshot", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-exec-policy-"));

    try {
      const snapshot = await createNeonNodeActionRequestSnapshot(projectRoot, {
        now: () => new Date("2026-06-01T00:00:00.000Z")
      });

      assert.equal(snapshot.execPolicy.executionEnabled, false);
      assert.equal(snapshot.execPolicy.state, "read-only");
      assert.equal(snapshot.execPolicy.decisions[0]?.kind, "system.run");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
