---
name: neon-grill-me
description: "Neon Plan-Grill: Einen Plan, ein Feature oder eine Architekturidee hart stress-testen, eine Frage nach der anderen, ohne Doku-Seiteneffekte."
---

<!-- Adapted from https://github.com/mattpocock/skills under the MIT License. See THIRD_PARTY_NOTICES.md in the Neonika distribution. -->

# Neon Grill Me

Nutzen, wenn der User einen Plan, ein Feature, eine Architekturidee oder eine
Produktentscheidung stress-testen will und keine Doku/ADR geschrieben werden
soll.

## Ablauf

1. Ziel des Plans in einem Satz spiegeln.
2. Die schwächste Annahme identifizieren.
3. Genau eine Frage stellen.
4. Direkt darunter die empfohlene Antwort geben.
5. Auf die Antwort des Users warten, dann den nächsten Ast nehmen.

## Regeln

- **Eine Frage pro Runde. Keine Fragebatterien.** Nicht aus Höflichkeit, sondern
  weil ein Mensch immer nur eine offene Entscheidung im Kopf halten kann. Ein
  Fragenblock zwingt den User zu flachen Antworten oder zu gar keinen.
- **Fakten selbst holen, Entscheidungen dem User überlassen.** Wenn die Antwort aus
  Code, Memory, Logs oder Docs ableitbar ist: nachschauen statt fragen. Was eine
  echte Entscheidung ist, gehört dem User — Frage stellen und auf die Antwort
  warten. **Nie selbst beantworten und weiterlaufen.** Ein Grill, der seine
  eigenen Fragen beantwortet, hat den Sinn der Session zerstört.
- Jede Frage muss eine echte Entscheidung freilegen: Scope, Nutzerfluss,
  Datenmodell, Runtime, Kosten, Sicherheit, Rollback, Ownership oder Verify.
- Immer eine klare Empfehlung geben. Kein neutraler Berater-Nebel.
- KISS zuerst: Wenn der Plan overengineered ist, kleiner schneiden. Die
  einfachste tragfähige Lösung gilt für Pläne, nicht nur für Code.
- Wenn der Plan unklar bleibt, in einen testbaren Slice übersetzen.
- Keine Dateien schreiben, keine ADRs erstellen, kein `CONTEXT.md` ändern.
  Dafür `/grill-with-docs` nutzen.

## Output-Form

```text
Plan in einem Satz:
...

Härtester Punkt:
...

Frage:
...

Meine Empfehlung:
...
```

## Stop

Nicht mit der Umsetzung anfangen, bevor der User bestätigt hat, dass wir ein
gemeinsames Verständnis haben. Der Grill endet mit seinem Okay, nicht mit meinem
Gefühl, genug gefragt zu haben.

Stoppen, wenn der Plan entweder:

- klein genug für einen testbaren Umsetzungsslice ist,
- als Nicht-Ziel verworfen wurde,
- oder eine externe Entscheidung des Users braucht.

## Verwandte Skills

- `/grilling` — der rohe Interview-Loop, den andere Skills aufrufen.
- `/grill-with-docs` — derselbe Loop plus `/domain-modeling`: schreibt `CONTEXT.md`
  und ADRs mit, sobald Entscheidungen fallen.
- `/wayfinder` — wenn das Vorhaben zu groß für eine Session ist. Dann nicht flach
  durchgrillen, sondern als Karte mit Tickets chartern.
