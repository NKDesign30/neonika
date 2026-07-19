#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

release_dir="${1:-release}"
case "$release_dir" in
  ""|"/"|"."|"..")
    printf 'Unsafe release directory: %s\n' "$release_dir" >&2
    exit 2
    ;;
esac

bash scripts/verify-changelog.sh
npm run build:package >/dev/null

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/neonika-release.XXXXXX")
cleanup() {
  rm -r -- "$temporary_dir"
}
trap cleanup EXIT

mkdir -p "$release_dir"
npm pack --json --ignore-scripts --pack-destination "$temporary_dir" >"$temporary_dir/pack.json"
packed_name=$(node - "$temporary_dir/pack.json" <<'NODE'
const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (!report[0] || typeof report[0].filename !== "string") {
  throw new Error("npm pack did not return an artifact name");
}
process.stdout.write(report[0].filename);
NODE
)

artifact="$release_dir/neonika.tgz"
checksum_file="$release_dir/neonika.tgz.sha256"
manifest_file="$release_dir/neonika.release.json"
notes_file="$release_dir/neonika.release-notes.md"
cp "$temporary_dir/$packed_name" "$artifact"
checksum=$(shasum -a 256 "$artifact" | awk '{print $1}')
printf '%s  %s\n' "$checksum" "neonika.tgz" >"$checksum_file"

version=$(node -p 'require("./package.json").version')
commit=$(git rev-parse HEAD)
branch=$(git branch --show-current)
[ -n "$branch" ] || branch="detached"
source_timestamp=$(git show -s --format=%cI HEAD)
dirty=false
[ -z "$(git status --porcelain)" ] || dirty=true

node - "$version" "$commit" "$branch" "$source_timestamp" "$dirty" "$checksum" "$manifest_file" <<'NODE'
const { writeFileSync } = require("node:fs");
const [version, commit, branch, generatedAt, dirtyText, checksum, output] = process.argv.slice(2);
const manifest = {
  schemaVersion: 1,
  product: "neonika",
  version,
  commit,
  branch,
  generatedAt,
  dirty: dirtyText === "true",
  changelog: `CHANGELOG.md#${version.replaceAll(".", "")}`,
  artifact: {
    name: "neonika.tgz",
    sha256: checksum
  },
  integrityFile: "neonika.tgz.sha256",
  distribution: "github-release",
  signing: "not-applicable"
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

node - "$version" "$notes_file" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [version, output] = process.argv.slice(2);
const changelog = readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replaceAll(".", "\\.");
const heading = new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})$`, "m").exec(changelog);
const sectionStart = heading ? heading.index + heading[0].length : -1;
const nextHeading = sectionStart >= 0 ? changelog.indexOf("\n## ", sectionStart) : -1;
const notes = sectionStart >= 0
  ? changelog.slice(sectionStart, nextHeading >= 0 ? nextHeading : changelog.length).trim()
  : "";
if (!heading || !heading[1] || notes === "") {
  throw new Error(`Cannot extract release notes for ${version}`);
}
writeFileSync(output, `# Neonika ${version}\n\n${notes}\n`, "utf8");
NODE

printf 'Neonika release package: ready\n'
printf 'Version: %s\n' "$version"
printf 'Artifact: %s\n' "$artifact"
printf 'SHA-256: %s\n' "$checksum"
printf 'Manifest: %s\n' "$manifest_file"
printf 'Source: %s (%s, dirty=%s)\n' "$commit" "$branch" "$dirty"
