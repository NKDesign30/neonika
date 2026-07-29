#!/usr/bin/env bash
#
# Pre-publication audit for the public repository.
#
# Why this exists: `git grep <username>` returning zero is not evidence of a
# clean repo. When it first returned zero here, the tree still carried real
# Discord snowflakes, home paths without a name in them, and a module exporting
# a private deployment profile. Absence of one string is not absence of
# identity. Each check below targets a class of leak, not a single spelling.
#
# Exit code is the gate: 0 means publishable, non-zero names what is left.
#
#   bash scripts/oss-audit.sh           # working tree
#   bash scripts/oss-audit.sh --history # also scan every commit
#
set -uo pipefail

# A .pyc embeds the absolute path of the machine that wrote it. Never write one.
export PYTHONDONTWRITEBYTECODE=1

cd "$(dirname "$0")/.." || exit 2

SCAN_HISTORY=0
[ "${1:-}" = "--history" ] && SCAN_HISTORY=1

FAILURES=0
SKIPPED=0
CHECK_NO=0

fail() {
  FAILURES=$((FAILURES + 1))
  printf '  \033[31mFAIL\033[0m %s\n' "$1"
}
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
skip() {
  SKIPPED=$((SKIPPED + 1))
  printf '  \033[33mskip\033[0m %s\n' "$1"
}

check() {
  CHECK_NO=$((CHECK_NO + 1))
  printf '\n[%d] %s\n' "$CHECK_NO" "$1"
}

# ---------------------------------------------------------------------------
# 1. Identity tokens, compared as hashes. Matching one spelling of a name is not
#    enough: the first version of this check passed while a module named after
#    the maintainer sat in the tree, along with 251 occurrences of the given
#    name inside identifiers.
#
#    The tokens live in scripts/oss-audit-denylist.sha256 as SHA-256, never as
#    words. A denylist of private names, published in a public repository,
#    leaks the names it exists to keep out. Matches print path and line only.
# ---------------------------------------------------------------------------
#    Exit 0 clean / 1 found / 2 could-not-run are three states, not two. Folding
#    "crashed" into "found" once made this check report a leak that was not there.
check "Identity tokens (hashed denylist)"
hits=$(python3 scripts/oss-identity-scan.py tree); rc=$?
case "$rc" in
  0) pass "no removed identity tokens in tracked files" ;;
  1) fail "an identity token is present ($(printf '%s' "$hits" | grep -c '' ) lines):"
     printf '%s\n' "$hits" | head -10 | sed 's/^/       /' ;;
  3) if [ "$SCAN_HISTORY" = "1" ]; then
       fail "denylist absent — a publication run may not skip the identity check"
     else
       skip "denylist absent (maintainer-only); identity tokens NOT checked"
     fi ;;
  *) fail "identity scan could not run (exit $rc) — the tree is UNVERIFIED" ;;
esac

# ---------------------------------------------------------------------------
# 2. Absolute home paths. The whitelist is a POSITIVE list of documentation
#    personas — never a blacklist of the real user, which would miss any path
#    that happens to belong to someone else.
# ---------------------------------------------------------------------------
#    A trailing name is required: `assert.doesNotMatch(path, /Users/)` is a
#    regex literal, not a home path, and must not be reported.
#
#    The personas below are the closed set fixtures may use. Growing this list
#    is the cost of the positive-whitelist design, and it is the right cost: a
#    blacklist of one real username lets every other real username through.
check "Absolute home paths outside the placeholder whitelist"
if hits=$(git grep -nE '/(Users|home)/[a-zA-Z0-9._-]+' -- . ':!scripts/oss-audit.sh' 2>/dev/null \
    | grep -vE '/(Users|home)/(you|user|me|someone|agent|operator|neo|neon|smoke|example|test|ada-lovelace)([/"'"'"'`)]|$)' ); then
  fail "machine-specific paths:"
  printf '%s\n' "$hits" | head -10 | sed 's/^/       /'
else
  pass "only placeholder home paths"
fi

# ---------------------------------------------------------------------------
# 3. Discord snowflakes. Whitelist of placeholder ranges, not of known-real IDs:
#    a blacklist cannot cover an ID nobody has looked at yet. That mistake cost
#    two rounds here — a filter on one ID prefix let a bot user ID through
#    because it started with different digits.
# ---------------------------------------------------------------------------
check "Discord snowflakes outside the placeholder ranges"
#    No -n here: a line number prefix would break the ^…$ anchors below and make
#    every placeholder look like a real ID.
#
#    Scans the whole repo, not just src/: the first version checked code only,
#    and README.md sat there with a real guild and channel id in a copy-paste
#    example. Docs leak exactly like code does.
#    The block is `9000000000000000xx`, not `9xxxxxxxxxxxxxxxxx`. The loose form
#    accepted `912345678901234567` — the shape of every real Discord id minted
#    between late 2021 and mid 2022 — as a placeholder. The `9000000000000000xx`
#    block is the one .gitleaks.toml allowlists as well, and those two must not
#    drift. The three literal ids below exist only here; gitleaks has no
#    snowflake rule, so there is nothing on its side to mirror them.
if hits=$(git grep -I -ohE '[0-9]{17,19}' -- . ':!scripts/oss-audit.sh' 2>/dev/null \
    | sort -u \
    | grep -vE '^(9000000000000000[0-9]{2}|112233445566778899|123456789012345678|999999999999999999)$' ); then
  fail "non-placeholder snowflakes:"
  printf '%s\n' "$hits" | head -10 | sed 's/^/       /'
