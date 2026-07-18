import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compileNeonAllowFrom,
  expandNeonAllowFromWithAccessGroups,
  isNeonSenderIdAllowed,
  resolveNeonAccessGroupMatchState,
  resolveNeonDirectDmAccess,
  resolveNeonInboundAccessDecision,
  renderNeonInboundAccessDecisionReport,
  type INeonInboundAccessFacts,
  type TNeonAccessGroup
} from "../src/index.js";

function isSenderAllowed(senderId: string, allowFrom: readonly string[]): boolean {
  return isNeonSenderIdAllowed(compileNeonAllowFrom(allowFrom), senderId, false);
}

const opsGroup: Record<string, TNeonAccessGroup> = {
  ops: {
    type: "message.senders",
    members: { "*": ["operator"], discord: ["chaty"] }
  }
};

function baseGroupFacts(overrides: Partial<INeonInboundAccessFacts> = {}): INeonInboundAccessFacts {
  return {
    channel: "discord",
    isGroup: true,
    senderId: "operator",
    hasControlCommand: false,
    requireMention: false,
    canDetectMention: true,
    wasMentioned: false,
    ...overrides
  };
}

describe("Neon access-group expansion", () => {
  it("matches an inline message.senders group by channel or wildcard", () => {
    const matched = resolveNeonAccessGroupMatchState({
      allowFrom: ["accessGroup:ops"],
      accessGroups: opsGroup,
      channel: "discord",
      senderId: "chaty",
      isSenderAllowed
    });
    assert.deepEqual(matched.matched, ["ops"]);
    assert.equal(matched.hasMatch, true);
  });

  it("reports missing and unsupported group references without throwing", () => {
    const state = resolveNeonAccessGroupMatchState({
      allowFrom: ["accessGroup:ghost", "accessGroup:ops"],
      accessGroups: opsGroup,
      channel: "discord",
      senderId: "stranger",
      isSenderAllowed
    });
    assert.deepEqual(state.missing, ["ghost"]);
    assert.equal(state.hasMatch, false);
  });

  it("folds the sender id into the effective allow-from on a group match", () => {
    const effective = expandNeonAllowFromWithAccessGroups({
      allowFrom: ["accessGroup:ops"],
      accessGroups: opsGroup,
      channel: "discord",
      senderId: "chaty",
      isSenderAllowed
    });
    assert.ok(effective.includes("chaty"));
  });

  it("leaves the allow-from unchanged when no group matches", () => {
    const effective = expandNeonAllowFromWithAccessGroups({
      allowFrom: ["accessGroup:ops"],
      accessGroups: opsGroup,
      channel: "discord",
      senderId: "stranger",
      isSenderAllowed
    });
    assert.deepEqual(effective, ["accessGroup:ops"]);
  });
});

describe("Neon direct DM access", () => {
  it("allows open DMs with no allowlist", () => {
    const access = resolveNeonDirectDmAccess({ dmPolicy: "open", senderId: "anyone" });
    assert.equal(access.decision, "allow");
    assert.equal(access.reasonCode, "dm_policy_open");
  });

  it("blocks disabled DMs outright", () => {
    const access = resolveNeonDirectDmAccess({ dmPolicy: "disabled", senderId: "operator" });
    assert.equal(access.decision, "block");
    assert.equal(access.reasonCode, "dm_policy_disabled");
  });

  it("allowlists by sender id", () => {
    const allowed = resolveNeonDirectDmAccess({
      dmPolicy: "allowlist",
      allowFrom: ["operator"],
      senderId: "operator"
    });
    const denied = resolveNeonDirectDmAccess({
      dmPolicy: "allowlist",
      allowFrom: ["operator"],
      senderId: "stranger"
    });
    assert.equal(allowed.decision, "allow");
    assert.equal(denied.decision, "block");
    assert.equal(denied.reasonCode, "dm_policy_not_allowlisted");
  });

  it("requires pairing for unknown senders under the pairing policy", () => {
    const access = resolveNeonDirectDmAccess({
      dmPolicy: "pairing",
      allowFrom: ["operator"],
      senderId: "stranger"
    });
    assert.equal(access.decision, "pairing");
    assert.equal(access.reasonCode, "dm_policy_pairing_required");
  });
});

describe("Neon inbound access decision chain", () => {
  it("allows when no access config is set (reduces to the mention gate)", () => {
    const decision = resolveNeonInboundAccessDecision(baseGroupFacts());
    assert.equal(decision.outcome, "allow");
  });

  it("drops a guild sender not in the configured allow-from", () => {
    const decision = resolveNeonInboundAccessDecision(
      baseGroupFacts({ senderId: "stranger", allowFrom: ["operator"] })
    );
    assert.equal(decision.outcome, "block");
    assert.equal(decision.blockReason, "sender-not-allowed");
  });

  it("admits a guild sender resolved through an access group", () => {
    const decision = resolveNeonInboundAccessDecision(
      baseGroupFacts({ senderId: "chaty", allowFrom: ["accessGroup:ops"], accessGroups: opsGroup })
    );
    assert.equal(decision.outcome, "allow");
    assert.equal(decision.senderAllowed, true);
    assert.deepEqual(decision.accessGroups.matched, ["ops"]);
  });

  it("blocks an unauthorized control command when text commands are on", () => {
    const decision = resolveNeonInboundAccessDecision(
      baseGroupFacts({
        senderId: "operator",
        allowTextCommands: true,
        hasControlCommand: true
      })
    );
    // useAccessGroups defaults true, nothing configured -> not authorized -> blocked.
    assert.equal(decision.outcome, "block");
    assert.equal(decision.blockReason, "command-not-authorized");
  });

  it("lets an authorized control command bypass a required mention", () => {
    const decision = resolveNeonInboundAccessDecision(
      baseGroupFacts({
        senderId: "operator",
        allowFrom: ["operator"],
        allowTextCommands: true,
        hasControlCommand: true,
        requireMention: true,
        wasMentioned: false
      })
    );
    assert.equal(decision.outcome, "allow");
    assert.equal(decision.commandAuthorized, true);
    assert.equal(decision.mention.shouldBypassMention, true);
  });

  it("blocks a DM under the disabled policy and surfaces the reason", () => {
    const decision = resolveNeonInboundAccessDecision({
      channel: "discord",
      isGroup: false,
      senderId: "operator",
      dmPolicy: "disabled",
      hasControlCommand: false,
      requireMention: false,
      canDetectMention: true,
      wasMentioned: false
    });
    assert.equal(decision.outcome, "block");
    assert.equal(decision.blockReason, "dm-not-allowed");
    assert.equal(decision.dmAccess?.reasonCode, "dm_policy_disabled");
  });

  it("requires pairing for an unknown DM sender", () => {
    const decision = resolveNeonInboundAccessDecision({
      channel: "discord",
      isGroup: false,
      senderId: "stranger",
      allowFrom: ["operator"],
      dmPolicy: "pairing",
      hasControlCommand: false,
      requireMention: false,
      canDetectMention: true,
      wasMentioned: false
    });
    assert.equal(decision.outcome, "block");
    assert.equal(decision.blockReason, "dm-pairing-required");
  });

  it("renders a leak-safe report without sender ids", () => {
    const decision = resolveNeonInboundAccessDecision(
      baseGroupFacts({ senderId: "secret-user", allowFrom: ["operator"] })
    );
    const report = renderNeonInboundAccessDecisionReport(decision);
    assert.doesNotMatch(report, /secret-user/);
    assert.match(report, /Outcome: block \(sender-not-allowed\)/);
  });
});
