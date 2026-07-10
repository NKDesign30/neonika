import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonMissionControlGatePosturePanel,
  resolveNeonGatedSideEffectPosture,
  type INeonGatedSideEffectPosture
} from "../src/index.js";

describe("Neon Mission-Control gate posture panel", () => {
  it("renders a fully-shadowed badge and a row per gate", () => {
    const posture = resolveNeonGatedSideEffectPosture({});
    const html = renderNeonMissionControlGatePosturePanel(posture);

    assert.match(html, /FULLY SHADOWED/);
    assert.match(html, /class="tag ok" id="gatePostureState"/);
    assert.match(html, /armed 0 · shadowed 16/);
    // One shadow tag per gate, no armed rows.
    assert.equal((html.match(/class="tag shadow">shadow/g) ?? []).length, 16);
    assert.doesNotMatch(html, /class="tag warn">ARMED/);
  });

  it("flags an armed gate with a warn badge", () => {
    const posture = resolveNeonGatedSideEffectPosture({ NEON_DOCTOR_FIX_ENABLED: "1" });
    const html = renderNeonMissionControlGatePosturePanel(posture);

    assert.match(html, /class="tag warn" id="gatePostureState">1 ARMED/);
    assert.match(html, /class="tag warn">ARMED<\/span> <strong>doctor-fix<\/strong>/);
  });

  it("escapes dynamic gate fields", () => {
    const malicious: INeonGatedSideEffectPosture = {
      state: "partially-armed",
      totals: { gates: 1, armed: 1, shadowed: 0 },
      armedEnvKeys: ["NEON_X"],
      gates: [
        {
          key: "x",
          envKey: "NEON_X",
          category: "execution",
          armed: true,
          sideEffect: "<script>alert(1)</script>"
        }
      ]
    };
    const html = renderNeonMissionControlGatePosturePanel(malicious);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});
