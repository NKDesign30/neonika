import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonCutoverGateSnapshot,
  isNeonOutboundStage,
  loadNeonCutoverEnv,
  neonDefaultCutoverStage,
  resolveCutoverStageFromEnv,
  writeNeonCutoverPromotion
} from "../src/index.js";

async function withTempRoot<T>(run: (projectRoot: string) => Promise<T>): Promise<T> {
  const projectRoot = await mkdtemp(join(tmpdir(), "neon-cutover-default-"));
  try {
    return await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

/**
 * A fresh install — no cutover env, no persisted promotion — resolves to `primary`
 * rather than `shadow`. The rungs below primary compare an old runtime against a new
 * one, which an install with no predecessor can never satisfy.
 *
 * The precedence guarantees matter as much as the default itself: every promoted
 * install carries a promotion file, so changing the fallback must leave them alone.
 */
describe("Default cutover stage for unconfigured installs", () => {
  it("resolves to primary when the env names no stage", () => {
    assert.equal(resolveCutoverStageFromEnv({}), "primary");
    assert.equal(resolveCutoverStageFromEnv({}), neonDefaultCutoverStage);
  });

  it("resolves to primary when the env names an unknown stage", () => {
    assert.equal(resolveCutoverStageFromEnv({ NEON_CUTOVER_STAGE: "banana" }), "primary");
  });

  it("lets an explicit env stage win over the default", () => {
    assert.equal(resolveCutoverStageFromEnv({ NEON_CUTOVER_STAGE: "shadow" }), "shadow");
    assert.equal(resolveCutoverStageFromEnv({ NEON_CUTOVER_STAGE: "mirror" }), "mirror");
  });

  it("lets a persisted promotion win over the default", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonCutoverPromotion(projectRoot, { NEON_CUTOVER_STAGE: "shadow" });

      const merged = await loadNeonCutoverEnv(projectRoot, {});

      assert.equal(resolveCutoverStageFromEnv(merged), "shadow");
    });
  });

  it("lets a live env value win over a persisted promotion", async () => {
    await withTempRoot(async (projectRoot) => {
      await writeNeonCutoverPromotion(projectRoot, { NEON_CUTOVER_STAGE: "shadow" });

      const merged = await loadNeonCutoverEnv(projectRoot, { NEON_CUTOVER_STAGE: "mirror" });

      assert.equal(resolveCutoverStageFromEnv(merged), "mirror");
    });
  });

  it("reports the default stage from a gate snapshot on an untouched project", async () => {
    await withTempRoot(async (projectRoot) => {
      const snapshot = await createNeonCutoverGateSnapshot(projectRoot, { env: {} });

      assert.equal(snapshot.currentStage, "primary");
    });
  });

  it("keeps the default stage outbound-capable, so arming is the only thing left", () => {
    assert.equal(isNeonOutboundStage(neonDefaultCutoverStage), true);
  });
});
