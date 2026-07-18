#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

const [htmlPath] = process.argv.slice(2);
if (!htmlPath) {
  fail("Usage: validate-html.mjs <input.html>");
}

const html = await readFile(htmlPath, "utf8").catch(() => fail("HTML input is missing or unreadable"));
if (!/<html\b/iu.test(html) || !/<body\b/iu.test(html)) {
  fail("HTML input must contain html and body elements");
}
if (/\[[^\]]+\]|\b(?:lorem ipsum|placeholder|dummy|tbd|todo|beispieltext|mustertext)\b/iu.test(html)) {
  fail("HTML input contains placeholder or dummy text");
}
if (/<(?:img|iframe|script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:/iu.test(html) || /url\(\s*["']?https?:/iu.test(html)) {
  fail("Remote assets are not allowed; use reproducible local assets");
}

const visibleText = html
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/giu, " ")
  .replace(/\s+/gu, " ")
  .trim();
if (visibleText.length < 80) {
  fail("HTML input needs at least 80 visible characters");
}

const references = collectLocalAssetReferences(html);
for (const reference of references) {
  if (isAbsolute(reference) || reference.split(/[\\/]/u).includes("..")) {
    fail(`Asset path must stay relative to the HTML directory: ${reference}`);
  }
  await access(resolve(dirname(htmlPath), reference)).catch(() => fail(`Local asset is missing: ${reference}`));
}

function collectLocalAssetReferences(input) {
  const values = [];
  for (const pattern of [
    /<(?:img|script|link)\b[^>]*(?:src|href)\s*=\s*["']([^"']+)["']/giu,
    /url\(\s*["']?([^"')]+)["']?\s*\)/giu
  ]) {
    let match;
    while ((match = pattern.exec(input)) !== null) {
      const value = match[1]?.trim();
      if (!value || value.startsWith("#") || value.startsWith("data:")) {
        continue;
      }
      values.push(value);
    }
  }
  return [...new Set(values)];
}

function fail(message) {
  process.stderr.write(`neon-pdf html: ${message}\n`);
  process.exit(2);
}
