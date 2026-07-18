import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  selectNeonHarness,
  type ICodexHarness,
  type INeonHarnessRegistry,
  type TAgentRuntime
} from "../src/index.js";

const codexHarness: ICodexHarness = {
  id: "codex-app-server",
  run: async () => {
    throw new Error("not invoked in selector tests");
  }
};

const claudeHarness: ICodexHarness = {
  id: "claude-cli",
  run: async () => {
    throw new Error("not invoked in selector tests");
  }
};

const registry: INeonHarnessRegistry = { codex: codexHarness, claude: claudeHarness };

describe("Neon harness selector", () => {
  it("routes the claude runtime to the Claude CLI harness", () => {
    const selection = selectNeonHarness("claude", registry);

    assert.equal(selection.harness.id, "claude-cli");
    assert.equal(selection.reason, "claude-runtime");
    assert.equal(selection.runtime, "claude");
  });

  it("routes the codex runtime to the Codex app-server harness", () => {
    const selection = selectNeonHarness("codex", registry);

    assert.equal(selection.harness.id, "codex-app-server");
    assert.equal(selection.reason, "codex-runtime");
  });

  it("falls back to Codex for non-inference runtimes", () => {
    const hybrid = selectNeonHarness("hybrid", registry);
    const humanGate = selectNeonHarness("human-gate", registry);

    for (const selection of [hybrid, humanGate]) {
      assert.equal(selection.harness.id, "codex-app-server");
      assert.equal(selection.reason, "default-codex");
    }
  });

  it("covers every declared agent runtime", () => {
    const runtimes: readonly TAgentRuntime[] = ["codex", "claude", "hybrid", "human-gate"];

    for (const runtime of runtimes) {
      const selection = selectNeonHarness(runtime, registry);

      assert.ok(selection.harness === codexHarness || selection.harness === claudeHarness);
    }
  });
});
