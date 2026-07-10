# Security

## Reporting a vulnerability

Email **info@design-nk.de** with the details. Do not open a public issue for
anything exploitable.

Include what you did, what happened, and what you expected. A proof of concept
helps. You will get a reply; this is a small project, so expect days rather than
hours.

Please do not run automated scanners against infrastructure you do not own.

## What this software is

Neon Core is an agent runtime. It reads messages from channels, runs coding
agents against them, and can — once explicitly armed — execute commands, write
files, and send replies. That is the product, not a bug.

Read this section before running it anywhere that matters.

## What is safe by default

These are structural, not configuration defaults you might forget to set:

- **Outbound delivery is suppressed.** Delivery records carry
  `state: "suppressed"`. The default sender is a no-op. Sending requires
  reaching the canary cutover stage, which requires recorded evidence.
- **Plugins are never loaded.** `evaluateNeonPluginTrust` returns
  `autoLoadable: false` for every plugin, allowlisted or not. There is no policy
  input that flips it. Manifests are catalogued and audited; code is not
  imported, required, or executed.
- **Text crossing a boundary is redacted.** Tokens, keys, and paths pass through
  `redactText` before reaching logs, snapshots, HTTP responses, or the dashboard.
- **The HTTP server binds to `127.0.0.1`.** Mutating endpoints without a
  configured token are accepted only from loopback addresses.
- **Runs are terminal-only.** Nothing is executing while you inspect it.

## What arms it

Each of these turns a read-only observer into something that acts. None is on by
default. All are environment variables.

| Switch | What it enables | Risk |
| --- | --- | --- |
| `NEON_CODEX_APP_SERVER_SANDBOX=danger-full-access` | The Codex harness runs with no sandbox | Arbitrary code execution as the running user. Use `read-only` or `workspace-write`. |
| `NEON_CUTOVER_OUTBOUND_ENABLED` + canary stage | Replies are actually sent | The agent writes to a real channel where real people read it |
| `NEON_GATEWAY_HTTP_MUTATION_TOKEN` unset **and** `NEON_CORE_HOST` set to a non-loopback address | Mutating HTTP endpoints reachable from the network without auth | Anyone who can reach the port can mutate state. Set the token, or keep the bind on loopback. |
| Node runner exec policies | Commands dispatched to paired devices | Remote command execution across machines |

If you set a non-loopback `NEON_CORE_HOST`, set
`NEON_GATEWAY_HTTP_MUTATION_TOKEN` too. The loopback exemption exists so local
tooling works without ceremony; it is not an authentication scheme.

## Prompt injection

An agent that reads a channel reads whatever someone types into it. Content
arriving from a channel is untrusted input to the model, and the model drives
the tools. Neon Core reduces the blast radius — outbound suppressed, plugins
never loaded, sandboxed harness — but it cannot make a language model immune to
instructions in its input.

Do not point an armed deployment at a channel where untrusted parties can post.

## What we consider a vulnerability

- Secrets reaching a log, snapshot, HTTP response, or the dashboard
- A gated capability acting without its gate being armed
- Auth bypass on mutating endpoints
- Plugin code being loaded or executed
- Path traversal, SSRF, or injection in the gateway or tool layer

## What we do not

- The agent executing commands when a sandbox mode explicitly permits it
- Outbound sending after the canary gate has been armed with evidence
- A model following instructions embedded in channel content when the deployment
  is armed against an untrusted channel

Those are the documented behaviour of the switches above.
