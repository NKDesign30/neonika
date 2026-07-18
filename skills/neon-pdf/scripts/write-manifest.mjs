#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const [
  briefPath,
  htmlPath,
  pdfPath,
  pdfInfoPath,
  pdfFontsPath,
  pagesDirectory,
  contactSheetPath,
  manifestPath,
  mode,
  visualReviewPath
] = process.argv.slice(2);
if (!visualReviewPath || (mode !== "preview" && mode !== "publish")) {
  fail(
    "Usage: write-manifest.mjs <brief> <html> <pdf> <pdfinfo> <pdffonts> <pages-dir> <contact-sheet> <manifest> <preview|publish> <visual-review>"
  );
}

const brief = JSON.parse(await readFile(briefPath, "utf8"));
const pdfInfo = await readFile(pdfInfoPath, "utf8");
const pdfFonts = await readFile(pdfFontsPath, "utf8");
const pageCount = readPageCount(pdfInfo);
if (pageCount < brief.medium.pageBudget.min || pageCount > brief.medium.pageBudget.max) {
  fail(`PDF page count ${pageCount} is outside brief budget ${brief.medium.pageBudget.min}-${brief.medium.pageBudget.max}`);
}

const fonts = readFonts(pdfFonts);
if (fonts.length === 0) {
  fail("PDF contains no detectable fonts");
}
const allowedFonts = brief.brand.fontAllowlist.map(normalizeFontName);
for (const font of fonts) {
  if (!font.embedded) {
    fail(`PDF font is not embedded: ${font.name}`);
  }
  const normalized = normalizeFontName(font.name.replace(/^[A-Z]{6}\+/u, ""));
  if (!allowedFonts.some((allowed) => normalized === allowed || normalized.startsWith(allowed))) {
    fail(`PDF font is outside brief allowlist: ${font.name}`);
  }
}

const pageFiles = (await readdir(pagesDirectory))
  .filter((name) => /^page-\d+\.png$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
if (pageFiles.length !== pageCount) {
  fail(`Raster count ${pageFiles.length} does not match PDF page count ${pageCount}`);
}

const artifacts = {
  designBrief: await describeFile(briefPath),
  sourceHtml: await describeFile(htmlPath),
  pdf: await describeFile(pdfPath),
  contactSheet: await describeFile(contactSheetPath),
  visualReview: await describeFile(visualReviewPath),
  pages: await Promise.all(pageFiles.map(async (name) => await describeFile(join(pagesDirectory, name))))
};
const manifest = {
  version: 1,
  state: mode === "publish" ? "verified" : "pending-visual-review",
  slug: brief.slug,
  documentVersion: brief.documentVersion,
  outputProfile: brief.outputProfile,
  privacyLevel: brief.privacyLevel,
  brand: {
    id: brief.brand.id,
    source: brief.brand.source,
    fontAllowlist: brief.brand.fontAllowlist
  },
  pageCount,
  pageBudget: brief.medium.pageBudget,
  fonts,
  checks: {
    brief: "passed",
    htmlAssets: "passed",
    qpdf: "passed",
    pageBudget: "passed",
    embeddedFonts: "passed",
    fontAllowlist: "passed",
    completeRaster: "passed",
    contactSheet: "passed",
    visualReview: mode === "publish" ? "passed" : "pending"
  },
  artifacts
};

const tempPath = `${manifestPath}.${process.pid}.tmp`;
await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await rename(tempPath, manifestPath);

function readPageCount(input) {
  const match = input.match(/^Pages:\s+(\d+)\s*$/mu);
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("pdfinfo did not report a valid page count");
  }
  return value;
}

function readFonts(input) {
  return input
    .split("\n")
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const name = line.split(/\s+/u)[0];
      const flags = line.match(/\s+(yes|no)\s+(yes|no)\s+(yes|no)\s+\d+\s+\d+\s*$/u);
      if (!name || !flags) {
        fail("pdffonts output could not be parsed safely");
      }
      return {
        name,
        embedded: flags[1] === "yes",
        subset: flags[2] === "yes",
        unicode: flags[3] === "yes"
      };
    });
}

function normalizeFontName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

async function describeFile(path) {
  const data = await readFile(path);
  return {
    name: basename(path),
    bytes: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex")
  };
}

function fail(message) {
  process.stderr.write(`neon-pdf manifest: ${message}\n`);
  process.exit(2);
}
