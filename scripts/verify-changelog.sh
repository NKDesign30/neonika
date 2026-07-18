#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node <<'NODE'
const { readFileSync } = require("node:fs");

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const changelog = readFileSync("CHANGELOG.md", "utf8");
const version = manifest.version;

if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("package.json version must be stable SemVer");
}
if (lock.version !== version || lock.packages?.[""]?.version !== version) {
  throw new Error("package-lock.json version does not match package.json");
}
const escaped = version.replaceAll(".", "\\.");
const heading = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m").exec(changelog);
const sectionStart = heading ? heading.index + heading[0].length : -1;
const nextHeading = sectionStart >= 0 ? changelog.indexOf("\n## ", sectionStart) : -1;
const section = sectionStart >= 0
  ? changelog.slice(sectionStart, nextHeading >= 0 ? nextHeading : changelog.length)
  : "";
if (!heading || !/^- .+/m.test(section)) {
  throw new Error(`CHANGELOG.md needs a non-empty [${version}] release section`);
}
process.stdout.write(`Changelog gate: ${version} ready\n`);
NODE
