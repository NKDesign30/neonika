# Working on Neonika

Guidance for coding agents and humans. `CLAUDE.md` points here.

## What this is

An agent runtime: channels in, agent runs, operator dashboard out. It is an
independent rebuild of an OpenClaw-style agent OS; copied and adapted modules
are listed in `THIRD_PARTY_NOTICES.md`. Comments saying `upstream` mean OpenClaw.

## The invariant everything follows

The runtime is in **shadow mode**, and most design decisions fall out of it:

- Runs are terminal-only. The store holds completed and failed runs; there is no
  live in-flight run. Anything needing a live run signal cannot be exercised —
  that is by design, not a gap.
- Outbound is suppressed at the seam. `createNeonDryRunOutboundSender` is the
  default. Sending is gated behind the canary cutover stage.
- Everything crossing a boundary goes through `redactText`. Tests assert the
  literal secret is absent from the serialized output.

When something looks missing, it is usually one of: a shadow-contract block, an
explicit non-goal, data the harness protocol does not surface, or a UI slice
needing a browser. Do not fabricate data or break the contract to complete it.

## Hard rules

- **No secrets** in files, logs, docs, tests, or replies.
- **No fake dashboard state.** UI reads live APIs and snapshots, never hardcoded
  data.
- TypeScript strict. **No new `any`.**
- Copying code from another project needs source review and license attribution
  in `THIRD_PARTY_NOTICES.md` *and* a header in the file itself. A notices file
  does not survive someone vendoring a directory out of this repo.
- Prefer a small runtime slice with a check over an architecture showpiece.
- Every non-doc change should expose or exercise a real entry point: a CLI
  command, an HTTP endpoint, a channel smoke, or a Doctor check.

## Commands

```bash
npm run check     # tsc --noEmit
npm run build     # tsc -> dist/
npm test          # build, then node --test dist/test/*.test.js
npm run doctor    # check + test — the gate
npm run ui:test   # the dashboard's own suite
bash scripts/oss-audit.sh   # leak audit before publishing
```

Run `npm run doctor` after a slice and report the actual test count.

## Traps

**Tests run from `dist/`, not from source.** There is no ts-node, jest, or
vitest. To run one file, build first:

```bash
npm run build && node --test dist/test/replay-snapshot.test.js
```

`tsc` does not remove orphaned output. Delete a test file and its compiled `.js`
would keep running — and failing. The `prebuild` script wipes `dist/`, so
`npm run build` and `npm test` are safe; a bare `tsc` is not.

**Two test runs at once deadlock.** Several suites bind the same port or watch
the same `runs.jsonl`. A second `node --test` against `dist/` hangs on the first
file instead of failing. If the suite seems to stall, look for a stray process
before you look at the test.

**`exactOptionalPropertyTypes` is on.** You cannot assign `undefined` to an
optional property. Omit it with a conditional spread:
`...(value ? { key: value } : {})`. This pattern is everywhere; match it.

**`noUncheckedIndexedAccess` is on.** `array[0]` is `T | undefined`.

**NodeNext modules.** Relative imports carry `.js` extensions even from `.ts`
sources. Use `import type` for type-only imports — no inline `import("pkg").Type`.

**macOS filesystems are case-insensitive.** `stat("MEMORY.md")` and
`stat("memory.md")` collide. For exact-case detection, read the directory with
`readdir` and match the entry name.

**Anchor time-based fixtures to `Date.now()`.** A test pinning a calendar date
against code that checks the real wall clock passes until real time crosses the
window, then fails for everyone.

## Architecture

`src/index.ts` is a single re-export barrel; tests import from `../src/index.js`.

The cutover model is the backbone: `shadow → mirror → canary → primary → retire`.
`core/cutoverGate.ts` gates each stage on recorded evidence.

The harness bridges two event types, and conflating them is the most common
mistake:

- `TCodexRunEvent` — projection of live app-server *notifications*
- `TCodexHarnessEvent` — the persisted union stored on runs

Approval and elicitation are server-*initiated* requests, not notifications, and
are deliberately not modelled. Do not invent method names for them.

`gateway/runStore.ts` persists redacted runs. Pure snapshot builders read it
read-only; each has an HTTP endpoint, a CLI command, and tests. In Mission
Control, prefer server-rendered panels when the data is already in the gateway
snapshot — they are testable without a browser.
