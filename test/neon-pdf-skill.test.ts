import assert from "node:assert/strict";
import { access, appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

const projectRoot = process.cwd();
const skillRoot = join(projectRoot, "skills", "neon-pdf");
const buildScript = join(skillRoot, "scripts", "build.sh");
const briefFixture = join(skillRoot, "fixtures", "quality-lane-brief.json");
const htmlFixture = join(skillRoot, "fixtures", "quality-lane.html");

describe("Neon PDF quality-lane skill", () => {
  it("keeps the default template neutral and free of biased visual shortcuts", async () => {
    const template = await readFile(join(skillRoot, "assets", "template.html"), "utf8");
    assert.doesNotMatch(template, /radial-gradient|counter-reset|nth-child|class=["'][^"']*card/iu);
    assert.doesNotMatch(template, /\[[^\]]+\]|lorem ipsum|placeholder|dummy|beispieltext|mustertext/iu);
    assert.match(template, /grid-template-columns/iu);
  });

  it("rejects an incomplete brief and placeholder content without publishing output", async () => {
    const root = await mkdtemp(join(tmpdir(), "neon-pdf-negative-"));
    const invalidBrief = join(root, "invalid-brief.json");
    const placeholderHtml = join(root, "placeholder.html");
    const brief: unknown = JSON.parse(await readFile(briefFixture, "utf8"));
    assert.ok(isRecord(brief));
    delete brief["audience"];
    await writeFile(invalidBrief, `${JSON.stringify(brief)}\n`, "utf8");
    await writeFile(
      placeholderHtml,
      "<!doctype html><html><body><h1>[Titel]</h1><p>Lorem ipsum placeholder dummy content for an unfinished PDF document that must never ship.</p></body></html>",
      "utf8"
    );

    try {
      const missingField = await runProcess("node", [
        join(skillRoot, "scripts", "validate-design-brief.mjs"),
        invalidBrief
      ]);
      const placeholder = await runProcess("node", [
        join(skillRoot, "scripts", "validate-html.mjs"),
        placeholderHtml
      ]);

      assert.notEqual(missingField.code, 0);
      assert.match(missingField.stderr, /audience/u);
      const missingArtDirection: unknown = JSON.parse(await readFile(briefFixture, "utf8"));
      assert.ok(isRecord(missingArtDirection));
      delete missingArtDirection["artDirection"];
      await writeFile(invalidBrief, `${JSON.stringify(missingArtDirection)}\n`, "utf8");
      const artDirection = await runProcess("node", [
        join(skillRoot, "scripts", "validate-design-brief.mjs"),
        invalidBrief
      ]);
      assert.notEqual(artDirection.code, 0);
      assert.match(artDirection.stderr, /artDirection/u);
      assert.notEqual(placeholder.code, 0);
      assert.match(placeholder.stderr, /placeholder or dummy/u);
      assert.deepEqual(await readdir(root), ["invalid-brief.json", "placeholder.html"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("renders every page for review without publishing a final PDF", async (context) => {
    const missingTool = await findMissingPdfTool();
    if (missingTool) {
      context.skip(`missing local PDF tool: ${missingTool}`);
      return;
    }

    const outputRoot = await mkdtemp(join(tmpdir(), "neon-pdf-positive-"));
    try {
      const result = await runProcess(buildScript, ["preview", htmlFixture, briefFixture, outputRoot]);
      assert.equal(result.code, 0, result.stderr);
      const previewRoot = await findPreviewRoot(outputRoot);
      const manifest: unknown = JSON.parse(await readFile(join(previewRoot, "manifest.json"), "utf8"));
      assert.ok(isRecord(manifest));
      assert.equal(manifest["state"], "pending-visual-review");
      assert.equal(manifest["pageCount"], 1);
      const review: unknown = JSON.parse(await readFile(join(previewRoot, "visual-review.json"), "utf8"));
      assert.ok(isRecord(review));
      assert.equal(review["decision"], "pending");
      await access(join(previewRoot, "quality-lane-proof-1.0.0.pdf"));
      await access(join(previewRoot, "contact-sheet.png"));
      assert.deepEqual(await readdir(join(previewRoot, "pages")), ["page-1.png"]);
      await assert.rejects(access(join(outputRoot, "quality-lane-proof-1.0.0")));
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("refuses publication while the visual review is still pending", async (context) => {
    const missingTool = await findMissingPdfTool();
    if (missingTool) {
      context.skip(`missing local PDF tool: ${missingTool}`);
      return;
    }

    const outputRoot = await mkdtemp(join(tmpdir(), "neon-pdf-pending-review-"));
    try {
      const preview = await runProcess(buildScript, ["preview", htmlFixture, briefFixture, outputRoot]);
      assert.equal(preview.code, 0, preview.stderr);
      const previewRoot = await findPreviewRoot(outputRoot);

      const publish = await runProcess(buildScript, ["publish", previewRoot]);
      assert.notEqual(publish.code, 0);
      assert.match(publish.stderr, /decision must be approved/u);
      await access(previewRoot);
      await assert.rejects(access(join(outputRoot, "quality-lane-proof-1.0.0")));
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("publishes the exact preview only after every page passes visual review", async (context) => {
    const missingTool = await findMissingPdfTool();
    if (missingTool) {
      context.skip(`missing local PDF tool: ${missingTool}`);
      return;
    }

    const outputRoot = await mkdtemp(join(tmpdir(), "neon-pdf-approved-review-"));
    const finalRoot = join(outputRoot, "quality-lane-proof-1.0.0");
    try {
      const preview = await runProcess(buildScript, ["preview", htmlFixture, briefFixture, outputRoot]);
      assert.equal(preview.code, 0, preview.stderr);
      const previewRoot = await findPreviewRoot(outputRoot);
      const reviewPath = join(previewRoot, "visual-review.json");
      const review: unknown = JSON.parse(await readFile(reviewPath, "utf8"));
      approveVisualReview(review);
      await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

      const publish = await runProcess(buildScript, ["publish", previewRoot]);
      assert.equal(publish.code, 0, publish.stderr);
      await assert.rejects(access(previewRoot));
      await access(join(finalRoot, "quality-lane-proof-1.0.0.pdf"));
      const manifest: unknown = JSON.parse(await readFile(join(finalRoot, "manifest.json"), "utf8"));
      assert.ok(isRecord(manifest));
      assert.equal(manifest["state"], "verified");
      const checks = manifest["checks"];
      assert.ok(isRecord(checks));
      assert.equal(checks["visualReview"], "passed");
      assert.ok(Object.values(checks).every((value) => value === "passed"));
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it("rejects an approved review when the reviewed PDF changed afterward", async (context) => {
    const missingTool = await findMissingPdfTool();
    if (missingTool) {
      context.skip(`missing local PDF tool: ${missingTool}`);
      return;
    }

    const outputRoot = await mkdtemp(join(tmpdir(), "neon-pdf-tampered-review-"));
    try {
      const preview = await runProcess(buildScript, ["preview", htmlFixture, briefFixture, outputRoot]);
      assert.equal(preview.code, 0, preview.stderr);
      const previewRoot = await findPreviewRoot(outputRoot);
      const reviewPath = join(previewRoot, "visual-review.json");
      const pdfPath = join(previewRoot, "quality-lane-proof-1.0.0.pdf");
      const review: unknown = JSON.parse(await readFile(reviewPath, "utf8"));
      approveVisualReview(review);
      await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
      await appendFile(pdfPath, "\n", "utf8");

      const publish = await runProcess(buildScript, ["publish", previewRoot]);
      assert.notEqual(publish.code, 0);
      assert.match(publish.stderr, /document\.pdfSha256 does not match/u);
      await access(previewRoot);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });
});

function approveVisualReview(input: unknown): void {
  assert.ok(isRecord(input));
  input["reviewer"] = "Chaty";
  input["decision"] = "approved";
  const pages = input["pages"];
  assert.ok(Array.isArray(pages));
  for (const page of pages) {
    assert.ok(isRecord(page));
    page["verdict"] = "pass";
    page["observation"] = "Hierarchy, spacing, typography and page bounds are visually balanced.";
    const checks = page["checks"];
    assert.ok(isRecord(checks));
    for (const key of Object.keys(checks)) {
      checks[key] = true;
    }
  }
  const revision = input["revision"];
  assert.ok(isRecord(revision));
  revision["performed"] = false;
  revision["summary"] = "No correction was needed because the reviewed fixture has no visual defect.";
}

async function findPreviewRoot(outputRoot: string): Promise<string> {
  const reviewRoot = join(outputRoot, ".review");
  const entries = await readdir(reviewRoot);
  assert.equal(entries.length, 1);
  const name = entries[0];
  assert.ok(name);
  return join(reviewRoot, name);
}

async function findMissingPdfTool(): Promise<string | undefined> {
  for (const command of ["weasyprint", "qpdf", "pdfinfo", "pdffonts", "pdftoppm", "magick"]) {
    if ((await runProcess("sh", ["-c", `command -v ${command}`])).code !== 0) {
      return command;
    }
  }
  return undefined;
}

function runProcess(command: string, args: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
