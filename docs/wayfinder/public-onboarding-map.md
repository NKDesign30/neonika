# Wayfinder Map: Public Fresh-Install Onboarding

Owner: Chaty

Execution: autonomous while the maintainer is AFK

Target: `main`, public repository, installable release artifact

## Product contract

A new operator installs Neonika with npm, runs `neonika onboard`, and receives
one local agent world:

- one canonical owner identity;
- one local SQLite memory store;
- Discord as the primary hub;
- WhatsApp as a linked companion channel;
- outbound delivery suppressed until a separate cutover decision;
- no secret values in config, reports, logs, tests, Git history, or release
  artifacts.

## Tickets

| Ticket | Owner | State | Acceptance proof |
| --- | --- | --- | --- |
| WF-01 Audit every public exposure surface | Chaty | done | Tree, history, package, GitHub metadata, Actions, alerts, and commit identities pass the publication audit |
| WF-02 Publish the audited repository | Chaty | done | Repository is public and the `v0.1.0` baseline is installable |
| WF-03 Ship the npm install artifact | Chaty | release pending | Exact local `v0.2.0` tarball passes allowlist, leak scan, fresh-prefix install, onboarding, and uninstall; immutable public asset follows the tag workflow |
| WF-04 Persist a safe Fresh-Install config | Chaty | done | Atomic `0700/0600` setup, idempotent rerun, no secret values persisted |
| WF-05 Bootstrap local memory | Chaty | done | Fresh SQLite schema opens through onboarding and memory checks |
| WF-06 Link the owner across channels | Chaty | done | Discord and WhatsApp peer ids resolve to one canonical owner without appearing in reports |
| WF-07 Onboard the Discord hub | Chaty | done | Explicit allowlists, actual ingress projection, and shared owner session are tested with outbound still cutover-gated |
| WF-08 Onboard the WhatsApp companion | Chaty | local-green; device pending | QR/auth, strict DM/group policy, persistent replay guard, and shadow ingress are tested; phone scan remains |
| WF-09 Prove the complete fresh-system flow | Chaty | release pending | Local package/onboard/Doctor/channel/leak gates are green; public `v0.2.0` CI, release-asset install, and the phone-gated WhatsApp smoke remain |
| WF-10 Make releases repeatable | Chaty | release pending | Version source, changelog gate, clean manifest, checksum, exact-artifact smoke, and immutable tag workflow are implemented; first `v0.2.0` run remains |

## Guardrails

- The checked-in README contains no predecessor-product name.
- Attribution remains in `THIRD_PARTY_NOTICES.md` and adapted source headers.
- Channel identity sharing is explicit. Similar usernames never imply identity.
- Discord is the hub; WhatsApp is a companion, not a separate bot world.
- Direct messages default to isolated channel peers and merge only through an
  explicit owner link.
- WhatsApp group ingress is disabled during onboarding until the operator adds
  an allowlist.
- Login readiness, transport readiness, and delivery readiness are separate
  states. The UI and CLI must not collapse them into one green status.

## Verification ladder

1. Unit tests for schema, validation, redaction, idempotence, and permissions.
2. CLI smoke from an isolated config root.
3. Package smoke from the exact packed tarball.
4. Real adapter-level Discord and WhatsApp inbound shadow smokes; live WhatsApp
   transport proof remains phone-gated.
5. `npm run doctor`, UI suite, and `scripts/oss-audit.sh --history`.
6. CI on every supported Node lane.
7. Public visibility switch and release-asset install smoke.
