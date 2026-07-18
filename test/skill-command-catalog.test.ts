import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonSkillCommandCatalog,
  createNeonSkillInventorySnapshot,
  deriveNeonSkillInvocation,
  normalizeNeonSkillName,
  renderNeonSkillCommandCatalogReport,
  summarizeNeonSkillFindings,
  type INeonSkillRootConfig,
  type INeonSkillSummary,
  type TNeonSkillLoadState
} from "../src/index.js";

function makeSkill(
  name: string,
  options: {
    readonly loadState?: TNeonSkillLoadState;
    readonly disableModelInvocation?: boolean;
    readonly rootId?: string;
  } = {}
): INeonSkillSummary {
  const loadState = options.loadState ?? "available";
  const disableModelInvocation = options.disableModelInvocation ?? false;
  const normalizedName = normalizeNeonSkillName(name);

  return {
    name,
    normalizedName,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    rootId: options.rootId ?? "workspace-skills",
    rootLabel: "Workspace skills",
    sourceKind: "workspace",
    trust: "trusted-project",
    loadState,
    disableModelInvocation,
    invocation: deriveNeonSkillInvocation({
      normalizedName,
      available: loadState === "available",
      shadowed: loadState === "shadowed",
      disableModelInvocation
    }),
    security: summarizeNeonSkillFindings([])
  };
}

describe("createNeonSkillCommandCatalog", () => {
  it("derives one /skill: command per normalized name and counts model-invocable", () => {
    const catalog = createNeonSkillCommandCatalog([
      makeSkill("alpha"),
      makeSkill("beta", { disableModelInvocation: true })
    ]);

    assert.equal(catalog.totals.commands, 2);
    assert.equal(catalog.totals.modelInvocable, 1);
    assert.equal(catalog.totals.collisions, 0);
    assert.deepEqual(
      catalog.entries.map((entry) => entry.command),
      ["/skill:alpha", "/skill:beta"]
    );
    const beta = catalog.entries.find((entry) => entry.command === "/skill:beta");
    assert.equal(beta?.state, "model-disabled");
    assert.equal(beta?.modelInvocable, false);
  });

  it("collapses same-name skills into one command and lists the shadowed duplicate as a collision", () => {
    const catalog = createNeonSkillCommandCatalog([
      makeSkill("alpha", { rootId: "primary" }),
      makeSkill("alpha", { loadState: "shadowed", rootId: "secondary" })
    ]);

    assert.equal(catalog.totals.commands, 1);
    assert.equal(catalog.totals.collisions, 1);
    const entry = catalog.entries[0];
    assert.equal(entry?.command, "/skill:alpha");
    assert.equal(entry?.ownerRootId, "primary");
    assert.equal(entry?.state, "active");
    assert.equal(entry?.collisions.length, 1);
    assert.equal(entry?.collisions[0]?.rootId, "secondary");
    assert.equal(entry?.collisions[0]?.loadState, "shadowed");
  });

  it("prefers an available owner even when the shadowed duplicate is listed first", () => {
    const catalog = createNeonSkillCommandCatalog([
      makeSkill("alpha", { loadState: "shadowed", rootId: "secondary" }),
      makeSkill("alpha", { rootId: "primary" })
    ]);

    assert.equal(catalog.entries[0]?.ownerRootId, "primary");
    assert.equal(catalog.entries[0]?.collisions[0]?.rootId, "secondary");
  });

  it("skips skills with an empty normalized name", () => {
    const catalog = createNeonSkillCommandCatalog([makeSkill("###")]);
    assert.equal(catalog.totals.commands, 0);
    assert.deepEqual(catalog.entries, []);
  });

  it("renders a report with command, owner and collisions", () => {
    const report = renderNeonSkillCommandCatalogReport(
      createNeonSkillCommandCatalog([
        makeSkill("alpha", { rootId: "primary" }),
        makeSkill("alpha", { loadState: "shadowed", rootId: "secondary" })
      ])
    );

    assert.match(report, /Neonika Skill Commands: 1 command/);
    assert.match(report, /\/skill:alpha: active \/ owner alpha@primary \/ collides: alpha@secondary/);
  });
});

// Exercises the exact path the `skill-commands` CLI command runs:
// a real inventory snapshot -> createNeonSkillCommandCatalog(snapshot.skills)
// -> renderNeonSkillCommandCatalogReport. Read-only, no dispatch.
describe("skill-commands CLI catalog from an inventory snapshot", () => {
  it("renders the /skill: command catalog and surfaces the shadowed collision", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-skill-commands-"));

    try {
      const primaryRoot = join(projectRoot, "skills");
      const secondaryRoot = join(projectRoot, ".agents", "skills");
      await writeSkillFile(
        join(primaryRoot, "alpha", "SKILL.md"),
        ["---", "name: alpha", "description: Alpha", "---"].join("\n")
      );
      await writeSkillFile(
        join(secondaryRoot, "alpha-copy", "SKILL.md"),
        ["---", "name: alpha", "description: Shadow copy", "---"].join("\n")
      );

      const skillRoots: readonly INeonSkillRootConfig[] = [
        {
          id: "primary",
          label: "Primary",
          kind: "workspace",
          path: primaryRoot,
          trust: "trusted-project"
        },
        {
          id: "secondary",
          label: "Secondary",
          kind: "project-agent",
          path: secondaryRoot,
          trust: "trusted-project"
        }
      ];

      const snapshot = await createNeonSkillInventorySnapshot(projectRoot, {
        generatedAt: new Date("2026-06-02T10:00:00.000Z"),
        skillRoots
      });
      const catalog = createNeonSkillCommandCatalog(snapshot.skills);
      const report = renderNeonSkillCommandCatalogReport(catalog);

      assert.equal(catalog.totals.commands, 1);
      assert.equal(catalog.totals.collisions, 1);
      assert.match(report, /Neonika Skill Commands: 1 command/);
      assert.match(report, /\/skill:alpha: active \/ owner alpha@primary \/ collides: alpha@secondary/);
      assert.doesNotMatch(report, /secret/i);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function writeSkillFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
