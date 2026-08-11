import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderNeonGatedSideEffectPostureReport,
  resolveNeonGatedSideEffectPosture
} from "../src/index.js";

describe("Neon gated side-effect posture", () => {
  it("reports fully-shadowed with every gate off when no env is set", () => {
    const posture = resolveNeonGatedSideEffectPosture({});
    assert.equal(posture.state, "fully-shadowed");
    assert.equal(posture.totals.armed, 0);
    assert.equal(posture.totals.shadowed, posture.totals.gates);
    assert.equal(posture.totals.gates, 17);
    assert.deepEqual(posture.armedEnvKeys, []);
    assert.ok(posture.gates.every((gate) => gate.armed === false));
  });

  it("flips to partially-armed and lists the armed env keys", () => {
    const posture = resolveNeonGatedSideEffectPosture({
      NEON_DELIVERY_DRAIN_ENABLED: "1",
      NEON_LIVE_RUN_LIFECYCLE_ENABLED: "ready",
      NEON_CRON_DAEMON_ENABLED: "ready",
      NEON_CRON_TIMER_ENABLED: "ready",
      NEON_HEARTBEAT_DAEMON_ENABLED: "ready",
      NEON_HEARTBEAT_TIMER_ENABLED: "ready",
      NEON_SCHEDULED_AGENT_EXECUTION_ENABLED: "ready",
      NEON_WORKSPACE_NOTES_ENABLED: "ready"
    });
    assert.equal(posture.state, "partially-armed");
    assert.equal(posture.totals.armed, 8);
    assert.ok(posture.armedEnvKeys.includes("NEON_DELIVERY_DRAIN_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_LIVE_RUN_LIFECYCLE_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_CRON_DAEMON_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_CRON_TIMER_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_HEARTBEAT_DAEMON_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_HEARTBEAT_TIMER_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_SCHEDULED_AGENT_EXECUTION_ENABLED"));
    assert.ok(posture.armedEnvKeys.includes("NEON_WORKSPACE_NOTES_ENABLED"));
  });

  it("honors each gate's own arming rule (plugin-install is strict)", () => {
    // resolveNeonPluginInstallGate only accepts "true"/"1", not the ready-style flags.
    const ready = resolveNeonGatedSideEffectPosture({ NEON_PLUGIN_INSTALL_ENABLED: "ready" });
    const plugin = ready.gates.find((gate) => gate.key === "plugin-install");
    assert.equal(plugin?.armed, false);

    const armed = resolveNeonGatedSideEffectPosture({ NEON_PLUGIN_INSTALL_ENABLED: "true" });
    assert.equal(armed.gates.find((gate) => gate.key === "plugin-install")?.armed, true);
  });

  it("exposes a stable category-then-key ordering with full metadata", () => {
    const posture = resolveNeonGatedSideEffectPosture({});
    const ordering = posture.gates.map((gate) => `${gate.category}/${gate.key}`);
    const sorted = [...ordering].sort((left, right) => left.localeCompare(right));
    assert.deepEqual(ordering, sorted);

    for (const gate of posture.gates) {
      assert.ok(gate.envKey.startsWith("NEON_"));
      assert.ok(gate.sideEffect.length > 0);
    }
  });

  it("renders a readable posture report in both states", () => {
    const shadowed = renderNeonGatedSideEffectPostureReport(resolveNeonGatedSideEffectPosture({}));
    assert.match(shadowed, /State: fully-shadowed/);
    assert.match(shadowed, /Gates: 17 \(armed 0/);

    const armed = renderNeonGatedSideEffectPostureReport(
      resolveNeonGatedSideEffectPosture({ NEON_DOCTOR_FIX_ENABLED: "1" })
    );
    assert.match(armed, /State: partially-armed/);
    assert.match(armed, /Armed: NEON_DOCTOR_FIX_ENABLED/);
  });
});
