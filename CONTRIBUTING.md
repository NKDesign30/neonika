# Contributing

## Expectations, honestly

One maintainer, working on this alongside other things. Issues and pull requests
get read; replies take days, not hours. A PR that sits open is not being
ignored — it is queued.

Small, focused changes get merged. Large refactors, new abstractions, or
architecture proposals will probably not, unless they were discussed in an issue
first.

## Before you open a PR

```bash
npm ci
npm run doctor              # tsc --noEmit, then the full suite
npm run ui:test             # only if you touched ui/
bash scripts/oss-audit.sh   # only if you touched docs, fixtures, or config
```

`npm run doctor` must be green, and the test count must not silently drop. If a
test disappeared, say so and say why in the PR description.

## What a good change looks like

- **One real entry point.** A CLI command, an HTTP endpoint, a Doctor check, or
  a channel smoke. Code that no entry point reaches is not finished.
- **A test that would have failed before.** For a bug fix, write it first and
  watch it fail.
- **No new `any`.** Use `unknown`, a concrete type, or a generic.
- **No stubs.** No `TODO`, no `throw new Error("not implemented")`, no
  placeholder data. Ship the smaller correct thing instead.
- **Match the surrounding style.** This codebase has strong conventions
  (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, NodeNext imports).
  `AGENTS.md` lists the ones that surprise people.

## The two things that will get a PR rejected

**Breaking the shadow contract.** Outbound stays suppressed, plugins stay
unloaded, runs stay terminal-only, redaction stays on every boundary. If your
change needs one of those to move, that is a discussion, not a PR.

**Copying code without attribution.** If you port something from another
project, add it to `THIRD_PARTY_NOTICES.md` *and* leave a header in the file.
The notices file does not travel with a vendored directory.

## Commit messages

Say what changed and why it was wrong before. The diff already says how.

## Security

Do not open an issue for anything exploitable. See [SECURITY.md](SECURITY.md).
