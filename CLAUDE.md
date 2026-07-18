# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

Everything worth knowing lives in [AGENTS.md](AGENTS.md): the shadow contract
that shapes the architecture, the hard rules, the commands, and the traps
(`dist/` zombie tests, `exactOptionalPropertyTypes`, NodeNext imports).

Read it before your first edit.

Two additions specific to this tool:

- **Verify at the entry point, not at the build.** `tsc` passing is not evidence
  a feature works. Run the CLI command, hit the HTTP endpoint, or run the
  matching `*-smoke` harness, and report what it printed.
- **Do not commit, merge, or push.** That decision belongs to the maintainer.
