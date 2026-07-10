import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createNeonLocalMediaAttachmentsFromText } from "../src/index.js";

describe("createNeonLocalMediaAttachmentsFromText", () => {
  it("turns a project-local PDF path into a Discord attachment without leaking the path", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-pdf-outbox-"));
    const outboxDir = join(projectRoot, "state", "gateway", "pdf-outbox", "sample");
    await mkdir(outboxDir, { recursive: true });
    const pdfPath = join(outboxDir, "angebot.pdf");
    await writeFile(pdfPath, new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]));

    try {
      const result = await createNeonLocalMediaAttachmentsFromText(`PDF fertig: \`${pdfPath}\``, { projectRoot });

      assert.equal(result.text, "PDF fertig: angebot.pdf");
      assert.deepEqual(result.attachedFilenames, ["angebot.pdf"]);
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0]?.name, "angebot.pdf");
      assert.equal(result.attachments[0]?.contentType, "application/pdf");
      assert.doesNotMatch(result.text, /state\/gateway|pdf-outbox|\//u);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it("redacts local media paths without flattening Discord text formatting", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "neon-core-image-outbox-"));
    const outboxDir = join(projectRoot, "state", "gateway", "peekaboo-captures");
    await mkdir(outboxDir, { recursive: true });
    const imagePath = join(outboxDir, "screen.png");
    await writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));

    try {
      const result = await createNeonLocalMediaAttachmentsFromText(
        `Fertig:\n1. Screenshot hängt an: \`${imagePath}\`\n2. Zahlen bleiben Zahlen.`,
        { projectRoot }
      );

      assert.equal(result.text, "Fertig:\n1. Screenshot hängt an: screen.png\n2. Zahlen bleiben Zahlen.");
      assert.equal(result.attachments.length, 1);
      assert.equal(result.attachments[0]?.name, "screen.png");
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
