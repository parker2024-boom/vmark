# KI-Genies

KI-Genies sind Prompt-Vorlagen, die Ihren Text mithilfe von KI transformieren. Wählen Sie Text aus, rufen Sie einen Genie auf und überprüfen Sie die vorgeschlagenen Änderungen — alles ohne den Editor zu verlassen.

## Schnellstart

1. Konfigurieren Sie einen KI-Anbieter unter **Einstellungen > Integrationen** (siehe [KI-Anbieter](/de/guide/ai-providers))
2. Wählen Sie Text im Editor aus
3. Drücken Sie `Mod + Y`, um die Genie-Auswahl zu öffnen
4. Wählen Sie einen Genie oder geben Sie einen freien Prompt ein
5. Überprüfen Sie den Inline-Vorschlag — annehmen oder ablehnen

## Die Genie-Auswahl

Drücken Sie `Mod + Y` (oder Menü **Bearbeiten → Genies → Genies suchen…**), um ein Spotlight-ähnliches Overlay mit einer einzigen einheitlichen Eingabe zu öffnen. Dasselbe Untermenü listet jedes Genie mit Namen auf, sodass sich ein Genie auch direkt aus dem Menü ausführen lässt.

**Suche und freie Eingabe** — Beginnen Sie zu tippen, um Genies nach Name, Beschreibung oder Kategorie zu filtern. Wenn keine Genies übereinstimmen, wird die Eingabe zu einem freien Promptfeld.

**Schnellschaltflächen** — Wenn der Bereich „Auswahl“ ist und die Eingabe leer ist, werden Ein-Klick-Schaltflächen für häufige Aktionen angezeigt (Polieren, Kürzen, Grammatik, Umformulieren).

**Zweistufige freie Eingabe** — Wenn keine Genies übereinstimmen, drücken Sie einmal `Enter`, um einen Bestätigungshinweis zu sehen, dann erneut `Enter`, um als KI-Prompt zu senden. Dies verhindert versehentliche Übermittlungen.

**Bereichsauswahl** — Drücken Sie `Tab`, um zwischen Bereichen zu wechseln: Auswahl → Block → Dokument → Alles.

**Prompt-Verlauf** — Im freien Modus (keine übereinstimmenden Genies) drücken Sie `Pfeil oben` / `Pfeil unten`, um frühere Prompts zu durchblättern. Drücken Sie `Strg + R`, um ein durchsuchbares Verlaufs-Dropdown zu öffnen; dessen Schaltfläche **Verlauf löschen** leert den gespeicherten Verlauf (bis zu 100 Prompts) auf einmal, ohne nachzufragen. Ghost-Text zeigt den zuletzt übereinstimmenden Prompt als grauen Hinweis an — drücken Sie `Tab`, um ihn zu übernehmen, oder `Escape`, um ihn auszublenden (er kehrt zurück, sobald Sie Ihre Eingabe ändern).

### Verarbeitungsrückmeldung

Nach der Auswahl eines Genie oder dem Absenden eines freien Prompts zeigt die Auswahl Inline-Rückmeldungen:

- **Verarbeitung** — Ein Denk-Indikator mit Zeitzähler. Drücken Sie `Escape` zum Abbrechen.
- **Vorschau** — Die KI-Antwort erscheint, sobald sie eintrifft: CLI-Anbieter streamen sie während der Generierung, während REST-Anbieter die gesamte Antwort auf einmal liefern, wenn die Anfrage abgeschlossen ist. Verwenden Sie `Annehmen`, um anzuwenden, oder `Ablehnen`, um zu verwerfen.
- **Fehler** — Falls etwas schiefgeht, wird die Fehlermeldung mit einer Schaltfläche `Erneut versuchen` angezeigt.

Die Statusleiste zeigt ebenfalls den KI-Fortschritt an — ein drehendes Symbol mit Zeitzähler während der Ausführung, ein kurzes „Fertig“-Symbol bei Erfolg oder ein Fehlerindikator mit den Schaltflächen **Erneut versuchen** und **Schließen**. **Erneut versuchen** führt die fehlgeschlagene Anfrage erneut aus — dasselbe Genie oder denselben Prompt, auf die aktuelle Auswahl — auch nachdem die Auswahl geschlossen wurde; die Schaltfläche fehlt, wenn es nichts zu wiederholen gibt, etwa ohne Anbieter. Die Statusleiste wird automatisch eingeblendet, wenn die KI aktiv ist, selbst wenn Sie sie zuvor mit `F7` ausgeblendet haben.

