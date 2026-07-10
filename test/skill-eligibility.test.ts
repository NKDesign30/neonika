import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonSkillInventorySnapshot,
  renderNeonSkillInventoryReport,
  type INeonSkillRootConfig
} from "../src/index.js";
import {
  createDefaultNeonSkillEligibilityChecks,
  evaluateNeonSkillEligibility,
  type INeonSkillEligibilityChecks
} from "../src/skills/skillEligibility.js";
import type { INeonSkillReferenceMetadata } from "../src/skills/skillMetadata.js";

function makeChecks(overrides: Partial<INeonSkillEligibilityChecks> = {}): INeonSkillEligibilityChecks {
  return {
    hasBinary: () => true,
    hasEnv: () => true,
    hasConfigPath: () => true,
    currentOs: "darwin",
    ...overrides
  };
}

describe("evaluateNeonSkillEligibility", () => {
  it("returns unknown when there is no metadata to evaluate", () => {
    const result = evaluateNeonSkillEligibility(undefined, makeChecks());
    assert.equal(result.state, "unknown");
    assert.deepEqual(result.missing, []);
  });

  it("returns eligible when every declared requirement is satisfied", () => {
    const metadata: INeonSkillReferenceMetadata = {
      os: ["darwin"],
      requires: { bins: ["memo"], env: ["TOKEN"], config: ["~/.config/memo"] }
    };
    const result = evaluateNeonSkillEligibility(metadata, makeChecks());
    assert.equal(result.state, "eligible");
    assert.deepEqual(result.missing, []);
  });

  it("flags a missing binary with a reason", () => {
    const metadata: INeonSkillReferenceMetadata = { requires: { bins: ["memo"] } };
    const result = evaluateNeonSkillEligibility(metadata, makeChecks({ hasBinary: () => false }));
    assert.equal(result.state, "ineligible");
    assert.deepEqual(result.missing, [{ kind: "missing-bin", detail: "memo" }]);
  });

  it("flags an os mismatch", () => {
    const metadata: INeonSkillReferenceMetadata = { os: ["darwin"] };
    const result = evaluateNeonSkillEligibility(metadata, makeChecks({ currentOs: "linux" }));
    assert.equal(result.state, "ineligible");
    assert.equal(result.missing[0]?.kind, "os-mismatch");
  });

  it("satisfies anyBins when at least one is present, flags when none are", () => {
    const metadata: INeonSkillReferenceMetadata = { requires: { anyBins: ["fd", "rg"] } };
    const present = evaluateNeonSkillEligibility(
      metadata,
      makeChecks({ hasBinary: (name) => name === "rg" })
    );
    assert.equal(present.state, "eligible");
    const absent = evaluateNeonSkillEligibility(metadata, makeChecks({ hasBinary: () => false }));
    assert.equal(absent.state, "ineligible");
    assert.equal(absent.missing[0]?.kind, "missing-any-bin");
  });

  it("flags missing env and config requirements", () => {
    const metadata: INeonSkillReferenceMetadata = { requires: { env: ["TOKEN"], config: ["~/.config/x"] } };
    const result = evaluateNeonSkillEligibility(
      metadata,
      makeChecks({ hasEnv: () => false, hasConfigPath: () => false })
    );
    assert.equal(result.state, "ineligible");
    const kinds = result.missing.map((reason) => reason.kind).sort();
    assert.deepEqual(kinds, ["missing-config", "missing-env"]);
  });
});

describe("createDefaultNeonSkillEligibilityChecks (read-only fs scan, no spawn)", () => {
  it("resolves binaries by scanning PATH dirs, reads env presence, and checks config paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-eligibility-"));
    try {
      const binDir = join(dir, "bin");
      const homeDir = join(dir, "home");
      await mkdir(binDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(join(binDir, "memo"), "#!/bin/sh\n", "utf8");
      await writeFile(join(homeDir, ".memorc"), "config\n", "utf8");

      const checks = createDefaultNeonSkillEligibilityChecks({
        PATH: binDir,
        HOME: homeDir,
        SOME_TOKEN: "present"
      });

      assert.equal(checks.hasBinary("memo"), true);
      assert.equal(checks.hasBinary("definitely-not-on-path-xyz"), false);
      assert.equal(checks.hasEnv("SOME_TOKEN"), true);
      assert.equal(checks.hasEnv("UNSET_TOKEN"), false);
      assert.equal(checks.hasConfigPath("~/.memorc"), true);
      assert.equal(checks.hasConfigPath(join(homeDir, ".memorc")), true);
      assert.equal(checks.hasConfigPath("~/.does-not-exist"), false);
      assert.equal(typeof checks.currentOs, "string");
      assert.ok(checks.currentOs.length > 0);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("skill inventory surfaces eligibility + install specs", () => {
  const SKILL_SOURCE = [
    "---",
    "name: notes",
    "description: Notes skill",
    "metadata:",
    "  {",
    '    "openclaw":',
    "      {",
    '        "os": ["darwin"],',
    '        "requires": { "bins": ["memo"] },',
    '        "install": [ { "id": "brew", "kind": "brew", "formula": "antoniorodr/memo/memo", "bins": ["memo"] } ],',
    "      },",
    "  }",
    "---",
    "Body"
  ].join("\n");

  async function buildSnapshot(checks: INeonSkillEligibilityChecks) {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-skill-eligibility-"));
    const primaryRoot = join(projectRoot, "skills");
    const filePath = join(primaryRoot, "notes", "SKILL.md");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, SKILL_SOURCE, "utf8");
    const skillRoots: readonly INeonSkillRootConfig[] = [
      { id: "primary", label: "Primary", kind: "workspace", path: primaryRoot, trust: "trusted-project" }
    ];
    const snapshot = await createNeonSkillInventorySnapshot(projectRoot, {
      generatedAt: new Date("2026-06-03T00:00:00.000Z"),
      referenceRoot: join(projectRoot, "upstream"),
      skillRoots,
      eligibilityChecks: checks
    });
    return { projectRoot, snapshot };
  }

  it("marks a skill ineligible when a required binary is missing and exposes its install spec", async () => {
    const { projectRoot, snapshot } = await buildSnapshot(makeChecks({ hasBinary: () => false }));
    try {
      const skill = snapshot.skills.find((entry) => entry.name === "notes");
      assert.ok(skill, "expected the notes skill");
      assert.equal(skill?.eligibility?.state, "ineligible");
      assert.deepEqual(skill?.eligibility?.missing, [{ kind: "missing-bin", detail: "memo" }]);
      assert.equal(skill?.install?.length, 1);
      assert.equal(skill?.install?.[0]?.kind, "brew");
      assert.equal(skill?.install?.[0]?.formula, "antoniorodr/memo/memo");

      const report = renderNeonSkillInventoryReport(snapshot);
      assert.match(report, /Eligibility: 0 eligible \/ 1 ineligible \/ 1 with install specs/);
      assert.match(report, /ineligible: memo/);
      assert.match(report, /install: brew/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("marks a skill eligible when every requirement is satisfied", async () => {
    const { projectRoot, snapshot } = await buildSnapshot(makeChecks());
    try {
      const skill = snapshot.skills.find((entry) => entry.name === "notes");
      assert.equal(skill?.eligibility?.state, "eligible");
      const report = renderNeonSkillInventoryReport(snapshot);
      assert.match(report, /Eligibility: 1 eligible \/ 0 ineligible \/ 1 with install specs/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
