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

For a supervised owner-only outbound canary, stop the shadow tap and start the
separate canary entry point. It accepts only owner messages beginning with
`/neon`, rejects groups and other peers, and checks the persisted outbound arm
again before every reply:

```bash
NEON_CUTOVER_PROMOTE_ENABLED=ready \
  NEON_CUTOVER_STAGE=canary \
  NEON_CUTOVER_CANARY_APPROVED=ready \
  neonika cutover-promote
neonika arm-outbound --yes
NEON_WHATSAPP_CANARY_OUTBOUND_ENABLED=ready neonika whatsapp-canary-tap
```

`neonika disarm-outbound` stops subsequent sends without relying on a process
restart. The canary uses Neonika's private linked-device state and never imports
or shares predecessor credentials. Its receipts and run records contain hashed
targets, not the owner's phone number. The original `whatsapp-shadow-tap`
remains permanently no-send even when every outbound gate is armed.

For a supervised Gateway and Mission Control process, create one private runtime
environment file and install the generated user service. The service runs the
CLI from the installed package, writes logs and rollback evidence below the
private config root, and stores no secret values in its plist/unit or manifest:

```bash
install -m 600 /dev/null ~/.neonika/runtime.env
$EDITOR ~/.neonika/runtime.env
NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED=ready neonika runtime-service install
neonika runtime-service status
```

Upgrade the npm package, then run `install` again. That updates the service to
the new installed CLI, verifies its HTTP health, and automatically restores the
previous definition if the new runtime does not become ready. This is the path
Martin can use both for a first supervised install and for later updates:

```bash
npm install --global https://github.com/NKDesign30/neonika/releases/latest/download/neonika.tgz
NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED=ready neonika runtime-service install
neonika runtime-service status
```

The remaining lifecycle commands are explicit and default-off:

```bash
NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED=ready neonika runtime-service restart
NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED=ready neonika runtime-service rollback
NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED=ready neonika runtime-service uninstall
npm uninstall --global neonika
```

`rollback` swaps to the last verified definition and restores the current one
automatically if that target fails health. `uninstall` removes the supervisor
definition but preserves private logs, audit evidence, and rollback state. On
macOS this uses a LaunchAgent; on Linux it uses a systemd user service. Neither
requires a root daemon or invokes a shell.

Retiring a predecessor is a separate, observed operation. Keep Neonika on the
live `primary` rung, persist a verified non-empty export/import proof, and only
then run the structured stand-down command configured in the private runtime
environment:

```bash
neonika cutover-retire-smoke --config-root ~/.neonika
NEON_RUNTIME_SERVICE_MUTATIONS_ENABLED=ready neonika runtime-service stand-down --config-root ~/.neonika
```

The Retire gate ignores manual evidence flags. `cutover-retire-smoke` writes a
private 0600 record containing only counts, timestamp, and a SHA-256 bundle
digest. Stand-down samples Neonika health three times across a bounded window;
any degraded sample immediately executes the configured predecessor restore.
`neonika runtime-service predecessor-restore` remains available independently
of Retire readiness.

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

### Failed-run supersession

Historical failed runs stay active cutover evidence until an operator explicitly
supersedes them. The workflow is dry-run first and never requires editing
`runs.jsonl`:

```bash
node dist/src/cli.js gateway-run-store-rescue
NEON_RUN_STORE_RESCUE_ENABLED=ready node dist/src/cli.js gateway-run-store-rescue
node dist/src/cli.js gateway-run-store-supersessions
node dist/src/cli.js doctor
node dist/src/cli.js cutover-gate
```

Apply preserves every failed run in a private `0600` archive, atomically replaces
the active store with non-failed runs, and records counts plus SHA-256 evidence.
Doctor fails closed if a record is incomplete, malformed, missing its archive or
has a digest mismatch. Stop Gateway listeners before Apply, keep the archive
private, and do not hand-edit either JSON or JSONL state.

### Productive memory writeback and rollback

Onboarding configures the same private Neonika SQLite database as both recall
primary and live-index target, plus a private backup directory. Productive
promotion still remains off until the daemon and both write gates are armed:

