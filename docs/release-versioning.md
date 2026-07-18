# Release and versioning

`package.json#version` is Neonika's only version source. `package-lock.json`, the
changelog section, Git tag, release manifest, installed CLI version, and GitHub
Release must match it.

Stable releases use SemVer and the tag `v<version>`. User-visible features bump
the minor version; compatible fixes bump the patch version.

## Build and verify

```bash
bash scripts/verify-changelog.sh
npm run doctor
npm run ui:test
bash scripts/oss-audit.sh --history
bash scripts/package-release.sh
bash scripts/npm-install-smoke.sh release/neonika.tgz
```

`scripts/package-release.sh` creates:

- `release/neonika.tgz`
- `release/neonika.tgz.sha256`
- `release/neonika.release.json`
- `release/neonika.release-notes.md`

The manifest records the version, commit, branch, source timestamp, dirty state,
changelog anchor, artifact name, and SHA-256. A public release is ready only
when the source tree is clean, the tag points at that commit, CI passes, and a
fresh prefix installs the exact uploaded asset.

## Publish and rollback

Pushing `v<version>` runs `.github/workflows/release.yml`, repeats the package
gate, and creates the GitHub Release. Never replace an existing versioned tag.
If a release is bad, leave its immutable evidence intact, mark it as not latest,
fix forward with a new patch version, and point the README's `latest` installer
at the new release.
