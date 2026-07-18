import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION,
  createNeonDiscordComponentActionRegistry,
  createNeonDiscordPlanApprovalRuntime,
  isNeonDiscordPlanApprovalActionType,
  parseNeonDiscordPlanApprovalMarker,
  readNeonDiscordPlanApprovalSession,
  resolveNeonDiscordWorkGovernanceInstruction,
  writeNeonGatewayRun,
  type INeonDeliveryQueueTarget,
  type INeonGatewayShadowRun,
  type TNeonDiscordActionRow
} from "../src/index.js";

const nowIso = "2026-07-11T12:00:00.000Z";

describe("Neon Discord plan approval marker", () => {
  it("strips a valid marker and exposes the plan for the approval runtime", () => {
    const parsed = parseNeonDiscordPlanApprovalMarker(
      "Plan:\n1. Ziel klären.\n2. Umsetzung prüfen.\n<NEON_PLAN_APPROVAL />"
    );

    assert.equal(parsed.text, "Plan:\n1. Ziel klären.\n2. Umsetzung prüfen.");
    assert.equal(parsed.planApproval?.planText, parsed.text);
  });

  it("keeps ordinary replies unchanged and ignores marker-only plans", () => {
    assert.deepEqual(parseNeonDiscordPlanApprovalMarker("Direkt erledigt."), {
      text: "Direkt erledigt."
    });
    assert.deepEqual(parseNeonDiscordPlanApprovalMarker("<NEON_PLAN_APPROVAL />"), {
      text: ""
    });
  });

  it("defines the shared PDF and clarification policy for both Discord harnesses", () => {
    assert.match(NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION, /\$neon-pdf/u);
    assert.match(NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION, /\$neon-grill-me/u);
    assert.match(NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION, /\$grill-with-docs/u);
    assert.match(NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION, /exactly one question/iu);
    assert.match(NEON_DISCORD_WORK_GOVERNANCE_INSTRUCTION, /NEON_PLAN_APPROVAL/u);
  });

  it("executes clear work directly and disables planning in configured channels", () => {
    const regular = resolveNeonDiscordWorkGovernanceInstruction("channel-1", {
      NEON_DISCORD_PLAN_APPROVAL_DISABLED_CHANNELS: "disabled-channel"
    });
    const disabled = resolveNeonDiscordWorkGovernanceInstruction("disabled-channel", {
      NEON_DISCORD_PLAN_APPROVAL_DISABLED_CHANNELS: "disabled-channel"
    });

    assert.match(regular, /clear PDF and file tasks directly/iu);
    assert.match(regular, /NEON_PLAN_APPROVAL/u);
    assert.match(disabled, /plan approval is disabled/iu);
    assert.doesNotMatch(disabled, /NEON_PLAN_APPROVAL/u);
  });
});

