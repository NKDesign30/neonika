import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createNeonWhatsAppReplayStore } from "../src/index.js";

describe("Neonika WhatsApp persistent replay protection", () => {
  it("deduplicates across store instances without persisting the raw message id", async () => {
    const root = join(tmpdir(), `neonika-whatsapp-replay-${process.pid}-${Date.now()}`);
    const path = join(root, "state", "whatsapp-replay.json");
    const rawMessageId = "transport-message-id-must-not-persist";
    const now = () => new Date("2026-07-18T18:00:00.000Z");
    try {
      const first = await createNeonWhatsAppReplayStore(path, { now });
      assert.equal(await first.claim(rawMessageId), true);

      const restarted = await createNeonWhatsAppReplayStore(path, { now });
      assert.equal(await restarted.claim(rawMessageId), false);

      const persisted = await readFile(path, "utf8");
      assert.doesNotMatch(persisted, new RegExp(rawMessageId));
      assert.match(persisted, /[a-f0-9]{64}/u);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, "state"))).mode & 0o777, 0o700);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
