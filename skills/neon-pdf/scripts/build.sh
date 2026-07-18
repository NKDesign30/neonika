#!/usr/bin/env bash
# Usage:
#   build.sh preview <input.html> <design-brief.json> [output-root]
#   build.sh publish <preview-dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
if [[ "$MODE" == "publish" ]]; then
  for command in node qpdf; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "neon-pdf build: required command is missing: $command" >&2
      exit 2
    fi
  done
  PREVIEW_DIR="${2:?Preview-Verzeichnis angeben}"
  if [[ ! -d "$PREVIEW_DIR" ]]; then
    echo "neon-pdf build: preview directory is missing: $PREVIEW_DIR" >&2
    exit 2
  fi
  PREVIEW_DIR="$(cd "$PREVIEW_DIR" && pwd)"
  REVIEW_PARENT="$(dirname "$PREVIEW_DIR")"
  if [[ "$(basename "$REVIEW_PARENT")" != ".review" ]]; then
    echo "neon-pdf build: preview directory must be inside an output .review directory" >&2
    exit 2
  fi
  OUTPUT_ROOT="$(dirname "$REVIEW_PARENT")"
  SOURCE_BRIEF="$PREVIEW_DIR/design-brief.json"
  SOURCE_HTML="$PREVIEW_DIR/source.html"
  REVIEW="$PREVIEW_DIR/visual-review.json"
  PAGES_DIR="$PREVIEW_DIR/pages"
  CONTACT_SHEET="$PREVIEW_DIR/contact-sheet.png"
  MANIFEST="$PREVIEW_DIR/manifest.json"
  QA_DIR="$PREVIEW_DIR/qa"
  for path in "$SOURCE_BRIEF" "$SOURCE_HTML" "$REVIEW" "$CONTACT_SHEET" "$MANIFEST" "$QA_DIR/pdfinfo.txt" "$QA_DIR/pdffonts.txt"; do
    if [[ ! -f "$path" ]]; then
      echo "neon-pdf build: preview artifact is missing: $path" >&2
      exit 2
    fi
  done
  META="$(node "$SCRIPT_DIR/validate-design-brief.mjs" "$SOURCE_BRIEF" meta)"
  IFS=$'\t' read -r SLUG DOCUMENT_VERSION OUTPUT_PROFILE MIN_PAGES MAX_PAGES FONT_ALLOWLIST <<<"$META"
  if [[ "$(basename "$PREVIEW_DIR")" != "$SLUG-$DOCUMENT_VERSION-"* ]]; then
    echo "neon-pdf build: preview directory does not match brief identity" >&2
    exit 2
  fi
  PDF_PATH="$PREVIEW_DIR/$SLUG-$DOCUMENT_VERSION.pdf"
  if [[ ! -f "$PDF_PATH" ]]; then
    echo "neon-pdf build: preview PDF is missing: $PDF_PATH" >&2
    exit 2
  fi
  TARGET_DIR="$OUTPUT_ROOT/$SLUG-$DOCUMENT_VERSION"
  if [[ -e "$TARGET_DIR" ]]; then
    echo "neon-pdf build: final target already exists: $TARGET_DIR" >&2
    exit 2
  fi
  node "$SCRIPT_DIR/visual-review.mjs" validate "$SOURCE_BRIEF" "$SOURCE_HTML" "$PDF_PATH" "$PAGES_DIR" "$REVIEW"
  qpdf --check "$PDF_PATH" >/dev/null 2>&1
  node "$SCRIPT_DIR/write-manifest.mjs" \
    "$SOURCE_BRIEF" \
    "$SOURCE_HTML" \
    "$PDF_PATH" \
    "$QA_DIR/pdfinfo.txt" \
    "$QA_DIR/pdffonts.txt" \
    "$PAGES_DIR" \
    "$CONTACT_SHEET" \
    "$MANIFEST" \
    publish \
    "$REVIEW"
  chmod -R go-rwx "$PREVIEW_DIR"
  mv "$PREVIEW_DIR" "$TARGET_DIR"
  echo "neon-pdf build: verified and published"
  echo "PDF: $TARGET_DIR/$SLUG-$DOCUMENT_VERSION.pdf"
  echo "Manifest: $TARGET_DIR/manifest.json"
  exit 0
fi
if [[ "$MODE" != "preview" ]]; then
  echo "neon-pdf build: mode must be preview or publish" >&2
  exit 2
fi

INPUT_HTML="${2:?HTML-Datei angeben}"
DESIGN_BRIEF="${3:?Design-Brief angeben}"
OUTPUT_ROOT="${4:-$(dirname "$INPUT_HTML")/dist}"

for command in node weasyprint qpdf pdfinfo pdffonts pdftoppm magick; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "neon-pdf build: required command is missing: $command" >&2
    exit 2
  fi
done

node "$SCRIPT_DIR/validate-design-brief.mjs" "$DESIGN_BRIEF"
node "$SCRIPT_DIR/validate-html.mjs" "$INPUT_HTML"

