import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonMemoryExportManifest,
  createNeonMemoryImportPlan,
  renderNeonMemoryExportManifest,
  renderNeonMemoryImportPlanReport
} from "../src/index.js";

const leakedSecret = "sk-ABCDEFGHIJKLMNOP1234567890";

describe("Neon Memory importer/exporter dry-run", () => {
  it("plans candidate imports from the isolated store without touching a real DB", async () => {
    const storePath = await seedStore([
      { id: "mem-1", content: "first isolated note", writtenAt: "2026-06-01T00:00:00.000Z", category: "project" },
      { id: "mem-2", content: `token snippet ${leakedSecret}`, writtenAt: "2026-06-01T00:01:00.000Z" },
      { id: "mem-3", content: "   ", writtenAt: "2026-06-01T00:02:00.000Z" }
    ]);

    try {
      const plan = await createNeonMemoryImportPlan(storePath);

      assert.equal(plan.mode, "dry-run");
      assert.equal(plan.totalEntries, 3);
      assert.equal(plan.importableRecords, 2);
      assert.equal(plan.skippedEmpty, 1);
      assert.equal(plan.safety.wouldWriteRealDb, false);
      assert.equal(plan.safety.realDbConnected, false);
      assert.equal(plan.safety.targetedRealMemoryDb, false);

      for (const record of plan.records) {
        assert.match(record.contentHash, /^[a-f0-9]{32}$/u);
      }

      // The seeded store carried a secret-shaped token; the plan must re-redact it.
      const serialized = JSON.stringify(plan);
      assert.doesNotMatch(serialized, new RegExp(leakedSecret, "u"));
      assert.doesNotMatch(renderNeonMemoryImportPlanReport(plan), new RegExp(leakedSecret, "u"));
      assert.match(serialized, /REDACTED_SECRET/u);
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("exports a portable read-only manifest with redacted, deterministic content", async () => {
    const storePath = await seedStore([
      { id: "mem-1", content: "first isolated note", writtenAt: "2026-06-01T00:00:00.000Z" },
      { id: "mem-2", content: `token snippet ${leakedSecret}`, writtenAt: "2026-06-01T00:01:00.000Z" }
    ]);

    try {
      const manifest = await createNeonMemoryExportManifest(storePath, {
        now: () => new Date("2026-06-02T12:00:00.000Z")
      });

      assert.equal(manifest.format, "neon-memory-export");
      assert.equal(manifest.version, 1);
      assert.equal(manifest.generatedAt, "2026-06-02T12:00:00.000Z");
      assert.equal(manifest.entryCount, 2);
      assert.equal(manifest.safety.readOnly, true);
      assert.equal(manifest.safety.targetedRealMemoryDb, false);

      const rendered = renderNeonMemoryExportManifest(manifest);
      assert.doesNotMatch(rendered, new RegExp(leakedSecret, "u"));
      assert.match(rendered, /REDACTED_SECRET/u);
      // The render is valid JSON round-trips to the same manifest.
      assert.deepEqual(JSON.parse(rendered), manifest);
    } finally {
      await rm(storePath, { force: true });
    }
  });

  it("returns an empty plan for a missing store without error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neonika-memory-io-missing-"));
    const storePath = join(dir, "absent-store.json");

    try {
      const plan = await createNeonMemoryImportPlan(storePath);
      assert.equal(plan.totalEntries, 0);
      assert.equal(plan.importableRecords, 0);
      assert.equal(plan.records.length, 0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function seedStore(
  entries: readonly { id: string; content: string; writtenAt: string; category?: string; source?: string }[]
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neonika-memory-io-"));
  const storePath = join(dir, "isolated-store.json");
  await writeFile(storePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return storePath;
}
