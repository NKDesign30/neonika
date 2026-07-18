# The Codex harness

How Neonika talks to a Codex app-server: what it owns, what it refuses to
model, and why the session key looks the way it does.

Provenance: the warm-session idea is taken from [OpenClaw](https://github.com/openclaw/openclaw),
which is also what comments in the source mean by `upstream`. The implementation
here is a rebuild — see `THIRD_PARTY_NOTICES.md` for the modules that were
actually copied or adapted.

## Why a harness at all

Spawning a CLI per turn is correct and slow. A warm app-server session, bound to
the channel it belongs to, keeps the model's context alive between turns. The
harness exists to make that binding explicit rather than incidental.

## The contract

```ts
// src/harness/types.ts
export interface ICodexHarness {
  readonly id: TNeonHarnessId; // "codex-app-server" | "claude-cli"
  run(input: ICodexHarnessInput): Promise<ICodexHarnessResult>;
}
```

Two harnesses satisfy it, so the contract stays free of Codex specifics. It is
also free of Discord specifics: Discord is one caller, not the interface.

## Two event types, and why conflating them breaks things

This is the mistake most easily made in this directory.

- **`TCodexRunEvent`** (`src/harness/threadRun.ts`) — a projection of live
  app-server *notifications*: thread started, item deltas, turn completed.
- **`TCodexHarnessEvent`** (`src/harness/types.ts`) — the union actually
  persisted on a run: `assistant-delta`, `tool-start`, `tool-output`,
  `file-write`, `command-exit`, `token-usage`, `final`, `failed`.

The first is what the transport emits. The second is what survives to the run
store and the dashboard. Every value in the second has passed `redactText`.

**Approval and elicitation are deliberately absent.** They are server-*initiated*
requests, not notifications, and nothing here models a request travelling in that
direction. Do not invent method names for them — an event kind that no transport
produces is worse than a missing feature, because it reads as supported.

## Session binding

Warm sessions are the point, so the key decides correctness, not just cache hits.

`deriveCodexSessionKey` (`src/harness/sessionKey.ts`) joins ten segments:

```text
neon:codex:{agentId}:{channel}:{accountId}:{guildId|dm}:{channelId}:{threadId|main}:{workspaceHash}:{mode}
```

Each segment is lowercased and stripped to `[a-z0-9_-]`; an empty result becomes
`none`. `workspaceHash` is `sha256(resolve(workspaceRoot))` truncated to 12 hex
characters.

What the segments buy, and what breaks without them:

- `accountId` and `guildId` — a DM and a guild channel never share a session.
  Absent `guildId` collapses to `dm`, which is a value, not a hole.
- `threadId` — the same thread resumes its conversation; a new thread does not.
- `workspaceHash` — pointing the agent at a different repository forces a new
  binding rather than silently reusing the old one's context.
- `mode` — a read-only session and a write-mode session never share state.

## State on disk

`resolveHarnessStatePaths` (`src/harness/statePaths.ts`) puts everything under
the project root, never the home directory:

```text
<projectRoot>/state/codex-harness/
  bindings/   # one JSON file per session
  logs/
  cache/
```

A binding file is named `sha256(sessionKey)` truncated to 24 hex characters
(`fingerprintSessionKey`). The key itself contains channel and guild ids, so it
is fingerprinted rather than used as a filename.

## Identity and memory

The harness receives targeted memory from Neonika. It does not crawl memory
itself, and a run records whether memory was `attached`, `skipped`, or `failed`,
so a reply never implies recall that did not happen.

The prompt is layered — agent identity, the request envelope, targeted memory
hits, workspace instructions, delivery rules — and does not import the whole
machine: not the full shell environment, not unrelated chat logs, not secrets.

## Security rules the harness holds

- No secret environment passthrough by default. The stdio transport passes safe
  base variables plus explicit overrides, and nothing else.
- Read-only sessions stay read-only. Write mode goes through the approval path.
- Tool output is redacted before it reaches a channel, a snapshot, or a log.
- Raw stack traces do not reach a final reply.

## Where this sits in the shadow contract

The gateway maps inbound messages into harness input, persists a run to
`state/gateway/runs.jsonl`, and suppresses outbound delivery. Mission Control
reads that file rather than fabricating cards. Runs are terminal-only: nothing is
executing while you inspect it, which is also why a live run interrupt has
nothing to interrupt.
