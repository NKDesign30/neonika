---
name: to-spec
description: Turn the current conversation, a grill session, or a finished wayfinder map into a spec — no interview, just synthesis of what's already settled. Use after grilling/wayfinder when the decisions are made and you need a durable spec before breaking it into tickets.
---

<!-- Adapted from https://github.com/mattpocock/skills under the MIT License. See THIRD_PARTY_NOTICES.md in the Neonika distribution. -->

# To Spec

Take the current conversation context, a finished `/wayfinder` map, or a `/grilling` session and produce a **spec** (you may know this document as a PRD). Do NOT interview the user — just synthesize what is already known and decided. If decisions are still open, you are too early: run `/grilling` (or `/wayfinder` for the too-big case) first.

The spec is the through-line artifact: `idea → [wayfinder] → to-spec → /to-tickets → build`. It is durable, tracker-publishable, and survives context resets — which the raw conversation does not.

## Process

1. **Load what's already settled.** Consult configured project and agent memory first — a decision already made is not an open question, and belongs straight into the spec with its source. If the source was a wayfinder map, its **Decisions so far** is the primary input. Explore the repo to understand the current state if you haven't already. Use the project's domain glossary vocabulary throughout (see `/domain-modeling`), and respect any ADRs in the area you're touching.

2. **Sketch the test seams.** Name the seams at which you'll test the feature. Prefer existing seams to new ones, and use the highest seam possible — the fewer seams across the codebase, the better; the ideal is one. If new seams are needed, propose them at the highest point you can. Check with the user that these seams match their expectations.

3. **Write the spec** using the template below, then publish it. Where it goes depends on the tracker (see `wayfinder/issue-tracker.md`): a **real tracker** (GitHub/GitLab) → publish as an issue, apply the `ready-for-agent` label; **local** → write to `.scratch/<feature-slug>/spec.md`. No further triage needed.

<spec-template>

## Problem Statement

The problem the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories, each in the format:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see the balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

Be extensive — cover all aspects of the feature.

## Implementation Decisions

The decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that change
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets — they go stale fast.

Exception: if a `/prototype` produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo.

## Testing Decisions

- What makes a good test here (only test external behaviour, not implementation details)
- Which modules will be tested
- Prior art — similar tests already in the codebase

## Out of Scope

The things that are explicitly out of scope. If this came from a wayfinder map, its **Out of scope** section seeds this directly.

## Further Notes

Anything else worth recording.

</spec-template>

## Hand off

The spec is done → break it into buildable slices with **`/to-tickets`**. For a small, single-session feature you can skip tickets and go straight to the project's normal implementation and verification workflow.

## Neonika notes

- **Facts vs. decisions.** Synthesis, not interview — but if you hit a genuine open *decision* while writing (not a fact you can look up), stop and put it to the user. Don't quietly decide it yourself and bury it in the spec (Fakt vs. Entscheidung).
- Consult configured memory before writing, and persist load-bearing choices afterward when they will shape later work.
- German prose keeps its umlauts (ä ö ü ß). Spec headings, user-story text, ticket titles and labels stay English so the tracker stays consistent.
- The spec never carries secrets, tokens or absolute local paths — it's tracker-published and outlives the session.
