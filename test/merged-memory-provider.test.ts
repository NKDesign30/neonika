import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createDefaultMergedMemoryRoots,
  createMergedNeonMemoryProvider,
  memorySharedRootsEnvKey,
  resolveNeonSharedMemoryRoots,
  type INeonMemoryProvider
} from "../src/index.js";

const secret = "sk-live-mergedmemorysecret1234567890";

describe("Neon merged memory provider", () => {
  it("merges primary memory with bounded local memory files and redacts snippets", async () => {
    const root = await mkdtempRoot("neon-core-merged-memory-");
    const fileRoot = join(root, "codex-memory");

    try {
      await mkdir(fileRoot, { recursive: true });
      await writeFile(
        join(fileRoot, "MEMORY.md"),
        `# Local Memory\nAda Lovelace launch context with token ${secret}\n`,
        "utf8"
      );

      const provider = createMergedNeonMemoryProvider({
        primaryProvider: staticProvider([
          { source: "semantic-memory", text: "Ada Lovelace primary semantic memory" }
        ]),
        fileRoots: [{ id: "local-memory", path: fileRoot }]
      });
      const result = await provider.search("Was weißt du über Ada Lovelace?", { maxHits: 4 });
      const serialized = JSON.stringify(result);

      assert.ok(result.hits.some((hit) => hit.source === "semantic-memory"));
      assert.ok(result.hits.some((hit) => hit.source === "local-memory:MEMORY.md"));
      assert.doesNotMatch(serialized, new RegExp(secret));
      assert.match(serialized, /\[REDACTED_SECRET\]/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reserves room for local memory hits when primary recall is already full", async () => {
    const root = await mkdtempRoot("neon-core-merged-memory-budget-");
    const fileRoot = join(root, "agent-memory");

    try {
      await mkdir(fileRoot, { recursive: true });
      await writeFile(join(fileRoot, "chaty.md"), "Chaty knows Neon Core Discord memory fusion.", "utf8");

      const provider = createMergedNeonMemoryProvider({
        primaryProvider: staticProvider([
          { source: "primary-1", text: "Neon Core primary one" },
          { source: "primary-2", text: "Neon Core primary two" },
          { source: "primary-3", text: "Neon Core primary three" }
        ]),
        fileRoots: [{ id: "agent-memory", path: fileRoot }]
      });
      const result = await provider.search("Chaty Neon Core memory", { maxHits: 3 });
      const localHitIndex = result.hits.findIndex((hit) => hit.source === "agent-memory:chaty.md");

      assert.equal(result.hits.length, 3);
      assert.ok(localHitIndex >= 0);
      assert.ok(localHitIndex < 2, "local memory should be interleaved before the tail cap");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("diversifies local memory roots so topical shared folders are not crowded out", async () => {
    const root = await mkdtempRoot("neon-core-merged-memory-diverse-");
    const genericRoot = join(root, "codex-memory");
    const sharedRoot = join(root, "shared-memory");

    try {
      await mkdir(genericRoot, { recursive: true });
      await mkdir(sharedRoot, { recursive: true });
      await writeFile(
        join(genericRoot, "MEMORY.md"),
        "Chaty Neon Core Discord memory Ada Lovelace analytics arena",
        "utf8"
      );
      await writeFile(
        join(genericRoot, "memory_summary.md"),
        "Chaty Neon Core Discord memory Ada Lovelace analytics arena",
        "utf8"
      );
      await writeFile(
        join(genericRoot, "rollout.md"),
        "Chaty Neon Core Discord memory Ada Lovelace analytics arena",
        "utf8"
      );
      await writeFile(
        join(sharedRoot, "arena.md"),
        "Ada Lovelace meets analytics arena context.",
        "utf8"
      );

      const provider = createMergedNeonMemoryProvider({
        primaryProvider: staticProvider([]),
        fileRoots: [
          { id: "codex-memory", path: genericRoot },
          { id: "shared-memory", path: sharedRoot }
        ]
      });
      const result = await provider.search("Chaty Neon Core Discord memory Ada Lovelace analytics arena", {
        maxHits: 3
      });

      assert.equal(result.hits.length, 3);
      assert.ok(result.hits.some((hit) => hit.source === "shared-memory:arena.md"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("ships no shared memory root unless one is configured", () => {
    const roots = createDefaultMergedMemoryRoots("/home/agent", {});

    assert.deepEqual(
      roots.map((root) => root.path),
      ["/home/agent/.codex/memories", "/home/agent/.claude/global-memory", "/home/agent/.claude/agent-sdk/memory"]
    );
  });

  it("prepends configured shared roots, ignoring blanks and duplicate basenames", () => {
    const env = { [memorySharedRootsEnvKey]: " /srv/Team-Memory , , /srv/team-memory ,/srv/notes " };

    assert.deepEqual(resolveNeonSharedMemoryRoots(env), [
      { id: "team-memory", path: "/srv/Team-Memory" },
      { id: "notes", path: "/srv/notes" }
    ]);
    assert.equal(createDefaultMergedMemoryRoots("/home/agent", env)[0]?.id, "team-memory");
    assert.deepEqual(resolveNeonSharedMemoryRoots({}), []);
  });
});

function staticProvider(hits: readonly { readonly source: string; readonly text: string }[]): INeonMemoryProvider {
  return {
    search: async (query, options = {}) => ({
      query,
      hits: hits.slice(0, options.maxHits ?? hits.length),
      diagnostics: []
    })
  };
}

async function mkdtempRoot(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}
