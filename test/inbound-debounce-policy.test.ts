import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonInboundDebounceReport,
  resolveNeonInboundDebounceMs,
  shouldDebounceNeonTextInbound
} from "../src/index.js";

describe("Neon inbound debounce policy (upstream inbound-debounce parity)", () => {
  it("debounces ordinary text but never commands, media, empty, or opt-outs", () => {
    assert.equal(shouldDebounceNeonTextInbound({ text: "hello there", isControlCommand: false }), true);
    assert.equal(shouldDebounceNeonTextInbound({ text: "/help", isControlCommand: true }), false);
    assert.equal(
      shouldDebounceNeonTextInbound({ text: "look", isControlCommand: false, hasMedia: true }),
      false
    );
    assert.equal(shouldDebounceNeonTextInbound({ text: "", isControlCommand: false }), false);
    assert.equal(shouldDebounceNeonTextInbound({ text: "   ", isControlCommand: false }), false);
    assert.equal(shouldDebounceNeonTextInbound({ text: null, isControlCommand: false }), false);
    assert.equal(
      shouldDebounceNeonTextInbound({ text: "hello", isControlCommand: false, allowDebounce: false }),
      false
    );
  });

  it("resolves the debounce window with override > channel > base > 0", () => {
    assert.equal(
      resolveNeonInboundDebounceMs({ baseDebounceMs: 100, byChannelMs: 200, overrideMs: 300 }),
      300
    );
    assert.equal(resolveNeonInboundDebounceMs({ baseDebounceMs: 100, byChannelMs: 200 }), 200);
    assert.equal(resolveNeonInboundDebounceMs({ baseDebounceMs: 100 }), 100);
    assert.equal(resolveNeonInboundDebounceMs({}), 0);
  });

  it("clamps each candidate to a non-negative integer and skips invalid ones", () => {
    assert.equal(resolveNeonInboundDebounceMs({ overrideMs: -50, baseDebounceMs: 100 }), 0);
    assert.equal(resolveNeonInboundDebounceMs({ overrideMs: 150.9 }), 150);
    // NaN override is skipped, falls through to the base.
    assert.equal(resolveNeonInboundDebounceMs({ overrideMs: Number.NaN, baseDebounceMs: 80 }), 80);
  });

  it("renders a readable report", () => {
    const report = renderNeonInboundDebounceReport({ decision: true, debounceMs: 250 });
    assert.match(report, /Debounce: true/);
    assert.match(report, /Window: 250ms/);
  });
});
