<!-- Adapted from https://github.com/mattpocock/skills under the MIT License. See THIRD_PARTY_NOTICES.md in the Neonika distribution. -->

# Issue tracker — Wayfinding operations

How `/wayfinder` expresses the map, its child tickets, blocking, and the frontier on each tracker.

**Pick the tracker** in this order:

1. If the repo has `docs/agents/issue-tracker.md`, that file wins — read it and follow it.
2. Otherwise pick by remote: `git remote -v` → GitHub → `gh`; GitLab → `glab`.
3. No remote, or a repository where issues are not tracked upstream → **local markdown**.

Never open issues on a customer's tracker without explicit permission. Default to local markdown when tracker ownership is unclear.

---

## GitHub (`gh`)

The **map** is a single issue with **child** issues as tickets.

- **Map**: an issue labelled `wayfinder:map`, holding the Destination / Notes / Decisions-so-far / fog body.
  `gh issue create --label wayfinder:map --title "<name>" --body-file <file>`
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` — one of `research`, `prototype`, `grilling`, `task`.
- **Blocking**: GitHub's native issue dependencies — the canonical, UI-visible representation.
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`
  where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), *not* the `#number` or `node_id`. The blocked-state summary rides on the issue payload — confirm the exact field on first use with `gh api repos/<o>/<r>/issues/<n> --jq .issue_dependencies_summary` (expected: a `blocked_by` count of *open* blockers). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

Labels must exist before use: `gh label create wayfinder:map` and one per ticket type.

---

## GitLab (`glab`)

The **map** is an issue; tickets are child issues linked by the map's task list.

- **Map**: `glab issue create --label wayfinder:map --title "<name>" --description "<body>"`
- **Child ticket**: `glab issue create --label "wayfinder:<type>"`, then add it to the map's task list. GitLab links children through the description checklist, not a native sub-issue API.
- **Blocking**: GitLab's native issue links — `glab api --method POST "projects/:id/issues/<child>/links?target_project_id=:id&target_issue_iid=<blocker>&link_type=is_blocked_by"`. A ticket is unblocked when every blocker is closed. Without link permissions, fall back to a `Blocked by: #<n>` line at the top of the child body.
- **Frontier query**: list the map's open children, then filter **client-side** — same shape as the GitHub block. `glab` has neither a label wildcard nor an "unassigned" filter: `--label` matches literally (so `wayfinder:*` matches a label of that exact name and returns nothing), and `--assignee` wants a username (`--not-assignee` excludes one person, it can't mean "nobody"). List once per ticket type and merge:
  `for t in research prototype grilling task; do glab issue list --state opened --label "wayfinder:$t"; done`
  then drop any ticket that has an assignee or an unclosed blocker. For the assignee check use the API, which does expose the real field: `glab api "projects/:id/issues/<iid>" --jq '.assignees | length'` → `0` means unclaimed. First in map order wins.
- **Claim**: `glab issue update <n> --assignee @me`
- **Resolve**: `glab issue note <n> --message "<answer>"`, then `glab issue close <n>`, then append the context pointer to the map.

---

## Local markdown (default)

The **map** is a file with one **child** file per ticket. No remote needed, works in any repo, survives offline.

```
.scratch/<effort>/
├── map.md
└── issues/
    ├── 01-which-harness-adapters.md
    └── 02-commit-extraction.md
```

- **Map**: `.scratch/<effort>/map.md` — the Destination / Notes / Decisions-so-far / fog body.
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `open`/`claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save **before any work**.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

Ticket file shape:

```markdown
Type: grilling
Status: open
Blocked by: 01

## Question

<the decision or investigation this ticket resolves>
```

Add `.scratch/` to `.gitignore` when the map is scratch-only. Commit it when the map should be shared or survive a clean checkout — for a long effort, commit it.
