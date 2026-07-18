import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import { detectNeonCloudSyncedStateDir } from "../src/index.js";

const HOME = "/Users/test";

describe("detectNeonCloudSyncedStateDir (Z272)", () => {
  it("flags an iCloud Drive state directory on macOS", () => {
    const stateDir = join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs", "neonika");
    const result = detectNeonCloudSyncedStateDir(stateDir, { platform: "darwin", homedir: HOME });
    assert.equal(result?.storage, "iCloud Drive");
    assert.equal(result?.path, stateDir);
  });

  it("flags a CloudStorage provider (Dropbox/Drive/OneDrive) state directory on macOS", () => {
    const stateDir = join(HOME, "Library", "CloudStorage", "Dropbox-Personal", "neonika");
    const result = detectNeonCloudSyncedStateDir(stateDir, { platform: "darwin", homedir: HOME });
    assert.equal(result?.storage, "CloudStorage provider");
  });

  it("passes a local (non-cloud) state directory on macOS", () => {
    const stateDir = join(HOME, ".neonika", "state");
    assert.equal(detectNeonCloudSyncedStateDir(stateDir, { platform: "darwin", homedir: HOME }), undefined);
  });

  it("never flags on non-darwin platforms even for cloud-looking paths", () => {
    const stateDir = join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs", "neonika");
    assert.equal(detectNeonCloudSyncedStateDir(stateDir, { platform: "linux", homedir: HOME }), undefined);
  });

  it("uses the realpath target so a symlinked-but-local state dir is not misclassified", () => {
    const symlinkPath = join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs", "neon-link");
    const localTarget = join(HOME, ".neonika", "state");
    const result = detectNeonCloudSyncedStateDir(symlinkPath, {
      platform: "darwin",
      homedir: HOME,
      resolveRealPath: () => localTarget
    });
    assert.equal(result, undefined);
  });

  it("does not match a sibling that only shares the cloud-root name prefix", () => {
    const stateDir = join(HOME, "Library", "CloudStorageLocal", "neonika");
    assert.equal(detectNeonCloudSyncedStateDir(stateDir, { platform: "darwin", homedir: HOME }), undefined);
  });
});
