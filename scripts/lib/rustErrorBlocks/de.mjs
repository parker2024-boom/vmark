/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/de.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/de
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "HTML-Inhalt zu groß (>50 MB)"
  core.pathTraversal: "Pfad-Traversierung (..) ist nicht erlaubt"
  core.pathNotAbsolute: "Pfad muss absolut sein"

  # === Pandoc export ===
  pandoc.pathTraversal: "Pfad-Traversierung im Ausgabepfad nicht erlaubt"
  pandoc.emptySourceDir: "source_dir darf nicht leer sein"
  pandoc.sourcePathTraversal: "Pfad-Traversierung in source_dir nicht erlaubt"
  pandoc.invalidSourceDir: "Ungültiges source_dir '%{dir}': %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' ist kein Verzeichnis"
  pandoc.notFound: "Pandoc nicht im PATH gefunden"
  pandoc.exitedWithCode: "Pandoc beendet mit Code %{code}"
  pandoc.timeout: "Pandoc-Zeitüberschreitung (länger als 2 Minuten)"
  pandoc.taskPanicked: "Pandoc-Aufgabe abgestürzt: %{detail}"
  pandoc.startFailed: "Pandoc konnte nicht gestartet werden: %{detail}"
  pandoc.stdinFailed: "Schreiben in Pandoc-stdin fehlgeschlagen: %{detail}"
  pandoc.waitFailed: "Warten auf Pandoc fehlgeschlagen: %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "Ausgabepfad muss die Endung .pdf haben"
  pdf.dirNotFound: "Ausgabeverzeichnis existiert nicht"
  pdf.loadTimeout: "HTML-Ladezeitüberschreitung (10 s)"
  pdf.emptyOutput: "Druckvorgang erzeugte leere PDF"
  pdf.printTimeout: "Druckvorgang-Zeitüberschreitung (60 s)"
  pdf.noPages: "PDF enthält keine Seiten"
  pdf.writeFailed: "Schreiben der PDF mit Lesezeichen fehlgeschlagen"

  # === Workflow execution ===
  workflow.alreadyRunning: "Ein Workflow läuft bereits. Warten Sie, bis er fertig ist, oder brechen Sie ihn ab."
  workflow.emptyYaml: "Workflow-YAML ist leer"
  workflow.invalidWorkspace: "Arbeitsbereich-Root '%{path}' ist kein gültiges Verzeichnis"
  workflow.parseFailed: "Workflow-YAML konnte nicht geparst werden: %{detail}"
  workflow.tooManySteps: "Workflow hat %{count} Schritte (Maximum 50)"
  workflow.genieNotImplemented: "Schritt %{index} ('%{id}') verwendet Genie-Ausführung, die noch nicht implementiert ist"
  workflow.webhookNotImplemented: "Schritt %{index} ('%{id}') verwendet Webhook-Ausführung, die noch nicht implementiert ist"
  workflow.notRunning: "Derzeit läuft kein Workflow"
  workflow.circularDependency: "Zirkuläre Abhängigkeit in Workflow-Schritten erkannt"
  workflow.noInteractivePrompt: "Interaktive Eingabeaufforderung in Workflow-Ausführung nicht unterstützt"

  # === Hot exit ===
  hotExit.noWindows: "Keine Dokumentfenster zum Erfassen"
  hotExit.captureEmitFailed: "Senden der Erfassungsanfrage fehlgeschlagen: %{detail}"
  hotExit.captureTimeout: "Erfassung abgelaufen: Keine Fenster haben geantwortet"

  # === Content search ===
  search.queryTooShort: "Suchbegriff muss mindestens 3 Zeichen lang sein"

  # === CLI install ===
  cli.noFile: "Installation schien erfolgreich zu sein, aber die Datei wurde nicht erstellt."
  cli.mismatch: "Installation abgeschlossen, aber Dateiinhalt stimmt nicht mit erwartetem Skript überein."

  # === Genies ===
  genie.pathBlocked: "Genie-Pfad liegt außerhalb der erlaubten Verzeichnisse"

  # === MCP ===
  mcp.spawnInProgress: "MCP-Sidecar-Start bereits in Arbeit"
  mcp.configMismatch: "Konfigurationsvalidierung fehlgeschlagen: geschriebener Inhalt stimmt nicht überein"
`;
