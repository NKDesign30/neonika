#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [briefPath, mode = "validate"] = process.argv.slice(2);
if (!briefPath) {
  fail("Usage: validate-design-brief.mjs <brief.json> [meta]");
}

const raw = await readFile(briefPath, "utf8").catch(() => fail("Design brief is missing or unreadable"));
let value;
try {
  value = JSON.parse(raw);
} catch {
  fail("Design brief is not valid JSON");
}

const brief = requireRecord(value, "brief");
requireExactNumber(brief, "version", 2);
const slug = requireSlug(brief, "slug");
const documentVersion = requireVersion(brief, "documentVersion");
requireText(brief, "audience");
requireText(brief, "readerDecision");
const medium = requireRecord(brief.medium, "medium");
if (requireText(medium, "format") !== "A4") {
  fail("medium.format must be A4");
}
const pageBudget = requireRecord(medium.pageBudget, "medium.pageBudget");
const minPages = requirePositiveInteger(pageBudget, "min");
const maxPages = requirePositiveInteger(pageBudget, "max");
if (maxPages < minPages) {
  fail("medium.pageBudget.max must be greater than or equal to min");
}

const brand = requireRecord(brief.brand, "brand");
const brandId = requireText(brand, "id");
const brandSource = requireText(brand, "source");
const fontAllowlist = requireTextArray(brand, "fontAllowlist", true);
if (brandId === "neon" || brandId === "nk") {
  if (!new Set(["~/neon-projects/neon-design", "neon-design"]).has(brandSource)) {
    fail("NEON/NK briefs must use ~/neon-projects/neon-design as brand.source");
  }
  for (const requiredFont of ["DM Serif Display", "Space Grotesk", "Geist Mono"]) {
    if (!fontAllowlist.includes(requiredFont)) {
      fail(`NEON/NK fontAllowlist must contain ${requiredFont}`);
    }
  }
}

const artDirection = requireRecord(brief.artDirection, "artDirection");
requireText(artDirection, "concept");
const visualTone = requireTextArray(artDirection, "visualTone", true);
if (visualTone.length < 2 || visualTone.length > 5) {
  fail("artDirection.visualTone must contain 2 to 5 entries");
}
validatePalette(artDirection.palette);
validateTypography(artDirection.typography, fontAllowlist);
const layout = requireRecord(artDirection.layout, "artDirection.layout");
requireText(layout, "grid");
requireText(layout, "rhythm");
requireText(layout, "density");
requireText(artDirection, "signatureElement");
const pageArchetypes = requireTextArray(artDirection, "pageArchetypes", true);
if (pageArchetypes.length > 12) {
  fail("artDirection.pageArchetypes must contain at most 12 entries");
}
const avoidDefaults = requireTextArray(artDirection, "avoidDefaults", true);
if (avoidDefaults.length < 2) {
  fail("artDirection.avoidDefaults must contain at least 2 entries");
}

requireTextArray(brief, "contentSpine", true);
requireTextArray(brief, "evidenceSources", true);
requireText(brief, "cta");
requireTextArray(brief, "subjectMaterials", true);
const sender = requireRecord(brief.sender, "sender");
requireText(sender, "name");
requireText(sender, "role");
requireText(sender, "contact");
requireTextArray(brief, "allowedDefaultExceptions", false);

const outputProfile = requireText(brief, "outputProfile");
if (outputProfile !== "screen-accessible" && outputProfile !== "office-print") {
  fail("outputProfile must be screen-accessible or office-print");
}
const privacyLevel = requireText(brief, "privacyLevel");
if (!new Set(["public", "internal", "confidential"]).has(privacyLevel)) {
  fail("privacyLevel must be public, internal, or confidential");
}

assertNoPlaceholders(brief, "brief");

if (mode === "meta") {
  process.stdout.write(
    [slug, documentVersion, outputProfile, String(minPages), String(maxPages), fontAllowlist.join("|")].join("\t")
  );
} else if (mode !== "validate") {
  fail("Validator mode must be validate or meta");
}

function requireRecord(input, path) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(`${path} must be an object`);
  }
  return input;
}

function requireText(record, key) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1_000) {
    fail(`${key} must be a non-empty string with at most 1000 characters`);
  }
  return value.trim();
}

function requireTextArray(record, key, nonEmpty) {
  const value = record[key];
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || value.length > 100) {
    fail(`${key} must be ${nonEmpty ? "a non-empty" : "an"} array with at most 100 entries`);
  }
  const strings = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > 1_000) {
      fail(`${key}[${index}] must be a non-empty string with at most 1000 characters`);
    }
    return entry.trim();
  });
  if (new Set(strings).size !== strings.length) {
    fail(`${key} must not contain duplicates`);
  }
  return strings;
}

function requirePositiveInteger(record, key) {
  const value = record[key];
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    fail(`${key} must be an integer from 1 to 500`);
  }
  return value;
}

function validatePalette(input) {
  if (!Array.isArray(input) || input.length < 4 || input.length > 6) {
    fail("artDirection.palette must contain 4 to 6 colors");
  }
  const roles = [];
  for (const [index, entry] of input.entries()) {
    const color = requireRecord(entry, `artDirection.palette[${index}]`);
    const role = requireText(color, "role");
    const hex = requireText(color, "hex");
    if (!/^#[0-9a-f]{6}$/iu.test(hex)) {
      fail(`artDirection.palette[${index}].hex must be a six-digit hex color`);
    }
    roles.push(role);
  }
  if (new Set(roles).size !== roles.length) {
    fail("artDirection.palette roles must be unique");
  }
}

function validateTypography(input, fontAllowlist) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 3) {
    fail("artDirection.typography must contain 2 or 3 roles");
  }
  const roles = [];
  for (const [index, entry] of input.entries()) {
    const typography = requireRecord(entry, `artDirection.typography[${index}]`);
    const role = requireText(typography, "role");
    const family = requireText(typography, "family");
    requireText(typography, "purpose");
    if (!fontAllowlist.includes(family)) {
      fail(`artDirection.typography[${index}].family must be in brand.fontAllowlist`);
    }
    roles.push(role);
  }
  if (new Set(roles).size !== roles.length) {
    fail("artDirection.typography roles must be unique");
  }
}

function requireExactNumber(record, key, expected) {
  if (record[key] !== expected) {
    fail(`${key} must equal ${expected}`);
  }
}

function requireSlug(record, key) {
  const value = requireText(record, key);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 80) {
    fail(`${key} must be a lowercase kebab-case slug`);
  }
  return value;
}

function requireVersion(record, key) {
  const value = requireText(record, key);
  if (!/^\d+\.\d+\.\d+$/u.test(value)) {
    fail(`${key} must be a semantic version such as 1.0.0`);
  }
  return value;
}

function assertNoPlaceholders(input, path) {
  if (typeof input === "string") {
    if (/\[[^\]]+\]|\b(?:lorem ipsum|placeholder|dummy|tbd|todo|beispieltext|mustertext)\b/iu.test(input)) {
      fail(`${path} contains placeholder or dummy text`);
    }
    return;
  }
  if (Array.isArray(input)) {
    input.forEach((entry, index) => assertNoPlaceholders(entry, `${path}[${index}]`));
    return;
  }
  if (typeof input === "object" && input !== null) {
    for (const [key, entry] of Object.entries(input)) {
      assertNoPlaceholders(entry, `${path}.${key}`);
    }
  }
}

function fail(message) {
  process.stderr.write(`neon-pdf brief: ${message}\n`);
  process.exit(2);
}
