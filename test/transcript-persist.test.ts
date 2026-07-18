import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  promoteNeonTranscriptProposal,
  readNeonMemoryStore,
  resolveNeonMemoryWriteGate,
  type INeonTranscriptProposal
} from "../src/index.js";

function proposal(overrides: Partial<INeonTranscriptProposal> = {}): INeonTranscriptProposal {
  return {
    sessionKey: "demo:sess-1",
    kind: "summary",
    state: "proposed",
    model: "haiku",
    gateEnabled: true,
    redactedText: "Built the transcript indexer floor and gated the LLM seam.",
    qualityIssues: [],
    safety: { memoryWritten: false },
    ...overrides
  };
}

describe("Neon Transcript persist runtime (S4)", () => {
  it("refuses to promote a non-proposed proposal", async () => {
    const result = await promoteNeonTranscriptProposal({
      proposal: proposal({ state: "planned" }),
      memoryGate: resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
      mode: "productive"
    });
    assert.equal(result.state, "not-promotable");
  });

  it("stays planned (no write) in the default dry-run mode", async () => {
    const result = await promoteNeonTranscriptProposal({
      proposal: proposal(),
      memoryGate: resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" })
    });
    assert.equal(result.state, "planned");
    assert.equal(result.entryId, undefined);
  });

  it("blocks a productive write when the memory gate is closed", async () => {
    const result = await promoteNeonTranscriptProposal({
      proposal: proposal(),
      memoryGate: resolveNeonMemoryWriteGate({}),
      mode: "productive"
    });
    assert.equal(result.state, "blocked");
  });

  it("writes once and is idempotent on re-run (content-hash dedupe)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-transcript-persist-"));
    const storePath = join(dir, "store.json");
    const gate = resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" });
    const now = (): Date => new Date("2026-06-01T12:00:00.000Z");

    try {
      const first = await promoteNeonTranscriptProposal({
        proposal: proposal(),
        memoryGate: gate,
        mode: "productive",
        storePath,
        now
      });
      assert.equal(first.state, "written");
      assert.ok(first.entryId);

      const second = await promoteNeonTranscriptProposal({
        proposal: proposal(),
        memoryGate: gate,
        mode: "productive",
        storePath,
        now
      });
      assert.equal(second.state, "duplicate");

      const stored = await readNeonMemoryStore(storePath);
      assert.equal(stored.length, 1, "re-run must not duplicate the entry");
      assert.match(stored[0]?.source ?? "", /^transcript:summary:demo:sess-1:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stays idempotent even when the source label has a secret shape (M1-fix)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-transcript-persist-srcsecret-"));
    const storePath = join(dir, "store.json");
    const gate = resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" });
    const now = (): Date => new Date("2026-06-01T12:00:00.000Z");
    // A session id with a token shape -> writeNeonMemoryEntry redacts the stored
    // source, so a full-string dedupe would miss. Hash-suffix dedupe must hold.
    const secretProposal = proposal({ sessionKey: "demo:sk-test1234567890abcdef" });

    try {
      const first = await promoteNeonTranscriptProposal({ proposal: secretProposal, memoryGate: gate, mode: "productive", storePath, now });
      assert.equal(first.state, "written");

      const second = await promoteNeonTranscriptProposal({ proposal: secretProposal, memoryGate: gate, mode: "productive", storePath, now });
      assert.equal(second.state, "duplicate");

      const stored = await readNeonMemoryStore(storePath);
      assert.equal(stored.length, 1, "secret-shaped source must not break idempotent dedupe");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("redacts secrets that survive into the persisted entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neon-transcript-persist-secret-"));
    const storePath = join(dir, "store.json");

    try {
      const result = await promoteNeonTranscriptProposal({
        proposal: proposal({ redactedText: "summary mentioning sk-test1234567890abcdef just in case" }),
        memoryGate: resolveNeonMemoryWriteGate({ NEON_MEMORY_WRITE_ENABLED: "ready" }),
        mode: "productive",
        storePath,
        now: () => new Date("2026-06-01T12:00:00.000Z")
      });
      assert.equal(result.state, "written");

      const stored = await readNeonMemoryStore(storePath);
      assert.doesNotMatch(JSON.stringify(stored), /sk-test1234567890abcdef/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
