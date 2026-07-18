import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  neonImplicitMentionKindWhen,
  renderNeonInboundMentionDecisionReport,
  resolveNeonInboundMentionDecision,
  type INeonInboundMentionPolicy
} from "../src/index.js";

const groupRequireMention: INeonInboundMentionPolicy = {
  isGroup: true,
  requireMention: true,
  allowTextCommands: true,
  hasControlCommand: false,
  commandAuthorized: false
};

describe("Neon inbound mention decision (upstream resolveInboundMentionDecision parity)", () => {
  it("skips a mention-required message that was not mentioned", () => {
    const decision = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false },
      policy: groupRequireMention
    });
    assert.equal(decision.shouldSkip, true);
    assert.equal(decision.effectiveWasMentioned, false);
  });

  it("does not skip when explicitly mentioned", () => {
    const decision = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: true },
      policy: groupRequireMention
    });
    assert.equal(decision.shouldSkip, false);
    assert.equal(decision.effectiveWasMentioned, true);
  });

  it("counts an allow-listed implicit mention as effective and skips disallowed ones", () => {
    const allowed = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, implicitMentionKinds: ["reply_to_bot"] },
      policy: { ...groupRequireMention, allowedImplicitMentionKinds: ["reply_to_bot"] }
    });
    assert.equal(allowed.implicitMention, true);
    assert.deepEqual(allowed.matchedImplicitMentionKinds, ["reply_to_bot"]);
    assert.equal(allowed.shouldSkip, false);

    const disallowed = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, implicitMentionKinds: ["quoted_bot"] },
      policy: { ...groupRequireMention, allowedImplicitMentionKinds: ["reply_to_bot"] }
    });
    assert.equal(disallowed.implicitMention, false);
    assert.equal(disallowed.shouldSkip, true);
  });

  it("bypasses the mention requirement for an authorized control command in a group", () => {
    const bypass = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: false },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true
      }
    });
    assert.equal(bypass.shouldBypassMention, true);
    assert.equal(bypass.effectiveWasMentioned, true);
    assert.equal(bypass.shouldSkip, false);

    // Another user's mention in the message disables the bypass.
    const noBypass = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: true, wasMentioned: false, hasAnyMention: true },
      policy: {
        isGroup: true,
        requireMention: true,
        allowTextCommands: true,
        hasControlCommand: true,
        commandAuthorized: true
      }
    });
    assert.equal(noBypass.shouldBypassMention, false);
    assert.equal(noBypass.shouldSkip, true);
  });

  it("never skips when mentions cannot be detected", () => {
    const decision = resolveNeonInboundMentionDecision({
      facts: { canDetectMention: false, wasMentioned: false },
      policy: groupRequireMention
    });
    assert.equal(decision.shouldSkip, false);
  });

  it("builds conditional implicit-kind lists and renders a report", () => {
    assert.deepEqual(neonImplicitMentionKindWhen("native", true), ["native"]);
    assert.deepEqual(neonImplicitMentionKindWhen("native", false), []);

    const report = renderNeonInboundMentionDecisionReport(
      resolveNeonInboundMentionDecision({
        facts: { canDetectMention: true, wasMentioned: false },
        policy: groupRequireMention
      })
    );
    assert.match(report, /Should skip: true/);
    assert.match(report, /Bypass mention: false/);
  });
});
