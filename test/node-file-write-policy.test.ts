import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  resolveNeonNodeContainedWritePath,
  resolveNeonNodeFileWriteGate,
  writeNeonNodeFile,
  type INeonNodeFileWriteGate
} from "../src/index.js";

const armedGate: INeonNodeFileWriteGate = {
  enabled: true,
  reason: "write-enabled",
  envKey: "NEON_NODE_FILE_WRITE_ENABLED"
};
const closedGate: INeonNodeFileWriteGate = {
  enabled: false,
  reason: "write-disabled",
  envKey: "NEON_NODE_FILE_WRITE_ENABLED"
};
const writeScopes = ["file.read", "file.write"];

describe("Neon node file.write policy (DP-7)", () => {
  it("keeps the write gate off by default and arms only on an explicit ready flag", () => {
    assert.equal(resolveNeonNodeFileWriteGate({}).enabled, false);
    for (const value of ["1", "ready", "true", "yes"]) {
      assert.equal(resolveNeonNodeFileWriteGate({ NEON_NODE_FILE_WRITE_ENABLED: value }).enabled, true);
    }
    assert.equal(resolveNeonNodeFileWriteGate({ NEON_NODE_FILE_WRITE_ENABLED: "0" }).enabled, false);
  });

  it("contains in-root paths and rejects every escape shape", () => {
    const root = "/tmp/neon-allowlist-root";

    assert.equal(resolveNeonNodeContainedWritePath(root, "reports/note.txt").contained, true);
    assert.equal(resolveNeonNodeContainedWritePath(root, "a/b/c.txt").relativePath, "a/b/c.txt");
    assert.equal(resolveNeonNodeContainedWritePath(root, "../escape.txt").contained, false);
    assert.equal(resolveNeonNodeContainedWritePath(root, "../../etc/passwd").contained, false);
    assert.equal(resolveNeonNodeContainedWritePath(root, "/etc/passwd").contained, false);
    assert.equal(resolveNeonNodeContainedWritePath(root, "reports/../../escape").contained, false);
    // The root itself is not a writable file target.
    assert.equal(resolveNeonNodeContainedWritePath(root, ".").contained, false);
  });

  it("blocks the write while the gate is closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-fw-"));
    try {
      const result = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "note.txt",
        content: "hi",
        gate: closedGate,
        approved: true,
        scopes: writeScopes
      });
      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "gate-disabled");
      await assert.rejects(() => access(join(root, "note.txt")));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("blocks the write without operator approval and without the file.write scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-fw-"));
    try {
      const notApproved = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "note.txt",
        content: "hi",
        gate: armedGate,
        approved: false,
        scopes: writeScopes
      });
      assert.equal(notApproved.blockReason, "not-approved");

      const noScope = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "note.txt",
        content: "hi",
        gate: armedGate,
        approved: true,
        scopes: ["file.read"]
      });
      assert.equal(noScope.blockReason, "missing-scope");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("hard-blocks a path-escape attempt before any disk write", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-fw-"));
    try {
      const result = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "../escape.txt",
        content: "tampered",
        gate: armedGate,
        approved: true,
        scopes: writeScopes
      });
      assert.equal(result.state, "blocked");
      assert.equal(result.blockReason, "path-escape");
      assert.equal(result.safety.wroteOutsideAllowlistRoot, false);
      // The sibling escape target must not exist.
      await assert.rejects(() => access(join(root, "..", "escape.txt")));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes a contained file when fully gated and round-trips the content", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-fw-"));
    try {
      const result = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "reports/note.txt",
        content: "hallo welt",
        gate: armedGate,
        approved: true,
        scopes: writeScopes
      });

      assert.equal(result.state, "written");
      assert.equal(result.relativePath, "reports/note.txt");
      assert.equal(result.bytesWritten, Buffer.byteLength("hallo welt", "utf8"));
      const onDisk = await readFile(join(root, "reports", "note.txt"), "utf8");
      assert.equal(onDisk, "hallo welt");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("redacts a secret in the result preview while writing the real payload inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-fw-"));
    try {
      const result = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "secret.txt",
        content: "token sk-abcdef0123456789ABCDEF",
        gate: armedGate,
        approved: true,
        scopes: writeScopes
      });

      assert.equal(result.state, "written");
      assert.doesNotMatch(result.contentPreview, /sk-abcdef/);
      assert.match(result.contentPreview, /\[REDACTED_SECRET\]/);
      assert.doesNotMatch(JSON.stringify(result), /sk-abcdef/);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("blocks empty content", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-fw-"));
    try {
      const result = await writeNeonNodeFile({
        allowlistRoot: root,
        requestedPath: "note.txt",
        content: "",
        gate: armedGate,
        approved: true,
        scopes: writeScopes
      });
      assert.equal(result.blockReason, "empty-content");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
