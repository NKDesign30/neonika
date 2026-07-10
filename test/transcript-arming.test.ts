import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderNeonTranscriptArmingReport, resolveNeonTranscriptArming } from "../src/index.js";

describe("Neon transcript production arming", () => {
  it("is fully disarmed by default", () => {
    const arming = resolveNeonTranscriptArming({});
    assert.equal(arming.llmArmed, false);
    assert.equal(arming.persistArmed, false);
    assert.equal(arming.fullyArmed, false);
    assert.equal(arming.storePath, null);
  });

  it("arms the LLM pass alone without touching persistence", () => {
    const arming = resolveNeonTranscriptArming({ NEON_TRANSCRIPT_LLM_ENABLED: "ready" });
    assert.equal(arming.llmArmed, true);
    assert.equal(arming.persistArmed, false);
    assert.equal(arming.fullyArmed, false);
  });

  it("requires BOTH the memory gate and an explicit store path for persistence", () => {
    const gateOnly = resolveNeonTranscriptArming({ NEON_MEMORY_WRITE_ENABLED: "ready" });
    assert.equal(gateOnly.persistArmed, false);

    const pathOnly = resolveNeonTranscriptArming({
      NEON_TRANSCRIPT_STORE_PATH: "/tmp/store.json"
    });
    assert.equal(pathOnly.persistArmed, false);

    const both = resolveNeonTranscriptArming({
      NEON_MEMORY_WRITE_ENABLED: "ready",
      NEON_TRANSCRIPT_STORE_PATH: "/tmp/store.json"
    });
    assert.equal(both.persistArmed, true);
    assert.equal(both.storePath, "/tmp/store.json");
  });

  it("reports fully armed only with all three switches", () => {
    const arming = resolveNeonTranscriptArming({
      NEON_TRANSCRIPT_LLM_ENABLED: "ready",
      NEON_MEMORY_WRITE_ENABLED: "ready",
      NEON_TRANSCRIPT_STORE_PATH: "/tmp/store.json"
    });
    assert.equal(arming.fullyArmed, true);
    assert.match(renderNeonTranscriptArmingReport(arming), /ARMED/);
  });

  it("treats a whitespace-only store path as unset", () => {
    const arming = resolveNeonTranscriptArming({
      NEON_MEMORY_WRITE_ENABLED: "ready",
      NEON_TRANSCRIPT_STORE_PATH: "   "
    });
    assert.equal(arming.storePath, null);
    assert.equal(arming.persistArmed, false);
  });
});