META="$(node "$SCRIPT_DIR/validate-design-brief.mjs" "$DESIGN_BRIEF" meta)"
IFS=$'\t' read -r SLUG DOCUMENT_VERSION OUTPUT_PROFILE MIN_PAGES MAX_PAGES FONT_ALLOWLIST <<<"$META"
if [[ -z "$SLUG" || -z "$DOCUMENT_VERSION" || -z "$OUTPUT_PROFILE" || -z "$FONT_ALLOWLIST" ]]; then
  echo "neon-pdf build: validated brief metadata is incomplete" >&2
  exit 2
fi

REVIEW_ROOT="$OUTPUT_ROOT/.review"
SOURCE_ID="$(node --input-type=module -e '
  import { createHash } from "node:crypto";
  import { readFileSync } from "node:fs";
  const hash = createHash("sha256");
  for (const path of process.argv.slice(1)) {
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  process.stdout.write(hash.digest("hex").slice(0, 12));
' "$INPUT_HTML" "$DESIGN_BRIEF")"
TARGET_DIR="$REVIEW_ROOT/$SLUG-$DOCUMENT_VERSION-$SOURCE_ID"
if [[ -e "$TARGET_DIR" ]]; then
  echo "neon-pdf build: preview already exists: $TARGET_DIR" >&2
  exit 2
fi

mkdir -p "$REVIEW_ROOT"
BUILD_DIR="$(mktemp -d "$REVIEW_ROOT/.${SLUG}-${DOCUMENT_VERSION}.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

PDF_PATH="$BUILD_DIR/$SLUG-$DOCUMENT_VERSION.pdf"
PAGES_DIR="$BUILD_DIR/pages"
QA_DIR="$BUILD_DIR/qa"
CONTACT_SHEET="$BUILD_DIR/contact-sheet.png"
MANIFEST="$BUILD_DIR/manifest.json"
REVIEW="$BUILD_DIR/visual-review.json"
SOURCE_HTML="$BUILD_DIR/source.html"
SOURCE_BRIEF="$BUILD_DIR/design-brief.json"
mkdir -p "$PAGES_DIR" "$QA_DIR"

WEASY_OPTIONS=(--allowed-protocols file,data --fail-on-http-errors --pdf-tags)
if [[ "$OUTPUT_PROFILE" == "screen-accessible" ]]; then
  WEASY_OPTIONS+=(--pdf-variant pdf/ua-1 --optimize-images --dpi 150)
elif [[ "$OUTPUT_PROFILE" == "office-print" ]]; then
  WEASY_OPTIONS+=(--pdf-variant pdf/a-3u --full-fonts --hinting --output-intent srgb)
else
  echo "neon-pdf build: unsupported output profile: $OUTPUT_PROFILE" >&2
  exit 2
fi

weasyprint "${WEASY_OPTIONS[@]}" "$INPUT_HTML" "$PDF_PATH"
qpdf --check "$PDF_PATH" >"$QA_DIR/qpdf.txt" 2>&1
pdfinfo "$PDF_PATH" >"$QA_DIR/pdfinfo.txt"
pdffonts "$PDF_PATH" >"$QA_DIR/pdffonts.txt"
pdftoppm -png -r 144 "$PDF_PATH" "$PAGES_DIR/page" >/dev/null 2>&1

PAGE_IMAGES=()
while IFS= read -r image; do
  PAGE_IMAGES+=("$image")
done < <(
  node --input-type=module -e '
    import { readdirSync } from "node:fs";
    import { join } from "node:path";
    const directory = process.argv[1];
    for (const name of readdirSync(directory).filter((value) => /^page-\d+\.png$/u.test(value)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
      process.stdout.write(`${join(directory, name)}\n`);
    }
  ' "$PAGES_DIR"
)
if [[ "${#PAGE_IMAGES[@]}" -eq 0 ]]; then
  echo "neon-pdf build: page rastering produced no images" >&2
  exit 2
fi
magick "${PAGE_IMAGES[@]}" -thumbnail '600x>' -background '#E9ECEA' -gravity center -append "$CONTACT_SHEET"

cp "$INPUT_HTML" "$SOURCE_HTML"
cp "$DESIGN_BRIEF" "$SOURCE_BRIEF"
node "$SCRIPT_DIR/visual-review.mjs" init "$SOURCE_BRIEF" "$SOURCE_HTML" "$PDF_PATH" "$PAGES_DIR" "$REVIEW"

node "$SCRIPT_DIR/write-manifest.mjs" \
  "$SOURCE_BRIEF" \
  "$SOURCE_HTML" \
  "$PDF_PATH" \
  "$QA_DIR/pdfinfo.txt" \
  "$QA_DIR/pdffonts.txt" \
  "$PAGES_DIR" \
  "$CONTACT_SHEET" \
  "$MANIFEST" \
  preview \
  "$REVIEW"

chmod -R go-rwx "$BUILD_DIR"
mv "$BUILD_DIR" "$TARGET_DIR"
trap - EXIT

echo "neon-pdf build: pending visual review"
echo "PDF: $TARGET_DIR/$SLUG-$DOCUMENT_VERSION.pdf"
echo "Contact sheet: $TARGET_DIR/contact-sheet.png"
echo "Manifest: $TARGET_DIR/manifest.json"
echo "Pages: $TARGET_DIR/pages"
echo "Review: $TARGET_DIR/visual-review.json"
