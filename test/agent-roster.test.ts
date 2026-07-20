import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDryRunHarness,
  createNeonAgentsSnapshot,
  loadNeonAgentProfiles,
  neonAgentProfiles,
  readNeonAgentRoster,
  resolveNeonAgentAttachment,
  resolveNeonAgentProfile,
  resolveNeonAgentRosterPath,
  runNeonGatewayShadow
} from "../src/index.js";

// The operator roster layers over the built-in profiles. Two properties matter
// more than the happy path: an install with no roster must behave exactly as it
// did before this seam existed, and a roster that is partly wrong must not take
// the working entries down with it.

function withProjectRoot(run: (projectRoot: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "neon-roster-"));
    try {
      await run(projectRoot);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  };
}

function writeRoster(projectRoot: string, contents: string): void {
  const rosterPath = resolveNeonAgentRosterPath(projectRoot);
  mkdirSync(join(projectRoot, "config"), { recursive: true });
  writeFileSync(rosterPath, contents, "utf8");
}

const VALID_ENTRY = {
  id: "archivist",
  aliases: ["arch"],
  displayName: "Archivist",
  role: "Archive and retrieval specialist.",
  runtime: "claude",
  instructions: ["Answer archive questions."],
  memoryQuerySeeds: ["document archive"],
  capabilities: ["archive"]
};

