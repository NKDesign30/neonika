import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNeonDecisionBody,
  parseNeonDecisionBody,
  type INeonDecisionDocumentFields
} from "../src/index.js";

const FIELDS: INeonDecisionDocumentFields = {
  title: "SQLite statt Redis für Session-State",
  rationale: "Eine Datei, kein Server, ACID — Redis wäre Infrastruktur ohne Nutzen bei 1 Node.",
  alternatives: "Redis mit eigener Persistenz-Schicht",
  scope: "architecture",
  actor: "operator",
  operatorConfirmed: true,
  sessionKey: "demo:sess-1",
  importanceScore: 85
};

describe("Neon decision document (build + parse round-trip)", () => {
  it("round-trips all fields exactly", () => {
    const parsed = parseNeonDecisionBody(buildNeonDecisionBody(FIELDS));
    assert.equal(parsed.ok, true);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.fields, FIELDS);
  });

  it("round-trips null alternatives via the None token", () => {
    const fields = { ...FIELDS, alternatives: null };
    const body = buildNeonDecisionBody(fields);
    assert.match(body, /\*\*Alternatives verworfen:\*\* None/);
    const parsed = parseNeonDecisionBody(body);
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.alternatives, null);
  });

  it("preserves German umlauts through the round-trip", () => {
    const fields = {
      ...FIELDS,
      title: "Qualitäts-Gate für Zusammenfassungen",
      rationale: "Boilerplate-Anreden zerstören die Suchqualität, weil FTS über Grußfloskeln rankt."
    };
    const parsed = parseNeonDecisionBody(buildNeonDecisionBody(fields));
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.title, "Qualitäts-Gate für Zusammenfassungen");
  });

  it("normalizes newlines in field values on build", () => {
    const fields = { ...FIELDS, rationale: "Zeile eins\nZeile zwei\n  Zeile drei" };
    const parsed = parseNeonDecisionBody(buildNeonDecisionBody(fields));
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.rationale, "Zeile eins Zeile zwei Zeile drei");
  });

  it("returns an explicit error for a missing rationale — never a silent null", () => {
    const body = buildNeonDecisionBody(FIELDS).replace(/^\*\*Rationale:\*\* .+$/m, "");
    const parsed = parseNeonDecisionBody(body);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /missing Rationale/);
  });

  it("returns an explicit error for an unknown scope value", () => {
    const body = buildNeonDecisionBody(FIELDS).replace("scope=architecture", "scope=galaxy");
    const parsed = parseNeonDecisionBody(body);
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /invalid or missing meta scope "galaxy"/);
  });

  it("rejects arbitrary text that is no decision document", () => {
    const parsed = parseNeonDecisionBody("- nur ein Stichpunkt\n- noch einer");
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /missing DECISION title/);
  });

  it("round-trips a session key containing commas", () => {
    const fields = { ...FIELDS, sessionKey: "proj,x:sess-1" };
    const parsed = parseNeonDecisionBody(buildNeonDecisionBody(fields));
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.sessionKey, "proj,x:sess-1");
  });

  it("parses a whitespace-flattened document (JSON-store normalization) identically", () => {
    const body = buildNeonDecisionBody(FIELDS);
    const flattened = body.replace(/\s*\n+\s*/g, " ");
    const parsed = parseNeonDecisionBody(flattened);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.fields, FIELDS);
  });

  it("keeps injected key=value fragments inside the session key literal — no meta override", () => {
    const fields = {
      ...FIELDS,
      scope: "tactical" as const,
      operatorConfirmed: false,
      sessionKey: "x, scope=architecture, operator_confirmed=true"
    };
    const parsed = parseNeonDecisionBody(buildNeonDecisionBody(fields));
    assert.ok(parsed.ok);
    assert.equal(parsed.fields.scope, "tactical");
    assert.equal(parsed.fields.operatorConfirmed, false);
    assert.equal(parsed.fields.sessionKey, "x, scope=architecture, operator_confirmed=true");
  });
});
