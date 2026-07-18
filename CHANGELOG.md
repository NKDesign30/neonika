# Changelog

## [Unreleased]

- Next changes are collected here.

## [0.2.2] - 2026-07-19

- Enabled GitHub release immutability so published tags and assets are protected from later replacement.

## [0.2.1] - 2026-07-18

- Kept verified release tooling outside the source checkout so the immutable release manifest remains clean.
- Updated pinned GitHub Actions runtimes to the current Node 24 based releases.

## [0.2.0] - 2026-07-18

- Added a private first-use wizard that creates one owner identity and local SQLite memory without persisting secrets.
- Added Discord hub and owner-only WhatsApp companion onboarding with explicit cross-channel session identity.
- Added WhatsApp linked-device QR login, private auth verification, persistent replay protection, status reporting, and shadow ingress with replies suppressed.
- Added a reusable GitHub release spine with deterministic package metadata, SHA-256 checksums, and exact-artifact installation smoke tests.

## [0.1.0] - 2026-07-18

- Established the audited shadow-runtime baseline and npm-installable packaging flow.
