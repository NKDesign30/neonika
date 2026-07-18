---
name: neon-pdf
description: "Gestaltete Business-PDFs mit Art Direction, WeasyPrint und verbindlicher visueller Freigabe."
version: "2.0.0"
category: workflow
complexity: high
auto-triggers:
  - "pdf erstellen"
  - "pdf gestalten"
  - "angebot als pdf"
  - "report als pdf"
  - "verkaufsunterlagen"
requires:
  bins:
    - node
    - weasyprint
    - qpdf
    - pdfinfo
    - pdffonts
    - pdftoppm
    - magick
---

# neon-pdf

Gemeinsame PDF-Lane für Chaty und Neo. Erzeugt gestaltete Business-PDFs aus HTML+CSS, hält Marken- und Art-Direction-Entscheidungen fest und veröffentlicht nur das exakt visuell geprüfte Artefakt.

## Wann nutzen

- Angebote, Verkaufsunterlagen, Broschüren, Reports, One-Pager, Preislisten und Datenblätter.
- Neue PDFs oder vollständige gestalterische Überarbeitungen bestehender Dokumente.
- Nicht für reine Tabellenexports, kleine Reparaturen in bestehenden PDFs oder Word-Layouts, die 1:1 erhalten bleiben müssen.

## Harte Verträge

- WeasyPrint ist der Produktionsrenderer. ReportLab bleibt der schnelle Weg für strukturierte interne PDFs.
- Bestehende PDFs nie destruktiv verändern. Inhalt und Struktur extrahieren, dann ein neues Dokument bauen.
- Vor HTML und CSS muss ein valider Design-Brief Version 2 nach `assets/design-brief.json` existieren.
- Kein finales PDF ohne `preview`, Prüfung jeder gerenderten Seite und anschließendem `publish`.
- Änderungen an HTML, Brief, PDF oder Seitenbildern machen ein vorhandenes Review ungültig.
- Keine Remote-Assets, erfundenen Daten, Placeholder, stillen Font-Fallbacks oder Secrets.
- Für gebrandete Dokumente muss `brand.source` im Design-Brief eine freigegebene lokale Markenquelle benennen.

## Skill-Root

`{baseDir}` bezeichnet immer das Verzeichnis der gerade geladenen Skill-Installation. Dadurch läuft derselbe Vertrag projektlokal, bei Chaty und bei Neo, ohne Home-Pfade in Befehle einzubauen.

Alle Befehle unten laufen über `{baseDir}/scripts/build.sh`.

## Workflow

### 1. Quelle und Entscheidung verstehen

- Quelle vollständig lesen und Fakten unverändert übernehmen.
- In einem Satz festhalten: Wer liest das Dokument und welche Entscheidung soll danach möglich sein?
- Seitenbudget, Output-Profil, Datenschutzstufe, CTA und Belegquellen festlegen.

### 2. Art Direction vor dem Code

Der Brief muss diese Entscheidungen enthalten:

- `concept`: ein dokumentbezogener visueller Leitgedanke.
- `visualTone`: zwei bis fünf präzise Eigenschaften.
- `palette`: vier bis sechs Farben mit Rolle und Hex-Wert.
- `typography`: zwei oder drei Rollen aus der Font-Allowlist, jeweils mit Zweck.
- `layout`: Raster, Rhythmus und Dichte.
- `signatureElement`: genau ein erinnerbares, aus dem Thema abgeleitetes Element.
- `pageArchetypes`: benötigte Seitentypen, etwa Opening, Evidence, Process, Comparison oder Decision.
- `avoidDefaults`: mindestens zwei Looks, die für dieses Dokument ausdrücklich nicht als Autopilot dienen.

Selbstkritik: Könnte dieselbe Gestaltung ohne nennenswerte Änderung für ein fachfremdes Dokument verwendet werden, ist sie zu generisch. Dann Konzept, Rhythmus oder Signature nachschärfen.

### 3. HTML+CSS bauen

