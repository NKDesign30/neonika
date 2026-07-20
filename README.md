<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img alt="neonika — an agent runtime that listens before it speaks" src="assets/banner-light.png">
</picture>

Channels come in. Runs happen. Nothing goes out until you say so.

An agent runtime in TypeScript: it takes messages in from a channel, runs an
agent against them, and shows an operator what happened. Runs are persisted,
redacted, and replayable. Nothing is sent back out until you explicitly arm it.

**Status: silent by default.** A fresh install is a complete runtime — it takes
messages in, runs agents, records everything. It sends nothing until you arm
outbound, and arming shows you the targets first. Suppression sits at the seam,
not merely unconfigured.

## Install

Requires Node.js 22.19+ (or 23.11+).

```bash
npm install --global https://github.com/NKDesign30/neonika/releases/latest/download/neonika.tgz
neonika --help
neonika onboard
neonika onboarding-smoke
neonika mission-control-serve        # http://127.0.0.1:8798/mission-control
```

`neonika onboard` is an interactive first-use wizard in a terminal. For CI or
headless hosts, use `neonika onboard --yes` and add channel settings later. The
wizard creates a private local config, bootstraps SQLite memory, links an
explicit owner identity across configured channels, and keeps outbound delivery
suppressed. Tokens remain environment variables and are never written to the
config file.

Discord is configured as the primary hub. WhatsApp is configured as a linked
companion with DMs allowlisted to the owner and groups disabled by default. The
wizard reports WhatsApp login as pending until a real linked-device session has
been verified.

After onboarding, link the companion from an interactive terminal and scan the
QR in WhatsApp under **Linked devices**:

```bash
neonika whatsapp-login
neonika whatsapp-status
neonika onboarding-smoke
neonika whatsapp-shadow-tap
```

The tap accepts only the explicitly linked owner, ignores history replay,
deduplicates message ids across restarts, attaches the same local memory used by
Discord, and records a terminal shadow run. Start both channel taps from the
same workspace so they resolve to the same owner session. The WhatsApp tap does
not send a reply.

Upgrade and uninstall use the normal npm lifecycle:

```bash
npm install --global https://github.com/NKDesign30/neonika/releases/latest/download/neonika.tgz
npm uninstall --global neonika
```

## Quickstart

Requires Node.js 22.19+ (or 23.11+). No database, no services, no API key.

```bash
git clone https://github.com/NKDesign30/neonika.git && cd neonika
npm ci
npm run build:package
node dist/src/cli.js status
```

That prints the product manifest. To see the operator dashboard:

```bash
npm run serve                     # http://127.0.0.1:8798/mission-control
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

## The silence contract

This is the invariant most of the architecture follows, and the reason you can
run it without worrying:

- **Outbound is disarmed.** Delivery records carry `state: "suppressed"` until
  you arm sending. There is a sender seam, and the no-op implementation is the
  default one.
- **Runs are terminal-only.** The store holds completed and failed runs. There
  is no live in-flight run to interrupt, by design.
- **Everything crossing a boundary is redacted.** Tokens, keys, paths and
  transcripts pass through `redactText` before they reach a log, a snapshot, an
  HTTP response, or the dashboard. The test suite asserts the absence of the
  literal secret, not the presence of a mask.

Breaking the silence is one deliberate act, not a climb:

```bash
node dist/src/cli.js arm-outbound        # shows the targets, changes nothing
node dist/src/cli.js arm-outbound --yes  # arms sending
node dist/src/cli.js disarm-outbound     # back to silence
```

`doctor` answers "will this send" at any point, and names what is missing when
the answer is no. Arming needs a token, a channel allowlist and an approval
flag alongside it — arming alone never sends.

Migrating off an existing runtime is a different case, and there is machinery
for it: a staged ladder (`shadow -> mirror -> canary -> primary -> retire`)
where each rung needs recorded comparison evidence before the next unlocks. A
fresh install does not walk it — the mirror rung compares an old runtime
against a new one. See `src/core/cutoverGate.ts` if you are coming from
something else.

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

The Claude harness pins each tier to a model id (`sonnet` -> `claude-sonnet-4-6`,
`haiku` -> `claude-haiku-4-5`). Those pins age as new models ship, so each is
overridable without forking:

```bash
NEON_CLAUDE_MODEL_SONNET=claude-sonnet-5
NEON_CLAUDE_MODEL_HAIKU=claude-haiku-5
```

An unset or malformed value keeps the shipped default — the value is spliced
into argv, so anything that could read as a further CLI flag is refused rather
than passed through. The Codex harness needs no equivalent: it runs whatever the
local `codex` CLI is configured with and pins nothing.

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
