import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateNeonBindingResume,
  hashNeonSessionStableBaseInstructions,
  type ICodexThreadBinding,
  type INeonBindingResumeSpec
} from "../src/index.js";

function makeBinding(overrides: Partial<ICodexThreadBinding> = {}): ICodexThreadBinding {
  return {
    schemaVersion: 1,
    sessionKey: "neon:codex:chaty:discord:local:dm:terminal:main:t:read-only",
    threadId: "thread-1",
    cwd: "/work",
    approvalPolicy: "on-request",
    sandbox: "read-only",
    memoryState: "attached",
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    model: "gpt-5-codex",
    ...overrides
  };
}

const BASE_SPEC: INeonBindingResumeSpec = {
  cwd: "/work",
  approvalPolicy: "on-request",
  sandbox: "read-only",
  model: "gpt-5-codex"
};

test("evaluateNeonBindingResume matches an identical spec", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), BASE_SPEC);
  assert.equal(decision.matches, true);
  assert.deepEqual(decision.drift, []);
});

test("evaluateNeonBindingResume flags cwd drift", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), { ...BASE_SPEC, cwd: "/other" });
  assert.equal(decision.matches, false);
  assert.deepEqual(decision.drift, ["cwd"]);
});

test("evaluateNeonBindingResume flags sandbox drift", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), { ...BASE_SPEC, sandbox: "workspace-write" });
  assert.equal(decision.matches, false);
  assert.deepEqual(decision.drift, ["sandbox"]);
});

test("evaluateNeonBindingResume flags approvalPolicy drift", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), { ...BASE_SPEC, approvalPolicy: "never" });
  assert.equal(decision.matches, false);
  assert.deepEqual(decision.drift, ["approvalPolicy"]);
});

test("evaluateNeonBindingResume flags an explicit model change", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), { ...BASE_SPEC, model: "gpt-5" });
  assert.equal(decision.matches, false);
  assert.deepEqual(decision.drift, ["model"]);
});

test("evaluateNeonBindingResume does NOT flag an absent spec model (harness falls back to persisted)", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), {
    cwd: "/work",
    approvalPolicy: "on-request",
    sandbox: "read-only"
  });
  assert.equal(decision.matches, true);
  assert.deepEqual(decision.drift, []);
});

test("evaluateNeonBindingResume reports every drifting field at once", () => {
  const decision = evaluateNeonBindingResume(makeBinding(), {
    cwd: "/other",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    model: "gpt-5"
  });
  assert.equal(decision.matches, false);
  assert.deepEqual([...decision.drift].sort(), ["approvalPolicy", "cwd", "model", "sandbox"]);
});

test("evaluateNeonBindingResume resumes when only the persisted side names a model", () => {
  const decision = evaluateNeonBindingResume(makeBinding({ model: "gpt-5-codex" }), {
    cwd: "/work",
    approvalPolicy: "on-request",
    sandbox: "read-only"
  });
  assert.equal(decision.matches, true);
});

test("hashNeonSessionStableBaseInstructions ignores explicitly volatile context lines only", () => {
  const stable = [
    "You are running inside Neon Core.",
    "Agent: chaty.",
    "Runtime context: gateway message 1",
    "Mention state: mentioned=true",
    "Group context: intro=v1",
    "Tool scope: peekaboo available",
    "Do not disclose secrets."
  ].join("\n");
  const volatileChanged = [
    "You are running inside Neon Core.",
    "Agent: chaty.",
    "Runtime context: gateway message 2",
    "Mention state: mentioned=false",
    "Group context: intro=v2",
    "Tool scope: peekaboo unavailable",
    "Do not disclose secrets."
  ].join("\n");
  const realInstructionChanged = [
    "You are running inside Neon Core.",
    "Agent: chaty.",
    "Do disclose secrets."
  ].join("\n");

  assert.equal(
    hashNeonSessionStableBaseInstructions(stable),
    hashNeonSessionStableBaseInstructions(volatileChanged)
  );
  assert.notEqual(
    hashNeonSessionStableBaseInstructions(stable),
    hashNeonSessionStableBaseInstructions(realInstructionChanged)
  );
});

test("evaluateNeonBindingResume keeps a thread when only marked volatile base instructions drift", () => {
  const persistedHash = hashNeonSessionStableBaseInstructions(
    ["Base instruction.", "Mention state: required", "Do not disclose secrets."].join("\n")
  );
  const currentHash = hashNeonSessionStableBaseInstructions(
    ["Base instruction.", "Mention state: not required", "Do not disclose secrets."].join("\n")
  );
  const decision = evaluateNeonBindingResume(makeBinding({ baseInstructionsHash: persistedHash }), {
    ...BASE_SPEC,
    baseInstructionsHash: currentHash
  });

  assert.equal(decision.matches, true);
  assert.deepEqual(decision.drift, []);
});

test("evaluateNeonBindingResume still blocks real base instruction drift", () => {
  const persistedHash = hashNeonSessionStableBaseInstructions("Base instruction.");
  const currentHash = hashNeonSessionStableBaseInstructions("Changed base instruction.");
  const decision = evaluateNeonBindingResume(makeBinding({ baseInstructionsHash: persistedHash }), {
    ...BASE_SPEC,
    baseInstructionsHash: currentHash
  });

  assert.equal(decision.matches, false);
  assert.deepEqual(decision.drift, ["baseInstructions"]);
});
