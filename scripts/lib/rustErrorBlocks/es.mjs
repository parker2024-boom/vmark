/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/es.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/es
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "Contenido HTML demasiado grande (>50 MB)"
  core.pathTraversal: "No se permite el recorrido de rutas (..)"
  core.pathNotAbsolute: "La ruta debe ser absoluta"

  # === Pandoc export ===
  pandoc.pathTraversal: "No se permite el recorrido de rutas en la ruta de salida"
  pandoc.emptySourceDir: "source_dir no puede estar vacío"
  pandoc.sourcePathTraversal: "No se permite el recorrido de rutas en source_dir"
  pandoc.invalidSourceDir: "source_dir no válido '%{dir}': %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' no es un directorio"
  pandoc.notFound: "Pandoc no encontrado en PATH"
  pandoc.exitedWithCode: "Pandoc terminó con el código %{code}"
  pandoc.timeout: "Tiempo de espera de Pandoc agotado (superó los 2 minutos)"
  pandoc.taskPanicked: "La tarea de Pandoc falló: %{detail}"
  pandoc.startFailed: "Error al iniciar Pandoc: %{detail}"
  pandoc.stdinFailed: "Error al escribir en stdin de Pandoc: %{detail}"
  pandoc.waitFailed: "Error al esperar a Pandoc: %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "La ruta de salida debe tener la extensión .pdf"
  pdf.dirNotFound: "El directorio de salida no existe"
  pdf.loadTimeout: "Tiempo de espera de carga HTML (10 s)"
  pdf.emptyOutput: "La operación de impresión generó un PDF vacío"
  pdf.printTimeout: "Tiempo de espera de impresión (60 s)"
  pdf.noPages: "El PDF no tiene páginas"
  pdf.writeFailed: "Error al escribir el PDF con marcadores"

  # === Workflow execution ===
  workflow.alreadyRunning: "Ya se está ejecutando un flujo de trabajo. Espere a que termine o cancélelo."
  workflow.emptyYaml: "El YAML del flujo de trabajo está vacío"
  workflow.invalidWorkspace: "La raíz del espacio de trabajo '%{path}' no es un directorio válido"
  workflow.parseFailed: "Error al analizar el YAML del flujo de trabajo: %{detail}"
  workflow.tooManySteps: "El flujo de trabajo tiene %{count} pasos (máximo 50)"
  workflow.genieNotImplemented: "El paso %{index} ('%{id}') usa la ejecución genie que aún no está implementada"
  workflow.webhookNotImplemented: "El paso %{index} ('%{id}') usa la ejecución webhook que aún no está implementada"
  workflow.notRunning: "No hay ningún flujo de trabajo en ejecución"
  workflow.circularDependency: "Se detectó una dependencia circular en los pasos del flujo de trabajo"
  workflow.noInteractivePrompt: "El flujo de trabajo no admite solicitudes interactivas"

  # === Hot exit ===
  hotExit.noWindows: "No hay ventanas de documento para capturar"
  hotExit.captureEmitFailed: "Error al enviar la solicitud de captura: %{detail}"
  hotExit.captureTimeout: "Tiempo de captura agotado: ninguna ventana respondió"

  # === Content search ===
  search.queryTooShort: "La búsqueda debe tener al menos 3 caracteres"

  # === CLI install ===
  cli.noFile: "La instalación pareció tener éxito, pero el archivo no se creó."
  cli.mismatch: "La instalación se completó, pero el contenido del archivo no coincide con el script esperado."

  # === Genies ===
  genie.pathBlocked: "La ruta de Genie está fuera de los directorios permitidos"

  # === MCP ===
  mcp.spawnInProgress: "El inicio del sidecar MCP ya está en curso"
  mcp.configMismatch: "Validación de configuración fallida: el contenido escrito no coincide"
`;
