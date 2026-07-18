#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/neonika-npm-install.XXXXXX")
cleanup() {
  rm -r -- "$smoke_dir"
}
trap cleanup EXIT

pack_report="$smoke_dir/pack.json"
prefix="$smoke_dir/prefix"
workspace="$smoke_dir/workspace"
extracted="$smoke_dir/extracted"
mkdir -p "$workspace" "$extracted"

npm pack --json --pack-destination "$smoke_dir" >"$pack_report"

package_file=$(node - "$pack_report" <<'NODE'
const { readFileSync } = require("node:fs");
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const packed = report[0];
if (!packed || typeof packed.filename !== "string" || !Array.isArray(packed.files)) {
  throw new Error("npm pack did not return a package manifest");
}
const paths = packed.files.map((file) => file.path);
const allowed = paths.every((path) =>
  path === "package.json" ||
  path === "README.md" ||
  path === "LICENSE" ||
  path === "THIRD_PARTY_NOTICES.md" ||
  path.startsWith("dist/src/")
);
if (!allowed || !paths.includes("dist/src/cli.js")) {
  throw new Error("npm package contains files outside the runtime allowlist");
}
process.stdout.write(packed.filename);
NODE
)

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
)

npm uninstall --global --prefix "$prefix" neonika >/dev/null
if [ -e "$neonika_bin" ]; then
  printf 'npm uninstall left the Neonika bin behind\n' >&2
  exit 1
fi

printf 'Neonika npm install smoke: ok\n'
printf 'Package: %s\n' "$package_file"
printf 'Version: %s\n' "$installed_version"
printf 'Leak scan: clean (%s files, %s bytes)\n' "$package_files" "$package_bytes"
printf 'Uninstall: clean\n'
