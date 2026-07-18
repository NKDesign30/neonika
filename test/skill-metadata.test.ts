import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseNeonSkillInstallSpec,
  parseNeonSkillReferenceMetadata
} from "../src/skills/skillMetadata.js";

// Sample upstream skill frontmatter: the metadata.upstream block is an embedded
// multi-line JSON object with trailing commas (JSON5-ish), mirroring the real
// skills/apple-notes/SKILL.md shape in the upstream reference checkout.
const SAMPLE_SOURCE = [
  "---",
  "name: apple-notes",
  "description: Read and write Apple Notes",
  "metadata:",
  "  {",
  '    "openclaw":',
  "      {",
  '        "os": ["darwin"],',
  '        "requires": { "bins": ["memo"] },',
  '        "install":',
  "          [",
  '            { "id": "brew", "kind": "brew", "formula": "antoniorodr/memo/memo", "bins": ["memo"], "label": "Install via Homebrew" },',
  "          ],",
  "      },",
  "  }",
  "---",
  "Skill body that must never be parsed as metadata."
].join("\n");

describe("parseNeonSkillReferenceMetadata", () => {
  it("extracts os, requires, and sanitized install specs from a JSON5-ish block", () => {
    const metadata = parseNeonSkillReferenceMetadata(SAMPLE_SOURCE);
    assert.ok(metadata, "expected metadata to parse");
    assert.deepEqual(metadata?.os, ["darwin"]);
    assert.deepEqual(metadata?.requires?.bins, ["memo"]);
    assert.equal(metadata?.install?.length, 1);
    assert.equal(metadata?.install?.[0]?.kind, "brew");
    assert.equal(metadata?.install?.[0]?.formula, "antoniorodr/memo/memo");
    assert.deepEqual(metadata?.install?.[0]?.bins, ["memo"]);
    assert.equal(metadata?.install?.[0]?.label, "Install via Homebrew");
  });

  it("returns undefined when there is no metadata block", () => {
    const source = ["---", "name: plain", "description: No metadata here", "---", "Body"].join("\n");
    assert.equal(parseNeonSkillReferenceMetadata(source), undefined);
  });

  it("returns undefined when the metadata block has no upstream key", () => {
    const source = ["---", "name: x", 'metadata:', "  {", '    "other": { "a": 1 }', "  }", "---"].join("\n");
    assert.equal(parseNeonSkillReferenceMetadata(source), undefined);
  });

  it("does not treat a brace inside the skill body as metadata", () => {
    const source = ["---", "name: y", "description: d", "---", "const x = { not: 'metadata' };"].join("\n");
    assert.equal(parseNeonSkillReferenceMetadata(source), undefined);
  });
});

describe("parseNeonSkillInstallSpec", () => {
  it("accepts a well-formed brew spec", () => {
    const spec = parseNeonSkillInstallSpec({ id: "brew", kind: "brew", formula: "antoniorodr/memo/memo", bins: ["memo"] });
    assert.equal(spec?.kind, "brew");
    assert.equal(spec?.formula, "antoniorodr/memo/memo");
  });

  it("accepts a scoped node package with a version tag", () => {
    const spec = parseNeonSkillInstallSpec({ kind: "node", package: "@scope/tool@1.2.3" });
    assert.equal(spec?.kind, "node");
    assert.equal(spec?.package, "@scope/tool@1.2.3");
    assert.equal(spec?.id, "node", "id should default to the kind when omitted");
  });

  it("rejects a shell-metacharacter injection in a brew formula", () => {
    assert.equal(parseNeonSkillInstallSpec({ kind: "brew", formula: "memo; rm -rf /" }), undefined);
    assert.equal(parseNeonSkillInstallSpec({ kind: "brew", formula: "memo && curl evil" }), undefined);
    assert.equal(parseNeonSkillInstallSpec({ kind: "brew", formula: "$(whoami)" }), undefined);
  });

  it("rejects a non-https download url and url injection", () => {
    assert.equal(parseNeonSkillInstallSpec({ kind: "download", url: "http://example.com/x" }), undefined);
    assert.equal(parseNeonSkillInstallSpec({ kind: "download", url: "https://example.com/x; rm -rf /" }), undefined);
  });

  it("accepts a clean https download url", () => {
    const spec = parseNeonSkillInstallSpec({ kind: "download", url: "https://example.com/tool.tar.gz" });
    assert.equal(spec?.kind, "download");
    assert.equal(spec?.url, "https://example.com/tool.tar.gz");
  });

  it("rejects an unknown install kind and a missing target field", () => {
    assert.equal(parseNeonSkillInstallSpec({ kind: "curl", url: "https://example.com" }), undefined);
    assert.equal(parseNeonSkillInstallSpec({ kind: "brew" }), undefined);
    assert.equal(parseNeonSkillInstallSpec("not-an-object"), undefined);
  });
});
