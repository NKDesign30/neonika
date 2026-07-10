import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNeonTranscriptSnapshot,
  projectNeonTranscript,
  transcriptHomePrefix,
  transcriptProjectLabel
} from "../src/index.js";

// S1: deterministic, redaction-first transcript projection. Every fixture is an
// mkdtemp dir with an injected `now` — the real ~/.claude/projects is never read
// (machine-dependent + real secrets). Anchored to a fixed base so mode/age never
// drift with the wall clock.
const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);

function jsonl(entries: readonly unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

async function writeSession(
  projectsDir: string,
  dirName: string,
  sessionId: string,
  entries: readonly unknown[],
  mtimeMs: number
): Promise<void> {
  const dir = join(projectsDir, dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, jsonl(entries), "utf8");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

async function withFixture(run: (projectsDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "neon-transcript-"));
  try {
    const projectsDir = join(root, "projects");
    await mkdir(projectsDir, { recursive: true });
    await run(projectsDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const PADDING = "Long enough body so the file clears the 200-byte floor. ".repeat(4);

describe("createNeonTranscriptSnapshot (S1)", () => {
  it("returns an empty state for a missing projects dir", async () => {
    const snapshot = await createNeonTranscriptSnapshot({
      projectsDir: join(tmpdir(), "neon-does-not-exist-xyz"),
      now: BASE
    });
    assert.equal(snapshot.state, "empty");
    assert.equal(snapshot.totals.sessions, 0);
    assert.equal(snapshot.sessions.length, 0);
  });

  it("projects sessions with a username-safe label, live mode, and turn counts", async () => {
    await withFixture(async (projectsDir) => {
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-demo",
        "sess-1",
        [
          { type: "user", message: `Please review the change. ${PADDING}` },
          { type: "assistant", message: { content: [{ type: "text", text: `On it, building carefully. ${PADDING}` }] } },
          { type: "assistant", message: { content: [{ type: "tool_result", is_error: true, content: "boom" }] } }
        ],
        BASE - 60_000
      );

      const snapshot = await createNeonTranscriptSnapshot({ projectsDir, now: BASE });
      assert.equal(snapshot.state, "ready");
      assert.equal(snapshot.totals.sessions, 1);
      assert.equal(snapshot.totals.projects, 1);

      const session = snapshot.sessions[0];
      assert.ok(session, "expected one session");
      assert.equal(session.project, "neon-projects-demo");
      assert.equal(session.sessionId, "sess-1");
      assert.equal(session.sessionKey, "neon-projects-demo:sess-1");
      assert.equal(session.mode, "live");
      assert.equal(session.isSubagent, false);
      assert.equal(session.messageCount, 2);
      assert.equal(session.userCount, 1);
      assert.equal(session.assistantCount, 1);
      assert.equal(session.toolFailureCount, 1);
    });
  });

  it("redacts secrets and filesystem paths in the latest preview", async () => {
    await withFixture(async (projectsDir) => {
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-demo",
        "sess-secret",
        [
          { type: "user", message: `Kick off the deploy. ${PADDING}` },
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: `Deployed with ghp_aBcD1234567890aBcD1234567890aBcD12 to /Users/someone/app done. ${PADDING}`
                }
              ]
            }
          }
        ],
        BASE - 60_000
      );

      const snapshot = await createNeonTranscriptSnapshot({ projectsDir, now: BASE });
      const serialized = JSON.stringify(snapshot);
      assert.doesNotMatch(serialized, /ghp_aBcD/);
      assert.doesNotMatch(serialized, /Users\/someone\/app/);
      assert.match(serialized, /\[REDACTED/);
    });
  });

  it("flags subagent sessions by their agent- session id", async () => {
    await withFixture(async (projectsDir) => {
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-demo",
        "agent-worker-1",
        [{ type: "assistant", message: { content: [{ type: "text", text: `Subagent ran. ${PADDING}` }] } }],
        BASE - 60_000
      );

      const snapshot = await createNeonTranscriptSnapshot({ projectsDir, now: BASE });
      const session = snapshot.sessions[0];
      assert.ok(session);
      assert.equal(session.isSubagent, true);
    });
  });

  it("skips files below the byte floor and beyond the age cutoff", async () => {
    await withFixture(async (projectsDir) => {
      // Too small (< 200 bytes).
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-demo",
        "tiny",
        [{ type: "user", message: "hi there" }],
        BASE - 60_000
      );
      // Too old (> 12h before now).
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-demo",
        "stale",
        [{ type: "user", message: `Old session. ${PADDING}` }],
        BASE - 13 * 60 * 60 * 1000
      );

      const snapshot = await createNeonTranscriptSnapshot({ projectsDir, now: BASE });
      assert.equal(snapshot.totals.sessions, 0);
      assert.equal(snapshot.state, "empty");
    });
  });

  it("classifies wrapping and final modes by age", async () => {
    await withFixture(async (projectsDir) => {
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-demo",
        "wrapping-one",
        [{ type: "user", message: `Wrapping up. ${PADDING}` }],
        BASE - 30 * 60 * 1000
      );
      await writeSession(
        projectsDir,
        "-Users-someone-neon-projects-other",
        "final-one",
        [{ type: "user", message: `Long done. ${PADDING}` }],
        BASE - 3 * 60 * 60 * 1000
      );

      const snapshot = await createNeonTranscriptSnapshot({ projectsDir, now: BASE });
      const byKey = new Map(snapshot.sessions.map((session) => [session.sessionId, session.mode]));
      assert.equal(byKey.get("wrapping-one"), "wrapping");
      assert.equal(byKey.get("final-one"), "final");
      assert.equal(snapshot.totals.projects, 2);
    });
  });
});

