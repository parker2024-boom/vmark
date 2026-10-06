# Genies IA

I Genies IA sono modelli di prompt che trasformano il tuo testo usando l'IA. Seleziona del testo, invoca un genie e revisiona le modifiche suggerite — tutto senza lasciare l'editor.

## Avvio Rapido

1. Configura un provider IA in **Impostazioni > Integrazioni** (vedi [Provider IA](/it/guide/ai-providers))
2. Seleziona del testo nell'editor
3. Premi `Mod + Y` per aprire il selettore genie
4. Scegli un genie o digita un prompt libero
5. Revisiona il suggerimento inline — accetta o rifiuta

## Il Selettore Genie

Premi `Mod + Y` (o menu **Modifica → Geni → Cerca geni…**) per aprire un overlay in stile Spotlight con un singolo input unificato. Lo stesso sottomenu elenca ogni genie per nome, quindi un genie può anche essere eseguito direttamente dal menu.

**Ricerca e prompt libero** — Inizia a digitare per filtrare i genies per nome, descrizione o categoria. Se nessun genie corrisponde, l'input diventa un campo per prompt libero.

**Chip Rapidi** — Quando l'ambito è "selezione" e l'input è vuoto, appaiono pulsanti con un clic per azioni comuni (Rifinisci, Condensa, Grammatica, Riformula).

**Prompt libero in due passaggi** — Quando nessun genie corrisponde, premi `Enter` una volta per vedere un suggerimento di conferma, poi `Enter` di nuovo per inviare come prompt IA. Questo previene invii accidentali.

**Ciclo ambito** — Premi `Tab` per ciclare tra gli ambiti: selezione → blocco → documento → tutto.

**Cronologia prompt** — In modalità prompt libero (nessun genie corrispondente), premi `ArrowUp` / `ArrowDown` per ciclare tra i prompt precedenti. Premi `Ctrl + R` per aprire un menu a discesa con cronologia ricercabile; il suo pulsante **Cancella cronologia** svuota in un colpo solo la cronologia salvata (fino a 100 prompt), senza chiedere conferma. Il testo fantasma mostra il prompt corrispondente più recente come suggerimento grigio — premi `Tab` per accettarlo, oppure `Escape` per ignorarlo (ricompare quando modifichi ciò che hai digitato).

### Feedback di Elaborazione

Dopo aver selezionato un genie o inviato un prompt libero, il selettore mostra un feedback inline:

- **In elaborazione** — Un indicatore di pensiero con contatore del tempo trascorso. Premi `Escape` per annullare.
- **Anteprima** — La risposta IA compare man mano che arriva: i provider CLI la trasmettono in streaming mentre viene generata, mentre i provider REST consegnano l'intera risposta in una volta quando la richiesta è completata. Usa `Accetta` per applicare o `Rifiuta` per scartare.
- **Errore** — Se qualcosa va storto, appare il messaggio di errore con un pulsante `Riprova`.

La barra di stato mostra anche i progressi dell'IA — un'icona girevole con il tempo trascorso durante l'esecuzione, un breve flash "Completato" al completamento, o un indicatore di errore con i pulsanti **Riprova** e **Ignora**. **Riprova** esegue di nuovo la richiesta fallita — lo stesso genie o lo stesso prompt, sulla selezione corrente — anche dopo la chiusura del selettore; non compare quando non c'è nulla da ripetere, per esempio senza provider. La barra di stato si mostra automaticamente quando l'IA è attiva, anche se in precedenza l'hai nascosta con `F7`.

## Genies Integrati

VMark viene fornito con 13 genies in quattro categorie:

### Modifica

| Genie | Descrizione | Ambito |
|-------|-------------|--------|
| Polish | Migliora chiarezza e fluidità | Selezione |
| Condense | Rendi il testo più conciso | Selezione |
| Fix Grammar | Correggi grammatica e ortografia | Selezione |
| Simplify | Usa un linguaggio più semplice | Selezione |

### Creativo

| Genie | Descrizione | Ambito |
|-------|-------------|--------|
| Expand | Sviluppa l'idea in una prosa più completa | Selezione |
| Rephrase | Di' la stessa cosa in modo diverso | Selezione |
| Vivid | Aggiungi dettagli sensoriali e immagini | Selezione |
| Continue | Continua a scrivere da qui | Blocco |

### Struttura

| Genie | Descrizione | Ambito |
|-------|-------------|--------|
| Summarize | Riassumi il documento | Documento |
| Outline | Genera una scaletta | Documento |
| Headline | Suggerisci opzioni di titolo | Documento |

### Strumenti

| Genie | Descrizione | Ambito |
|-------|-------------|--------|
| Translate | Traduci in inglese | Selezione |
| Rewrite in English | Riscrivi il testo in inglese | Selezione |

