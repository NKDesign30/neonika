import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getLayerById,
  neonikaCutoverStages,
  neonikaLayers,
  nextCutoverStage,
  renderArchitectureSummary,
  renderProductManifest
} from "../src/index.js";

describe("Neonika product foundation", () => {
  it("defines the expected product layers", () => {
    assert.deepEqual(
      neonikaLayers.map((layer) => layer.id),
      [
        "runtime",
        "gateway",
        "mission-control",
        "memory",
        "agents",
        "skills",
        "doctor"
      ]
    );
  });

  it("renders the architecture around Neon Gateway and Mission Control", () => {
    const summary = renderArchitectureSummary();

    assert.match(summary, /Neon Gateway/);
    assert.match(summary, /Neon Mission Control/);
    assert.match(summary, /Live Neonika APIs/);
  });

  it("renders a product manifest with Neon Memory and Neon Agents", () => {
    const manifest = renderProductManifest();

    assert.match(manifest, /Neon Memory/);
    assert.match(manifest, /Neon Agents/);
  });

  it("keeps cutover stages explicit and ordered", () => {
    assert.deepEqual(
      neonikaCutoverStages.map((stage) => stage.id),
      ["shadow", "mirror", "canary", "primary", "retire"]
    );
    assert.equal(nextCutoverStage("shadow"), "mirror");
    assert.equal(nextCutoverStage("primary"), "retire");
    assert.equal(nextCutoverStage("retire"), null);
  });

  it("can resolve a product layer by id", () => {
    assert.equal(getLayerById("gateway").name, "Neon Gateway");
  });

});
