import { createRequire } from "node:module";

import type { INeonDocExtractProvider } from "./documentExtract.js";

// PDF text-extraction provider backed by `unpdf` (a dependency-light, ESM, no-native
// pdfjs build). It plugs into the `documentExtract` provider seam so PDF bytes get
// real text extraction. Read-only: it parses bytes already in hand, never fetches or
// executes anything. A corrupt PDF makes `extractText` throw, which the extractor
// maps to `extract-failed`.
//
// unpdf is loaded through `createRequire` instead of a static import on purpose: its
// shipped `.d.mts` declarations do not satisfy this project's strict NodeNext
// type-check (extensionless relative imports + an uninstalled optional
// `@napi-rs/canvas` peer). `createRequire` keeps the project-wide `skipLibCheck:
// false` invariant intact and types unpdf locally against the exact read-only surface
// used here. Node resolves the real module at runtime.
interface IUnpdfModule {
  getDocumentProxy(data: Uint8Array): Promise<unknown>;
  extractText(
    pdf: unknown,
    options?: { readonly mergePages?: boolean }
  ): Promise<{ readonly totalPages: number; readonly text: string | string[] }>;
}

const requireFromHere = createRequire(import.meta.url);
let cachedUnpdf: IUnpdfModule | undefined;

function loadUnpdf(): IUnpdfModule {
  cachedUnpdf ??= requireFromHere("unpdf") as IUnpdfModule;
  return cachedUnpdf;
}

export function createNeonPdfExtractProvider(): INeonDocExtractProvider {
  return {
    format: "pdf",
    mimeTypes: ["application/pdf"],
    extract: async (bytes: Buffer): Promise<string> => {
      const { getDocumentProxy, extractText } = loadUnpdf();
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join("\n") : text;
    }
  };
}
