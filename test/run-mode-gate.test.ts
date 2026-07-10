import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSessionBindingFromGatewayMessage,
  resolveNeonHarnessRunMode,
  type INeonGatewayInboundMessage
} from "../src/index.js";

describe("Neon harness write-mode gate", () => {
  it("keeps read-only requests read-only regardless of the flag", () => {
    const decision = resolveNeonHarnessRunMode("read-only", {
      NEON_HARNESS_WRITE_ENABLED: "1"
    });

    assert.equal(decision.mode, "read-only");
    assert.equal(decision.writeEnabled, false);
    assert.equal(decision.reason, "requested-read-only");
  });

  it("downgrades a write request to read-only when the flag is absent", () => {
    const decision = resolveNeonHarnessRunMode("write", {});

    assert.equal(decision.mode, "read-only");
    assert.equal(decision.requested, "write");
    assert.equal(decision.reason, "write-gate-closed");
  });

  it("allows write only with an explicit ready flag (1/ready/true/yes)", () => {
    for (const value of ["1", "ready", "true", "yes"]) {
      const decision = resolveNeonHarnessRunMode("write", {
        NEON_HARNESS_WRITE_ENABLED: value
      });
      assert.equal(decision.mode, "write", `value ${value} should enable write`);
      assert.equal(decision.reason, "write-enabled");
    }
  });

  it("forces the gateway binding to read-only by default even if the message asks for write", () => {
    const binding = createSessionBindingFromGatewayMessage(writeMessage(), {});
    assert.equal(binding.mode, "read-only");

    const gated = createSessionBindingFromGatewayMessage(writeMessage(), {
      NEON_HARNESS_WRITE_ENABLED: "1"
    });
    assert.equal(gated.mode, "write");
  });
});

function writeMessage(): INeonGatewayInboundMessage {
  return {
    channel: "discord",
    accountId: "default",
    channelId: "channel-1",
    userId: "operator",
    agentId: "chaty",
    workspaceRoot: "/Users/operator/neon-projects/neon-core",
    mode: "write",
    content: "write please",
    createdAt: "2026-06-02T11:30:00.000Z"
  };
}
