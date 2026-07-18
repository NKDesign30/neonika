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

  it("renders the architecture around Neonika Gateway and Mission Control", () => {
    const summary = renderArchitectureSummary();

    assert.match(summary, /Neonika Gateway/);
    assert.match(summary, /Neonika Mission Control/);
    assert.match(summary, /Live Neonika APIs/);
  });

  it("renders a product manifest with Neonika Memory and Neonika Agents", () => {
    const manifest = renderProductManifest();

    assert.match(manifest, /Neonika Memory/);
    assert.match(manifest, /Neonika Agents/);
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
    assert.equal(getLayerById("gateway").name, "Neonika Gateway");
  });

});
