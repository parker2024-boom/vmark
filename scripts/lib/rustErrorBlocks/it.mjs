/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/it.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/it
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "Contenuto HTML troppo grande (>50 MB)"
  core.pathTraversal: "Traversal del percorso (..) non consentito"
  core.pathNotAbsolute: "Il percorso deve essere assoluto"

  # === Pandoc export ===
  pandoc.pathTraversal: "Traversal del percorso non consentito nel percorso di output"
  pandoc.emptySourceDir: "source_dir non può essere vuoto"
  pandoc.sourcePathTraversal: "Traversal del percorso non consentito in source_dir"
  pandoc.invalidSourceDir: "source_dir non valido '%{dir}': %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' non è una directory"
  pandoc.notFound: "Pandoc non trovato nel PATH"
  pandoc.exitedWithCode: "Pandoc terminato con codice %{code}"
  pandoc.timeout: "Timeout di Pandoc (oltre 2 minuti)"
  pandoc.taskPanicked: "Il task Pandoc si è bloccato: %{detail}"
  pandoc.startFailed: "Impossibile avviare Pandoc: %{detail}"
  pandoc.stdinFailed: "Impossibile scrivere nello stdin di Pandoc: %{detail}"
  pandoc.waitFailed: "Impossibile attendere Pandoc: %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "Il percorso di output deve avere estensione .pdf"
  pdf.dirNotFound: "La directory di output non esiste"
  pdf.loadTimeout: "Timeout caricamento HTML (10 s)"
  pdf.emptyOutput: "L'operazione di stampa ha prodotto un PDF vuoto"
  pdf.printTimeout: "Timeout operazione di stampa (60 s)"
  pdf.noPages: "Il PDF non ha pagine"
  pdf.writeFailed: "Impossibile scrivere il PDF con segnalibri"

  # === Workflow execution ===
  workflow.alreadyRunning: "Un flusso di lavoro è già in esecuzione. Attendere il completamento o annullarlo."
  workflow.emptyYaml: "Il YAML del flusso di lavoro è vuoto"
  workflow.invalidWorkspace: "La radice dell'area di lavoro '%{path}' non è una directory valida"
  workflow.parseFailed: "Impossibile analizzare il YAML del flusso di lavoro: %{detail}"
  workflow.tooManySteps: "Il flusso di lavoro ha %{count} passaggi (massimo 50)"
  workflow.genieNotImplemented: "Il passaggio %{index} ('%{id}') utilizza l'esecuzione genie non ancora implementata"
  workflow.webhookNotImplemented: "Il passaggio %{index} ('%{id}') utilizza l'esecuzione webhook non ancora implementata"
  workflow.notRunning: "Nessun flusso di lavoro è attualmente in esecuzione"
  workflow.circularDependency: "Rilevata dipendenza circolare nei passaggi del flusso di lavoro"
  workflow.noInteractivePrompt: "Il prompt interattivo non è supportato nell'esecuzione del flusso di lavoro"

  # === Hot exit ===
  hotExit.noWindows: "Nessuna finestra documento da catturare"
  hotExit.captureEmitFailed: "Impossibile inviare la richiesta di cattura: %{detail}"
  hotExit.captureTimeout: "Timeout cattura: nessuna finestra ha risposto"

  # === Content search ===
  search.queryTooShort: "La query deve contenere almeno 3 caratteri"

  # === CLI install ===
  cli.noFile: "L'installazione sembra riuscita ma il file non è stato creato."
  cli.mismatch: "Installazione completata, ma il contenuto del file non corrisponde allo script previsto."

  # === Genies ===
  genie.pathBlocked: "Il percorso di Genie è al di fuori delle directory consentite"

  # === MCP ===
  mcp.spawnInProgress: "L'avvio del sidecar MCP è già in corso"
  mcp.configMismatch: "Convalida della configurazione non riuscita: il contenuto scritto non corrisponde"
`;
