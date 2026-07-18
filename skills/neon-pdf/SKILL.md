---
name: neon-pdf
description: "Build or revise a PDF, write it under state/, and let the existing gateway attachment path deliver it to the channel."
---

# neon-pdf

Use this when a gateway run should produce a PDF and deliver it as a file rather
than as text.

## How delivery actually works

`gateway/localMediaAttachment.ts` scans the final reply text for local media
paths — backticked, absolute, or relative under `state/` — strips the path out
of the visible message, and attaches the file. `.pdf` is one of the recognised
extensions.

So this skill sends nothing. It writes a file and names the path. The attachment
happens because the reply mentions it, and only while the canary outbound gates
are open. Never call a channel API from a skill.

## Contract

- Render new PDFs from HTML and CSS with an external renderer (WeasyPrint).
- Never edit a PDF destructively. Extract its content, rebuild the HTML, render a
  new file.
- Write the result under `state/`, for example
  `state/gateway/pdf-outbox/<slug>/<name>.pdf`. Anything under `state/` is
  recognised; the subdirectory is a convention, not a requirement.
- Name the final path in the closing reply, in backticks.

## Workflow

1. Read the source: Markdown, text, HTML, or an existing document.
2. Build print-safe HTML and CSS. A4, readable at 100%. Dark covers are fine;
   body pages stay light enough to print.
3. Render:
   ```bash
   mkdir -p state/gateway/pdf-outbox/<slug>
   weasyprint input.html state/gateway/pdf-outbox/<slug>/<name>.pdf
   ```
4. Verify: `weasyprint --version`, `file <pdf>`, and a page count. Look at it if
   you can.
5. Close by saying what was produced, and give the exact path in backticks.

## Rules

- No invented prices, names, figures, or customer data.
- No secrets in the HTML, the PDF, the logs, or the reply.
- No full-bleed dark areas on content pages. They are unprintable.
- If WeasyPrint is not installed, say so and deliver nothing. A PDF that was
  never rendered is not a PDF, and a placeholder that looks like one is worse
  than an error.
