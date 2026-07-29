#!/usr/bin/env python3
"""Find removed identity tokens without naming them.

The denylist is a file of SHA-256 hashes (``scripts/oss-audit-denylist.sha256``).
Writing the words out in a public repository would leak the very names the audit
exists to remove, and printing a matched word would leak it again into a CI log.
So: hash the tokens, hash every word in the repository, compare.

Word-level, never substring: a forbidden token has to be a whole word, so a
longer word that merely contains those letters is not a hit. Identifiers are
split further on camelCase and on punctuation, so ``someNameDetector`` also
yields ``some``, ``Some-Name-Memory`` also yields ``name``, and an email address
yields each of its parts.

    oss-identity-scan.py tree        # tracked files at the working tree
    oss-identity-scan.py history     # every blob reachable from HEAD
    oss-identity-scan.py authors     # author/committer of every commit

Exit 0 clean, 1 on a hit, 2 when the scan could not run, 3 when the denylist is
absent. Those four are distinct on purpose: a crashing scanner that exits 1 is
indistinguishable from a finding, and reads as a leak that is not there — or
hides one that is. Exit 3 says "this machine cannot answer the question", which
is a different sentence from "the answer is no".

The denylist is not in the repository. Unsalted SHA-256 over guessable names is
a membership oracle: anyone may hash a candidate and confirm that it was scrubbed
from a private history. Harmless for the maintainer, whose name is on the account
anyway — wrong for the third parties this exists to protect.

Output is ``path:line`` (tree) or ``path`` (history) — never the word.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
from pathlib import Path

DENYLIST = Path(__file__).with_name("oss-audit-denylist.sha256")
SELF = {"scripts/oss-identity-scan.py", "scripts/oss-audit-denylist.sha256"}
PUBLISHED_MAINTAINER_NAMES = {
    "Niko Knez",
    "Niko.Knez",
}

# A run of letters, including the German ones — an ASCII-only class would split
# "Grüße" into "gr" and "e" and quietly stop matching anything spelled properly.
WORD = re.compile(r"[A-Za-zÄÖÜäöüßÀ-ÿ]+")
# camelCase / PascalCase / ACRONYMWord boundaries.
CAMEL = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+")


class ScanError(RuntimeError):
    """The scan could not run. Distinct from "the scan found something"."""


class MissingDenylist(RuntimeError):
    """No denylist on this machine. Distinct from "the denylist found nothing"."""


def load_denylist() -> set[str]:
    if not DENYLIST.is_file():
        raise MissingDenylist(DENYLIST.name)
    hashes = {
        line.strip()
        for line in DENYLIST.read_text(encoding="utf8").splitlines()
        if line.strip() and not line.startswith("#")
    }
    if not hashes:
        raise ScanError(f"denylist empty: {DENYLIST.name}")
    return hashes


def tokens(text: str) -> set[str]:
    """Every lowercased token a word could reasonably be read as."""
    out: set[str] = set()
    for chunk in WORD.findall(text):
        out.add(chunk.lower())
        parts = CAMEL.findall(chunk)
        if len(parts) > 1:
            out.update(part.lower() for part in parts)
    return out


def hit(text: str, deny: set[str]) -> bool:
    return any(hashlib.sha256(t.encode()).hexdigest() in deny for t in tokens(text))


def git(*args: str) -> str:
    result = subprocess.run(["git", *args], capture_output=True)
    if result.returncode != 0:
        raise ScanError(f"git {' '.join(args)}: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout.decode("utf8", errors="replace")


def as_text(blob: bytes) -> str | None:
    """None for binary. A font or a PNG holds no readable name, and decoding one
    strictly crashes the scan — which is how this check first reported a leak
    that did not exist."""
    try:
        return blob.decode("utf8")
    except UnicodeDecodeError:
        return None


def scan_tree(deny: set[str]) -> list[str]:
    findings: list[str] = []
    for path in git("ls-files").splitlines():
        if path in SELF:
            continue
        try:
            content = as_text(Path(path).read_bytes())
        except OSError:
            continue
        if content is None:
            continue
        for number, line in enumerate(content.splitlines(), start=1):
            if hit(line, deny):
                findings.append(f"{path}:{number}")
    return findings


def reachable_blobs() -> dict[str, str]:
    """Unique blob sha -> a path it appears at, across every commit from HEAD.

    Deduplicating by content turns 8 commits x 600 files into a few hundred
    reads. Unchanged files share one blob.
    """
    blobs: dict[str, str] = {}
    for line in git("rev-list", "--objects", "HEAD").splitlines():
        sha, _, path = line.partition(" ")
        path = path.strip()
        if not path or path in SELF:
            continue  # commits and trees carry no path
        blobs.setdefault(sha, path)
    return blobs


def scan_history(deny: set[str]) -> list[str]:
    blobs = reachable_blobs()
    if not blobs:
        return []

    # One `cat-file --batch` beats one `git show` per blob by three orders of
    # magnitude in process count.
    proc = subprocess.run(
        ["git", "cat-file", "--batch"],
        input="\n".join(blobs).encode() + b"\n",
        capture_output=True,
    )
    if proc.returncode != 0:
        raise ScanError(f"git cat-file: {proc.stderr.decode(errors='replace').strip()}")

    findings: list[str] = []
    out, offset = proc.stdout, 0
    while offset < len(out):
        newline = out.index(b"\n", offset)
        sha, kind, size = out[offset:newline].split(b" ")
        start = newline + 1
        end = start + int(size)
        # `rev-list --objects` names directories too, so trees arrive here with a
        # path attached. Only blobs hold text.
        if kind == b"blob":
            content = as_text(out[start:end])
            if content is not None and hit(content, deny):
                findings.append(blobs[sha.decode()])
        offset = end + 1  # trailing newline after each object

    return sorted(set(findings))


def scan_authors(deny: set[str]) -> list[str]:
    """Commit metadata is not a file. `git grep` cannot reach it, so an audit
    built only on greps reports a clean tree while every commit in `git log`
    still carries a name.

    Whether a maintainer publishes under their own name is a choice, not a leak.
    This check only enforces the choice already recorded in the denylist.
    """
    fields = ("author-name", "author-email", "committer-name", "committer-email")
    log = git("log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce", "HEAD")

    findings: list[str] = []
    for line in log.splitlines():
        if not line:
            continue
        commit, *values = line.split("\0")
        for name, value in zip(fields, values):
            if name.endswith("-name") and value in PUBLISHED_MAINTAINER_NAMES:
                continue
            if hit(value, deny):
                findings.append(f"{commit[:12]}:{name}")
    return findings


SCANS = {"tree": scan_tree, "history": scan_history, "authors": scan_authors}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in SCANS:
        print(__doc__, file=sys.stderr)
        return 2

    try:
        deny = load_denylist()
        findings = SCANS[sys.argv[1]](deny)
    except MissingDenylist as absent:
        # Name only. An absolute path names a home directory, and a CI log is public.
        print(f"denylist absent (maintainer-only): {absent}", file=sys.stderr)
        return 3
    except ScanError as error:
        print(f"identity scan could not run: {error}", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001 - never exit 1 for a crash
        print(f"identity scan crashed: {error!r}", file=sys.stderr)
        return 2

    for line in findings:
        print(line)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
