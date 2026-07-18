import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildNeonAgentMemoryQuery,
  createNeonAgentsSnapshot,
  defaultNeonAgentId,
  listNeonAgentProfiles,
  renderNeonAgentIdentity,
  resolveNeonAgentAttachment,
  resolveNeonAgentProfile
} from "../src/index.js";

describe("Neon Agents registry", () => {
  it("exposes the canonical Neon agent roster", () => {
    const snapshot = createNeonAgentsSnapshot();

    assert.equal(snapshot.state, "ready");
    assert.equal(snapshot.defaultAgentId, defaultNeonAgentId);
    assert.ok(snapshot.agents.length >= 14);
    assert.ok(snapshot.agents.some((agent) => agent.id === "chaty"));
    assert.ok(snapshot.agents.every((agent) => agent.capabilityCount > 0));
    assert.ok(snapshot.agents.every((agent) => agent.memorySeedCount > 0));
  });

  it("resolves ids and aliases into agent profiles", () => {
    assert.equal(resolveNeonAgentProfile("chaty")?.displayName, "Chaty");
    assert.equal(resolveNeonAgentProfile("@chaty-lab")?.id, "chaty");
    assert.equal(resolveNeonAgentProfile("architect")?.id, "rex");
    assert.equal(resolveNeonAgentProfile("unknown"), undefined);
  });

  it("creates a harness-safe agent identity attachment", () => {
    const attachment = resolveNeonAgentAttachment("chaty");

    assert.equal(attachment?.id, "chaty");
    assert.equal(attachment?.runtime, "codex");
    assert.match(renderNeonAgentIdentity(assertPresent(attachment)), /Senior Dev/);
  });

  it("builds bounded memory queries from agent seeds", () => {
    const attachment = assertPresent(resolveNeonAgentAttachment("chaty"));
    const query = buildNeonAgentMemoryQuery(attachment, "Bitte baue Neon Gateway weiter.");

    assert.ok(query.length <= 240);
    assert.match(query, /chaty agent memory/);
    assert.match(query, /Neon Gateway/);
  });

  it("keeps profile ids unique", () => {
    const ids = listNeonAgentProfiles().map((profile) => profile.id);
    const uniqueIds = new Set(ids);

    assert.equal(ids.length, uniqueIds.size);
  });
});

function assertPresent<TValue>(value: TValue | undefined): TValue {
  if (value === undefined) {
    assert.fail("Expected value to be present");
  }

  return value;
}
