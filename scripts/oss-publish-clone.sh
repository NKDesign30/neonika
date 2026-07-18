#!/usr/bin/env bash
#
# Build the repository that gets pushed. Never push this one.
#
# This working copy holds two branches: the cleanup history, whose first commit
# still contains everything the audit later removed, and `public-main`, a single
# squashed commit that passes the audit over its whole history.
#
# `git push --all`, a GUI "Publish", or muscle memory typing `git push origin
# main` from the wrong directory puts the first one on GitHub. That is not
# recoverable by force-pushing afterwards: GitHub keeps unreachable objects and
# serves them by sha through the API until someone opens a support ticket.
#
# So the repository that has a remote is a different repository, and it only
# ever contained one branch. That is the whole idea.
#
#   bash scripts/oss-publish-clone.sh ~/neonika-public
#
set -euo pipefail

SOURCE_BRANCH="public-main"
TARGET_BRANCH="main"
PUBLISH_NAME="NK Design"
PUBLISH_EMAIL="info@design-nk.de"

source_repo="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-}"

if [ -z "$target" ]; then
  echo "usage: bash scripts/oss-publish-clone.sh <target-directory>" >&2
  exit 2
fi
if [ -e "$target" ]; then
  echo "refusing to write into an existing path: $target" >&2
  exit 2
fi
if ! git -C "$source_repo" show-ref --verify --quiet "refs/heads/$SOURCE_BRANCH"; then
  echo "branch $SOURCE_BRANCH does not exist in $source_repo" >&2
  exit 2
fi

echo "==> cloning $SOURCE_BRANCH only"
# --no-local matters more than --single-branch. Cloning a local path uses the
# local transport, which hardlinks the whole object store: the clone ends up
# with every object the source has, including the commits of the branch that
# still contains everything. `git push` would not send them, but the directory
# sitting on disk carries them, and a tar of it leaks the lot. --no-local forces
# the pack protocol, which sends only what the cloned branch reaches.
git clone --quiet --no-local --single-branch --branch "$SOURCE_BRANCH" "$source_repo" "$target"
git -C "$target" remote remove origin
git -C "$target" branch --move "$TARGET_BRANCH"
git -C "$target" config user.name "$PUBLISH_NAME"
git -C "$target" config user.email "$PUBLISH_EMAIL"

# The clone inherits this machine's committer identity for any future commit
# unless it is overridden here — the squashed commit is anonymous, the next one
# would not be, and CI only notices after the push.

echo "==> proving the clone carries nothing else"
refs=$(git -C "$target" for-each-ref --format='%(refname)' | wc -l | tr -d ' ')
commits=$(git -C "$target" rev-list --all --count)
remotes=$(git -C "$target" remote | wc -l | tr -d ' ')
printf '    refs=%s commits=%s remotes=%s\n' "$refs" "$commits" "$remotes"
if [ "$refs" != "1" ] || [ "$commits" != "1" ] || [ "$remotes" != "0" ]; then
  echo "clone is not a single anonymous commit on a single ref without a remote — stopping" >&2
  exit 1
fi

# Counting refs and commits proves what is reachable. It says nothing about what
# is *present*: a local-transport clone answers `cat-file -e` for every object of
# the source. So ask the object store directly, for every branch tip that must
# not be here.
echo "==> proving the private objects are absent, not merely unreferenced"
leaked=0
while read -r sha name; do
  [ "$name" = "refs/heads/$SOURCE_BRANCH" ] && continue
  if git -C "$target" cat-file -e "$sha" 2>/dev/null; then
    printf '    %s (%s) is readable inside the clone\n' "${sha:0:12}" "$name" >&2
    leaked=1
  fi
done < <(git -C "$source_repo" for-each-ref --format='%(objectname) %(refname)' refs/heads)
if [ "$leaked" != "0" ]; then
  echo "the clone still holds objects from another branch — stopping" >&2
  exit 1
fi
printf '    no foreign branch tip resolves inside the clone\n'

objects_source=$(git -C "$source_repo" count-objects -v | awk '/^count:|^in-pack:/{s+=$2} END{print s}')
objects_target=$(git -C "$target" count-objects -v | awk '/^count:|^in-pack:/{s+=$2} END{print s}')
printf '    objects: source=%s clone=%s\n' "$objects_source" "$objects_target"

# The denylist is deliberately untracked, so a clone does not get one. The audit
# refuses to skip the identity check under --history, which is exactly the run
# about to happen.
denylist="scripts/oss-audit-denylist.sha256"
if [ -f "$source_repo/$denylist" ]; then
  cp "$source_repo/$denylist" "$target/$denylist"
  echo "==> copied the maintainer-only denylist into the clone"
else
  echo "no denylist at $source_repo/$denylist — the audit below will refuse to run" >&2
fi

echo "==> full audit inside the clone"
( cd "$target" && bash scripts/oss-audit.sh --history )

cat <<EOF

The clone is clean. Nothing has been pushed.

  cd $target
  git remote add origin git@github.com:<owner>/<repo>.git
  git push -u origin $TARGET_BRANCH

On GitHub afterwards: enable Secret Scanning and Push Protection, protect
$TARGET_BRANCH, and turn on Dependabot security updates. If the repository
already existed with other content, delete and recreate it rather than
force-pushing over it.
EOF
