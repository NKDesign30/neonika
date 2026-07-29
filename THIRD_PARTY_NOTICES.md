# Third-Party Notices

Neonika is an independent rebuild of an OpenClaw-style agent runtime. Most of
it is written from scratch, but several modules were adapted from — and a few
copied from — [OpenClaw](https://github.com/openclaw/openclaw), which is MIT
licensed. Every such module is listed below with the upstream file it came from.

This list is maintained by hand. When you port anything else from an upstream
project, add it here **and** leave a header in the file itself: a notices file
does not survive someone vendoring a single directory out of this repo.

## NK Design Mission Control

The Sites view, full Workboard replay detail and their related styles were
adapted from NK Design's first-party Neon Mission Control implementation for
Neonika. Copyright (c) NK Design; included with owner permission under this
repository's MIT license.

| Neonika file | Adapted surface |
| --- | --- |
| `ui/src/ui/views/sites.ts` | Sites reach and analytics view |
| `ui/src/ui/views/workboard.ts` | Workboard pagination and replay detail |
| `ui/src/ui/components/run-detail.ts` | Shared terminal-run detail overlay |
| `ui/src/ui/components/run-detail.test.ts` | Run-detail tests |
| `ui/src/styles/app.css` | Workboard detail overlay styles |
| `ui/src/styles/views.css` | Sites view styles |

## NK Design Neon Runtime

The Memory and live-indexer hardening below was adapted from NK Design's
first-party Neon runtime for Neonika. Copyright (c) NK Design; included with
owner permission under this repository's MIT license.

| Neonika file | Adapted surface |
| --- | --- |
| `src/indexer/memoryIndexActivity.ts` | Redacted live-indexer activity snapshots |
| `src/indexer/summaryQualityCli.ts` | Callable summary-quality entry point |
| `src/memory/memoryMaintenanceGate.ts` | Shared maintenance safety gate |
| `src/memory/neonMemoryDbOpen.ts` | SQLite open policy |
| `src/memory/neonMemoryEmbeddingBackfill.ts` | Gated embedding backfill |
| `src/memory/neonMemoryRecallTelemetry.ts` | Recall-gap telemetry |
| `test/memory-index-activity.test.ts` | Memory activity coverage |
| `test/memory-maintenance-gate.test.ts` | Maintenance gate coverage |
| `test/neon-memory-db-open.test.ts` | SQLite policy coverage |
| `test/neon-memory-embedding-backfill.test.ts` | Backfill coverage |
| `test/summary-quality-cli.test.ts` | Summary CLI coverage |

## Matt Pocock Skills

The prompt and reference files under the paths below were adapted from
[mattpocock/skills](https://github.com/mattpocock/skills), reviewed against
commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c`. Maintainer-specific paths,
host commands and account assumptions were removed for the portable Neonika
bundle. The exact included and intentionally excluded skills are recorded in
`skills/MATT_POCOCK_SKILLS.md`.

Copyright (c) 2026 Matt Pocock — MIT (full text below).

| Neonika path | Upstream surface |
| --- | --- |
| `skills/{codebase-design,diagnose,domain-modeling,grill-with-docs,improve-codebase-architecture,prototype,resolving-merge-conflicts,tdd,to-spec,to-tickets,triage,wayfinder}/` | `skills/engineering/` |
| `skills/{grilling,teach,writing-great-skills}/` | `skills/productivity/` |
| `skills/neon-grill-me/` | Neonika wrapper adapted from the upstream grilling workflow |

### MIT License

```
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenClaw

Copyright (c) 2026 OpenClaw Foundation — MIT (full text below).

### Copied, with local modifications

These carry substantial upstream code. Structure, naming, and most lines are
OpenClaw's.

| Neonika | OpenClaw |
| --- | --- |
| `src/gateway/markdownCore/chunk-text.ts` | `packages/markdown-core/src/chunk-text.ts` |
| `src/gateway/markdownCore/fences.ts` | `packages/markdown-core/src/fences.ts` |
| `src/gateway/markdownCore/ir.ts` | `packages/markdown-core/src/ir.ts` |
| `src/gateway/markdownCore/render.ts` | `packages/markdown-core/src/render.ts` |
| `src/gateway/markdownCore/tables.ts` | `packages/markdown-core/src/tables.ts` |
| `src/gateway/markdownCore/types.ts` | `packages/markdown-core/src/types.ts` |
| `src/gateway/replyChunking.ts` | `src/auto-reply/chunk.ts` |
| `src/gateway/discordChunk.ts` | `extensions/discord/src/chunk.ts` |
| `src/text/utf16Safe.ts` | `src/shared/utf16-slice.ts` |

### Adapted

Rewritten against Neonika's own model, but the algorithm, the pattern set, or
the constant originated upstream.

| Neonika | OpenClaw | What was taken |
| --- | --- | --- |
| `src/automation/conceptVocabulary.ts` | `extensions/memory-core/src/concept-vocabulary.ts` | `deriveConceptTags` keyword extraction (CJK segmentation dropped) |
| `src/skills/skillSecurityScan.ts` | `src/skills/security/scanner.ts` | `scanSource` pattern set, applied to `SKILL.md` bodies |
| `src/tasks/taskAudit.ts` | `src/tasks/task-registry.audit.ts` | `listTaskAuditFindings`, `summarizeTaskAuditFindings` |
| `src/plugin-sdk/manifest.ts` | `src/plugins/min-host-version.ts` | `MIN_HOST_VERSION_RE` semver-floor pattern |
| `src/plugin-sdk/trust.ts` | `src/plugins/dependency-denylist.ts` | `blockedInstallDependencyPackageNames` |
| `src/skills/neonSkillExtensions.ts` | `src/plugins/{dependency-denylist,min-host-version}.ts` | both of the above |
| `src/doctor/neonDoctor.ts` | `src/commands/doctor-workspace.ts`, `src/memory/root-memory-files.ts` | `detectRootMemoryFiles`, exact-case entry check |
| `src/secrets/secretRefs.ts` | `src/config/redact-snapshot.secret-ref.ts` | shape-validation approach, rebuilt for `op://` strings |
| `src/gateway/discordProgressCard.ts` | `src/channels/streaming.ts`, `src/agents/tool-display-config.ts` | progress-draft layout and tool display labels |
| `src/gateway/discordRecoveryFlow.ts` | `extensions/discord/src/approval-handler.runtime.ts` | owner-bound expiring recovery card pattern |
| `src/gateway/discordShadowTap.ts` | `src/channels/status-reactions.ts` | terminal-safe status-reaction lifecycle |
| `src/gateway/discordThreadWorkspace.ts` | `extensions/discord/src/monitor/thread-title.ts` | bounded thread-title heuristic |
| `src/gateway/discordUiColors.ts` | `extensions/discord/src/ui-colors.ts`, `extensions/discord/src/approval-handler.runtime.ts` | shared accent, severity and expiry presentation |
| `src/harness/threadRun.ts` | `src/agents/tool-display-config.ts` | bounded tool-detail extraction keys |

### MIT License

```
MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Runtime dependencies

Installed from npm, not vendored. Full license texts ship inside their packages.

| Package | License |
| --- | --- |
| `baileys` | MIT |
| `discord.js` | Apache-2.0 |
| `markdown-it` | MIT |
| `qrcode-terminal` | Apache-2.0 |
| `unpdf` | MIT |
| `ws` | MIT |
| `lit` (UI) | BSD-3-Clause |
| `@phosphor-icons/web` (UI) | MIT |

## Bundled fonts

These five font files are committed to this repository, unmodified. Each is
licensed under the **SIL Open Font License, Version 1.1**
(<https://openfontlicense.org>), which requires that this notice travel with the
files. The copyright lines below are read from each font's own `name` table.

| File | Copyright |
| --- | --- |
| `ui/public/fonts/SpaceGrotesk-Variable.ttf` | Copyright 2020 The Space Grotesk Project Authors |
| `ui/src/styles/fonts/InterVariable.ttf` | Copyright 2016 The Inter Project Authors |
| `ui/src/styles/fonts/GeistMono-Variable.ttf` | Copyright 2024 The Geist Project Authors |
| `ui/src/styles/fonts/DMSerifDisplay-Regular.ttf` | Copyright 2014–2017 Adobe Systems Incorporated, with Reserved Font Name 'Source'. Copyright 2019 Google LLC. |
| `ui/src/styles/fonts/DMSerifDisplay-Italic.ttf` | Copyright 2014–2017 Adobe Systems Incorporated, with Reserved Font Name 'Source'. Copyright 2019 Google LLC. |

Two OFL conditions bind anyone redistributing this repository:

- The fonts may not be sold on their own. Bundling them inside this software is
  what the license is for.
- DM Serif Display carries the Reserved Font Name **Source**. A modified version
  of that font may not be distributed under a name containing it.

Space Grotesk is loaded from the committed variable master; the UI does not
depend on a runtime font CDN.
