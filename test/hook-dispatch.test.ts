import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonReadOnlyHookHandlers,
  dispatchNeonInternalHook,
  renderNeonHookDispatchReport,
  resolveNeonHookDispatchGate,
  type INeonHookDispatchGate,
  type INeonReadOnlyHookHandler
} from "../src/index.js";

const fixedNow = new Date("2026-06-02T12:00:00.000Z");
const armedGate: INeonHookDispatchGate = {
  enabled: true,
  reason: "dispatch-enabled",
  envKey: "NEON_HOOK_DISPATCH_ENABLED"
};
const closedGate: INeonHookDispatchGate = {
  enabled: false,
  reason: "dispatch-disabled",
  envKey: "NEON_HOOK_DISPATCH_ENABLED"
};

describe("Neon internal hook dispatch (DP-9)", () => {
  it("keeps dispatch off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonHookDispatchGate({}).enabled, false);
    assert.equal(resolveNeonHookDispatchGate({}).reason, "dispatch-disabled");

    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonHookDispatchGate({ NEON_HOOK_DISPATCH_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonHookDispatchGate({ NEON_HOOK_DISPATCH_ENABLED: "0" }).enabled, false);
  });

  it("runs no handler while the dispatch gate is closed", () => {
    const result = dispatchNeonInternalHook({
      event: "gateway:startup",
      gate: closedGate,
      now: () => fixedNow
    });

    assert.equal(result.dispatched, false);
    assert.equal(result.ranHandlers.length, 0);
    assert.equal(result.audit.length, 0);
    assert.equal(result.safety.mutated, false);
    assert.equal(result.safety.outboundSent, false);
  });

  it("runs the read-only observer for a registered event when armed", () => {
    const result = dispatchNeonInternalHook({
      event: "gateway:startup",
      gate: armedGate,
      now: () => fixedNow
    });

    assert.equal(result.dispatched, true);
    assert.deepEqual(result.ranHandlers, ["gateway-start-observer"]);
    assert.equal(result.audit.length, 1);
    assert.equal(result.audit[0]?.outcome, "observed");
    assert.equal(result.safety.mutated, false);
    assert.equal(result.safety.outboundSent, false);
  });

  it("dispatches but runs nothing when no handler is registered for the event", () => {
    // session:compact:after is a catalog event with no loaded read-only dispatch handler.
    const result = dispatchNeonInternalHook({
      event: "session:compact:after",
      gate: armedGate,
      now: () => fixedNow
    });

    assert.equal(result.dispatched, true);
    assert.equal(result.ranHandlers.length, 0);
    assert.equal(result.audit.length, 0);
  });

  it("observes message:received read-only when armed and runs nothing while gated off", () => {
    const armed = dispatchNeonInternalHook({
      event: "message:received",
      gate: armedGate,
      payload: "inbound discord message",
      now: () => fixedNow
    });

    assert.equal(armed.dispatched, true);
    assert.deepEqual(armed.ranHandlers, ["message-received-observer"]);
    assert.equal(armed.audit[0]?.outcome, "observed");
    assert.match(armed.audit[0]?.observation ?? "", /observed inbound message:received/);
    assert.equal(armed.safety.mutated, false);
    assert.equal(armed.safety.outboundSent, false);

    const off = dispatchNeonInternalHook({
      event: "message:received",
      gate: closedGate,
      payload: "inbound discord message",
      now: () => fixedNow
    });

    assert.equal(off.dispatched, false);
    assert.equal(off.ranHandlers.length, 0);
    assert.equal(off.audit.length, 0);
  });

  it("never runs a handler that is not declared read-only", () => {
    // Controlled cast: inject a write-capable handler to prove the runtime policy
    // filter — `observe` would throw if the dispatch path ever ran it.
    const writeHandler = {
      hookId: "rogue-writer",
      event: "gateway:startup",
      policy: "write",
      observe: () => {
        throw new Error("a non-read-only handler must never run on this path");
      }
    } as unknown as INeonReadOnlyHookHandler;

    const result = dispatchNeonInternalHook({
      event: "gateway:startup",
      gate: armedGate,
      handlers: [...createNeonReadOnlyHookHandlers(), writeHandler],
      now: () => fixedNow
    });

    assert.deepEqual(result.skippedNonReadOnly, ["rogue-writer"]);
    assert.equal(result.ranHandlers.includes("rogue-writer"), false);
    assert.deepEqual(result.ranHandlers, ["gateway-start-observer"]);
  });

  it("redacts a secret-bearing payload in the audit", () => {
    const result = dispatchNeonInternalHook({
      event: "gateway:startup",
      gate: armedGate,
      payload: "token sk-abcdef0123456789ABCDEF",
      now: () => fixedNow
    });

    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /sk-abcdef/);
    assert.match(result.audit[0]?.observation ?? "", /\[REDACTED_SECRET\]/);
  });

  it("reduces a throwing handler to a fixed leak-free error marker", () => {
    const throwingHandler: INeonReadOnlyHookHandler = {
      hookId: "boom",
      event: "gateway:startup",
      policy: "read-only",
      observe: () => {
        throw new Error("secret-token-sk-abcdef0123456789ABCDEF in error");
      }
    };

    const result = dispatchNeonInternalHook({
      event: "gateway:startup",
      gate: armedGate,
      handlers: [throwingHandler],
      now: () => fixedNow
    });

    assert.equal(result.audit[0]?.outcome, "handler-error");
    assert.equal(result.audit[0]?.observation, "handler-error");
    assert.doesNotMatch(JSON.stringify(result), /sk-abcdef/);
  });

  it("renders a report that names the gate and safety posture", () => {
    const report = renderNeonHookDispatchReport(
      dispatchNeonInternalHook({ event: "gateway:startup", gate: closedGate, now: () => fixedNow })
    );

    assert.match(report, /Neonika Hook Dispatch: disabled/);
    assert.match(report, /mutated=false outboundSent=false/);
  });
});