## Integrierte Genies

VMark wird mit 13 Genies in vier Kategorien geliefert:

### Bearbeiten

| Genie | Beschreibung | Bereich |
|-------|-------------|---------|
| Polieren | Klarheit und Fluss verbessern | Auswahl |
| Kürzen | Text prägnanter machen | Auswahl |
| Grammatik korrigieren | Grammatik und Rechtschreibung korrigieren | Auswahl |
| Vereinfachen | Einfachere Sprache verwenden | Auswahl |

### Kreativ

| Genie | Beschreibung | Bereich |
|-------|-------------|---------|
| Erweitern | Idee zu vollständigem Text ausarbeiten | Auswahl |
| Umformulieren | Dasselbe anders ausdrücken | Auswahl |
| Lebendig | Sensorische Details und Bilder hinzufügen | Auswahl |
| Fortsetzen | Schreiben von hier aus fortsetzen | Block |

### Struktur

| Genie | Beschreibung | Bereich |
|-------|-------------|---------|
| Zusammenfassen | Dokument zusammenfassen | Dokument |
| Gliederung | Gliederung erstellen | Dokument |
| Überschrift | Titeloptionen vorschlagen | Dokument |

### Werkzeuge

| Genie | Beschreibung | Bereich |
|-------|-------------|---------|
| Übersetzen | Ins Englische übersetzen | Auswahl |
| Auf Englisch umschreiben | Text auf Englisch umschreiben | Auswahl |

## Bereich

Jeder Genie arbeitet mit einem von drei Bereichen:

- **Auswahl** — Der hervorgehobene Text. Wenn nichts ausgewählt ist, wird der aktuelle Block verwendet.
- **Block** — Der Absatz oder das Blockelement an der Cursorposition.
- **Dokument** — Der gesamte Dokumentinhalt.

Der Bereich bestimmt, welcher Text extrahiert und als `{{content}}` an die KI übergeben wird.

::: tip
Wenn der Bereich **Auswahl** ist, aber nichts ausgewählt ist, arbeitet der Genie am aktuellen Absatz.
:::

## Vorschläge überprüfen

Nachdem ein Genie ausgeführt wurde, erscheint der Vorschlag inline:

- **Ersetzen** — Originaltext mit roter, gewellter Durchstreichung, gefolgt vom neuen Text als verblasstem, kursivem „Geistertext“ in der Akzentfarbe
- **Einfügen** — Neuer Text als Geistertext nach dem Quellblock
- **Löschen** — Originaltext mit roter, gewellter Durchstreichung

Jeder Vorschlag hat Annehmen- (Häkchen) und Ablehnen- (X) Schaltflächen.

### Tastaturkürzel

| Aktion | Tastenkürzel |
|--------|-------------|
| Vorschlag annehmen | `Eingabe` |
| Vorschlag ablehnen | `Escape` |
| Nächster Vorschlag | `Tab` |
| Vorheriger Vorschlag | `Umschalt + Tab` |
| Alle annehmen | `Mod + Umschalt + Eingabe` |
| Alle ablehnen | `Mod + Umschalt + Escape` |

## Statusleisten-Anzeige

Während die KI generiert, zeigt die Statusleiste ein drehendes Funken-Symbol mit einem Zeitzähler („Denkt... 3s“). Eine Abbrechen-Schaltfläche (×) ermöglicht das Stoppen der Anfrage.

Nach Abschluss wird kurz ein „Fertig“-Häkchen für 3 Sekunden angezeigt. Bei einem Fehler zeigt die Statusleiste die Fehlermeldung mit den Schaltflächen „Erneut versuchen“ und „Schließen“.

Die Statusleiste wird automatisch eingeblendet, wenn die KI aktiv ist (läuft, Fehler oder Erfolg), auch wenn sie mit `F7` ausgeblendet wurde.

---

## Eigene Genies erstellen

Sie können Ihre eigenen Genies erstellen. Jeder Genie ist eine einzelne Markdown-Datei mit YAML-Frontmatter und einer Prompt-Vorlage.

### Wo Genies gespeichert werden

Genies werden im Anwendungsdatenverzeichnis gespeichert:

| Plattform | Pfad |
|-----------|------|
| macOS | `~/Library/Application Support/app.vmark/genies/` |
| Windows | `%APPDATA%\app.vmark\genies\` |
| Linux | `~/.local/share/app.vmark/genies/` |

Öffnen Sie diesen Ordner über das Menü **Bearbeiten → Genies → Genies-Ordner öffnen**; nach dem Hinzufügen oder Bearbeiten von Dateien aktualisiert **Bearbeiten → Genies → Genies neu laden** die Liste.

### Verzeichnisstruktur

Unterverzeichnisse werden zu **Kategorien** in der Auswahl, und der Scan ist rekursiv — verschachteln Sie Ordner so tief Sie möchten; die Kategorie eines Genies ist sein Ordnerpfad relativ zu `genies/` (`academic/thesis/abstract.md` landet also in `academic/thesis`), sofern das Frontmatter nicht `category` setzt. Symbolische Links werden übersprungen. Sie können Genies beliebig organisieren:

```text
genies/
├── editing/
│   ├── polish.md
│   ├── condense.md
│   └── fix-grammar.md
├── creative/
│   ├── expand.md
│   └── rephrase.md
├── academic/          ← your custom category
│   ├── cite.md
│   └── abstract.md
└── my-workflows/      ← another custom category
    └── blog-intro.md
```

### Dateiformat

Jede Genie-Datei hat zwei Teile: **Frontmatter** (Metadaten) und **Vorlage** (der Prompt).

```markdown
---
description: Improve clarity and flow
scope: selection
category: editing
---

You are an expert editor. Improve the clarity, flow, and conciseness
of the following text while preserving the author's voice and intent.

Return only the improved text — no explanations.

{{content}}
```

Der Dateiname `polish.md` wird in der Auswahl als Anzeigename „Polish“ verwendet.

### Frontmatter-Felder

| Feld | Erforderlich | Werte | Standard |
|------|-------------|-------|---------|
| `description` | Nein | Kurze Beschreibung in der Auswahl | Leer |
| `scope` | Nein | `selection`, `block`, `document` | `selection` |
| `category` | Nein | Kategoriename für Gruppierung | Unterverzeichnisname |
| `action` | Nein | `replace`, `insert` | `replace` |
| `context` | Nein | `1`, `2` | `0` (keiner) |
| `model` | Nein | Modell-Bezeichner, der den Anbieterstandard überschreibt | Anbieterstandard |

**Genie-Name** — Der Anzeigename wird immer aus dem **Dateinamen** (ohne `.md`) abgeleitet. Zum Beispiel erscheint `fix-grammar.md` als „Fix Grammar“ in der Auswahl. Benennen Sie die Datei um, um den Anzeigenamen zu ändern.

### Der `{{content}}`-Platzhalter

Der `{{content}}`-Platzhalter ist das Kernstück jedes Genie. Wenn ein Genie ausgeführt wird, führt VMark folgende Schritte durch:

1. **Text extrahieren** basierend auf dem Bereich (ausgewählter Text, aktueller Block oder gesamtes Dokument)
2. **Ersetzen** jedes `{{content}}` in Ihrer Vorlage durch den extrahierten Text
3. **Senden** des ausgefüllten Prompts an den aktiven KI-Anbieter
4. **Zurückgeben** der Antwort als Inline-Vorschlag — bei einem CLI-Anbieter während der Generierung gestreamt, bei einem REST-Anbieter in einem Stück

Mit dieser Vorlage zum Beispiel:

```markdown
Translate the following text into French.

{{content}}
```

Wenn der Benutzer „Hello, how are you?“ auswählt, erhält die KI:

```text
Translate the following text into French.