- A4 und print-safe. Dunkles Cover ist erlaubt, Inhaltsseiten bleiben lesbar und sparsam mit Vollflächen.
- Farben und Typorollen aus dem Brief als CSS-Variablen und lokale `@font-face`-Quellen umsetzen.
- Informationshierarchie vor Dekoration. Nummern nur, wenn Reihenfolge Bedeutung hat. Karten nur, wenn sie echte Einheiten modellieren.
- Ein Signature-Element trägt die gestalterische Spannung; der Rest bleibt ruhig.
- Inhalte und Assets müssen lokal, freigegeben und reproduzierbar sein.

### 4. Preview erzeugen

```bash
{baseDir}/scripts/build.sh preview input.html design-brief.json output-root
```

Die Preview landet unveröffentlicht unter `output-root/.review/<slug>-<version>-<source-hash>/` und enthält:

- PDF
- jede Seite als PNG
- Contact Sheet
- technische QA
- `manifest.json` mit `state: pending-visual-review`
- `visual-review.json`, gebunden an die SHA-256-Werte der konkreten Artefakte

### 5. Jede Seite wirklich ansehen

Contact Sheet und anschließend jede Datei unter `pages/` mit dem verfügbaren Bildwerkzeug öffnen. Pro Seite prüfen:

- `bounds`: nichts abgeschnitten oder außerhalb des Satzspiegels
- `hierarchy`: Blickführung und Priorität verständlich
- `typography`: Rollen, Größen, Laufweiten und Zeilenlängen sauber
- `spacing`: Raster, Abstände, Witwen und Umbrüche stimmig
- `contrast`: Bildschirm und Druck lesbar
- `brand`: Brief und echte Markenquelle eingehalten
- `contentIntegrity`: keine fehlenden, erfundenen oder vertauschten Inhalte

Wenn etwas nicht sitzt: Quelle korrigieren und eine neue Preview erzeugen. Durch den Source-Hash bleibt die alte Review-Spur erhalten.

### 6. Review freigeben

Nur die erzeugte `visual-review.json` bearbeiten; Hashes, Dateinamen und Seitenzahlen bleiben unverändert.

- `reviewer`: `Chaty`, `Neo` oder der tatsächliche menschliche Reviewer
- `decision`: `approved`
- jede Seite: `verdict: pass`
- alle sieben Checks: `true`
- jede Seite: konkrete `observation`
- `revision.performed`: ob vor dieser Preview korrigiert wurde
- `revision.summary`: konkrete Korrektur oder ehrliche Begründung, warum keine nötig war

### 7. Exakt diese Preview veröffentlichen

```bash
{baseDir}/scripts/build.sh publish output-root/.review/<preview-dir>
```

`publish` validiert Review, Quellen und alle Artefakt-Hashes erneut. Nur dann wird die Preview atomar nach `output-root/<slug>-<version>/` verschoben und das Manifest auf `state: verified` gesetzt.

Für Neonika ist das Ziel `state/gateway/pdf-outbox/<slug>`. Der bestehende Gateway-/Canary-Sender übernimmt das Discord-Attachment; der Skill sendet nie direkt an Discord.

## Fehlerbehandlung

- Schlägt Brief-, Asset-, Font-, PDF- oder Review-Validierung fehl, bleibt die Preview unveröffentlicht.
- Bei einer korrigierten Quelle eine neue Preview verwenden; der Source-Hash trennt beide Revisionen ohne Datenverlust.
- Existiert das finale Versionsziel bereits, `documentVersion` bewusst erhöhen. Kein Überschreiben und kein stilles Ersetzen.
- Fehlt ein erforderliches Binary, den von `build.sh` genannten Befehl installieren oder den konkreten Gate-Namen melden. Kein Ersatz-PDF über einen ungeprüften Pfad.

## Abschluss

Melde nur die verifizierte PDF aus dem finalen Versionsordner. Nenne kurz:

- erfülltes Seitenbudget
- verwendete Markenquelle und Fonts
- ausgeführte technische Checks
- visuell geprüfte Seitenzahl
- konkrete Korrektur oder begründete Nullkorrektur

## Design-Referenz

Der verpflichtende Art-Direction-Pass übernimmt das allgemeine Prinzip einer getrennten Designphase aus Anthropics Apache-2.0-lizenziertem `canvas-design`-Skill, ist hier jedoch eigenständig für mehrseitige Business-Dokumente und die Neon-Quality-Lane formuliert:
https://github.com/anthropics/skills/tree/main/skills/canvas-design