else
  pass "only placeholder snowflakes"
fi

# ---------------------------------------------------------------------------
# 4. Binary files. Every text check above — git grep, the identity scanner,
#    gitleaks in practice — skips a file it cannot decode. That is a blind zone,
#    and it is not theoretical: a stray `__pycache__/*.pyc` was tracked here, and
#    it carried the absolute source path of the machine that wrote it, home
#    directory and username included. Ten checks were green.
#
#    "Binary" means "no text check can read it": not UTF-8 decodable. `file(1)`
#    calls two ordinary TypeScript sources binary because they contain a 0x1f,
#    and would have to be argued with instead of trusted.
#
#    Positive allowlist. A new binary fails until someone says why it is there.
# ---------------------------------------------------------------------------
check "Binary files outside the allowlist"
binaries=$(PYTHONDONTWRITEBYTECODE=1 python3 - <<'PYEOF'
import subprocess, sys
ALLOWED = {
    "assets/banner-dark.png",                     # README banner, rendered from
    "assets/banner-light.png",                    # SVG: IHDR/bKGD/IDAT/IEND only,
                                                  # no tEXt/iTXt/zTXt/eXIf/tIME
    "ui/public/fonts/SpaceGrotesk-Variable.ttf",  # the five fonts, SIL OFL,
    "ui/src/styles/fonts/InterVariable.ttf",      # see THIRD_PARTY_NOTICES.md
    "ui/src/styles/fonts/GeistMono-Variable.ttf",
    "ui/src/styles/fonts/DMSerifDisplay-Regular.ttf",
    "ui/src/styles/fonts/DMSerifDisplay-Italic.ttf",
}
files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
for path in files:
    if path in ALLOWED:
        continue
    try:
        with open(path, "rb") as handle:
            handle.read().decode("utf8")
    except UnicodeDecodeError:
        print(path)
    except OSError:
        pass
PYEOF
)
if [ -n "$binaries" ]; then
  fail "unreviewed binary files (no text check can read these):"
  printf '%s\n' "$binaries" | head -10 | sed 's/^/       /'
else
  pass "only allowlisted binaries"
fi

# ---------------------------------------------------------------------------
# 5. References to the private runtime that this project is being migrated from.
#    Meaningless to an outside reader, and it names an internal system.
# ---------------------------------------------------------------------------
check "References to the private predecessor runtime"
if hits=$(git grep -inE 'neo-wake|neon-home' -- . ':!scripts/oss-audit.sh' 2>/dev/null); then
  fail "predecessor runtime referenced in code:"
  printf '%s\n' "$hits" | head -10 | sed 's/^/       /'
else
  pass "no predecessor references in code"
fi

# ---------------------------------------------------------------------------
# 6. OpenClaw references. NOT a leak — OpenClaw is public and MIT, and keeping
#    the attribution is legally required wherever code was adapted or copied.
#    This check exists so the remaining references stay *deliberate*.
#
#    The whitelist is DERIVED from THIRD_PARTY_NOTICES.md rather than typed
#    here: a hand-kept second list drifts from the attribution it is supposed
#    to mirror, and the drift always favours deleting a notice.
# ---------------------------------------------------------------------------
#    Three kinds of mention are legitimate, and the check tests for the KIND of
#    line rather than whitelisting whole files — a file-level whitelist grows
#    until it exempts everything the file happens to contain:
#      a) a file listed in THIRD_PARTY_NOTICES.md (attribution)
#      b) an interop NAME: a quoted key or value that exists on disk or in a
#         manifest — the `openclaw` frontmatter key, `openclaw.plugin.json`, the
#         `OpenClaw` Application Support directory, the `format: "openclaw"`
#         manifest value. Renaming any of these makes the scanner find nothing.
#      c) a `github.com/openclaw` URL (public provenance link served in snapshots)
#    Anything else merely names the project in prose, and is a leftover.
#
#    The pattern tolerates regex-escaped forms (`openclaw\.plugin\.json`), which
#    is how a first pass silently rewrote four test fixtures.
#    The three seeded files are the repo's provenance surfaces: they exist in
#    order to say where the code came from, so naming the source there is the
#    point, not a leftover. Adding a fourth means a fourth file has taken on
#    that job — not that a stray mention needed somewhere to hide.
check "OpenClaw mentioned only for attribution, interop, or a public link"
attributed=$(mktemp)
{
  printf '%s\n' 'THIRD_PARTY_NOTICES.md' 'README.md' 'AGENTS.md' 'scripts/oss-audit.sh'
  grep -oE '`[A-Za-z0-9_./-]+\.(ts|md)`' THIRD_PARTY_NOTICES.md 2>/dev/null | tr -d '`'
} | sort -u > "$attributed"

