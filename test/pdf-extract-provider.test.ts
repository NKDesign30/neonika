import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractNeonDocument } from "../src/tools/documentExtract.js";
import { createNeonPdfExtractProvider } from "../src/tools/pdfExtractProvider.js";

// A real, minimal PDF (ReportLab-generated) whose visible text is
// "Neon invoice" / "Total amount: 42 EUR". Embedded so the test is self-contained.
const SAMPLE_PDF_BASE64 =
  "JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDYwNDA5NTAyMiswMicwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDYwNDA5NTAyMiswMicwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMTM3Cj4+CnN0cmVhbQpHYXBRaDBFPUYsMFVcSDNUXHBOWVReUUtrP3RjPklQLDtXI1UxXjIzaWhQRU1fP0NXNEtJU2k5ME1qR14yLEZTIzxSQzUuYy1LPjBiVV5sXzlNWCw7I2cjc01kRERkNyhucyY6XkViTygrWWJwajFwPWhpXzhKbVwyKUdTMVFOQHMnYjkucjl+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDgKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDYxIDAwMDAwIG4gCjAwMDAwMDAwOTIgMDAwMDAgbiAKMDAwMDAwMDE5OSAwMDAwMCBuIAowMDAwMDAwNDAyIDAwMDAwIG4gCjAwMDAwMDA0NzAgMDAwMDAgbiAKMDAwMDAwMDczMSAwMDAwMCBuIAowMDAwMDAwNzkwIDAwMDAwIG4gCnRyYWlsZXIKPDwKL0lEIApbPDU4YmNkNDBjMGQwMzYxYmQwMDU0ZGQxYzVlYTgzYTk3Pjw1OGJjZDQwYzBkMDM2MWJkMDA1NGRkMWM1ZWE4M2E5Nz5dCiUgUmVwb3J0TGFiIGdlbmVyYXRlZCBQREYgZG9jdW1lbnQgLS0gZGlnZXN0IChvcGVuc291cmNlKQoKL0luZm8gNSAwIFIKL1Jvb3QgNCAwIFIKL1NpemUgOAo+PgpzdGFydHhyZWYKMTAxNwolJUVPRgo=";

describe("createNeonPdfExtractProvider (unpdf-backed)", () => {
  it("extracts real text from a real PDF through the documentExtract seam", async () => {
    const result = await extractNeonDocument(
      { contentBase64: SAMPLE_PDF_BASE64, mimeType: "application/pdf", fileName: "invoice.pdf" },
      [createNeonPdfExtractProvider()]
    );
    assert.equal(result.state, "extracted");
    assert.equal(result.format, "pdf");
    assert.match(result.text, /Neon invoice/);
    assert.match(result.text, /Total amount: 42 EUR/);
    assert.ok(result.characters > 0);
  });

  it("maps non-PDF bytes (not a valid PDF) to extract-failed without leaking parser internals", async () => {
    const garbage = Buffer.from("this is definitely not a pdf", "utf8").toString("base64");
    const result = await extractNeonDocument(
      { contentBase64: garbage, mimeType: "application/pdf" },
      [createNeonPdfExtractProvider()]
    );
    assert.equal(result.state, "extract-failed");
    assert.equal(result.text, "");
  });
});
