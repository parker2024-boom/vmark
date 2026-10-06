/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/fr.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/fr
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "Contenu HTML trop volumineux (>50 Mo)"
  core.pathTraversal: "Traversée de chemin (..) non autorisée"
  core.pathNotAbsolute: "Le chemin doit être absolu"

  # === Pandoc export ===
  pandoc.pathTraversal: "Traversée de chemin non autorisée dans le chemin de sortie"
  pandoc.emptySourceDir: "source_dir ne peut pas être vide"
  pandoc.sourcePathTraversal: "Traversée de chemin non autorisée dans source_dir"
  pandoc.invalidSourceDir: "source_dir '%{dir}' invalide : %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' n'est pas un répertoire"
  pandoc.notFound: "Pandoc introuvable dans PATH"
  pandoc.exitedWithCode: "Pandoc terminé avec le code %{code}"
  pandoc.timeout: "Pandoc a dépassé le délai (plus de 2 minutes)"
  pandoc.taskPanicked: "La tâche Pandoc s'est arrêtée : %{detail}"
  pandoc.startFailed: "Échec du démarrage de Pandoc : %{detail}"
  pandoc.stdinFailed: "Échec d'écriture dans l'entrée standard de Pandoc : %{detail}"
  pandoc.waitFailed: "Échec d'attente de Pandoc : %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "Le chemin de sortie doit avoir l'extension .pdf"
  pdf.dirNotFound: "Le répertoire de sortie n'existe pas"
  pdf.loadTimeout: "Délai de chargement HTML dépassé (10 s)"
  pdf.emptyOutput: "L'opération d'impression a produit un PDF vide"
  pdf.printTimeout: "Délai d'impression dépassé (60 s)"
  pdf.noPages: "Le PDF n'a aucune page"
  pdf.writeFailed: "Échec de l'écriture du PDF avec signets"

  # === Workflow execution ===
  workflow.alreadyRunning: "Un flux de travail est déjà en cours. Attendez qu'il se termine ou annulez-le."
  workflow.emptyYaml: "Le YAML du flux de travail est vide"
  workflow.invalidWorkspace: "La racine de l'espace de travail '%{path}' n'est pas un répertoire valide"
  workflow.parseFailed: "Échec de l'analyse du YAML du flux de travail : %{detail}"
  workflow.tooManySteps: "Le flux de travail comporte %{count} étapes (maximum 50)"
  workflow.genieNotImplemented: "L'étape %{index} ('%{id}') utilise l'exécution genie, qui n'est pas encore implémentée"
  workflow.webhookNotImplemented: "L'étape %{index} ('%{id}') utilise l'exécution webhook, qui n'est pas encore implémentée"
  workflow.notRunning: "Aucun flux de travail n'est en cours d'exécution"
  workflow.circularDependency: "Dépendance circulaire détectée dans les étapes du flux de travail"
  workflow.noInteractivePrompt: "Les invites interactives ne sont pas prises en charge dans l'exécution de flux de travail"

  # === Hot exit ===
  hotExit.noWindows: "Aucune fenêtre de document à capturer"
  hotExit.captureEmitFailed: "Échec d'envoi de la requête de capture : %{detail}"
  hotExit.captureTimeout: "Délai de capture dépassé : aucune fenêtre n'a répondu"

  # === Content search ===
  search.queryTooShort: "La requête doit comporter au moins 3 caractères"

  # === CLI install ===
  cli.noFile: "L'installation semble avoir réussi mais le fichier n'a pas été créé."
  cli.mismatch: "Installation terminée, mais le contenu du fichier ne correspond pas au script attendu."

  # === Genies ===
  genie.pathBlocked: "Le chemin Genie se trouve en dehors des répertoires autorisés"

  # === MCP ===
  mcp.spawnInProgress: "Démarrage du sidecar MCP déjà en cours"
  mcp.configMismatch: "Échec de validation de la configuration : le contenu écrit ne correspond pas"
`;
