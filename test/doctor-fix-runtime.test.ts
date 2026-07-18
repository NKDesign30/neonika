import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  applyNeonDoctorPermissionFix,
  resolveNeonDoctorFixGate,
  rollbackNeonDoctorPermissionFix,
  type INeonDoctorFixGate
} from "../src/index.js";

const armedGate: INeonDoctorFixGate = {
  enabled: true,
  reason: "fix-enabled",
  envKey: "NEON_DOCTOR_FIX_ENABLED"
};
const closedGate: INeonDoctorFixGate = {
  enabled: false,
  reason: "fix-disabled",
  envKey: "NEON_DOCTOR_FIX_ENABLED"
};

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("Neonika Doctor --fix runtime (DP-12)", () => {
  it("keeps the fix gate off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonDoctorFixGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonDoctorFixGate({ NEON_DOCTOR_FIX_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonDoctorFixGate({ NEON_DOCTOR_FIX_ENABLED: "0" }).enabled, false);
  });

  it("blocks the fix and leaves permissions untouched while the gate is closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-doctor-fix-"));
    const target = join(dir, "config.json");
    try {
      await writeFile(target, "{}\n", { encoding: "utf8", mode: 0o644 });

      const result = await applyNeonDoctorPermissionFix({
        targetPath: target,
        desiredMode: 0o600,
        gate: closedGate
      });

      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "gate-disabled");
      assert.equal(await modeOf(target), 0o644);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("blocks when the target is not a regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-doctor-fix-"));
    try {
      const result = await applyNeonDoctorPermissionFix({
        targetPath: dir,
        desiredMode: 0o700,
        gate: armedGate
      });
      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "not-a-file");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("skips when the permissions already match the desired mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-doctor-fix-"));
    const target = join(dir, "config.json");
    try {
      await writeFile(target, "{}\n", { encoding: "utf8", mode: 0o600 });

      const result = await applyNeonDoctorPermissionFix({
        targetPath: target,
        desiredMode: 0o600,
        gate: armedGate
      });
      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "already-tight");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("tightens permissions content-safe and exposes a rollback record when fully gated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-doctor-fix-"));
    const target = join(dir, "config.json");
    try {
      await writeFile(target, "{\"keep\":true}\n", { encoding: "utf8", mode: 0o644 });

      const result = await applyNeonDoctorPermissionFix({
        targetPath: target,
        desiredMode: 0o600,
        gate: armedGate
      });

      assert.equal(result.state, "fixed");
      assert.equal(result.previousModeOctal, "0644");
      assert.equal(result.newModeOctal, "0600");
      assert.equal(result.safety.contentMutated, false);
      assert.ok(result.rollback);
      assert.equal(result.rollback?.modeOctal, "0644");
      assert.equal(await modeOf(target), 0o600);
      // Content is untouched.
      assert.equal(await readFile(target, "utf8"), "{\"keep\":true}\n");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rolls the permissions back to the captured mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-doctor-fix-"));
    const target = join(dir, "config.json");
    try {
      await writeFile(target, "{}\n", { encoding: "utf8", mode: 0o644 });

      const result = await applyNeonDoctorPermissionFix({
        targetPath: target,
        desiredMode: 0o600,
        gate: armedGate
      });
      assert.ok(result.rollback);
      assert.equal(await modeOf(target), 0o600);

      const rollback = await rollbackNeonDoctorPermissionFix(result.rollback);
      assert.equal(rollback.restoredModeOctal, "0644");
      assert.equal(await modeOf(target), 0o644);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
