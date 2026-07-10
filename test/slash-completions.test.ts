import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { completeNeonSlashCommand, renderNeonSlashCompletions } from "../src/index.js";

type State = "active" | "model-disabled" | "shadowed" | "unavailable";

function entry(toolName: string, opts: { modelInvocable?: boolean; state?: State } = {}) {
  return {
    command: `/skill:${toolName}`,
    toolName,
    ownerName: toolName,
    ownerRootId: `root-${toolName}`,
    state: opts.state ?? ("active" as State),
    modelInvocable: opts.modelInvocable ?? true,
    collisions: []
  };
}

const catalog = {
  entries: [
    entry("review"),
    entry("revert"),
    entry("deploy"),
    entry("research", { modelInvocable: false }),
    entry("verify", { state: "shadowed" })
  ],
  totals: { commands: 5, modelInvocable: 4, collisions: 0 }
};

describe("Neon slash completions", () => {
  it("matches by command prefix (/skill:rev)", () => {
    const out = completeNeonSlashCommand("/skill:rev", catalog);
    assert.deepEqual(out.map((c) => c.toolName).sort(), ["revert", "review"]);
    assert.ok(out.every((c) => c.matchKind === "command-prefix"));
  });

  it("matches by bare name prefix (rev)", () => {
    const out = completeNeonSlashCommand("rev", catalog);
    assert.deepEqual(out.map((c) => c.toolName).sort(), ["revert", "review"]);
    assert.ok(out.every((c) => c.matchKind === "name-prefix"));
  });

  it("lists everything for an empty prefix, capped by limit", () => {
    assert.equal(completeNeonSlashCommand("", catalog).length, 5);
    assert.equal(completeNeonSlashCommand("", catalog, { limit: 2 }).length, 2);
  });

  it("returns nothing for an unmatched prefix", () => {
    assert.deepEqual(completeNeonSlashCommand("xyz", catalog), []);
  });

  it("is case-insensitive", () => {
    assert.equal(completeNeonSlashCommand("/SKILL:REV", catalog).length, 2);
  });

  it("ranks active + model-invocable entries first within a match kind", () => {
    const out = completeNeonSlashCommand("/skill:", catalog);
    assert.equal(out[0]?.state, "active");
    assert.equal(out[0]?.modelInvocable, true);
    assert.deepEqual(out.slice(-2).map((c) => c.toolName).sort(), ["research", "verify"]);
  });

  it("renders a readable completion report", () => {
    assert.match(
      renderNeonSlashCompletions("/skill:rev", completeNeonSlashCommand("/skill:rev", catalog)),
      /Slash completions for "\/skill:rev": 2/
    );
    assert.match(renderNeonSlashCompletions("xyz", []), /none/);
  });
});