Hello, how are you?
```

Die KI antwortet mit „Bonjour, comment allez-vous ?“ und es erscheint als Inline-Vorschlag, der den ausgewählten Text ersetzt.

### Der `{{context}}`-Platzhalter

Der `{{context}}`-Platzhalter gibt der KI schreibgeschützten Umgebungstext — damit sie Ton, Stil und Struktur der benachbarten Blöcke nachahmen kann, ohne sie zu ändern.

**Funktionsweise:**

1. Setzen Sie `context: 1` oder `context: 2` im Frontmatter, um ±1 oder ±2 benachbarte Blöcke einzuschließen
2. Verwenden Sie `{{context}}` in Ihrer Vorlage, wo der Umgebungstext eingefügt werden soll
3. Die KI sieht den Kontext, aber der Vorschlag ersetzt nur `{{content}}`

**Zusammengesetzte Blöcke sind atomar** — wenn ein Nachbar eine Liste, Tabelle, Blockzitat oder Details-Block ist, zählt die gesamte Struktur als ein Block.

**Bereichseinschränkungen** — Kontext funktioniert nur mit den Bereichen `selection` und `block`. Beim `document`-Bereich ist der Inhalt bereits das gesamte Dokument.

**Freie Prompts** — Wenn Sie eine freie Anweisung in der Auswahl eingeben, bezieht VMark automatisch ±1 benachbarten Block als Kontext für den `selection`- und `block`-Bereich ein. Keine Konfiguration erforderlich.

**Rückwärtskompatibel** — Genies ohne `{{context}}` funktionieren genau wie zuvor. Wenn die Vorlage kein `{{context}}` enthält, wird kein Umgebungstext extrahiert.

**Beispiel — was die KI erhält:**

Mit `context: 1` und dem Cursor im zweiten Absatz eines Dokuments mit drei Absätzen:

```text
[Before]
First paragraph content here.

[After]
Third paragraph content here.
```

Die Abschnitte `[Before]` und `[After]` werden weggelassen, wenn es keine Nachbarn in dieser Richtung gibt (z.B. der Inhalt am Anfang oder Ende des Dokuments ist).

### Das `action`-Feld

Standardmäßig **ersetzen** Genies den Quelltext durch die KI-Ausgabe. Setzen Sie `action: insert`, um die Ausgabe **hinter** den Quellblock **anzufügen**.

Verwenden Sie `replace` für: Bearbeitung, Umformulierung, Übersetzung, Grammatikkorrekturen — alles, was den Originaltext transformiert.

Verwenden Sie `insert` für: Weiterschreiben, Zusammenfassungen unter Inhalten erstellen, Kommentare hinzufügen — alles, was neuen Text hinzufügt, ohne das Original zu entfernen.

**Beispiel — insert-Aktion:**

```markdown
---
description: Continue writing from here
scope: block
action: insert
---

Continue writing naturally from where the following text leaves off.
Match the author's voice, style, and tone. Write 2-3 paragraphs.

Do not repeat or summarize the existing text — just continue it.

{{content}}
```

### Das `model`-Feld

Überschreiben Sie das Standardmodell für einen bestimmten Genie. Nützlich, wenn Sie ein günstigeres Modell für einfache Aufgaben oder ein leistungsfähigeres für komplexe Aufgaben möchten.

```markdown
---
description: Quick grammar fix (uses fast model)
scope: selection
model: claude-haiku-4-5-20251001
---

Fix grammar and spelling errors. Return only the corrected text.

{{content}}
```

Der Modell-Bezeichner muss mit dem übereinstimmen, was Ihr aktiver Anbieter akzeptiert.

## Effektive Prompts schreiben

### Ausgabeformat genau angeben

Sagen Sie der KI genau, was sie zurückgeben soll. Ohne dies neigen Modelle dazu, Erklärungen, Überschriften oder Kommentare hinzuzufügen.

```markdown
<!-- Good -->
Return only the improved text — no explanations.

<!-- Bad — AI may wrap output in quotes, add "Here's the improved version:", etc. -->
Improve this text.
```

### Eine Rolle festlegen

Geben Sie der KI eine Persona, um ihr Verhalten zu verankern.

```markdown
<!-- Good -->
You are an expert technical editor who specializes in API documentation.

<!-- Okay but less focused -->
Edit the following text.
```

### Den Bereich einschränken

Sagen Sie der KI, was sie NICHT ändern soll. Dies verhindert übermäßiges Bearbeiten.

```markdown
<!-- Good -->
Fix grammar and spelling errors only.
Do not change the meaning, style, or tone.
Do not restructure sentences.

<!-- Bad — gives the AI too much freedom -->
Fix this text.
```

### Markdown in Prompts verwenden

Sie können Markdown-Formatierung in Ihren Prompt-Vorlagen verwenden. Dies ist hilfreich, wenn die KI strukturierte Ausgaben erzeugen soll.

```markdown
---
description: Generate a pros/cons analysis
scope: selection
action: insert
---