describe("Neon Discord plan approval runtime", () => {
  it("does not present approval controls in disabled channels", async () => {
    const fixture = await createFixture("disabled-channel");
    try {
      const runtime = createNeonDiscordPlanApprovalRuntime({
        projectRoot: fixture.projectRoot,
        registry: fixture.registry,
        transport: fixture.transport,
        disabledChannelIds: [fixture.target.channelId],
        approve: () => Promise.resolve({ runId: "approved-run-unused" }),
        requestRevision: () => Promise.resolve({ runId: "revision-run-unused" }),
        now: () => new Date(nowIso)
      });

      assert.equal(await runtime.present(fixture.run, fixture.target, "Plan v1"), undefined);
      assert.deepEqual(fixture.labels(), []);
    } finally {
      await fixture.cleanup();
    }
  });

  it("approves exactly once and blocks sibling decisions", async () => {
    const fixture = await createFixture("approve");
    try {
      const approved: string[] = [];
      const runtime = createNeonDiscordPlanApprovalRuntime({
        projectRoot: fixture.projectRoot,
        registry: fixture.registry,
        transport: fixture.transport,
        approve: ({ planText }) => {
          approved.push(planText);
          return Promise.resolve({ runId: "approved-run-1" });
        },
        requestRevision: () => Promise.resolve({ runId: "revision-run-unused" }),
        now: () => new Date(nowIso)
      });
      const presented = await runtime.present(fixture.run, fixture.target, "1. Implementieren\n2. Prüfen");
      assert.ok(presented);
      assert.deepEqual(fixture.labels(), ["Genehmigen", "Bearbeiten", "Verwerfen"]);

      const approvedResult = await fixture.click("Genehmigen", "approve-click", "operator-a", "Ada Lovelace");
      const discardedResult = await fixture.click("Verwerfen", "discard-click");

      assert.equal(approvedResult.state, "completed");
      assert.equal(
        approvedResult.state === "completed" ? approvedResult.publicMessage : undefined,
        undefined
      );
      assert.equal(discardedResult.state, "rejected");
      assert.equal(discardedResult.reason, "already-consumed");
      assert.deepEqual(approved, ["1. Implementieren\n2. Prüfen"]);
      const session = await readNeonDiscordPlanApprovalSession(
        fixture.projectRoot,
        presented.approvalId
      );
      assert.equal(session?.status, "approved");
      assert.equal(session?.actedByUserId, "operator-a");
      assert.equal(session?.actedByDisplayName, "Ada Lovelace");
      assert.ok(isNeonDiscordPlanApprovalActionType("plan-approval:approve"));
    } finally {
      await fixture.cleanup();
    }
  });

  it("announces approval publicly before starting the approved follow-up run", async () => {
    const fixture = await createFixture("public-approval");
    try {
      const order: string[] = [];
      const publicMessages: string[] = [];
      const runtime = createNeonDiscordPlanApprovalRuntime({
        projectRoot: fixture.projectRoot,
        registry: fixture.registry,
        transport: {
          ...fixture.transport,
          postPublic: (_target, message) => {
            order.push("public");
            publicMessages.push(message);
            return Promise.resolve({ messageId: "public-approval-1" });
          }
        },
        approve: () => {
          order.push("approve");
          return Promise.resolve({ runId: "approved-run-1" });
        },
        requestRevision: () => Promise.resolve({ runId: "revision-run-unused" }),
        now: () => new Date(nowIso)
      });
      await runtime.present(fixture.run, fixture.target, "Plan v1");

      const result = await fixture.click("Genehmigen", "public-click", "operator-a", "Ada Lovelace");

      assert.equal(result.state, "completed");
      assert.deepEqual(order, ["public", "approve"]);
      assert.deepEqual(publicMessages, [
        "✅ Plan genehmigt von Ada Lovelace. Die Ausführung startet."
      ]);
      assert.equal(result.state === "completed" ? result.publicMessage : undefined, undefined);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps edit and discard owner-bound", async () => {
    const fixture = await createFixture("owner-only-decisions");
    try {
      const runtime = createNeonDiscordPlanApprovalRuntime({
        projectRoot: fixture.projectRoot,
        registry: fixture.registry,
        transport: fixture.transport,
        approve: () => Promise.resolve({ runId: "approved-run-unused" }),
        requestRevision: () => Promise.resolve({ runId: "revision-run-unused" }),
        now: () => new Date(nowIso)
      });
      await runtime.present(fixture.run, fixture.target, "Plan v1");

      const foreignEdit = await fixture.click("Bearbeiten", "foreign-edit", "operator-b", "Grace Hopper");
      const foreignDiscard = await fixture.click(
        "Verwerfen",
        "foreign-discard",
        "operator-b",
        "Grace Hopper"
      );

      assert.equal(foreignEdit.state, "rejected");
      assert.equal(foreignEdit.reason, "owner-mismatch");
      assert.equal(foreignDiscard.state, "rejected");
      assert.equal(foreignDiscard.reason, "owner-mismatch");
    } finally {
      await fixture.cleanup();
    }
  });

  it("collects one edit request through a modal and starts a fresh plan revision", async () => {
    const fixture = await createFixture("edit");
    try {
      const revisions: string[] = [];
      const runtime = createNeonDiscordPlanApprovalRuntime({
        projectRoot: fixture.projectRoot,
        registry: fixture.registry,
        transport: fixture.transport,
        approve: () => Promise.resolve({ runId: "approved-run-unused" }),
        requestRevision: ({ request }) => {
          revisions.push(request);
          return Promise.resolve({ runId: "revision-run-1" });
        },
        now: () => new Date(nowIso)
      });
      const presented = await runtime.present(fixture.run, fixture.target, "Plan v1");
      assert.ok(presented);

      const edit = await fixture.click("Bearbeiten", "edit-click");
      assert.equal(edit.state, "completed");
      assert.equal(edit.modal?.title, "Plan bearbeiten");
      assert.ok(edit.modal);

      const revision = await fixture.registry.dispatch({
        interactionId: "revision-submit",
        kind: "modal-submit",
        customId: edit.modal.customId,
        userId: "operator",
        guildId: "guild-1",
        channelId: "channel-1",
        fields: { "plan-change-request": "Schritt 2 kleiner schneiden." },
        createdAt: "2026-07-11T12:00:02.000Z"
      });

      assert.equal(revision.state, "completed");
      assert.deepEqual(revisions, ["Schritt 2 kleiner schneiden."]);
      const session = await readNeonDiscordPlanApprovalSession(
        fixture.projectRoot,
        presented.approvalId
      );
      assert.equal(session?.status, "revision-requested");
      assert.equal(session?.revisionRunId, "revision-run-1");
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createFixture(suffix: string): Promise<{
  readonly projectRoot: string;
  readonly registry: ReturnType<typeof createNeonDiscordComponentActionRegistry>;
  readonly run: INeonGatewayShadowRun;
  readonly target: INeonDeliveryQueueTarget;
  readonly transport: {
    postPublic(
      target: INeonDeliveryQueueTarget,
      content: string
    ): Promise<{ readonly messageId: string }>;
    postComponents(
      target: INeonDeliveryQueueTarget,
      content: string,
      rows: readonly TNeonDiscordActionRow[]
    ): Promise<{ readonly messageId: string }>;
  };
  labels(): readonly string[];
  click(
    label: string,
    interactionId: string,
    userId?: string,
    userDisplayName?: string
  ): ReturnType<
    ReturnType<typeof createNeonDiscordComponentActionRegistry>["dispatch"]
  >;
  cleanup(): Promise<void>;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), `neon-plan-approval-${suffix}-`));
  const registry = createNeonDiscordComponentActionRegistry({
    now: () => new Date(nowIso),
    statePath: join(projectRoot, "state", "gateway", "discord-component-actions.json")
  });
  const run = createRun(projectRoot);
  await writeNeonGatewayRun(projectRoot, run);
  const target: INeonDeliveryQueueTarget = {
    channel: "discord",
    accountId: "default",
    guildId: "guild-1",
    channelId: "channel-1"
  };
  let rows: readonly TNeonDiscordActionRow[] = [];
  const transport = {
    postPublic: (
      _target: INeonDeliveryQueueTarget,
      _content: string
    ) => Promise.resolve({ messageId: `plan-public-${suffix}` }),
    postComponents: (
      _target: INeonDeliveryQueueTarget,
      _content: string,
      nextRows: readonly TNeonDiscordActionRow[]
    ) => {
      rows = nextRows;
      return Promise.resolve({ messageId: `plan-card-${suffix}` });
    }
  };
  const labels = (): readonly string[] => {
    const row = rows[0];
    return row && "buttons" in row ? row.buttons.map((button) => button.label) : [];
  };
  const click = (
    label: string,
    interactionId: string,
    userId = "operator",
    userDisplayName = "the operator"
  ) => {
    const row = rows[0];
    if (!row || !("buttons" in row)) {
      throw new Error("Expected plan approval buttons");
    }
    const customId = row.buttons.find((button) => button.label === label)?.customId;
    assert.ok(customId);
    return registry.dispatch({
      interactionId,
      kind: "button",
      customId,
      userId,
      userDisplayName,
      guildId: "guild-1",
      channelId: "channel-1",
      createdAt: "2026-07-11T12:00:01.000Z"
    });
  };
  return {
    projectRoot,
    registry,
    run,
    target,
    transport,
    labels,
    click,
    cleanup: () => rm(projectRoot, { recursive: true, force: true })
  };
}

function createRun(projectRoot: string): INeonGatewayShadowRun {
  return {
    runId: "plan-source-run-1",
    mode: "live",
    status: "completed",
    request: {
      channel: "discord",
      accountId: "default",
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "source-message-1",
      userId: "operator",
      userDisplayName: "the operator",
      agentId: "chaty",
      workspaceRoot: projectRoot,
      mode: "write",
      contentPreview: "Baue das Feature",
      receivedAt: nowIso
    },
    harnessId: "codex-app-server",
    harnessSessionKey: "session-1",
    memoryState: "attached",
    events: [],
    finalText: "Plan v1",
    delivery: {
      state: "suppressed",
      targetChannel: "discord",
      targetChannelId: "channel-1",
      reason: "pending",
      finalText: "Plan v1"
    },
    startedAt: nowIso,
    completedAt: nowIso
  };
}
