import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonFlowsSnapshot,
  planNeonFlowExecution,
  renderNeonFlowPlanReport,
  writeNeonFlow,
  type INeonFlowDefinition,
  type INeonFlowStep
} from "../src/index.js";

describe("Neon Flow planning", () => {
  it("plans read steps and blocks every gated side-effecting step, never executable", () => {
    const plan = planNeonFlowExecution(
      createFlow("flow-auto-reply", {
        steps: [
          step("recall", "read", "context.pack"),
          step("draft", "read", "agent.draft"),
          step("send", "send", "discord.send"),
          step("track", "write", "workboard.create")
        ]
      }),
      { now: fixedNow }
    );

    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.executable, false);
    assert.equal(plan.totals.steps, 4);
    assert.equal(plan.totals.plannable, 2);
    assert.equal(plan.totals.blocked, 2);
    assert.equal(plan.safety.autonomousExecution, false);
    assert.equal(plan.safety.gatedActionsRequireApproval, true);

    const send = plan.steps.find((entry) => entry.stepId === "send");
    const recall = plan.steps.find((entry) => entry.stepId === "recall");
    assert.equal(send?.decision, "blocked");
    assert.equal(send?.reason, "gated-side-effect");
    assert.equal(recall?.decision, "plan");
    assert.equal(recall?.reason, "read-only-step");
  });

  it("blocks every step of a disabled flow", () => {
    const plan = planNeonFlowExecution(
      createFlow("flow-off", {
        status: "disabled",
        steps: [step("recall", "read", "context.pack")]
      }),
      { now: fixedNow }
    );

    assert.equal(plan.totals.blocked, 1);
    assert.equal(plan.totals.plannable, 0);
    assert.equal(plan.steps[0]?.reason, "flow-disabled");
  });

  it("blocks a read step that is explicitly gated", () => {
    const plan = planNeonFlowExecution(
      createFlow("flow-gated-read", {
        steps: [{ stepId: "summary", title: "Summary", effect: "read", action: "agent.summarize", gated: true }]
      }),
      { now: fixedNow }
    );

    assert.equal(plan.steps[0]?.decision, "blocked");
    assert.equal(plan.steps[0]?.reason, "explicitly-gated");
  });

  it("projects blocked side-effecting steps as a waiting-approval list", () => {
    const plan = planNeonFlowExecution(
      createFlow("flow-approval", {
        steps: [
          step("recall", "read", "context.pack"),
          step("send", "send", "discord.send"),
          { stepId: "summary", title: "Summary", effect: "read", action: "agent.summarize", gated: true }
        ]
      }),
      { now: fixedNow }
    );

    assert.equal(plan.totals.waitingApproval, 2);
    assert.deepEqual(
      plan.waitingApproval.map((entry) => [entry.stepId, entry.reason]),
      [
        ["send", "gated-side-effect"],
        ["summary", "explicitly-gated"]
      ]
    );
    // A read-only step is plannable, never waiting for approval.
    assert.ok(!plan.waitingApproval.some((entry) => entry.stepId === "recall"));

    const report = renderNeonFlowPlanReport(plan);
    assert.match(report, /waiting approval: 2/);
    assert.match(report, /Waiting for approval \(2\):/);
  });

  it("reports zero waiting-approval steps for a disabled flow (the flow itself is off)", () => {
    const plan = planNeonFlowExecution(
      createFlow("flow-off", {
        status: "disabled",
        steps: [step("send", "send", "discord.send")]
      }),
      { now: fixedNow }
    );

    assert.equal(plan.totals.blocked, 1);
    assert.equal(plan.totals.waitingApproval, 0);
    assert.deepEqual(plan.waitingApproval, []);
  });

  it("keeps the plan leak-safe and renders a readable report", () => {
    const plan = planNeonFlowExecution(
      createFlow("flow-secret", {
        name: "Leak sk-live-0123456789abcdefghij flow",
        steps: [step("send", "send", "discord.send")]
      }),
      { now: fixedNow }
    );
    const report = renderNeonFlowPlanReport(plan);

    assert.match(report, /executable: false/);
    assert.match(report, /\[BLOCKED\]/);
  });

  it("summarizes stored flows with gated-step counts", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-flow-plan-"));

    try {
      await writeNeonFlow(
        projectRoot,
        createFlow("flow-armed", {
          status: "armed",
          steps: [step("recall", "read", "context.pack"), step("send", "send", "discord.send")]
        })
      );
      await writeNeonFlow(projectRoot, createFlow("flow-draft", { status: "draft" }));

      const snapshot = await createNeonFlowsSnapshot(projectRoot, { now: fixedNow });

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.flows, 2);
      assert.equal(snapshot.totals.armed, 1);
      assert.equal(snapshot.totals.gatedSteps, 1);
      assert.equal(snapshot.flows[0]?.flowId, "flow-armed", "armed flows sort first");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

function step(stepId: string, effect: INeonFlowStep["effect"], action: string): INeonFlowStep {
  return {
    stepId,
    title: `${stepId} step`,
    effect,
    action,
    gated: effect !== "read"
  };
}

function createFlow(flowId: string, overrides: Partial<INeonFlowDefinition>): INeonFlowDefinition {
  return {
    flowId,
    name: "Sample flow",
    ownerAgentId: "neo",
    trigger: { kind: "manual" },
    steps: [step("recall", "read", "context.pack")],
    status: "armed",
    createdAt: "2026-06-02T10:00:00.000Z",
    updatedAt: "2026-06-02T10:00:00.000Z",
    ...overrides
  };
}

function fixedNow(): Date {
  return new Date("2026-06-02T12:00:00.000Z");
}