Analyze the following text and produce a brief pros/cons list.

Format as:

**Pros:**
- point 1
- point 2

**Cons:**
- point 1
- point 2

{{content}}
```

### Prompts fokussiert halten

Ein Genie, eine Aufgabe. Kombinieren Sie keine mehreren Aufgaben in einem einzigen Genie — erstellen Sie stattdessen separate Genies.

```markdown
<!-- Good — one clear job -->
---
description: Convert to active voice
scope: selection
---

Rewrite the following text using active voice.
Do not change the meaning.
Return only the rewritten text.

{{content}}
```

## Beispiele für eigene Genies

### Akademisch — Abstract schreiben

```markdown
---
description: Generate an academic abstract
scope: document
action: insert
---

Read the following paper and write a concise academic abstract
(150-250 words). Follow standard structure: background, methods,
results, conclusion.

{{content}}
```

### Blog — Hook erstellen

```markdown
---
description: Write an engaging opening paragraph
scope: document
action: insert
---

Read the following draft and write a compelling opening paragraph
that hooks the reader. Use a question, surprising fact, or vivid
scene. Keep it under 3 sentences.

{{content}}
```

### Code — Code-Block erklären

```markdown
---
description: Add a plain-English explanation above code
scope: selection
action: insert
---

Read the following code and write a brief plain-English explanation
of what it does. Use 1-2 sentences. Do not include the code itself
in your response.

{{content}}
```

### E-Mail — Professionell gestalten

```markdown
---
description: Rewrite in professional tone
scope: selection
---

Rewrite the following text in a professional, business-appropriate tone.
Keep the same meaning and key points. Remove casual language,
slang, and filler words.

Return only the rewritten text — no explanations.

{{content}}
```

### Übersetzung — Ins vereinfachte Chinesisch

```markdown
---
description: Translate to Simplified Chinese
scope: selection
---

Translate the following text into Simplified Chinese.
Preserve the original meaning, tone, and formatting.
Use natural, idiomatic Chinese — not word-for-word translation.

Return only the translated text — no explanations.

{{content}}
```

### Kontextbewusst — Zur Umgebung passen

```markdown
---
description: Rewrite to match surrounding tone and style
scope: selection
context: 1
---

Rewrite the following content to fit naturally with its surrounding context.
Match the tone, style, and level of detail.

Return only the rewritten text — no explanations.

## Surrounding context (do not include in output):
{{context}}

## Content to rewrite:
{{content}}
```

### Überprüfung — Faktencheck

```markdown
---
description: Flag claims that need verification
scope: selection
action: insert
---

Read the following text and list any factual claims that should be
verified. For each claim, note why it might need checking (e.g.,
specific numbers, dates, statistics, or strong assertions).

Format as a bullet list. If everything looks solid, say
"No claims flagged for verification."