leftovers=$(git grep -in 'openclaw' -- . 2>/dev/null \
  | grep -viE 'openclaw\\?\.plugin\\?\.json|github\\?\.com\\?/openclaw|["'"'"'`]openclaw["'"'"'`]|["'"'"'`]OpenClaw["'"'"'`]|Support\\?/OpenClaw|openclaw:|openclaw\[' \
  | while IFS=: read -r file rest; do
      grep -qxF "$file" "$attributed" || printf '%s:%s\n' "$file" "${rest%%:*}"
    done)
rm -f "$attributed"

if [ -n "$leftovers" ]; then
  fail "OpenClaw named without attribution, interop, or a link:"
  printf '%s\n' "$leftovers" | head -12 | sed 's/^/       /'
  printf '       (%s lines total — attribute the file, or drop the mention)\n' \
    "$(printf '%s\n' "$leftovers" | wc -l | tr -d ' ')"
else
  pass "every OpenClaw mention is attribution, interop, or a public link"
fi

# ---------------------------------------------------------------------------
# 7. Email addresses. None of the five checks above can see one: an address
#    carries no username, no snowflake, no home path, and gitleaks does not
#    treat it as a secret. A test fixture in this repo held a real exchange
#    between two named third parties — sender, recipient, subject, body — and
#    passed every check. Third-party personal data is the one leak class where
#    the repo owner is not the injured party.
#
#    Positive whitelist, same reason as check 2: reserved documentation domains,
#    the contact address the project publishes on purpose, and `git@github.com`,
#    which is the user part of an ssh remote url rather than a mailbox. A numeric
#    `@s.whatsapp.net` suffix is not a mailbox either; check 8 validates the full
#    JID, including an optional linked-device suffix, without losing the number.
# ---------------------------------------------------------------------------
check "Email addresses outside the placeholder whitelist"
if hits=$(git grep -ohE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . ':!scripts/oss-audit.sh' 2>/dev/null \
    | sort -u \
    | grep -vE '@(example\.(com|org|net)|db\.internal)$|\.test$|^info@design-nk\.de$|^git@github\.com$|^[0-9]+@s\.whatsapp\.net$' ); then
  fail "addresses that are neither reserved-for-documentation nor the published contact:"
  printf '%s\n' "$hits" | head -10 | sed 's/^/       /'
else
  pass "only placeholder and published-contact addresses"
fi

# ---------------------------------------------------------------------------
# 8. Contact identifiers. A phone number is not a secret, not an email, and not
#    a name — no check above sees one. This project's upstream reads WhatsApp,
#    where a JID *is* a phone number in plain text (`4915112345678@s.whatsapp.net`).
#    The tree is clean today; "clean today" is what the email fixture was, right
#    up until someone looked.
#
#    IBANs are matched per country with their exact length. A generic
#    two-letters-two-digits pattern matches every npm `sha512-` integrity hash.
# ---------------------------------------------------------------------------
check "Phone numbers, chat JIDs, and IBANs"
if hits=$(git grep -I -ohE '[0-9]{7,15}(:[0-9]{1,4})?@(s\.whatsapp\.net|c\.us|g\.us)|\+(49|43|41|386)[0-9]{6,}|DE[0-9]{20}|AT[0-9]{18}|CH[0-9]{19}|SI[0-9]{17}' \
    -- . ':!scripts/oss-audit.sh' 2>/dev/null \
    | sort -u \
    | grep -vE '^15551234567(:[0-9]{1,4})?@s\.whatsapp\.net$'); then
  fail "contact identifiers:"
  printf '%s\n' "$hits" | head -10 | sed 's/^/       /'
else
  pass "no phone numbers, chat JIDs, or IBANs"
fi

