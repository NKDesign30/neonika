#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

package_input="${1:-}"
if [ -n "$package_input" ]; then
  package_input=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$package_input")
  if [ ! -f "$package_input" ]; then
    printf 'Package artifact not found: %s\n' "$package_input" >&2
    exit 2
  fi
fi

smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/neonika-npm-install.XXXXXX")
cleanup() {
  rm -r -- "$smoke_dir"
}
trap cleanup EXIT

prefix="$smoke_dir/prefix"
workspace="$smoke_dir/workspace"
config_root="$smoke_dir/config"
extracted="$smoke_dir/extracted"
mkdir -p "$workspace" "$extracted"

if [ -n "$package_input" ]; then
  package_file="neonika.tgz"
  cp "$package_input" "$smoke_dir/$package_file"
  tar -tzf "$smoke_dir/$package_file" >"$smoke_dir/package-files.txt"
  tar -tvzf "$smoke_dir/$package_file" >"$smoke_dir/package-entries.txt"
  if grep -Eq '^[lhcbps]' "$smoke_dir/package-entries.txt"; then
    printf 'Release package contains a link or special filesystem entry\n' >&2
    exit 1
  fi
  node - "$smoke_dir/package-files.txt" <<'NODE'
const { readFileSync } = require("node:fs");
const { posix } = require("node:path");
const entries = readFileSync(process.argv[2], "utf8")
  .split(/\r?\n/u)
  .filter(Boolean);
for (const entry of entries) {
  if (
    !entry.startsWith("package/") ||
    entry.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(entry)
  ) {
    throw new Error("release package contains an unsafe path");
  }
  const relative = entry.slice("package/".length);
  if (relative === "" || posix.normalize(relative) !== relative) {
    throw new Error("release package contains a non-canonical path");
  }
}
const paths = entries.map((entry) => entry.slice("package/".length));
const allowed = paths.every((path) =>
  path === "package.json" ||
  path === "README.md" ||
  path === "LICENSE" ||
  path === "THIRD_PARTY_NOTICES.md" ||
  path.startsWith("skills/") ||
  path.startsWith("dist/src/") ||
  path.startsWith("dist/control-ui/")
);
if (
  !allowed ||
  !paths.includes("dist/src/cli.js") ||
  !paths.includes("dist/control-ui/index.html") ||
  !paths.includes("skills/wayfinder/SKILL.md") ||
  !paths.includes("skills/teach/SKILL.md") ||
  !paths.includes("skills/ultraresearch/SKILL.md")
) {
  throw new Error("release package contains files outside the runtime allowlist");
}
NODE
else
  pack_report="$smoke_dir/pack.json"
  npm run build:package >/dev/null
  npm pack --json --ignore-scripts --pack-destination "$smoke_dir" >"$pack_report"

  package_file=$(node - "$pack_report" <<'NODE'
const { readFileSync } = require("node:fs");
const { posix } = require("node:path");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const packed = report[0];
if (!packed || typeof packed.filename !== "string" || !Array.isArray(packed.files)) {
  throw new Error("npm pack did not return a package manifest");
}
const paths = packed.files.map((file) => file.path);
if (paths.some((path) =>
  typeof path !== "string" ||
  path === "" ||
  path.includes("\\") ||
  /[\u0000-\u001f\u007f]/u.test(path) ||
  posix.normalize(path) !== path
)) {
  throw new Error("npm package contains a non-canonical path");
}
const allowed = paths.every((path) =>
  path === "package.json" ||
  path === "README.md" ||
  path === "LICENSE" ||
  path === "THIRD_PARTY_NOTICES.md" ||
  path.startsWith("skills/") ||
  path.startsWith("dist/src/") ||
  path.startsWith("dist/control-ui/")
);
if (
  !allowed ||
  !paths.includes("dist/src/cli.js") ||
  !paths.includes("dist/control-ui/index.html") ||
  !paths.includes("skills/wayfinder/SKILL.md") ||
  !paths.includes("skills/teach/SKILL.md") ||
  !paths.includes("skills/ultraresearch/SKILL.md")
) {
  throw new Error("npm package contains files outside the runtime allowlist");
}
process.stdout.write(packed.filename);
NODE
  )