describe("transcriptProjectLabel — username safety (S1 H1-fix)", () => {
  it("strips a hyphenated username whole without leaking its tail", () => {
    const homePrefix = transcriptHomePrefix("/Users/ada-lovelace");
    assert.equal(homePrefix, "-Users-ada-lovelace");
    const label = transcriptProjectLabel("-Users-ada-lovelace-neon-projects-demo", homePrefix);
    assert.equal(label, "neon-projects-demo");
    assert.ok(!label?.includes("lovelace"), "username tail must not leak");
  });

  it("maps the bare home dir to global", () => {
    assert.equal(transcriptProjectLabel("-Users-ada-lovelace", "-Users-ada-lovelace"), "global");
  });

  it("rejects ghost buckets regardless of home prefix", () => {
    assert.equal(transcriptProjectLabel("-private-tmp-x", "-Users-x"), null);
    assert.equal(transcriptProjectLabel("-worktrees-y", "-Users-x"), null);
    assert.equal(transcriptProjectLabel("-", "-Users-x"), null);
  });
});

describe("projectNeonTranscript (pure)", () => {
  it("folds totals across inputs without IO", () => {
    const projection = projectNeonTranscript([
      {
        file: {
          sessionId: "s1",
          project: "demo",
          jsonlPath: "/x/s1.jsonl",
          mtimeMs: BASE,
          sizeBytes: 500,
          mode: "live",
          isSubagent: false
        },
        extract: {
          messageCount: 4,
          userCount: 2,
          assistantCount: 2,
          toolFailureCount: 1,
          latestPreview: "hello",
          linesRead: 10
        }
      },
      {
        file: {
          sessionId: "agent-x",
          project: "demo",
          jsonlPath: "/x/agent-x.jsonl",
          mtimeMs: BASE - 1000,
          sizeBytes: 500,
          mode: "final",
          isSubagent: true
        },
        extract: {
          messageCount: 3,
          userCount: 1,
          assistantCount: 2,
          toolFailureCount: 0,
          latestPreview: "world",
          linesRead: 8
        }
      }
    ]);

    assert.equal(projection.totals.sessions, 2);
    assert.equal(projection.totals.messages, 7);
    assert.equal(projection.totals.projects, 1);
    assert.equal(projection.totals.subagentSessions, 1);
    // newest (higher mtime) first
    assert.equal(projection.sessions[0]?.sessionId, "s1");
  });
});