## Ambito

Ogni genie opera su uno dei tre ambiti:

- **Selezione** — Il testo evidenziato. Se non è selezionato nulla, ricade sul blocco corrente.
- **Blocco** — Il paragrafo o l'elemento blocco alla posizione del cursore.
- **Documento** — L'intero contenuto del documento.

L'ambito determina quale testo viene estratto e passato all'IA come `{{content}}`.

::: tip
Se l'ambito è **Selezione** ma non è selezionato nulla, il genie opera sul paragrafo corrente.
:::

## Revisione dei Suggerimenti

Dopo che un genie viene eseguito, il suggerimento appare inline:

- **Sostituisci** — Testo originale con barratura ondulata rossa, seguito dal nuovo testo come testo "fantasma" in corsivo sbiadito nel colore d'accento
- **Inserisci** — Nuovo testo mostrato come testo fantasma dopo il blocco sorgente
- **Elimina** — Testo originale con barratura ondulata rossa

Ogni suggerimento ha pulsanti accetta (segno di spunta) e rifiuta (X).

### Scorciatoie da Tastiera

| Azione | Scorciatoia |
|--------|-------------|
| Accetta suggerimento | `Enter` |
| Rifiuta suggerimento | `Escape` |
| Suggerimento successivo | `Tab` |
| Suggerimento precedente | `Shift + Tab` |
| Accetta tutti | `Mod + Shift + Enter` |
| Rifiuta tutti | `Mod + Shift + Escape` |

## Indicatore della Barra di Stato

Mentre l'IA genera, la barra di stato mostra un'icona scintillante girevole con un contatore del tempo trascorso ("Elaborazione... 3s"). Un pulsante di annullamento (×) ti permette di interrompere la richiesta.

Al completamento, un breve segno di spunta "Completato" lampeggia per 3 secondi. Se si verifica un errore, la barra di stato mostra il messaggio di errore con i pulsanti Riprova e Ignora.

La barra di stato si mostra automaticamente quando l'IA è attiva (in esecuzione, errore o completamento), anche se l'hai nascosta con `F7`.

---

## Scrittura di Genies Personalizzati

Puoi creare i tuoi genies. Ogni genie è un singolo file Markdown con frontmatter YAML e un modello di prompt.

### Dove Vivono i Genies

I genies sono memorizzati nella directory dei dati dell'applicazione:

| Piattaforma | Percorso |
|-------------|----------|
| macOS | `~/Library/Application Support/app.vmark/genies/` |
| Windows | `%APPDATA%\app.vmark\genies\` |
| Linux | `~/.local/share/app.vmark/genies/` |

Apri questa cartella dal menu **Modifica → Geni → Apri cartella geni**; dopo aver aggiunto o modificato dei file, **Modifica → Geni → Ricarica geni** aggiorna l'elenco.

### Struttura delle Directory

Le sottodirectory diventano **categorie** nel selettore, e la scansione è ricorsiva — annida le cartelle a qualsiasi profondità; la categoria di un genie è il percorso della sua cartella relativo a `genies/` (quindi `academic/thesis/abstract.md` finisce in `academic/thesis`), a meno che il frontmatter non imposti `category`. I collegamenti simbolici vengono ignorati. Puoi organizzare i genies come preferisci:

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

### Formato del File

Ogni file genie ha due parti: **frontmatter** (metadati) e **template** (il prompt).

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

Il nome file `polish.md` diventa il nome visualizzato "Polish" nel selettore.

### Campi del Frontmatter

| Campo | Obbligatorio | Valori | Predefinito |
|-------|--------------|--------|-------------|
| `description` | No | Breve descrizione mostrata nel selettore | Vuoto |
| `scope` | No | `selection`, `block`, `document` | `selection` |
| `category` | No | Nome della categoria per il raggruppamento | Nome della sottodirectory |
| `action` | No | `replace`, `insert` | `replace` |
| `context` | No | `1`, `2` | `0` (nessuno) |
| `model` | No | Identificatore del modello per sovrascrivere il predefinito del provider | Predefinito del provider |

**Nome del genie** — Il nome visualizzato è sempre derivato dal **nome file** (senza `.md`). Per esempio, `fix-grammar.md` appare come "Fix Grammar" nel selettore. Rinomina il file per cambiare il nome visualizzato.

### Il Segnaposto `{{content}}`

Il segnaposto `{{content}}` è il nucleo di ogni genie. Quando un genie viene eseguito, VMark:

1. **Estrae il testo** in base all'ambito (testo selezionato, blocco corrente o intero documento)
2. **Sostituisce** ogni `{{content}}` nel tuo template con il testo estratto
3. **Invia** il prompt compilato al provider IA attivo
4. **Restituisce** la risposta come suggerimento inline — in streaming man mano che viene generata da un provider CLI, in un unico blocco da un provider REST

Per esempio, con questo template:

```markdown
Translate the following text into French.

