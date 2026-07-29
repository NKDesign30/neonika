---
name: grill-with-docs
description: A relentless interview to sharpen a plan or design, which also creates docs (ADRs and glossary) as we go. Use when the user wants to stress-test a plan against their project's language and documented decisions.
---

<!-- Adapted from https://github.com/mattpocock/skills under the MIT License. See THIRD_PARTY_NOTICES.md in the Neonika distribution. -->

# Grill With Docs

Run a `/grilling` session, using the `/domain-modeling` skill.

The grilling supplies the interview loop — one question at a time, recommendation attached, facts looked up rather than asked. Domain modeling supplies the side effects — `CONTEXT.md` sharpened and ADRs written the moment a decision crystallises, not batched at the end.

Use this when the vocabulary and the decisions should outlive the session. When they shouldn't, use `/neon-grill-me` (no files written) or plain `/grilling`.

When the effort is too big for a single session, chart it with `/wayfinder` first — it grills breadth-first and splits the space into tickets, each small enough to grill properly on its own.
