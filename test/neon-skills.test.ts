import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import {
  createNeonExtensionInventorySnapshot,
  createNeonSkillInventorySnapshot,
  deriveNeonSkillInvocation,
  renderNeonExtensionsReport,
  renderNeonSkillInventoryReport,
  scanNeonSkillScripts,
  scanNeonSkillSource,
  summarizeNeonSkillFindings,
  type INeonSkillRootConfig
} from "../src/index.js";

describe("Neon Skills inventory", () => {
  it("discovers local skills, marks lower-precedence duplicates shadowed, and redacts bodies", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const primaryRoot = join(projectRoot, "skills");
      const secondaryRoot = join(projectRoot, ".agents", "skills");
      const referenceRoot = join(projectRoot, "upstream");
      await writeSkill(
        join(primaryRoot, "alpha", "SKILL.md"),
        [
          "---",
          "name: alpha",
          "description: Alpha frontmatter description",
          "disableModelInvocation: true",
          "---",
          "SECRET_TOKEN=never-render"
        ].join("\n")
      );
      await writeSkill(
        join(secondaryRoot, "alpha-copy", "SKILL.md"),
        ["---", "name: alpha", "description: Shadow copy", "---"].join("\n")
      );
      await writeManifest(
        join(referenceRoot, "extensions", "discord", "openclaw.plugin.json"),
        {
          id: "discord",
          name: "Discord",
          description: "Discord channel plugin",
          version: "1.0.0",
          channels: ["discord"],
          providers: [],
          skills: ["skills/discord"],
          contracts: {
            tools: ["discord.send"]
          },
          setup: {
            providers: [{ id: "discord" }]
          },
          configSchema: {
            type: "object"
          }
        }
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
        generatedAt: new Date("2026-05-31T10:00:00.000Z"),
        referenceRoot,
        skillRoots
      });
      const report = renderNeonSkillInventoryReport(snapshot);

      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.skills, 2);
      assert.equal(snapshot.totals.availableSkills, 1);
      assert.equal(snapshot.totals.shadowedSkills, 1);
      assert.equal(snapshot.totals.extensionManifests, 1);
      assert.equal(snapshot.skills[0]?.disableModelInvocation, true);
      assert.equal(snapshot.skills[0]?.security.state, "clean");
      assert.equal(snapshot.skills[0]?.invocation.state, "model-disabled");
      assert.equal(snapshot.skills[0]?.invocation.modelInvocable, false);
      assert.equal(snapshot.skills[0]?.invocation.slashCommand, "/skill:alpha");
      assert.equal(snapshot.skills[0]?.invocation.toolName, "alpha");
      assert.equal(snapshot.totals.modelInvocableSkills, 0);
      assert.equal(snapshot.totals.flaggedSkills, 0);
      assert.equal(snapshot.totals.criticalSkillFindings, 0);
      assert.equal(snapshot.skills[1]?.loadState, "shadowed");
      assert.equal(snapshot.skills[1]?.shadowedBy, "alpha");
      assert.equal(snapshot.skills[1]?.invocation.state, "shadowed");
      assert.equal(snapshot.skills[1]?.invocation.modelInvocable, false);
      assert.equal(snapshot.extensions[0]?.trust, "reference-only");
      assert.equal(snapshot.extensions[0]?.loadState, "reference-only");
      assert.equal(snapshot.extensions[0]?.capabilities.channels, 1);
      assert.equal(snapshot.extensions[0]?.capabilities.tools, 1);
      assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_TOKEN/);
      assert.match(report, /Neon Skills Inventory: ready/);
      assert.match(report, /skill alpha: available/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reports invalid extension manifests without loading plugin code", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const referenceRoot = join(projectRoot, "upstream");
      const manifestPath = join(referenceRoot, "extensions", "broken", "openclaw.plugin.json");
      await mkdir(join(referenceRoot, "extensions", "broken"), { recursive: true });
      await writeFile(manifestPath, "{", "utf8");

      const snapshot = await createNeonExtensionInventorySnapshot(projectRoot, {
        referenceRoot
      });
      const report = renderNeonExtensionsReport(snapshot);

      assert.equal(snapshot.state, "partial");
      assert.equal(snapshot.totals.extensionManifests, 1);
      assert.equal(snapshot.totals.invalidExtensionManifests, 1);
      assert.equal(snapshot.extensions[0]?.loadState, "invalid");
      assert.match(report, /Invalid: 1/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("reads min-host-version and flags denylisted dependencies read-only without invalidating the manifest", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const referenceRoot = join(projectRoot, "upstream");
      await mkdir(join(referenceRoot, "extensions", "good-ext"), { recursive: true });
      await writeFile(
        join(referenceRoot, "extensions", "good-ext", "openclaw.plugin.json"),
        JSON.stringify({
          id: "good-ext",
          name: "Good Extension",
          install: { minHostVersion: ">=1.2.3" },
          dependencies: { "plain-crypto-js": "^1.0.0", "left-pad": "^1.0.0" }
        }),
        "utf8"
      );
      await mkdir(join(referenceRoot, "extensions", "badver-ext"), { recursive: true });
      await writeFile(
        join(referenceRoot, "extensions", "badver-ext", "openclaw.plugin.json"),
        JSON.stringify({ id: "badver-ext", name: "Bad Version", install: { minHostVersion: "1.2.3" } }),
        "utf8"
      );

      const snapshot = await createNeonExtensionInventorySnapshot(projectRoot, { referenceRoot });
      const good = snapshot.extensions.find((extension) => extension.id === "good-ext");
      const badver = snapshot.extensions.find((extension) => extension.id === "badver-ext");

      // Read-only: warnings do not invalidate the manifest.
      assert.equal(good?.loadState, "reference-only");
      assert.equal(good?.minHostVersion, ">=1.2.3");
      assert.deepEqual(good?.manifestWarnings, ["blocked dependency: plain-crypto-js"]);
      assert.equal(badver?.loadState, "reference-only");
      assert.equal(badver?.minHostVersion, undefined);
      assert.match(badver?.manifestWarnings?.[0] ?? "", /invalid install\.minHostVersion/);
      // The scan surfaces the warnings as issues.
      assert.ok(snapshot.issues.some((issue) => issue.includes("blocked dependency: plain-crypto-js")));
      assert.ok(snapshot.issues.some((issue) => issue.includes("invalid install.minHostVersion")));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

describe("scanNeonSkillSource", () => {
  const file = "/skills/sample/SKILL.md";

  function ruleIds(source: string): string[] {
    return scanNeonSkillSource(source, file)
      .map((finding) => finding.ruleId)
      .sort();
  }

  it("flags child_process command execution as critical", () => {
    const findings = scanNeonSkillSource(
      'const cp = require("child_process");\ncp.exec(userCommand);',
      file
    );
    const exec = findings.find((finding) => finding.ruleId === "dangerous-exec");
    assert.ok(exec, "dangerous-exec finding expected");
    assert.equal(exec?.severity, "critical");
    assert.equal(exec?.file, file);
    assert.equal(exec?.line, 2);
  });

  it("does not flag a bare member .exec() without child_process context", () => {
    assert.deepEqual(ruleIds("const match = /foo/.exec(input);"), []);
  });

  it("flags eval and new Function as dynamic code execution", () => {
    assert.deepEqual(ruleIds("const value = eval(payload);"), ["dynamic-code-execution"]);
    assert.deepEqual(ruleIds("const fn = new Function('return 1');"), ["dynamic-code-execution"]);
  });

  it("flags crypto-mining references", () => {
    assert.deepEqual(ruleIds('connect("stratum+tcp://pool.example:3333");'), ["crypto-mining"]);
  });

  it("flags WebSocket connections to non-standard ports but allows standard ones", () => {
    assert.deepEqual(ruleIds('new WebSocket("wss://exfil.example:9001");'), ["suspicious-network"]);
    assert.deepEqual(ruleIds('new WebSocket("wss://api.example:443");'), []);
  });

  it("flags file read combined with network send as potential exfiltration", () => {
    const source = ['const data = readFileSync("/etc/passwd");', "fetch(remote, { body: data });"].join(
      "\n"
    );
    assert.ok(ruleIds(source).includes("potential-exfiltration"));
  });

  it("flags hex and base64 obfuscation", () => {
    assert.deepEqual(ruleIds("const s = '\\x68\\x65\\x6c\\x6c\\x6f\\x21\\x21';"), ["obfuscated-code"]);
    const base64 = `atob("${"QQ".repeat(120)}")`;
    assert.deepEqual(ruleIds(base64), ["obfuscated-code"]);
  });

  it("flags env access near a network send but not env access alone", () => {
    const harvesting = ["const token = process.env.SECRET;", "fetch(remote, { body: token });"].join(
      "\n"
    );
    assert.ok(ruleIds(harvesting).includes("env-harvesting"));
    assert.deepEqual(ruleIds("const port = process.env.PORT;"), []);
  });

  it("ignores patterns that only appear inside comments", () => {
    assert.deepEqual(ruleIds("// const data = readFileSync(x); fetch(y, data);"), []);
  });

  it("returns no findings for a benign body", () => {
    assert.deepEqual(ruleIds("# A helpful skill\n\nDescribe what the skill does."), []);
  });

  it("aggregates findings into a leak-safe summary", () => {
    const findings = scanNeonSkillSource(
      'eval(a);\nconst cp = require("child_process");\ncp.exec(b);',
      file
    );
    const summary = summarizeNeonSkillFindings(findings);

    assert.equal(summary.state, "flagged");
    assert.equal(summary.critical, 2);
    assert.equal(summary.warn, 0);
    assert.deepEqual(
      summary.findings.map((finding) => finding.ruleId),
      ["dangerous-exec", "dynamic-code-execution"]
    );
    assert.ok(summary.findings.every((finding) => finding.count === 1));
  });

  it("summarizes an empty finding list as clean", () => {
    const summary = summarizeNeonSkillFindings([]);
    assert.equal(summary.state, "clean");
    assert.equal(summary.critical, 0);
    assert.deepEqual(summary.findings, []);
  });
});

describe("deriveNeonSkillInvocation", () => {
  it("marks an available, model-enabled skill active and model-invocable", () => {
    const invocation = deriveNeonSkillInvocation({
      normalizedName: "alpha",
      available: true,
      shadowed: false,
      disableModelInvocation: false
    });

    assert.equal(invocation.state, "active");
    assert.equal(invocation.modelInvocable, true);
    assert.equal(invocation.toolName, "alpha");
    assert.equal(invocation.slashCommand, "/skill:alpha");
  });

  it("marks a model-disabled skill slash-only (model-disabled, not model-invocable)", () => {
    const invocation = deriveNeonSkillInvocation({
      normalizedName: "alpha",
      available: true,
      shadowed: false,
      disableModelInvocation: true
    });

    assert.equal(invocation.state, "model-disabled");
    assert.equal(invocation.modelInvocable, false);
    assert.equal(invocation.slashCommand, "/skill:alpha");
  });

  it("marks a shadowed skill shadowed regardless of model invocation flag", () => {
    const invocation = deriveNeonSkillInvocation({
      normalizedName: "alpha",
      available: false,
      shadowed: true,
      disableModelInvocation: false
    });

    assert.equal(invocation.state, "shadowed");
    assert.equal(invocation.modelInvocable, false);
  });

  it("marks an unreadable/invalid skill unavailable", () => {
    const invocation = deriveNeonSkillInvocation({
      normalizedName: "alpha",
      available: false,
      shadowed: false,
      disableModelInvocation: false
    });

    assert.equal(invocation.state, "unavailable");
    assert.equal(invocation.modelInvocable, false);
  });
});

describe("scanNeonSkillScripts", () => {
  it("scans sibling scripts and flags dangerous patterns without leaking source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-scripts-"));

    try {
      await writeFile(join(dir, "helper.js"), "const x = eval(scriptSecretToken);", "utf8");
      await writeFile(join(dir, "README.md"), "not a script: eval(ignored)", "utf8");

      const result = await scanNeonSkillScripts(dir);

      assert.equal(result.scannedFiles, 1);
      assert.equal(result.truncated, false);
      assert.ok(result.findings.some((finding) => finding.ruleId === "dynamic-code-execution"));
      assert.doesNotMatch(JSON.stringify(result.findings), /scriptSecretToken/);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns an empty result for a directory with no scannable scripts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-scripts-"));

    try {
      await writeFile(join(dir, "SKILL.md"), "# doc only", "utf8");
      const result = await scanNeonSkillScripts(dir);
      assert.deepEqual(result, { scannedFiles: 0, truncated: false, findings: [] });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("bounds the number of scanned files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-core-scripts-"));

    try {
      await Promise.all(
        Array.from({ length: 5 }, (_unused, index) =>
          writeFile(join(dir, `mod-${index}.js`), "export const ok = true;", "utf8")
        )
      );
      const result = await scanNeonSkillScripts(dir, { maxFiles: 2 });
      assert.equal(result.scannedFiles, 2);
      assert.equal(result.truncated, true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("Neon Skills inventory security scan", () => {
  it("flags a skill body with dangerous code without leaking the body", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const primaryRoot = join(projectRoot, "skills");
      await writeSkill(
        join(primaryRoot, "risky", "SKILL.md"),
        [
          "---",
          "name: risky",
          "description: A risky skill",
          "---",
          "# Risky skill",
          "",
          "    const cp = require(\"child_process\");",
          "    cp.exec(dangerousCommandToken);"
        ].join("\n")
      );

      const skillRoots: readonly INeonSkillRootConfig[] = [
        {
          id: "primary",
          label: "Primary",
          kind: "workspace",
          path: primaryRoot,
          trust: "trusted-project"
        }
      ];
      const snapshot = await createNeonSkillInventorySnapshot(projectRoot, {
        generatedAt: new Date("2026-05-31T10:00:00.000Z"),
        referenceRoot: join(projectRoot, "upstream"),
        skillRoots
      });
      const report = renderNeonSkillInventoryReport(snapshot);

      assert.equal(snapshot.skills[0]?.security.state, "flagged");
      assert.equal(snapshot.skills[0]?.security.critical, 1);
      assert.equal(snapshot.skills[0]?.security.findings[0]?.ruleId, "dangerous-exec");
      assert.equal(snapshot.totals.flaggedSkills, 1);
      assert.equal(snapshot.totals.criticalSkillFindings, 1);
      assert.doesNotMatch(JSON.stringify(snapshot), /dangerousCommandToken/);
      assert.match(report, /flagged: dangerous-exec/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("flags a benign skill whose sibling script is dangerous, counting scanned scripts", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const primaryRoot = join(projectRoot, "skills");
      await writeSkill(
        join(primaryRoot, "scripted", "SKILL.md"),
        ["---", "name: scripted", "description: A scripted skill", "---", "# Scripted skill"].join("\n")
      );
      await writeFile(
        join(primaryRoot, "scripted", "tool.ts"),
        "const value = eval(siblingScriptToken);\nexport { value };",
        "utf8"
      );

      const skillRoots: readonly INeonSkillRootConfig[] = [
        {
          id: "primary",
          label: "Primary",
          kind: "workspace",
          path: primaryRoot,
          trust: "trusted-project"
        }
      ];
      const snapshot = await createNeonSkillInventorySnapshot(projectRoot, {
        generatedAt: new Date("2026-05-31T10:00:00.000Z"),
        referenceRoot: join(projectRoot, "upstream"),
        skillRoots
      });

      assert.equal(snapshot.skills[0]?.security.state, "flagged");
      assert.equal(snapshot.skills[0]?.security.critical, 1);
      assert.equal(snapshot.skills[0]?.security.scannedScripts, 1);
      assert.equal(snapshot.skills[0]?.security.findings[0]?.ruleId, "dynamic-code-execution");
      assert.equal(snapshot.totals.scannedSkillScripts, 1);
      assert.doesNotMatch(JSON.stringify(snapshot), /siblingScriptToken/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

describe("Neon Skills inventory content hash", () => {
  function roots(primaryRoot: string): readonly INeonSkillRootConfig[] {
    return [
      { id: "primary", label: "Primary", kind: "workspace", path: primaryRoot, trust: "trusted-project" }
    ];
  }

  it("is stable for an unchanged skill set and changes when a skill is added", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const primaryRoot = join(projectRoot, "skills");
      await writeSkill(join(primaryRoot, "alpha", "SKILL.md"), "---\nname: alpha\n---\nbody");
      const options = { referenceRoot: join(projectRoot, "upstream"), skillRoots: roots(primaryRoot) };

      const first = await createNeonSkillInventorySnapshot(projectRoot, options);
      const second = await createNeonSkillInventorySnapshot(projectRoot, options);

      assert.match(first.contentHash, /^[a-f0-9]{64}$/u);
      assert.equal(first.contentHash, second.contentHash);

      await writeSkill(join(primaryRoot, "beta", "SKILL.md"), "---\nname: beta\n---\nbody");
      const third = await createNeonSkillInventorySnapshot(projectRoot, options);

      assert.notEqual(third.contentHash, first.contentHash);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("changes when a discovered skill file mtime advances", async () => {
    const projectRoot = await createTempProjectRoot();

    try {
      const primaryRoot = join(projectRoot, "skills");
      const skillPath = join(primaryRoot, "alpha", "SKILL.md");
      await writeSkill(skillPath, "---\nname: alpha\n---\nbody");
      const options = { referenceRoot: join(projectRoot, "upstream"), skillRoots: roots(primaryRoot) };

      const before = await createNeonSkillInventorySnapshot(projectRoot, options);
      await utimes(skillPath, new Date("2027-01-01T00:00:00.000Z"), new Date("2027-01-01T00:00:00.000Z"));
      const after = await createNeonSkillInventorySnapshot(projectRoot, options);

      assert.notEqual(after.contentHash, before.contentHash);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});

async function createTempProjectRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "neon-core-skills-"));
}

async function writeSkill(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function writeManifest(filePath: string, content: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
}
