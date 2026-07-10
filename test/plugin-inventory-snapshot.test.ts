import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createNeonPluginInventorySnapshot,
  neonPluginInstallGateFlag,
  renderNeonPluginsReport
} from "../src/index.js";

let workspace: string;
let referenceRoot: string;

async function writeManifest(directoryName: string, contents: string): Promise<void> {
  const dir = join(referenceRoot, "extensions", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "openclaw.plugin.json"), contents, "utf8");
}

async function writePluginPackage(
  directoryName: string,
  contents: Readonly<Record<string, unknown>>,
  options: { readonly shrinkwrap?: boolean } = {}
): Promise<void> {
  const dir = join(referenceRoot, "extensions", directoryName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(contents, null, 2)}\n`, "utf8");

  if (options.shrinkwrap === true) {
    const name = typeof contents["name"] === "string" ? contents["name"] : directoryName;
    const shrinkwrap = { name, lockfileVersion: 3 };
    await writeFile(join(dir, "npm-shrinkwrap.json"), `${JSON.stringify(shrinkwrap, null, 2)}\n`, "utf8");
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "neon-plugin-inv-"));
  referenceRoot = join(workspace, "upstream");
  await mkdir(join(referenceRoot, "extensions"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("createNeonPluginInventorySnapshot", () => {
  it("builds a read-only snapshot with the install gate disabled by default", async () => {
    await writeManifest("discord", JSON.stringify({ id: "discord", channels: ["discord"] }));
    await writeManifest(
      "acpx",
      JSON.stringify({ id: "acpx", enabledByDefault: true, commandAliases: [{ name: "acpx" }] })
    );
    await writePluginPackage(
      "acpx",
      {
        name: "@neon/acpx",
        version: "1.0.0",
        type: "module",
        main: "./dist/index.js",
        dependencies: { "@sinclair/typebox": "1.1.39" },
        optionalDependencies: { sharp: "1.0.0" }
      },
      { shrinkwrap: true }
    );

    const snapshot = await createNeonPluginInventorySnapshot(workspace, {
      referenceRoot,
      allowlist: ["acpx"],
      env: {}
    });

    assert.equal(snapshot.generatedFrom, "upstream-extensions");
    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.installGate.enabled, false);
    assert.equal(snapshot.installGate.flag, neonPluginInstallGateFlag);
    assert.deepEqual([...snapshot.trustPolicy.allowlist], ["acpx"]);
    assert.equal(snapshot.totals.plugins, 2);
    assert.equal(snapshot.totals.autoLoadHonored, 0);
    assert.equal(snapshot.source.extensionRoot, join(referenceRoot, "extensions"));

    const acpx = snapshot.plugins.find((plugin) => plugin.id === "acpx");
    assert.equal(acpx?.trustLevel, "allowlisted");
    assert.equal(acpx?.autoLoadOnStartup, true);
    assert.equal(acpx?.autoLoadHonored, false);
    assert.equal(acpx?.installDecision, "gated"); // flag off -> never plan-only
    assert.equal(acpx?.packageProof.packageJson, "present");
    assert.equal(acpx?.packageProof.runtimeEntry, "compiled");
    assert.equal(acpx?.packageProof.runtimeDependencies, 1);
    assert.equal(acpx?.packageProof.optionalDependencies, 1);
    assert.equal(acpx?.packageProof.shrinkwrap, "present");
    assert.equal(acpx?.packageProof.liveProof, "package-ready");
  });

  it("reflects an enabled gate as plan-only for allowlisted plugins, gated otherwise", async () => {
    await writeManifest("acpx", JSON.stringify({ id: "acpx" }));
    await writeManifest("discord", JSON.stringify({ id: "discord" }));

    const snapshot = await createNeonPluginInventorySnapshot(workspace, {
      referenceRoot,
      allowlist: ["acpx"],
      env: { [neonPluginInstallGateFlag]: "true" }
    });

    assert.equal(snapshot.installGate.enabled, true);
    assert.equal(snapshot.plugins.find((plugin) => plugin.id === "acpx")?.installDecision, "plan-only");
    assert.equal(snapshot.plugins.find((plugin) => plugin.id === "discord")?.installDecision, "gated");
  });

  it("separates package proof from trust proof without loading plugin code", async () => {
    await writeManifest("source-only", JSON.stringify({ id: "source-only" }));
    await writePluginPackage("source-only", {
      name: "@neon/source-only",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.ts"] },
      devDependencies: { "@sinclair/typebox": "1.1.39" }
    });
    await writeManifest("missing-package", JSON.stringify({ id: "missing-package" }));

    const snapshot = await createNeonPluginInventorySnapshot(workspace, {
      referenceRoot,
      allowlist: ["source-only"],
      env: { [neonPluginInstallGateFlag]: "true" }
    });

    const sourceOnly = snapshot.plugins.find((plugin) => plugin.id === "source-only");
    const missing = snapshot.plugins.find((plugin) => plugin.id === "missing-package");

    assert.equal(sourceOnly?.trustLevel, "allowlisted");
    assert.equal(sourceOnly?.installDecision, "plan-only");
    assert.equal(sourceOnly?.packageProof.packageJson, "present");
    assert.equal(sourceOnly?.packageProof.runtimeEntry, "source-only");
    assert.equal(sourceOnly?.packageProof.runtimeDependencies, 0);
    assert.equal(sourceOnly?.packageProof.liveProof, "source-only");
    assert.equal(missing?.trustLevel, "reference-only");
    assert.equal(missing?.packageProof.packageJson, "missing");
    assert.equal(missing?.packageProof.liveProof, "needs-package-json");
  });

  it("marks the inventory empty when no manifests exist", async () => {
    const snapshot = await createNeonPluginInventorySnapshot(workspace, { referenceRoot, env: {} });
    assert.equal(snapshot.state, "empty");
    assert.equal(snapshot.totals.plugins, 0);
  });

  it("does not leak manifest fields Neon never surfaces", async () => {
    await writeManifest(
      "leaky",
      JSON.stringify({ id: "leaky", apiKey: "sk-should-never-appear", description: "x" })
    );
    await writePluginPackage("leaky", {
      name: "leaky",
      main: "./dist/index.js",
      dependencies: { "secret-dependency-name": "1.0.0" }
    });
    const snapshot = await createNeonPluginInventorySnapshot(workspace, { referenceRoot, env: {} });
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /sk-should-never-appear/);
    assert.doesNotMatch(serialized, /secret-dependency-name/);
  });

  it("renders a human-readable report", async () => {
    await writeManifest("discord", JSON.stringify({ id: "discord", channels: ["discord"] }));
    const snapshot = await createNeonPluginInventorySnapshot(workspace, { referenceRoot, env: {} });
    const report = renderNeonPluginsReport(snapshot);

    assert.match(report, /Neon Plugins Inventory: ready/);
    assert.match(report, /Install gate: disabled/);
    assert.match(report, /- discord: reference-only/);
    assert.match(report, /package=needs-package-json/);
  });
});
