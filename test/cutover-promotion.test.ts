import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  loadNeonCutoverEnv,
  readNeonCutoverPromotion,
  resolveNeonCutoverPromotionPath,
  sanitizeNeonCutoverPromotionEnv,
  writeNeonCutoverPromotion
} from "../src/index.js";

async function withTempRoot<T>(run: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-cutover-promotion-"));
  try {
    return await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

describe("Neon cutover promotion state", () => {
  it("sanitizes to allowed non-secret keys and drops tokens and empties", () => {
    const sanitized = sanitizeNeonCutoverPromotionEnv({
      NEON_CUTOVER_STAGE: "primary",
      NEON_CUTOVER_PRIMARY_APPROVED: "ready",
      NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005",
      NEON_CUTOVER_ROLLBACK_COMMAND: "systemctl --user stop neonika-gateway",
      NEON_DISCORD_BOT_TOKEN: "MToooooo.secret.value",
      DISCORD_BOT_TOKEN: "MTaaaaaa.secret.value",
      NEON_CUTOVER_RETIRE_EVIDENCE: "   ",
      UNRELATED_KEY: "keep-out"
    });

    assert.deepEqual(sanitized, {
      NEON_CUTOVER_STAGE: "primary",
      NEON_CUTOVER_PRIMARY_APPROVED: "ready",
      NEON_CUTOVER_CANARY_CHANNELS: "900000000000000005",
      NEON_CUTOVER_ROLLBACK_COMMAND: "systemctl --user stop neonika-gateway"
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /secret/u);
    assert.ok(!("NEON_DISCORD_BOT_TOKEN" in sanitized));
    assert.ok(!("DISCORD_BOT_TOKEN" in sanitized));
    assert.ok(!("UNRELATED_KEY" in sanitized));
    assert.ok(!("NEON_CUTOVER_RETIRE_EVIDENCE" in sanitized));
  });

  it("writes a promotion file that never contains a token value", async () => {
    await withTempRoot(async (projectRoot) => {
      const promotion = await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_STAGE: "primary",
        NEON_CUTOVER_PRIMARY_APPROVED: "ready",
        NEON_DISCORD_BOT_TOKEN: "MToooo.never.persist",
        DISCORD_BOT_TOKEN: "MTaaaa.never.persist"
      });

      assert.equal(promotion.env["NEON_CUTOVER_STAGE"], "primary");
      const raw = await readFile(resolveNeonCutoverPromotionPath(projectRoot), "utf8");
      assert.doesNotMatch(raw, /MT[A-Za-z0-9._-]+/u);
      assert.doesNotMatch(raw, /persist/u);
      assert.match(raw, /"NEON_CUTOVER_STAGE": "primary"/u);
    });
  });

  it("round-trips a written promotion", async () => {
    await withTempRoot(async (projectRoot) => {
      assert.equal(await readNeonCutoverPromotion(projectRoot), undefined);
      await writeNeonCutoverPromotion(projectRoot, { NEON_CUTOVER_STAGE: "canary" });
      const read = await readNeonCutoverPromotion(projectRoot);
      assert.equal(read?.env["NEON_CUTOVER_STAGE"], "canary");
    });
  });

  it("lets live env override ordinary persisted cutover configuration", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_STAGE: "primary",
        NEON_CUTOVER_PRIMARY_APPROVED: "ready"
      });

      const merged = await loadNeonCutoverEnv(projectRoot, {
        NEON_CUTOVER_STAGE: "shadow"
      });

      // Live "shadow" overrides the persisted "primary"; persisted-only keys survive.
      assert.equal(merged["NEON_CUTOVER_STAGE"], "shadow");
      assert.equal(merged["NEON_CUTOVER_PRIMARY_APPROVED"], "ready");
    });
  });

  it("treats the persisted outbound arm as authoritative and fails closed", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonCutoverPromotion(projectRoot, {
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
      });

      const armed = await loadNeonCutoverEnv(projectRoot, {
        NEON_CUTOVER_OUTBOUND_ENABLED: "disabled"
      });
      assert.equal(armed["NEON_CUTOVER_OUTBOUND_ENABLED"], "ready");

      await writeNeonCutoverPromotion(projectRoot, {});
      const disarmed = await loadNeonCutoverEnv(projectRoot, {
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready"
      });
      assert.equal(disarmed["NEON_CUTOVER_OUTBOUND_ENABLED"], undefined);
    });
  });

  it("keeps ordinary live env when nothing is persisted", async () => {
    await withTempRoot(async (projectRoot) => {
      const liveEnv = { NEON_CUTOVER_STAGE: "shadow" } as const;
      const merged = await loadNeonCutoverEnv(projectRoot, liveEnv);
      assert.equal(merged["NEON_CUTOVER_STAGE"], "shadow");
    });
  });
});
