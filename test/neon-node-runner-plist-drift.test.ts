import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectNeonNodeRunnerPlistArgsDrift } from "../src/index.js";

describe("detectNeonNodeRunnerPlistArgsDrift (Z395)", () => {
  const cliPath = "/Users/neo/neon-core/dist/src/cli.js";

  it("flags an installed plist that no longer references the current cli path", () => {
    // Stale LaunchAgent from an older checkout — points at a moved/old dist path.
    const stale = "<string>exec node /Users/neo/OLD-checkout/dist/src/cli.js node-runner-loop</string>";
    assert.equal(
      detectNeonNodeRunnerPlistArgsDrift({ installedLaunchAgentPlist: stale, expectedCliPath: cliPath }),
      true
    );
  });

  it("does not flag a plist that still references the current cli path", () => {
    const current = `<string>exec node ${cliPath} node-runner-loop</string>`;
    assert.equal(
      detectNeonNodeRunnerPlistArgsDrift({ installedLaunchAgentPlist: current, expectedCliPath: cliPath }),
      false
    );
  });

  it("treats a missing install as no drift", () => {
    assert.equal(
      detectNeonNodeRunnerPlistArgsDrift({ installedLaunchAgentPlist: undefined, expectedCliPath: cliPath }),
      false
    );
  });
});
