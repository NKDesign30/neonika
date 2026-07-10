import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessNeonNodeRuntime,
  isNeonSupportedNodeVersion,
  neonSupportedNodeEngine,
  parseNeonNodeVersion
} from "../src/index.js";

describe("Neon Node runtime guard", () => {
  it("matches the upstream-supported Node engine range", () => {
    assert.equal(neonSupportedNodeEngine, ">=22.19.0 <23 || >=23.11.0");
    assert.equal(isNeonSupportedNodeVersion("22.18.9"), false);
    assert.equal(isNeonSupportedNodeVersion("22.19.0"), true);
    assert.equal(isNeonSupportedNodeVersion("23.0.0"), false);
    assert.equal(isNeonSupportedNodeVersion("23.10.9"), false);
    assert.equal(isNeonSupportedNodeVersion("23.11.0"), true);
    assert.equal(isNeonSupportedNodeVersion("24.16.0"), true);
  });

  it("fails closed on unreadable Node runtime versions", () => {
    assert.equal(parseNeonNodeVersion("not-node"), undefined);
    const assessment = assessNeonNodeRuntime(undefined);

    assert.equal(assessment.state, "unsupported");
    assert.equal(assessment.nodeVersion, "unreadable");
    assert.match(assessment.reason, /unreadable/);
  });
});