```bash
NEON_LIVE_INDEX_DAEMON_ENABLED=ready \
NEON_MEMORY_WRITE_ENABLED=ready \
NEON_LIVE_INDEX_WRITEBACK_ENABLED=ready \
node dist/src/cli.js live-index-production-check
```

The check prints no local paths. It requires both configured database paths to
resolve to the same owner-only primary database. Each non-empty promotion batch
first creates and verifies a private SQLite snapshot, then commits the complete
batch in one transaction. Public CLI and HTTP projections plus private daemon
metrics expose only states and counts, never database paths or memory content.

Restore is deliberately separate from writeback. Stop the live-index daemon and
other writers, choose a snapshot id from private operator storage, arm rollback
for that single invocation, and disarm it afterward:

```bash
NEON_MEMORY_ROLLBACK_ENABLED=ready \
node dist/src/cli.js memory-writeback-rollback <snapshot-id>
```

Restore verifies the source, preserves the current database in a safety
snapshot, replaces atomically, and verifies the result. A failed verification
gets at most one recovery attempt from that safety snapshot.

## Bundled skills

Fresh installations include Neonika's reviewed adaptation of Matt Pocock's
engineering skill workflow: Wayfinder, Teach, TDD, domain modeling, architecture
improvement, prototyping, triage and the related handoff skills. They also
include Neonika's portable Ultraresearch workflow for explicit, evidence-heavy
100+ source investigations.

```bash
neonika skills          # inventory, ownership and security posture
neonika skill-commands  # available /skill:<name> commands
```

Workspace, Codex and agent skill roots keep precedence. A local skill with the
same normalized name overrides the bundled fallback without modifying the
installed package. See [the bundled collection manifest](skills/MATT_POCOCK_SKILLS.md)
and [third-party notices](THIRD_PARTY_NOTICES.md).

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

The agent registry ships built-in profiles and layers an optional operator
roster over them. Drop a `config/agents.json` next to the project root — an
array of profiles, or an object with an `agents` array:

```json
{
  "agents": [
    {
      "id": "archivist",
      "aliases": ["arch"],
      "displayName": "Archivist",
      "role": "Archive and retrieval specialist.",
      "runtime": "claude",
      "instructions": ["Answer archive questions."],
      "memoryQuerySeeds": ["document archive"],
      "capabilities": ["archive"]
    }
  ]
}
```

An entry whose `id` matches a built-in replaces it; every other entry is added.
No file means the built-ins alone. A roster is never fatal: unusable entries are
skipped and named (`agents-smoke`, and `doctor` reports the check as `warn`),
because a registry that refuses to load would leave the runtime with no
identities at all. `runtime` must be one of `codex`, `claude`, `hybrid`,
`human-gate`. The file is local operator input and is gitignored — `instructions`
is prompt surface, so it is deliberately a local path with no remote loader.

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

### Scheduled agent execution

Cron and heartbeat daemons remain no-execution/no-send by default. Arming a
daemon and its timer only creates deduplicated terminal shadow evidence. Real
agent turns require a third, independent gate:

```bash
NEON_CRON_DAEMON_ENABLED=ready
NEON_CRON_TIMER_ENABLED=ready
NEON_SCHEDULED_AGENT_EXECUTION_ENABLED=ready
node dist/src/cli.js cron-daemon-run
```

The armed path selects the harness from the agent roster, attaches agent-scoped
memory, persists running then terminal state under one deterministic run id,
and retries only classified transient failures (two attempts by default, hard
cap three via `NEON_SCHEDULED_AGENT_MAX_ATTEMPTS`). Cron delivery uses the
job's explicit target; heartbeat delivery is eligible only when exactly one
Canary Discord channel is configured. Every send still passes through the
existing Canary stage, approval, outbound-enable, allowlist, and transport
policy. Without all of them, delivery is recorded as suppressed.
Live scheduled Discord delivery is available inside `discord-shadow-tap`, where
the real Discord transport is already owned; standalone daemon commands never
construct a channel transport and therefore remain suppressed.

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