describe("Neon agent roster", () => {
  it(
    "returns exactly the built-ins when no roster file exists",
    withProjectRoot(async (projectRoot) => {
      const roster = await loadNeonAgentProfiles(projectRoot);
      assert.equal(roster.rosterPresent, false);
      assert.deepEqual(roster.issues, []);
      assert.equal(roster.addedCount, 0);
      assert.equal(roster.overriddenCount, 0);
      assert.deepEqual(
        roster.profiles.map((profile) => profile.id),
        neonAgentProfiles.map((profile) => profile.id)
      );
    })
  );

  it(
    "adds a configured profile and makes it resolvable by id and alias",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, JSON.stringify([VALID_ENTRY]));
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.equal(roster.rosterPresent, true);
      assert.equal(roster.addedCount, 1);
      assert.equal(roster.overriddenCount, 0);
      assert.deepEqual(roster.issues, []);
      assert.equal(resolveNeonAgentProfile("archivist", roster.profiles)?.displayName, "Archivist");
      assert.equal(resolveNeonAgentProfile("arch", roster.profiles)?.id, "archivist");
      assert.equal(resolveNeonAgentAttachment("archivist", roster.profiles)?.runtime, "claude");
      assert.ok(createNeonAgentsSnapshot(roster.profiles).agents.some((agent) => agent.id === "archivist"));
    })
  );

  it(
    "lets a configured profile replace a built-in of the same id without growing the roster",
    withProjectRoot(async (projectRoot) => {
      writeRoster(
        projectRoot,
        JSON.stringify([{ ...VALID_ENTRY, id: "chaty", displayName: "Chaty (local)", aliases: [] }])
      );
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.equal(roster.overriddenCount, 1);
      assert.equal(roster.addedCount, 0);
      assert.equal(roster.profiles.length, neonAgentProfiles.length);
      assert.equal(resolveNeonAgentProfile("chaty", roster.profiles)?.displayName, "Chaty (local)");
    })
  );

  it(
    "accepts the object form with an agents array",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, JSON.stringify({ agents: [VALID_ENTRY] }));
      const roster = await loadNeonAgentProfiles(projectRoot);
      assert.equal(roster.addedCount, 1);
    })
  );

  // The property that matters most: a typo in one entry must not unregister the
  // others, or a roster silently shrinks to nothing on a trailing mistake.
  it(
    "keeps the valid entries when one entry is malformed, and names the bad one",
    withProjectRoot(async (projectRoot) => {
      writeRoster(
        projectRoot,
        JSON.stringify([
          VALID_ENTRY,
          { id: "broken", displayName: "Broken", role: "x", runtime: "telepathy" },
          { ...VALID_ENTRY, id: "second", aliases: [] }
        ])
      );
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.equal(roster.addedCount, 2);
      assert.ok(resolveNeonAgentProfile("archivist", roster.profiles));
      assert.ok(resolveNeonAgentProfile("second", roster.profiles));
      assert.equal(resolveNeonAgentProfile("broken", roster.profiles), undefined);
      assert.equal(roster.issues.length, 1);
      assert.match(roster.issues[0] ?? "", /runtime "telepathy"/);
    })
  );

  it(
    "falls back to the built-ins when the file is unusable, and says why",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, "{ not json");
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.equal(roster.rosterPresent, true);
      assert.deepEqual(
        roster.profiles.map((profile) => profile.id),
        neonAgentProfiles.map((profile) => profile.id)
      );
      assert.equal(roster.issues.length, 1);
      assert.match(roster.issues[0] ?? "", /not valid JSON/);
    })
  );

  it(
    "rejects a roster that is neither an array nor an agents object",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, JSON.stringify({ profiles: [VALID_ENTRY] }));
      const roster = await loadNeonAgentProfiles(projectRoot);
      assert.equal(roster.addedCount, 0);
      assert.match(roster.issues[0] ?? "", /must be an array of profiles/);
    })
  );

  // An alias that another profile already claims never resolves, and nothing in
  // the file shows that. Reporting it beats letting list order decide identity.
  it(
    "reports an alias that is already claimed by another profile",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, JSON.stringify([{ ...VALID_ENTRY, aliases: ["chaty"] }]));
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.equal(roster.addedCount, 1);
      assert.ok(roster.issues.some((issue) => /alias "chaty".*already taken by "chaty"/.test(issue)));
      // The built-in still owns the alias — the roster entry did not steal it.
      assert.equal(resolveNeonAgentProfile("chaty", roster.profiles)?.id, "chaty");
    })
  );

  it(
    "flags a duplicated id inside the roster rather than letting file order decide",
    withProjectRoot(async (projectRoot) => {
      writeRoster(
        projectRoot,
        JSON.stringify([VALID_ENTRY, { ...VALID_ENTRY, displayName: "Archivist Two", aliases: [] }])
      );
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.ok(roster.issues.some((issue) => /repeats id "archivist"/.test(issue)));
      assert.equal(resolveNeonAgentProfile("archivist", roster.profiles)?.displayName, "Archivist Two");
    })
  );

  it(
    "treats an absent file as absent rather than as an error",
    withProjectRoot(async (projectRoot) => {
      const read = await readNeonAgentRoster(projectRoot);
      assert.equal(read.present, false);
      assert.deepEqual(read.issues, []);
      assert.deepEqual(read.profiles, []);
      assert.match(read.rosterPath, /config\/agents\.json$/);
    })
  );

  it(
    "drops non-string entries in a string array instead of trusting them",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, JSON.stringify([{ ...VALID_ENTRY, instructions: ["ok", 42] }]));
      const roster = await loadNeonAgentProfiles(projectRoot);

      assert.equal(roster.addedCount, 0);
      assert.match(roster.issues[0] ?? "", /"instructions" must contain only strings/);
    })
  );

  // The property that makes the roster more than a listing: a configured agent
  // has to survive the gateway's agent resolution, which is where an inbound
  // message is turned into a run. Without the roster threaded through, this
  // throws "agent profile not resolved" while every read-only view still
  // reports the agent as available.
  it(
    "dispatches a roster-only agent through the gateway when the profiles are passed",
    withProjectRoot(async (projectRoot) => {
      writeRoster(projectRoot, JSON.stringify([VALID_ENTRY]));
      const roster = await loadNeonAgentProfiles(projectRoot);

      const message = {
        channel: "discord",
        accountId: "local",
        channelId: "terminal",
        userId: "operator",
        agentId: "archivist",
        workspaceRoot: projectRoot,
        mode: "read-only",
        content: "Roster dispatch"
      } as const;
      const memory = { state: "skipped", hitCount: 0, note: "roster test" } as const;

      const result = await runNeonGatewayShadow(
        { message, memory },
        {
          harness: createDryRunHarness(),
          resolveAgent: (agentId: string) => resolveNeonAgentAttachment(agentId, roster.profiles)
        }
      );
      assert.equal(result.run.status, "completed");
      assert.match(result.run.harnessSessionKey, /:archivist:/);

      // Same message without the roster is the pre-fix behaviour, pinned so a
      // future refactor cannot quietly drop the wiring again.
      await assert.rejects(
        runNeonGatewayShadow({ message, memory }, { harness: createDryRunHarness() }),
        /agent profile not resolved/
      );
    })
  );

  it(
    "keeps the built-in profiles untouched when a roster is loaded",
    withProjectRoot(async (projectRoot) => {
      const before = neonAgentProfiles.length;
      writeRoster(projectRoot, JSON.stringify([VALID_ENTRY]));
      await loadNeonAgentProfiles(projectRoot);
      assert.equal(neonAgentProfiles.length, before);
      assert.equal(resolveNeonAgentProfile("archivist"), undefined);
    })
  );
});
