import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonDoctorSnapshot,
  writeNeonCutoverPromotion,
  type INeonDoctorCheck
} from "../src/index.js";

async function withTempRoot<T>(run: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-doctor-outbound-"));
  try {
    return await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function outboundCheck(checks: readonly INeonDoctorCheck[]): INeonDoctorCheck {
  const check = checks.find((entry) => entry.id === "outbound");
  assert.ok(check, "doctor must report an outbound check");
  return check;
}

const armedEnv = {
  NEON_DISCORD_BOT_TOKEN: "token-value",
  NEON_CUTOVER_CANARY_CHANNELS: "channel-1",
  NEON_CUTOVER_CANARY_APPROVED: "ready",
  NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
} as const;

/**
 * The doctor answers "will this send" for an operator who just installed. Silence is
 * not a fault — a disarmed install is behaving as promised. What must never happen is
 * the doctor claiming armed while the sender would still refuse.
 */
describe("Doctor outbound check", () => {
  it("reports disarmed as healthy on a fresh install", async () => {
    await withTempRoot(async (projectRoot) => {
      const snapshot = await createNeonDoctorSnapshot(projectRoot, { env: {} });
      const check = outboundCheck(snapshot.checks);

      assert.equal(check.state, "pass");
      assert.match(check.summary, /disarmed/);
    });
  });

  it("names what is missing so the operator knows the next step", async () => {
    await withTempRoot(async (projectRoot) => {
      const snapshot = await createNeonDoctorSnapshot(projectRoot, { env: {} });
      const check = outboundCheck(snapshot.checks);

      assert.match(check.details.join(" "), /token=missing/);
      assert.match(check.details.join(" "), /allowlist=unset/);
      assert.match(check.details.join(" "), /armed=no/);
    });
  });

  it("reports armed when every requirement holds", async () => {
    await withTempRoot(async (projectRoot) => {
      const snapshot = await createNeonDoctorSnapshot(projectRoot, { env: armedEnv });
      const check = outboundCheck(snapshot.checks);

      assert.equal(check.state, "pass");
      assert.match(check.summary, /armed/);
    });
  });

  it("warns when arming is on but the runtime still cannot send", async () => {
    await withTempRoot(async (projectRoot) => {
      const snapshot = await createNeonDoctorSnapshot(projectRoot, {
        env: { NEON_CUTOVER_OUTBOUND_ENABLED: "ready" }
      });
      const check = outboundCheck(snapshot.checks);

      // The dangerous state: an operator believing they send while they do not.
      assert.equal(check.state, "warn");
      assert.match(check.summary, /cannot send/);
      assert.match(check.summary, /bot token/);
    });
  });

  it("sees arming that lives in the persisted promotion, not just the environment", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonCutoverPromotion(projectRoot, armedEnv);

      // No env passed at all: the doctor must merge the persisted promotion, or it
      // would report an armed install as silent.
      const snapshot = await createNeonDoctorSnapshot(projectRoot);
      const check = outboundCheck(snapshot.checks);

      assert.match(check.details.join(" "), /armed=yes/);
    });
  });

  it("never prints the bot token", async () => {
    await withTempRoot(async (projectRoot) => {
      const snapshot = await createNeonDoctorSnapshot(projectRoot, { env: armedEnv });
      const serialised = JSON.stringify(outboundCheck(snapshot.checks));

      assert.doesNotMatch(serialised, /token-value/);
    });
  });
});
