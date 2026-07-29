# Matt Pocock skill collection

Neonika bundles a reviewed, portable adaptation of the stable engineering
workflow from [mattpocock/skills](https://github.com/mattpocock/skills).
The source was reviewed against upstream commit
`2ab958093e83e0ec752e6c1c5932da465bf23e0c` on 2026-07-29.

Included skills:

- `codebase-design`
- `diagnose` (upstream: `diagnosing-bugs`)
- `domain-modeling`
- `grill-with-docs`
- `grilling`
- `improve-codebase-architecture`
- `prototype`
- `resolving-merge-conflicts`
- `tdd`
- `teach`
- `to-spec`
- `to-tickets`
- `triage`
- `wayfinder`
- `writing-great-skills`

`neon-grill-me` is the small Neonika wrapper used by `grilling` and
`grill-with-docs`.

The bundle deliberately excludes deprecated, in-progress, personal and setup
skills. It also excludes `ask-matt`, `code-review`, `implement` and `research`:
those either install the upstream collection, assume an upstream-specific host,
or overlap with Neonika's existing review and execution workflow.

Neonika removes maintainer-specific paths, account assumptions and unavailable
commands from the adapted text. Local workspace, Codex and agent skills are
scanned before this bundle and therefore override a bundled skill with the same
name.

License and provenance are recorded in `THIRD_PARTY_NOTICES.md`; every adapted
file also carries its own source header.
