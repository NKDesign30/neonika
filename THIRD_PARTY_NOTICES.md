# Third-Party Notices

Neonika is an independent rebuild of an OpenClaw-style agent runtime. Most of
it is written from scratch, but several modules were adapted from — and a few
copied from — [OpenClaw](https://github.com/openclaw/openclaw), which is MIT
licensed. Every such module is listed below with the upstream file it came from.

This list is maintained by hand. When you port anything else from an upstream
project, add it here **and** leave a header in the file itself: a notices file
does not survive someone vendoring a single directory out of this repo.

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
| `discord.js` | Apache-2.0 |
| `markdown-it` | MIT |
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

Space Grotesk is additionally loaded from Google Fonts at runtime; the committed
variable master is the offline fallback.
