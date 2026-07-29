---
name: to-tickets
description: Break a spec, plan, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker — native blocking links on GitHub/GitLab, or one file per ticket locally. Use after /to-spec, or whenever a plan needs slicing into parallel-buildable work.
---

<!-- Adapted from https://github.com/mattpocock/skills under the MIT License. See THIRD_PARTY_NOTICES.md in the Neonika distribution. -->

# To Tickets

Break a spec, plan, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it. This is the step between a settled spec and the build: `/to-spec → to-tickets → build`.

The tracker choice (GitHub / GitLab / local markdown) follows `wayfinder/issue-tracker.md`. The tickets are the same either way — only the shape of the blocking edges changes.

## Process

### 1. Gather context

Work from whatever is already in the conversation. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments. Consult configured project and agent memory for prior decisions and known pitfalls before slicing.

### 2. Explore the codebase (optional)

If you haven't already, explore the code to understand the current state. Ticket titles and descriptions use the project's domain glossary (see `/domain-modeling`) and respect ADRs in the area you're touching. Look for **prefactoring** that makes the implementation easier: "make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer-bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring is its own first ticket

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately (it's on the **frontier**).

**Wide refactors are the exception to vertical slicing.** A wide refactor is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so one edit breaks thousands of call sites at once and no vertical slice lands green. Sequence it as **expand–contract**: first **expand** (add the new form beside the old so nothing breaks); then **migrate** call sites in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, CI green batch to batch because the old form still exists; finally **contract** (delete the old form once no caller remains, blocked by every migrate batch). When even the batches can't stay green alone, keep the sequence but share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Quiz the user

Present the breakdown as a numbered list. Per ticket show:

- **Title** — short descriptive name
- **Blocked by** — which other tickets (if any) must complete first
- **What it delivers** — the end-to-end behaviour this ticket makes work

Ask: Does the granularity feel right (too coarse / too fine)? Are the blocking edges correct — does each ticket depend only on tickets that genuinely gate it? Should any be merged or split? Iterate until the user approves. This is a real gate — do not publish before approval.

### 5. Publish to the configured tracker

Publish the approved tickets in dependency order (blockers first):

- **Local files** → one file per ticket under `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` in dependency order. Use the local template below — one ticket per file, never a combined file.
- **A real tracker (GitHub / GitLab)** → one issue per ticket in dependency order so blocking edges can reference real ids. Use the platform's native sub-issue / blocking relationship where it has one; otherwise fill the `## Blocked by` body section. Apply the `ready-for-agent` label unless told otherwise.

Do NOT close or modify any parent issue.

<local-ticket-template>

# <NN> — <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None — can start immediately".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>

<issue-template>

## Parent

A reference to the parent issue on the tracker (omit if the source wasn't an existing issue).

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None — can start immediately".

</issue-template>

In either form, avoid specific file paths or code snippets — they go stale fast. Exception: a `/prototype` snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape) — inline the decision-rich parts and note it came from a prototype.

## Build the frontier

Work the **frontier** — any ticket whose blockers are all done — one ticket at a time, **clearing context between tickets**. Each ticket follows the project's normal implementation workflow and closes only after its checks and real entry point are proven.

For several unblocked tickets at once, use the available agent-delegation mechanism — one isolated agent per ticket, each with explicit file ownership and no overlapping writes.

## Neonika notes

- **Load relevant memory before delegation.** Pass only the context needed for the ticket and use a role suited to the work.
- **No two agents write the same files.** The blocking edges already serialize dependent work; for parallel frontier tickets confirm file ownership does not overlap before spawning.
- **An agent result is input, not proof.** Review every returned diff and verify it at the source before a ticket counts as done.
- **Runtime truth before "done".** A ticket closes on a live proof of the real user flow, not on green tests alone.
- German prose keeps its umlauts (ä ö ü ß). Ticket titles, acceptance criteria and labels stay English so the tracker stays consistent.