# ---------------------------------------------------------------------------
# 9. Secret scan. The allowlist lives in .gitleaks.toml, where every entry
#    carries its justification. An allowlist without a reason is a leak channel.
#
#    `gitleaks --no-git` ignores .gitignore and used to scan local runtime state
#    that cannot be published. Build the scan tree from Git's own publishable
#    set instead: tracked files plus untracked, non-ignored files. A force-added
#    state file is still tracked and therefore still fails.
# ---------------------------------------------------------------------------
scan_gitleaks_working_tree() {
  local audit_tree
  local repo_path
  audit_tree=$(mktemp -d) || return 2

  while IFS= read -r -d '' repo_path; do
    if [ ! -e "$repo_path" ] && [ ! -L "$repo_path" ]; then
      continue
    fi
    mkdir -p "$audit_tree/$(dirname "$repo_path")" || {
      rm -rf -- "$audit_tree"
      return 2
    }
    cp -P -- "$repo_path" "$audit_tree/$repo_path" || {
      rm -rf -- "$audit_tree"
      return 2
    }
  done < <(git ls-files -z --cached --others --exclude-standard)

  (
    cd "$audit_tree" &&
      gitleaks detect \
        --no-git \
        --source . \
        --config .gitleaks.toml \
        --no-banner \
        --redact \
        >/dev/null 2>&1
  )
  local scan_status=$?
  rm -rf -- "$audit_tree"
  return "$scan_status"
}

check "gitleaks (working tree)"
if ! command -v gitleaks >/dev/null 2>&1; then
  fail "gitleaks not installed (brew install gitleaks)"
elif scan_gitleaks_working_tree; then
  pass "no secrets in working tree"
else
  fail "gitleaks reported findings in tracked or publishable untracked files"
fi

if [ "$SCAN_HISTORY" = "1" ]; then
  check "gitleaks (full history)"
  if ! command -v gitleaks >/dev/null 2>&1; then
    fail "gitleaks not installed"
  elif gitleaks detect --no-banner --redact >/dev/null 2>&1; then
    pass "no secrets in history"
  else
    fail "gitleaks reported findings in history — rewrite BEFORE the first public push"
  fi

  # -------------------------------------------------------------------------
  # Identity in history. gitleaks answers "is there a secret", and a name, an
  # email, and a company are none. This repository began as a copy of a private
  # one, so every string the checks above removed still sits in the commit that
  # imported it. `git grep` reads the tip; a reader of a published repo reads
  # `git log -p`.
  #
  # Not fixable by editing a file. The only remedy is rewriting history before
  # the first push — which is why this check exists to say so, and stops.
  # -------------------------------------------------------------------------
  #
  #    Scans what `git push` of the CURRENT branch would carry — not
  #    `rev-list --all`, which also sees local branches nobody is publishing and
  #    would report a clean branch as dirty. Every branch you intend to push has
  #    to pass this on its own.
  check "Identity across every commit of this branch, not just the tip"
  hist=$(python3 scripts/oss-identity-scan.py history); rc=$?
  case "$rc" in
    0) pass "no identity tokens in any commit of this branch" ;;
    1) fail "identity survives in history ($(printf '%s' "$hist" | grep -c '') files):"
       printf '%s\n' "$hist" | head -6 | sed 's/^/       /'
       printf '       A published clone carries these. Squash or rewrite before the first push.\n' ;;
    3) fail "denylist absent — a publication run may not skip the history check" ;;
    *) fail "history identity scan could not run (exit $rc) — the history is UNVERIFIED" ;;
  esac

  # -------------------------------------------------------------------------
  # Commit metadata is not a file, so no grep above can see it. Every commit in
  # `git log` names an author and a committer, and a published clone shows them.
  #
  # Publishing under your own name is a choice. The scanner allows only the
  # maintainer spellings already public in this repository's GitHub metadata;
  # every email and every other name still goes through the denylist.
  # -------------------------------------------------------------------------
  check "Commit author and committer identities"
  who=$(python3 scripts/oss-identity-scan.py authors); rc=$?
  case "$rc" in
    0) pass "no identity tokens in commit metadata" ;;
    1) fail "commit metadata carries an identity token ($(printf '%s' "$who" | grep -c '') fields):"
       printf '%s\n' "$who" | head -6 | sed 's/^/       /'
       printf '       Rewrite with git filter-repo --mailmap, or allow the name.\n' ;;
    *) fail "author identity scan could not run (exit $rc) — metadata is UNVERIFIED" ;;
  esac
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAILURES" -eq 0 ]; then
  if [ "$SKIPPED" -gt 0 ]; then
    # A skipped check is not a passed check. Saying "passed" without saying how
    # many questions went unasked is the quiet lie this whole script exists against.
    printf '\033[32mAudit passed\033[0m — %d checks, 0 failures, \033[33m%d skipped\033[0m.\n' \
      "$CHECK_NO" "$SKIPPED"
    printf 'Run with --history before publishing; skipped checks are failures there.\n'
  else
    printf '\033[32mAudit passed\033[0m — %d checks, 0 failures.\n' "$CHECK_NO"
  fi
  exit 0
fi
printf '\033[31mAudit failed\033[0m — %d of %d checks need work.\n' "$FAILURES" "$CHECK_NO"
printf 'This is expected while slices are still open. It must be green before the first public push.\n'
exit 1
