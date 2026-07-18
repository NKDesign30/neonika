<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img alt="neonika — an agent runtime that listens before it speaks" src="assets/banner-light.png">
</picture>

Channels come in. Runs happen. Nothing goes out until you say so.

An agent runtime in TypeScript: it takes messages in from a channel, runs an
agent against them, and shows an operator what happened. Runs are persisted,
redacted, and replayable. Nothing is sent back out until you explicitly arm it.

Copied or adapted modules and their sources are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Comments that say `upstream`
identify adapted source.

**Status: shadow.** The runtime observes, records, and reports. Outbound
delivery is suppressed at the seam, not merely unconfigured. Treat this as
software you can read, run, and inspect — not as something to point at a
production channel.

## Quickstart

Requires Node.js 22.19+ (or 23.11+). No database, no services, no API key.

```bash
git clone <this repo> && cd neonika
npm ci
npm run build
node dist/src/cli.js status
```

That prints the product manifest. To see the operator dashboard:

```bash
npm run serve                     # http://127.0.0.1:8788/mission-control/gateway
```

To check what the runtime thinks of its own environment:

```bash
node dist/src/cli.js doctor
```

On a fresh clone Doctor reports the memory backend as unavailable and finds no
runs. That is the correct answer for an empty machine, not a broken install.

Copy `.env.example` to `.env` if you want to change anything. Every value is
optional.

## What runs where

| Layer | Role |
| --- | --- |
| Neonika | Agent runs, policy, sessions, tasks, tools, memory context |
| Neonika Gateway | Ingress: Discord, channels, devices |
| Neonika Mission Control | Operator dashboard over the live snapshots |
| Neonika Memory | Recall over a local SQLite store (FTS5 + optional vectors) |
| Neonika Doctor | Health, auth, config, security checks |

The CLI is the primary entry point — `node dist/src/cli.js` with no argument
lists every command. The `*-smoke` commands are live verification harnesses:
they start a real server, exercise a real path, and print what happened.

```bash
node dist/src/cli.js gateway-api-smoke        # HTTP gateway, start to teardown
node dist/src/cli.js mission-control-ui-smoke # dashboard renders
node dist/src/cli.js doctor-smoke             # every health check
node dist/src/cli.js tui                      # read-only terminal dashboard
```

## The shadow contract

This is the invariant most of the architecture follows, and the reason you can
run it without worrying:

- **Outbound is suppressed.** Delivery records carry `state: "suppressed"`.
  There is a sender seam, and the no-op implementation is the default one.
- **Runs are terminal-only.** The store holds completed and failed runs. There
  is no live in-flight run to interrupt, by design.
- **Everything crossing a boundary is redacted.** Tokens, keys, paths and
  transcripts pass through `redactText` before they reach a log, a snapshot, an
  HTTP response, or the dashboard. The test suite asserts the absence of the
  literal secret, not the presence of a mask.

Moving beyond shadow is a staged, gated decision:

```text
shadow -> mirror -> canary -> primary -> retire
```

Each stage requires recorded evidence before the next one unlocks. See
`src/core/cutoverGate.ts`.

## External dependencies

The agent harness shells out to coding CLIs. Neither ships with this repo, and
neither is needed to build, test, or explore:

- `codex` — the Codex app-server harness (`appserver-smoke`, `thread-smoke`)
- `claude` — the Claude CLI harness (`harness-smoke`)

Reading a Discord channel needs a bot token and an explicit allowlist. It is
opt-in, reads secrets only from the environment, and still sends nothing:

```bash
NEON_DISCORD_BOT_TOKEN=...
NEON_DISCORD_BOT_USER_ID=...
NEON_DISCORD_ALLOWED_GUILDS=...
NEON_DISCORD_ALLOWED_CHANNELS=...
node dist/src/cli.js discord-shadow-tap
```

## Development

```bash
npm run check     # tsc --noEmit
npm test          # build, then node --test over dist/test
npm run doctor    # check + test — the gate
npm run ui:test   # the Lit dashboard's own suite
bash scripts/oss-audit.sh   # pre-publication leak audit
```

Tests run from compiled output, so a single file means building first:

```bash
npm run build && node --test dist/test/replay-snapshot.test.js
```

Two things about this codebase surprise people:

- `exactOptionalPropertyTypes` is on. You cannot assign `undefined` to an
  optional property; omit it with a conditional spread instead.
- `noUncheckedIndexedAccess` is on. `array[0]` is `T | undefined`.

Both are deliberate. Match the surrounding style.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues go to
[SECURITY.md](SECURITY.md) — please read the deployment warnings there before
running this anywhere that matters.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