fi

tar -xzf "$smoke_dir/$package_file" -C "$extracted"
package_root="$extracted/package"
package_stats=$(node - "$package_root" <<'NODE'
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = process.argv[2];
let files = 0;
let bytes = 0;
const pending = [root];

while (pending.length > 0) {
  const current = pending.pop();
  if (current === undefined) {
    continue;
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      pending.push(path);
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(path).size;
    }
  }
}

if (files === 0 || bytes === 0) {
  throw new Error("extracted npm package is empty");
}
process.stdout.write(`${files} ${bytes}`);
NODE
)
read -r package_files package_bytes <<<"$package_stats"

if [ ! -f "$package_root/dist/src/cli.js" ]; then
  printf 'Extracted npm package has no runtime entry point\n' >&2
  exit 1
fi

if [ ! -f "$package_root/dist/control-ui/index.html" ]; then
  printf 'Extracted npm package has no Mission Control SPA\n' >&2
  exit 1
fi

gitleaks dir "$package_root" \
  --config scripts/npm-package-gitleaks.toml \
  --no-banner \
  --redact \
  >/dev/null

npm install --global --prefix "$prefix" "$smoke_dir/$package_file" >/dev/null

neonika_bin="$prefix/bin/neonika"
expected_version=$(node -p 'require("./package.json").version')
installed_version=$("$neonika_bin" --version)
if [ "$installed_version" != "$expected_version" ]; then
  printf 'Version mismatch: expected %s, got %s\n' "$expected_version" "$installed_version" >&2
  exit 1
fi

"$neonika_bin" --help | grep -q '^Usage: neonika <command> \[options\]'
(
  cd "$workspace"
  "$neonika_bin" status >/dev/null
  "$neonika_bin" onboard --yes --config-root "$config_root" >/dev/null
  "$neonika_bin" onboarding-smoke --config-root "$config_root" >/dev/null
  "$neonika_bin" runtime-service-smoke | grep -q '^Neonika Runtime Service Smoke: ok$'
  "$neonika_bin" whatsapp-status --config-root "$config_root" | grep -q '^WhatsApp companion: disabled$'
  "$neonika_bin" mission-control-ui-smoke | grep -q '^UI: spa '
  HOME="$smoke_dir/home" "$neonika_bin" skills >"$smoke_dir/skills-report.txt"
  grep -q -- '- root neonika-bundled-skills: readable / 18 skill files / trusted-local' "$smoke_dir/skills-report.txt"
  HOME="$smoke_dir/home" "$neonika_bin" skill-commands >"$smoke_dir/skill-commands.txt"
  grep -q -- '- /skill:teach: model-disabled / owner teach@neonika-bundled-skills' "$smoke_dir/skill-commands.txt"
  grep -q -- '- /skill:ultraresearch: active / owner ultraresearch@neonika-bundled-skills' "$smoke_dir/skill-commands.txt"
)

node - "$config_root" <<'NODE'
const { statSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[2];
const mode = (path) => statSync(path).mode & 0o777;
if (mode(root) !== 0o700 || mode(join(root, "config.json")) !== 0o600) {
  throw new Error("fresh-install onboarding did not create private setup state");
}
if (mode(join(root, "memory", "semantic-memory.db")) !== 0o600) {
  throw new Error("fresh-install onboarding did not create private local memory");
}
NODE

npm uninstall --global --prefix "$prefix" neonika >/dev/null
if [ -e "$neonika_bin" ]; then
  printf 'npm uninstall left the Neonika bin behind\n' >&2
  exit 1
fi

printf 'Neonika npm install smoke: ok\n'
printf 'Package: %s\n' "$package_file"
printf 'Version: %s\n' "$installed_version"
printf 'Leak scan: clean (%s files, %s bytes)\n' "$package_files" "$package_bytes"
printf 'Fresh onboarding: private config and local memory ready\n'
printf 'Mission Control: packaged SPA ready\n'
printf 'Runtime service: portable lifecycle ready\n'
printf 'Bundled skills: 18 ready (Ultraresearch and Teach commands; Wayfinder packaged)\n'
printf 'Uninstall: clean\n'
