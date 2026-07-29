import assert from "node:assert/strict";
import { mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonSkillInventorySnapshot,
  resolveBundledSkillRoot
} from "../src/index.js";

const adaptedSkillNames = [
  "codebase-design",
  "diagnose",
  "domain-modeling",
  "grill-with-docs",
  "grilling",
  "improve-codebase-architecture",
  "neon-grill-me",
  "prototype",
  "resolving-merge-conflicts",
  "tdd",
  "teach",
  "to-spec",
  "to-tickets",
  "triage",
  "wayfinder",
  "writing-great-skills"
] as const;

const attribution =
  "Adapted from https://github.com/mattpocock/skills under the MIT License.";

describe("Neonika bundled skills", () => {
  it("discovers the portable Matt Pocock collection from the installed package root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "neonika-bundled-skills-"));
    const homeDir = join(workspace, "home");
    const referenceRoot = join(workspace, "reference");
    await mkdir(homeDir, { recursive: true });

    try {
      const snapshot = await createNeonSkillInventorySnapshot(workspace, {
        generatedAt: new Date("2026-07-29T00:00:00.000Z"),
        homeDir,
        referenceRoot
      });
      const root = snapshot.roots.find(
        (candidate) => candidate.id === "neonika-bundled-skills"
      );
      const bundledSkills = snapshot.skills.filter(
        (skill) => skill.rootId === "neonika-bundled-skills"
      );

      assert.ok(root);
      assert.equal(root.path, resolveBundledSkillRoot());
      assert.equal(root.kind, "bundled");
      assert.equal(root.discoveredSkillFiles, adaptedSkillNames.length + 1);
      assert.equal(bundledSkills.length, adaptedSkillNames.length + 1);
      assert.equal(snapshot.totals.criticalSkillFindings, 0);

      for (const name of adaptedSkillNames) {
        const skill = bundledSkills.find((candidate) => candidate.normalizedName === name);
        assert.ok(skill, `missing bundled skill ${name}`);
        assert.equal(skill.loadState, "available");
      }

      const diagnose = bundledSkills.find(
        (candidate) => candidate.normalizedName === "diagnose"
      );
      const teach = bundledSkills.find(
        (candidate) => candidate.normalizedName === "teach"
      );
      assert.equal(diagnose?.security.scannedScripts, 1);
      assert.equal(teach?.disableModelInvocation, true);
      assert.equal(teach?.invocation.state, "model-disabled");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("keeps local workspace skills ahead of the bundled fallback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "neonika-bundled-shadow-"));
    const homeDir = join(workspace, "home");
    const referenceRoot = join(workspace, "reference");
    await mkdir(join(workspace, "skills", "wayfinder"), { recursive: true });
    await writeFile(
      join(workspace, "skills", "wayfinder", "SKILL.md"),
      "---\nname: wayfinder\ndescription: Workspace override\n---\n",
      "utf8"
    );

    try {
      const snapshot = await createNeonSkillInventorySnapshot(workspace, {
        generatedAt: new Date("2026-07-29T00:00:00.000Z"),
        homeDir,
        referenceRoot
      });
      const wayfinders = snapshot.skills.filter(
        (skill) => skill.normalizedName === "wayfinder"
      );

      assert.equal(wayfinders.length, 2);
      assert.equal(wayfinders[0]?.rootId, "workspace-skills");
      assert.equal(wayfinders[0]?.loadState, "available");
      assert.equal(wayfinders[1]?.rootId, "neonika-bundled-skills");
      assert.equal(wayfinders[1]?.loadState, "shadowed");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("carries an attribution header in every adapted file", async () => {
    for (const name of adaptedSkillNames) {
      const pending = [join(resolveBundledSkillRoot(), name)];

      while (pending.length > 0) {
        const directory = pending.pop();
        assert.ok(directory);
        const entries = await opendir(directory);

        for await (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            pending.push(path);
            continue;
          }
          assert.equal(entry.isFile(), true, `${path} must be a regular file`);
          assert.equal(
            (await readFile(path, "utf8")).includes(attribution),
            true,
            `${path} must carry Matt Pocock attribution`
          );
        }
      }
    }
  });
});