{{content}}
```

Se l'utente seleziona "Hello, how are you?", l'IA riceve:

```text
Translate the following text into French.

Hello, how are you?
```

L'IA risponde con "Bonjour, comment allez-vous ?" e appare come suggerimento inline che sostituisce il testo selezionato.

### Il Segnaposto `{{context}}`

Il segnaposto `{{context}}` fornisce all'IA il testo circostante in sola lettura — così può abbinare tono, stile e struttura dei blocchi vicini senza modificarli.

**Come funziona:**

1. Imposta `context: 1` o `context: 2` nel frontmatter per includere ±1 o ±2 blocchi vicini
2. Usa `{{context}}` nel tuo template dove vuoi iniettare il testo circostante
3. L'IA vede il contesto ma il suggerimento sostituisce solo `{{content}}`

**I blocchi composti sono atomici** — se un vicino è un elenco, una tabella, una citazione o un blocco dettagli, l'intera struttura conta come un blocco.

**Restrizioni dell'ambito** — Il contesto funziona solo con l'ambito `selection` e `block`. Per l'ambito `document`, il contenuto è già l'intero documento.

**Prompt liberi** — Quando digiti un'istruzione libera nel selettore, VMark include automaticamente ±1 blocco circostante come contesto per gli ambiti `selection` e `block`. Nessuna configurazione necessaria.

**Retrocompatibile** — I genies senza `{{context}}` funzionano esattamente come prima. Se il template non contiene `{{context}}`, non viene estratto nessun testo circostante.

**Esempio — cosa riceve l'IA:**

Con `context: 1` e il cursore sul secondo paragrafo di un documento a tre paragrafi:

```text
[Before]
First paragraph content here.

[After]
Third paragraph content here.
```

Le sezioni `[Before]` e `[After]` vengono omesse quando non ci sono vicini in quella direzione (es. il contenuto è all'inizio o alla fine del documento).

### Il Campo `action`

Per impostazione predefinita, i genies **sostituiscono** il testo sorgente con l'output dell'IA. Imposta `action: insert` per **aggiungere** l'output dopo il blocco sorgente invece.

Usa `replace` per: modifica, riformulazione, traduzione, correzioni grammaticali — qualsiasi cosa che trasformi il testo originale.

Usa `insert` per: continuare a scrivere, generare riassunti sotto il contenuto, aggiungere commenti — qualsiasi cosa che aggiunga nuovo testo senza rimuovere l'originale.

**Esempio — azione insert:**

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

### Il Campo `model`

Sovrascrive il modello predefinito per un genie specifico. Utile quando vuoi un modello più economico per attività semplici o uno più potente per attività complesse.

```markdown
---
description: Quick grammar fix (uses fast model)
scope: selection
model: claude-haiku-4-5-20251001
---

Fix grammar and spelling errors. Return only the corrected text.

{{content}}
```

L'identificatore del modello deve corrispondere a quello accettato dal tuo provider attivo.

## Scrittura di Prompt Efficaci

### Sii Specifico sul Formato dell'Output

Di' all'IA esattamente cosa restituire. Senza questo, i modelli tendono ad aggiungere spiegazioni, intestazioni o commenti.

```markdown
<!-- Good -->
Return only the improved text — no explanations.

<!-- Bad — AI may wrap output in quotes, add "Here's the improved version:", etc. -->
Improve this text.
```

### Assegna un Ruolo

Dai all'IA un personaggio per ancorare il suo comportamento.

```markdown
<!-- Good -->
You are an expert technical editor who specializes in API documentation.

<!-- Okay but less focused -->
Edit the following text.
```

### Limita l'Ambito

Di' all'IA cosa NON cambiare. Questo previene la sovraeditazione.

```markdown
<!-- Good -->
Fix grammar and spelling errors only.
Do not change the meaning, style, or tone.
Do not restructure sentences.