{{content}}
```

## KI-Vorschläge

Wenn ein Genie Text zurückgibt, der als Ersatz für die Auswahl gedacht ist (statt einer freien Chat-Antwort), zeigt VMark ihn als **Vorschlag** mit einem Inline-Diff an: rote, gewellte Durchstreichung für den Originaltext, verblasster, kursiver Geistertext in der Akzentfarbe für den vorgeschlagenen Text. Sie prüfen und bestätigen, bevor irgendeine Änderung dauerhaft wird.

| Aktion | Kürzel |
|---|---|
| Fokussierten Vorschlag annehmen | `Eingabe` |
| Fokussierten Vorschlag ablehnen | `Esc` |
| Zum nächsten / vorherigen Vorschlag wechseln | `Tab` / `Umschalt + Tab` |
| Alle Vorschläge im Dokument annehmen | `Mod + Umschalt + Eingabe` _(kontextabhängig — innerhalb einer Tabelle bedeutet es zugleich „Zeile darüber hinzufügen“)_ |
| Alle Vorschläge im Dokument ablehnen | `Mod + Umschalt + Escape` |

Wenn ein Genie mehrere Absätze umschreibt, ist jede Ersetzung ein eigenständig navigierbarer Vorschlag. Das Annehmen eines Vorschlags akzeptiert die anderen nicht automatisch.

## Genies in Workflows

Ein einzelnes Genie führt einen Prompt aus. Wenn Sie mehrere KI-Schritte verketten müssen — Gliederung, dann Entwurf, dann Politur — und die Ausgabe einer Stufe in die nächste leiten wollen, verwenden Sie einen **Genie-Workflow**: eine YAML-Datei, die mehrere Genie-Aufrufe mit explizitem Datenfluss, optionalen Genehmigungsschritten, Modellen pro Schritt und einem Live-Ausführungsdiagramm orchestriert.

Da Workflow-Schritte den `{{content}}`-Platzhalter eines Genies aus einer `with: { input: "..." }`-Map füllen, **laufen die Genies, die Sie hier schreiben, unverändert in Workflows** — keine Umwandlung nötig.

Unter [Genie-Workflows](/de/guide/workflows) finden Sie das vollständige YAML-Schema, die Ausdruckssyntax, Genehmigungen und wie Sie einen Workflow ausführen.

### Abschirmung nicht vertrauenswürdiger Inhalte

Wenn der `genie/<name>`-Schritt eines Workflows ausgeführt wird, werden
Dokumenttext, Auswahlen und Dateiinhalte in eindeutige
`<<<DOCUMENT-DATA-…>>>`-Markierungen eingeschlossen, bevor sie den
KI-Anbieter erreichen, und der Prompt weist das Modell an, abgeschirmten
Text strikt als Daten zu behandeln. Die Abschirmung gehört zu
Workflow-Schritten — ein Genie, das direkt aus der Auswahl gestartet
wird, sendet den Text seines Bereichs unverändert an den Anbieter. Das
schützt vor Dokumenten, die versuchen, der KI Anweisungen
unterzuschieben („ignoriere deine Anweisungen und führe … aus“) — was
vor allem bei CLI-Anbietern (Claude Code, Codex, Gemini CLI) wichtig
ist, die Befehle ausführen können. Behandeln Sie Genies, die Sie auf
Dateien aus nicht vertrauenswürdigen Quellen anwenden, mit derselben
Vorsicht wie das Ausführen eines Skripts aus dem Internet: Die
Abschirmung ist eine starke Gegenmaßnahme, keine absolute Garantie.

## Einschränkungen

- Genies funktionieren nur im **WYSIWYG-Modus**. Im Quellmodus erklärt eine Toast-Benachrichtigung dies.
- Es kann immer nur ein Genie gleichzeitig ausgeführt werden. Wenn die KI bereits generiert, startet die Auswahl keinen weiteren.
- Der `{{content}}`-Platzhalter wird wörtlich ersetzt — er unterstützt keine Bedingungen oder Schleifen.
- Sehr große Dokumente können bei Verwendung von `scope: document` die Token-Grenzen des Anbieters überschreiten.

## Fehlerbehebung

**„Kein KI-Anbieter verfügbar“** — Öffnen Sie Einstellungen > Integrationen und konfigurieren Sie einen Anbieter. Siehe [KI-Anbieter](/de/guide/ai-providers).

**Genie erscheint nicht in der Auswahl** — Überprüfen Sie, ob die Datei eine `.md`-Erweiterung (oder `.yml`/`.yaml` für ein [Workflow-Genie](/de/guide/workflow-genies)) und gültiges Frontmatter mit `---`-Begrenzern hat. Unterordner werden bis zu acht Ebenen tief durchsucht (insgesamt höchstens 10.000 Einträge), symbolische Links werden übersprungen. Führen Sie nach dem Hinzufügen von Dateien **Bearbeiten → Genies → Genies neu laden** aus.

**KI gibt Unsinn oder Fehler zurück** — Überprüfen Sie, ob Ihr API-Schlüssel korrekt ist und der Modellname für Ihren Anbieter gültig ist. Überprüfen Sie das Terminal/die Konsole auf Fehlerdetails.

**Vorschlag entspricht nicht den Erwartungen** — Verfeinern Sie Ihren Prompt. Fügen Sie Einschränkungen hinzu („nur den Text zurückgeben“, „nicht erklären“), legen Sie eine Rolle fest oder schränken Sie den Bereich ein.

## Siehe auch

- [KI-Anbieter](/de/guide/ai-providers) — CLI- oder REST-API-Anbieter konfigurieren
- [Tastaturkürzel](/de/guide/shortcuts) — Vollständige Tastaturkürzel-Referenz
- [MCP-Werkzeuge](/de/guide/mcp-tools) — Externe KI-Integration über MCP
