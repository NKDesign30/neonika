import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  deriveNeonSkillInvocation,
  loadNeonSkillPolicySource,
  neonSkillPolicySourceRelativePath,
  neonSkillPolicyWildcard,
  resolveAgentSkillPolicy,
  resolveNeonSkillPolicySourcePath,
  summarizeNeonSkillFindings,
  type INeonSkillPolicyConfig,
  type INeonSkillSummary
} from "../src/index.js";

function makeSkill(name: string, trust: INeonSkillSummary["trust"] = "trusted-project"): INeonSkillSummary {
  const normalizedName = name
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return {
    name,
    normalizedName,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    rootId: "workspace-skills",
    rootLabel: "Workspace skills",
    sourceKind: "workspace",
    trust,
    loadState: "available",
    disableModelInvocation: false,
    invocation: deriveNeonSkillInvocation({
      normalizedName,
      available: true,
      shadowed: false,
      disableModelInvocation: false
    }),
    security: summarizeNeonSkillFindings([])
  };
}

const sampleSkills: readonly INeonSkillSummary[] = [
  makeSkill("alpha"),
  makeSkill("beta"),
  makeSkill("upstream-bundled", "reference-only")
];

describe("resolveAgentSkillPolicy", () => {
  it("defaults to allow-everything when no config is provided", () => {
    const result = resolveAgentSkillPolicy("neo", sampleSkills);

    assert.equal(result.agentResolved, false);
    assert.equal(result.policyEnabled, true);
    assert.equal(result.decisions.length, sampleSkills.length);
    assert.equal(result.allowed.length, sampleSkills.length);
    assert.equal(result.denied.length, 0);
    assert.ok(
      result.decisions.every((decision) => decision.reason === "unknown-agent-default-allow"),
      "without an agent resolver every skill is unknown-agent default-allow"
    );
  });

  it("denies a skill when the global denylist names it (deny wins over allow)", () => {
    const config: INeonSkillPolicyConfig = {
      allow: ["alpha", "beta"],
      deny: ["beta"]
    };
    const result = resolveAgentSkillPolicy("forge", sampleSkills, config);

    const beta = result.decisions.find((decision) => decision.normalizedName === "beta");
    const alpha = result.decisions.find((decision) => decision.normalizedName === "alpha");
    const bundled = result.decisions.find((decision) => decision.normalizedName === "upstream-bundled");

    assert.equal(beta?.decision, "deny");
    assert.equal(beta?.reason, "denied-global");
    assert.equal(alpha?.decision, "allow");
    assert.equal(alpha?.reason, "allowlisted");
    // A non-empty allowlist becomes an exclusive gate.
    assert.equal(bundled?.decision, "deny");
    assert.equal(bundled?.reason, "not-in-allowlist");
    assert.equal(result.allowed.length, 1);
    assert.equal(result.denied.length, 2);
  });

  it("allows a skill explicitly through a per-agent allowlist", () => {
    const config: INeonSkillPolicyConfig = {
      byAgent: {
        sentinel: { allow: ["alpha"] }
      }
    };
    const result = resolveAgentSkillPolicy("sentinel", sampleSkills, config);

    const alpha = result.decisions.find((decision) => decision.normalizedName === "alpha");
    const beta = result.decisions.find((decision) => decision.normalizedName === "beta");

    assert.equal(alpha?.decision, "allow");
    assert.equal(alpha?.reason, "allowlisted");
    assert.equal(beta?.decision, "deny");
    assert.equal(beta?.reason, "not-in-allowlist");
  });

  it("keeps default-allow for an unknown agent even when other agents have rules", () => {
    const config: INeonSkillPolicyConfig = {
      byAgent: {
        sentinel: { deny: ["alpha"] }
      }
    };
    const result = resolveAgentSkillPolicy("ghost-agent", sampleSkills, config, {
      resolveAgentId: (agentId) => (agentId === "sentinel" ? "sentinel" : undefined)
    });

    assert.equal(result.agentResolved, false);
    assert.equal(result.allowed.length, sampleSkills.length);
    assert.equal(result.denied.length, 0);
    assert.ok(
      result.decisions.every((decision) => decision.reason === "unknown-agent-default-allow"),
      "an unknown agent inherits no other agent's deny rules"
    );
  });

  it("marks a resolved agent's decisions as plain default-allow", () => {
    const result = resolveAgentSkillPolicy("@Sentinel", sampleSkills, {}, {
      resolveAgentId: (agentId) => (agentId === "@Sentinel" ? "sentinel" : undefined)
    });

    assert.equal(result.agentResolved, true);
    assert.equal(result.normalizedAgentId, "sentinel");
    assert.ok(result.decisions.every((decision) => decision.reason === "default-allow"));
  });

  it("denies everything when the master switch is disabled", () => {
    const result = resolveAgentSkillPolicy("neo", sampleSkills, { enabled: false });

    assert.equal(result.policyEnabled, false);
    assert.equal(result.allowed.length, 0);
    assert.equal(result.denied.length, sampleSkills.length);
    assert.ok(result.decisions.every((decision) => decision.reason === "master-disabled"));
  });

  it("treats a wildcard allow as allow-all regardless of allowlist gate", () => {
    const config: INeonSkillPolicyConfig = {
      allow: [neonSkillPolicyWildcard],
      byAgent: {
        nova: { allow: ["alpha"] }
      }
    };
    const result = resolveAgentSkillPolicy("nova", sampleSkills, config);

    assert.equal(result.allowed.length, sampleSkills.length);
    assert.ok(result.decisions.every((decision) => decision.reason === "wildcard-allow"));
  });

  it("preserves the skill trust as a reason on every decision without loading code", () => {
    const result = resolveAgentSkillPolicy("scout", sampleSkills);

    const bundled = result.decisions.find((decision) => decision.normalizedName === "upstream-bundled");
    assert.equal(bundled?.trust, "reference-only");
    assert.equal(bundled?.decision, "allow");
  });
});

