import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  readNeonOperatorAcks,
  recordNeonOperatorAck,
  resolveGatewayStatePaths
} from "../src/index.js";

describe("Neon operator acknowledgements (run.ack.set mutation)", () => {
  it("is idempotent by runId: re-acking upserts a single entry", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-operator-acks-"));

    try {
      const first = await recordNeonOperatorAck(projectRoot, {
        runId: "neon-shadow-1",
        ackedBy: "operator"
      });
      assert.equal(first.created, true);
      assert.equal(first.ack.runId, "neon-shadow-1");
      assert.equal(first.safety.outboundSent, false);
      assert.equal(first.safety.mutation, "operator-ack");

      const second = await recordNeonOperatorAck(projectRoot, {
        runId: "neon-shadow-1",
        ackedBy: "chaty",
        note: "re-checked"
      });
      assert.equal(second.created, false);

      const acks = await readNeonOperatorAcks(projectRoot);
      assert.equal(acks.length, 1);
      assert.equal(acks[0]?.runId, "neon-shadow-1");
      assert.equal(acks[0]?.ackedBy, "chaty");
      assert.equal(acks[0]?.note, "re-checked");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("keeps distinct runs as separate acknowledgements", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-operator-acks-"));

    try {
      await recordNeonOperatorAck(projectRoot, { runId: "run-a", ackedBy: "operator" });
      await recordNeonOperatorAck(projectRoot, { runId: "run-b", ackedBy: "operator" });

      const acks = await readNeonOperatorAcks(projectRoot);
      assert.equal(acks.length, 2);
      assert.deepEqual(
        acks.map((ack) => ack.runId).sort(),
        ["run-a", "run-b"]
      );
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("rejects missing or empty runId / ackedBy", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-operator-acks-"));

    try {
      await assert.rejects(() => recordNeonOperatorAck(projectRoot, null));
      await assert.rejects(() => recordNeonOperatorAck(projectRoot, { ackedBy: "operator" }));
      await assert.rejects(() => recordNeonOperatorAck(projectRoot, { runId: "  ", ackedBy: "operator" }));
      await assert.rejects(() => recordNeonOperatorAck(projectRoot, { runId: "run-a", ackedBy: "" }));

      const acks = await readNeonOperatorAcks(projectRoot);
      assert.equal(acks.length, 0);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("redacts a secret-bearing note before it ever touches disk", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-operator-acks-"));
    const secret = "sk-abcdef0123456789ABCDEF";

    try {
      const result = await recordNeonOperatorAck(projectRoot, {
        runId: "run-secret",
        ackedBy: "operator",
        note: `leaked ${secret} here`
      });

      assert.doesNotMatch(result.ack.note ?? "", /sk-abcdef/);
      assert.match(result.ack.note ?? "", /\[REDACTED_SECRET\]/);

      const acksPath = join(resolveGatewayStatePaths(projectRoot).gatewayRoot, "operator-acks.json");
      const raw = await readFile(acksPath, "utf8");
      assert.doesNotMatch(raw, /sk-abcdef/);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("truncates long acknowledgement notes without splitting UTF-16 surrogate pairs", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-operator-acks-"));

    try {
      const result = await recordNeonOperatorAck(projectRoot, {
        runId: "run-emoji-note",
        ackedBy: "operator",
        note: `${"a".repeat(279)}🙂tail`
      });

      assert.equal(result.ack.note, "a".repeat(279));
      assert.equal(result.ack.note?.includes("\uD83D"), false);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("uses an injected clock for the acknowledgement timestamp", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neonika-operator-acks-"));
    const fixedIso = "2026-06-02T12:00:00.000Z";

    try {
      const result = await recordNeonOperatorAck(
        projectRoot,
        { runId: "run-clock", ackedBy: "operator" },
        { now: () => new Date(fixedIso) }
      );

      assert.equal(result.ack.ackedAt, fixedIso);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
