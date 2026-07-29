---
name: grilling
description: Grill the user relentlessly about a plan or design, one question at a time. Use when the user wants to stress-test a plan before building, or uses any 'grill' trigger phrase. Reference skill — other skills invoke it.
---

<!-- Adapted from https://github.com/mattpocock/skills under the MIT License. See THIRD_PARTY_NOTICES.md in the Neonika distribution. -->

# Grilling

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions **one at a time**, waiting for feedback on each before continuing. Asking multiple questions at once is bewildering — the human can only hold one open decision at a time, and a batch forces them to answer shallowly or not at all.

If a **fact** can be found by exploring the codebase, look it up rather than asking me. The **decisions**, though, are mine — put each one to me and wait for my answer. An agent that answers its own decision questions has broken the point of the session.

Do not enact the plan until I confirm we have reached a shared understanding.

## Which grill to run

This skill is the raw interview loop. Three skills wrap it:

- **`/grilling`** (this one) — the loop itself, no side effects. Invoked by other skills.
- **`/grill-with-docs`** — the same loop, plus `/domain-modeling`: writes `CONTEXT.md` and ADRs as decisions crystallise. Use when the vocabulary and the decisions should outlive the session.
- **`/neon-grill-me`** — Neonika's German variant with a fixed output shape and an explicit KISS bias. No files written, no ADRs. Use for a quick plan stress-test.

If the effort is too big for one session, don't grill it flat — chart it with `/wayfinder` instead, which grills breadth-first and then splits the space into tickets.

## Neonika notes

- Always give a clear recommendation. No neutral advisor fog.
- If the plan is overengineered, cut it smaller before grilling the details.
- Consult configured project and agent memory before asking the user about facts or decisions that may already be recorded.