describe("loadNeonSkillPolicySource", () => {
  async function withProjectRoot(run: (projectRoot: string) => Promise<void>): Promise<void> {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-skill-policy-source-"));
    try {
      await run(projectRoot);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  }

  async function writePolicyFile(projectRoot: string, contents: string): Promise<void> {
    await mkdir(join(projectRoot, ".agents"), { recursive: true });
    await writeFile(resolveNeonSkillPolicySourcePath(projectRoot), contents, "utf8");
  }

  it("loads and validates a well-formed policy file and feeds resolveAgentSkillPolicy", async () => {
    await withProjectRoot(async (projectRoot) => {
      await writePolicyFile(
        projectRoot,
        JSON.stringify({
          deny: ["beta"],
          byAgent: { sentinel: { allow: ["alpha"] } }
        })
      );

      const source = await loadNeonSkillPolicySource(projectRoot);

      assert.equal(source.state, "loaded");
      assert.equal(source.relativePath, neonSkillPolicySourceRelativePath);
      assert.deepEqual(source.config.deny, ["beta"]);
      assert.deepEqual(source.config.byAgent?.["sentinel"]?.allow, ["alpha"]);

      const result = resolveAgentSkillPolicy("forge", sampleSkills, source.config);
      const beta = result.decisions.find((decision) => decision.normalizedName === "beta");
      assert.equal(beta?.decision, "deny");
      assert.equal(beta?.reason, "denied-global");
    });
  });

  it("falls back to default-allow when the file is absent (no throw)", async () => {
    await withProjectRoot(async (projectRoot) => {
      const source = await loadNeonSkillPolicySource(projectRoot);

      assert.equal(source.state, "absent");
      assert.deepEqual(source.config, {});

      const result = resolveAgentSkillPolicy("neo", sampleSkills, source.config);
      assert.equal(result.denied.length, 0);
      assert.equal(result.allowed.length, result.decisions.length);
    });
  });

  it("falls back to default-allow when the file is malformed JSON (no throw)", async () => {
    await withProjectRoot(async (projectRoot) => {
      await writePolicyFile(projectRoot, "{ not json");

      const source = await loadNeonSkillPolicySource(projectRoot);

      assert.equal(source.state, "invalid");
      assert.deepEqual(source.config, {});

      const result = resolveAgentSkillPolicy("neo", sampleSkills, source.config);
      assert.equal(result.denied.length, 0);
      assert.equal(result.allowed.length, result.decisions.length);
    });
  });

  it("falls back to default-allow when the top-level type is not an object", async () => {
    await withProjectRoot(async (projectRoot) => {
      await writePolicyFile(projectRoot, "[1, 2, 3]");

      const source = await loadNeonSkillPolicySource(projectRoot);

      assert.equal(source.state, "invalid");
      assert.deepEqual(source.config, {});
    });
  });

  it("drops malformed fields but keeps valid declarative data", async () => {
    await withProjectRoot(async (projectRoot) => {
      await writePolicyFile(
        projectRoot,
        JSON.stringify({
          enabled: "yes",
          allow: ["alpha", 42, "", "beta"],
          deny: "not-an-array",
          byAgent: { sentinel: { allow: ["alpha"], deny: 7 }, ghost: "nope" }
        })
      );

      const source = await loadNeonSkillPolicySource(projectRoot);

      assert.equal(source.state, "loaded");
      // "enabled" was not a boolean -> dropped (defaults to true downstream).
      assert.equal(source.config.enabled, undefined);
      // Non-string and empty entries are filtered out.
      assert.deepEqual(source.config.allow, ["alpha", "beta"]);
      // "deny" was not an array -> dropped.
      assert.equal(source.config.deny, undefined);
      // Valid per-agent allow kept, invalid deny dropped, non-record agent dropped.
      assert.deepEqual(source.config.byAgent?.["sentinel"]?.allow, ["alpha"]);
      assert.equal(source.config.byAgent?.["sentinel"]?.deny, undefined);
      assert.equal(source.config.byAgent?.["ghost"], undefined);
    });
  });
});
