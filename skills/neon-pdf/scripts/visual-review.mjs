#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REVIEW_CHECKS = [
  "bounds",
  "hierarchy",
  "typography",
  "spacing",
  "contrast",
  "brand",
  "contentIntegrity"
];

const [mode, briefPath, htmlPath, pdfPath, pagesDirectory, reviewPath] = process.argv.slice(2);
if (!reviewPath || (mode !== "init" && mode !== "validate")) {
  fail("Usage: visual-review.mjs <init|validate> <brief> <html> <pdf> <pages-dir> <review>");
}

const brief = await readJson(briefPath, "Design brief");
const pageFiles = (await readdir(pagesDirectory))
  .filter((name) => /^page-\d+\.png$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
if (pageFiles.length === 0) {
  fail("Rendered pages are missing");
}

if (mode === "init") {
  await initializeReview();
} else {
  await validateReview();
}

async function initializeReview() {
  const review = {
    version: 1,
    document: {
      slug: brief.slug,
      documentVersion: brief.documentVersion,
      htmlSha256: await sha256(htmlPath),
      briefSha256: await sha256(briefPath),
      pdfSha256: await sha256(pdfPath)
    },
    reviewer: "",
    decision: "pending",
    pages: await Promise.all(
      pageFiles.map(async (name, index) => ({
        page: index + 1,
        file: name,
        sha256: await sha256(join(pagesDirectory, name)),
        verdict: "pending",
        checks: Object.fromEntries(REVIEW_CHECKS.map((check) => [check, false])),
        observation: ""
      }))
    ),
    revision: {
      performed: false,
      summary: ""
    }
  };

  const temporaryPath = `${reviewPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(review, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, reviewPath);
}

async function validateReview() {
  const review = requireRecord(await readJson(reviewPath, "Visual review"), "review");
  if (review.version !== 1) {
    fail("version must equal 1");
  }
  if (review.decision !== "approved") {
    fail("decision must be approved");
  }
  requireReviewText(review.reviewer, "reviewer", 2);

  const document = requireRecord(review.document, "document");
  requireMatch(document.slug, brief.slug, "document.slug");
  requireMatch(document.documentVersion, brief.documentVersion, "document.documentVersion");
  requireMatch(document.htmlSha256, await sha256(htmlPath), "document.htmlSha256");
  requireMatch(document.briefSha256, await sha256(briefPath), "document.briefSha256");
  requireMatch(document.pdfSha256, await sha256(pdfPath), "document.pdfSha256");

  if (!Array.isArray(review.pages) || review.pages.length !== pageFiles.length) {
    fail(`pages must contain exactly ${pageFiles.length} entries`);
  }
  for (const [index, name] of pageFiles.entries()) {
    const page = requireRecord(review.pages[index], `pages[${index}]`);
    requireMatch(page.page, index + 1, `pages[${index}].page`);
    requireMatch(page.file, name, `pages[${index}].file`);
    requireMatch(page.sha256, await sha256(join(pagesDirectory, name)), `pages[${index}].sha256`);
    if (page.verdict !== "pass") {
      fail(`pages[${index}].verdict must be pass`);
    }
    const checks = requireRecord(page.checks, `pages[${index}].checks`);
    for (const check of REVIEW_CHECKS) {
      if (checks[check] !== true) {
        fail(`pages[${index}].checks.${check} must be true`);
      }
    }
    requireReviewText(page.observation, `pages[${index}].observation`, 8);
  }

  const revision = requireRecord(review.revision, "revision");
  if (typeof revision.performed !== "boolean") {
    fail("revision.performed must be a boolean");
  }
  requireReviewText(revision.summary, "revision.summary", 12);
  process.stdout.write("neon-pdf visual review: approved\n");
}

async function readJson(path, label) {
  const raw = await readFile(path, "utf8").catch(() => fail(`${label} is missing or unreadable`));
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function requireRecord(input, path) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(`${path} must be an object`);
  }
  return input;
}

function requireReviewText(input, path, minimumLength) {
  if (typeof input !== "string" || input.trim().length < minimumLength || input.length > 1_000) {
    fail(`${path} must contain ${minimumLength} to 1000 characters`);
  }
  if (/\[[^\]]+\]|\b(?:lorem ipsum|placeholder|dummy|tbd|todo|beispieltext|mustertext)\b/iu.test(input)) {
    fail(`${path} contains placeholder or dummy text`);
  }
}

function requireMatch(actual, expected, path) {
  if (actual !== expected) {
    fail(`${path} does not match the rendered artifact`);
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function fail(message) {
  process.stderr.write(`neon-pdf visual review: ${message}\n`);
  process.exit(2);
}
