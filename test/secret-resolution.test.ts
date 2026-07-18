import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonSecretResolutionReport,
  resolveNeonSecretRef,
  resolveNeonSecretResolutionGate,
  type INeonSecretResolutionGate,
  type TNeonOpRunner
} from "../src/index.js";

const ref = "op://Automation/Neon Discord Bot/credential";
const fakeSecret = "fake-secret-value-1234567890-abcdef";
const armedGate: INeonSecretResolutionGate = {
  enabled: true,
  reason: "resolution-enabled",
  envKey: "NEON_SECRET_RESOLUTION_ENABLED"
};
const closedGate: INeonSecretResolutionGate = {
  enabled: false,
  reason: "resolution-disabled",
  envKey: "NEON_SECRET_RESOLUTION_ENABLED"
};
const okRunner: TNeonOpRunner = () => Promise.resolve({ exitCode: 0, stdout: `${fakeSecret}\n`, stderr: "" });

describe("Neon secret-ref resolution (DP-13)", () => {
  it("keeps resolution off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonSecretResolutionGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonSecretResolutionGate({ NEON_SECRET_RESOLUTION_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonSecretResolutionGate({ NEON_SECRET_RESOLUTION_ENABLED: "0" }).enabled, false);
  });

  it("blocks resolution while the gate is closed and never invokes op", async () => {
    let invoked = false;
    const result = await resolveNeonSecretRef({
      ref,
      gate: closedGate,
      runOp: () => {
        invoked = true;
        return Promise.resolve({ exitCode: 0, stdout: fakeSecret, stderr: "" });
      }
    });

    assert.equal(result.state, "blocked");
    assert.equal(result.blockReason, "gate-disabled");
    assert.equal(invoked, false);
  });

  it("blocks a non-op reference", async () => {
    const result = await resolveNeonSecretRef({ ref: "just-a-plain-value", gate: armedGate, runOp: okRunner });
    assert.equal(result.state, "blocked");
    assert.equal(result.blockReason, "not-a-ref");
  });

  it("blocks invalid timeouts before invoking op", async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      let invoked = false;
      const result = await resolveNeonSecretRef({
        ref,
        gate: armedGate,
        timeoutMs,
        runOp: () => {
          invoked = true;
          return Promise.resolve({ exitCode: 0, stdout: fakeSecret, stderr: "" });
        }
      });

      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "invalid-timeout");
      assert.equal(invoked, false);
    }
  });

  it("blocks when op exits non-zero without leaking stderr", async () => {
    const result = await resolveNeonSecretRef({
      ref,
      gate: armedGate,
      runOp: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "1Password error: stderr-leak-token-xyz" })
    });
    assert.equal(result.state, "blocked");
    assert.equal(result.blockReason, "resolution-failed");
    // stderr can echo environment/ref detail, so it must never reach the result.
    assert.doesNotMatch(JSON.stringify(result), /stderr-leak-token/);
  });

  it("resolves through op but never returns, logs, or persists the value", async () => {
    const result = await resolveNeonSecretRef({ ref, gate: armedGate, runOp: okRunner });

    assert.equal(result.state, "resolved");
    assert.equal(result.valueLength, fakeSecret.length);
    assert.ok(result.valueFingerprint && result.valueFingerprint.length === 16);
    assert.equal(result.valuePersisted, false);
    assert.equal(result.valueLogged, false);
    assert.equal(result.safety.secretInResult, false);
    // The single most important assertion: the value is nowhere in the result.
    assert.doesNotMatch(JSON.stringify(result), /fake-secret-value/);
    assert.doesNotMatch(renderNeonSecretResolutionReport(result), /fake-secret-value/);
  });

  it("hands the raw value to a transient consumer exactly once", async () => {
    const consumed: string[] = [];
    await resolveNeonSecretRef({
      ref,
      gate: armedGate,
      runOp: okRunner,
      consume: (value) => consumed.push(value)
    });

    assert.deepEqual(consumed, [fakeSecret]);
  });

  it("redacts the ref to vault/item/field shape without the value", async () => {
    const result = await resolveNeonSecretRef({ ref, gate: armedGate, runOp: okRunner });
    assert.equal(result.refRedacted, "op://Automation/Neon Discord Bot/credential");
  });
});
