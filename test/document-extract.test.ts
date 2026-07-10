import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectNeonDocFormat,
  extractNeonDocument,
  renderNeonDocExtractReport,
  type INeonDocExtractProvider
} from "../src/tools/documentExtract.js";

describe("detectNeonDocFormat", () => {
  it("resolves by mime type first, then by file extension", () => {
    assert.equal(detectNeonDocFormat("text/markdown"), "markdown");
    assert.equal(detectNeonDocFormat("application/pdf"), "pdf");
    assert.equal(detectNeonDocFormat("text/plain; charset=utf-8"), "text");
    assert.equal(detectNeonDocFormat(undefined, "notes.md"), "markdown");
    assert.equal(detectNeonDocFormat(undefined, "report.PDF"), "pdf");
    assert.equal(detectNeonDocFormat(undefined, "mystery"), "unknown");
  });
});

describe("extractNeonDocument — text formats (dependency-free)", () => {
  it("passes plain text through", async () => {
    const result = await extractNeonDocument({ text: "hello world", mimeType: "text/plain" });
    assert.equal(result.state, "extracted");
    assert.equal(result.format, "text");
    assert.equal(result.text, "hello world");
    assert.equal(result.characters, 11);
  });

  it("strips markdown markup down to readable text", async () => {
    const md = "# Title\n\nSome **bold** and _italic_ and `code` and a [link](https://example.com).";
    const result = await extractNeonDocument({ text: md, fileName: "doc.md" });
    assert.equal(result.format, "markdown");
    assert.doesNotMatch(result.text, /[#*_`]/u);
    assert.match(result.text, /Title/);
    assert.match(result.text, /bold/);
    assert.match(result.text, /link/);
  });

  it("strips html tags, scripts, and decodes entities", async () => {
    const html = "<html><head><style>x{}</style></head><body><p>Hi &amp; bye</p><script>steal()</script></body></html>";
    const result = await extractNeonDocument({ text: html, mimeType: "text/html" });
    assert.equal(result.format, "html");
    assert.doesNotMatch(result.text, /<[^>]+>/u);
    assert.doesNotMatch(result.text, /steal\(\)/u);
    assert.match(result.text, /Hi & bye/);
  });

  it("flattens json into path: value lines", async () => {
    const json = JSON.stringify({ user: { name: "neo", roles: ["admin", "ops"] } });
    const result = await extractNeonDocument({ text: json, mimeType: "application/json" });
    assert.equal(result.format, "json");
    assert.match(result.text, /user\.name: neo/);
    assert.match(result.text, /user\.roles\[0\]: admin/);
  });

  it("renders csv rows as pipe-joined cells", async () => {
    const result = await extractNeonDocument({ text: "a,b,c\n1,2,3", fileName: "data.csv" });
    assert.equal(result.format, "csv");
    assert.match(result.text, /a \| b \| c/);
    assert.match(result.text, /1 \| 2 \| 3/);
  });
});

describe("extractNeonDocument — limits, states, redaction", () => {
  it("reports an empty document", async () => {
    const result = await extractNeonDocument({ text: "", mimeType: "text/plain" });
    assert.equal(result.state, "empty");
    assert.equal(result.byteLength, 0);
  });

  it("rejects an oversized document without extracting", async () => {
    const result = await extractNeonDocument({ text: "x".repeat(2048), mimeType: "text/plain", maxBytes: 1024 });
    assert.equal(result.state, "too-large");
    assert.equal(result.text, "");
  });

  it("reports unsupported-format for an unknown type", async () => {
    const result = await extractNeonDocument({ text: "data", mimeType: "application/octet-stream" });
    assert.equal(result.state, "unsupported-format");
    assert.equal(result.format, "unknown");
  });

  it("redacts a secret found in extracted text", async () => {
    const result = await extractNeonDocument({ text: "api key sk-abcdef0123456789ABCDEF here", mimeType: "text/plain" });
    assert.doesNotMatch(result.text, /sk-abcdef/);
    assert.match(result.text, /\[REDACTED_SECRET\]/);
  });

  it("decodes a base64 content payload", async () => {
    const base64 = Buffer.from("decoded body text", "utf8").toString("base64");
    const result = await extractNeonDocument({ contentBase64: base64, mimeType: "text/plain" });
    assert.equal(result.state, "extracted");
    assert.equal(result.text, "decoded body text");
  });
});

describe("extractNeonDocument — binary provider seam (PDF/Docx)", () => {
  it("returns provider-not-configured for pdf when no provider is registered", async () => {
    const base64 = Buffer.from("%PDF-1.4 fake", "utf8").toString("base64");
    const result = await extractNeonDocument({ contentBase64: base64, mimeType: "application/pdf" });
    assert.equal(result.state, "provider-not-configured");
    assert.equal(result.format, "pdf");
    assert.equal(result.text, "");
  });

  it("uses a registered provider to extract pdf text", async () => {
    const provider: INeonDocExtractProvider = {
      format: "pdf",
      mimeTypes: ["application/pdf"],
      extract: (bytes) => `parsed ${bytes.byteLength} bytes: invoice total 42`
    };
    const base64 = Buffer.from("%PDF-1.4 ...", "utf8").toString("base64");
    const result = await extractNeonDocument({ contentBase64: base64, mimeType: "application/pdf" }, [provider]);
    assert.equal(result.state, "extracted");
    assert.match(result.text, /invoice total 42/);
    assert.match(renderNeonDocExtractReport(result), /extracted \(pdf\)/);
  });

  it("awaits an async provider", async () => {
    const provider: INeonDocExtractProvider = {
      format: "pdf",
      mimeTypes: ["application/pdf"],
      extract: async (bytes) => Promise.resolve(`async parsed ${bytes.byteLength} bytes`)
    };
    const result = await extractNeonDocument({ text: "x", mimeType: "application/pdf" }, [provider]);
    assert.equal(result.state, "extracted");
    assert.match(result.text, /async parsed/);
  });

  it("maps a throwing provider to extract-failed, never leaking the parser error", async () => {
    const provider: INeonDocExtractProvider = {
      format: "pdf",
      mimeTypes: ["application/pdf"],
      extract: () => {
        throw new Error("corrupt pdf internal detail");
      }
    };
    const result = await extractNeonDocument({ text: "x", mimeType: "application/pdf" }, [provider]);
    assert.equal(result.state, "extract-failed");
    assert.equal(result.text, "");
    assert.doesNotMatch(JSON.stringify(result), /corrupt pdf internal detail/);
  });

  it("falls back to provider-not-configured when the provider declines (returns null)", async () => {
    const provider: INeonDocExtractProvider = {
      format: "pdf",
      mimeTypes: ["application/pdf"],
      extract: () => null
    };
    const result = await extractNeonDocument({ text: "x", mimeType: "application/pdf" }, [provider]);
    assert.equal(result.state, "provider-not-configured");
  });
});