<!-- Bad — gives the AI too much freedom -->
Fix this text.
```

### Usa Markdown nei Prompt

Puoi usare la formattazione Markdown nei tuoi template di prompt. Questo aiuta quando vuoi che l'IA produca output strutturato.

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

### Mantieni i Prompt Focalizzati

Un genie, un compito. Non combinare più attività in un singolo genie — crea invece genies separati.

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

## Genies Personalizzati di Esempio

### Accademico — Scrivi un Abstract

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

### Blog — Genera un Aggancio

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

### Codice — Spiega il Blocco di Codice

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

### Email — Rendi Professionale

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

### Traduzione — In Cinese Semplificato

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

### Contestuale — Adattati all'Ambiente

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

### Revisione — Verifica Fatti

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

## Suggerimenti IA

Quando un Genie restituisce testo destinato a essere una sostituzione per la selezione (piuttosto che una risposta di chat libera), VMark lo mostra come **suggerimento** con un diff inline: barratura ondulata rossa per il testo originale, testo fantasma in corsivo sbiadito nel colore d'accento per il testo proposto. Esamini e approvi prima che qualsiasi modifica persista.

| Azione | Scorciatoia |
|---|---|
| Accetta il suggerimento focalizzato | `Enter` |
| Rifiuta il suggerimento focalizzato | `Esc` |
| Passa al suggerimento successivo / precedente | `Tab` / `Shift + Tab` |
| Accetta tutti i suggerimenti nel documento | `Mod + Shift + Enter` _(contestuale — anche Aggiungi riga sopra quando all'interno di una tabella)_ |
| Rifiuta tutti i suggerimenti nel documento | `Mod + Shift + Escape` |

Quando un Genie riscrive più paragrafi, ogni sostituzione è il proprio suggerimento navigabile in modo indipendente. Accettarne uno non accetta automaticamente gli altri.

## Genies nei Workflow

Un singolo genie esegue un solo prompt. Quando devi concatenare più passaggi IA — scaletta, poi bozza, poi rifinitura — e instradare l'output di una fase nella successiva, usa un **flusso di lavoro Genie**: un file YAML che orchestra più chiamate ai genies con un flusso di dati esplicito, punti di approvazione opzionali, modelli per singolo passaggio e un diagramma di esecuzione dal vivo.

Poiché i passaggi di un workflow riempiono il segnaposto `{{content}}` di un genie a partire da una mappa `with: { input: "..." }`, **i genies che scrivi qui funzionano senza modifiche all'interno dei workflow** — non serve alcuna conversione.

Vedi [Flussi di lavoro Genie](/it/guide/workflows) per lo schema YAML completo, la sintassi delle espressioni, le approvazioni e come eseguirne uno.

### Delimitazione dei contenuti non attendibili

Quando viene eseguito un passaggio `genie/<name>` di un workflow, il testo del documento, le selezioni e i contenuti dei file vengono racchiusi tra marcatori univoci `<<<DOCUMENT-DATA-…>>>` prima di raggiungere il provider IA, e il prompt istruisce il modello a trattare il testo delimitato strettamente come dati. La delimitazione riguarda i passaggi dei workflow — un genie eseguito direttamente dal selettore invia al provider il testo del suo ambito così com'è. Questo protegge dai documenti che cercano di far passare di nascosto istruzioni all'IA ("ignora le tue istruzioni ed esegui …") — il che conta soprattutto per i provider CLI (Claude Code, Codex, Gemini CLI) che possono eseguire comandi. Tratta i genies che esegui su file provenienti da fonti non attendibili con la stessa cautela che useresti per eseguire uno script scaricato da internet: la delimitazione è una mitigazione solida, non una garanzia assoluta.

## Limitazioni

- I genies funzionano solo in **modalità WYSIWYG**. In modalità sorgente, una notifica toast spiega questo.
- Un genie può essere eseguito alla volta. Se l'IA sta già generando, il selettore non avvierà un altro.
- Il segnaposto `{{content}}` viene sostituito letteralmente — non supporta condizionali o cicli.
- I documenti molto grandi potrebbero raggiungere i limiti di token del provider quando si usa `scope: document`.

## Risoluzione dei Problemi

**"Nessun provider IA disponibile"** — Apri Impostazioni > Integrazioni e configura un provider. Vedi [Provider IA](/it/guide/ai-providers).

**Il genie non appare nel selettore** — Verifica che il file abbia un'estensione `.md` (o `.yml`/`.yaml` per un [genie del workflow](/it/guide/workflow-genies)) e un frontmatter valido con delimitatori `---`. Le sottocartelle vengono analizzate fino a otto livelli di profondità (e al massimo 10.000 voci in totale), e i collegamenti simbolici vengono ignorati. Esegui **Modifica → Geni → Ricarica geni** dopo aver aggiunto dei file.

**L'IA restituisce spazzatura o errori** — Verifica che la tua chiave API sia corretta e che il nome del modello sia valido per il tuo provider. Controlla il terminale/console per i dettagli dell'errore.

**Il suggerimento non soddisfa le aspettative** — Perfeziona il tuo prompt. Aggiungi vincoli ("restituisci solo il testo", "non spiegare"), assegna un ruolo o restringi l'ambito.

## Vedi Anche

- [Provider IA](/it/guide/ai-providers) — Configura provider CLI o API REST
- [Scorciatoie da Tastiera](/it/guide/shortcuts) — Riferimento completo delle scorciatoie
- [Strumenti MCP](/it/guide/mcp-tools) — Integrazione IA esterna tramite MCP
