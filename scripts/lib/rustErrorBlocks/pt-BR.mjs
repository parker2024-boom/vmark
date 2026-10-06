/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/pt-BR.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/pt-BR
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "Conteúdo HTML muito grande (>50 MB)"
  core.pathTraversal: "Travessia de caminho (..) não permitida"
  core.pathNotAbsolute: "O caminho precisa ser absoluto"

  # === Pandoc export ===
  pandoc.pathTraversal: "Travessia de caminho não permitida no caminho de saída"
  pandoc.emptySourceDir: "source_dir não pode estar vazio"
  pandoc.sourcePathTraversal: "Travessia de caminho não permitida em source_dir"
  pandoc.invalidSourceDir: "source_dir inválido '%{dir}': %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' não é um diretório"
  pandoc.notFound: "Pandoc não encontrado no PATH"
  pandoc.exitedWithCode: "Pandoc encerrou com código %{code}"
  pandoc.timeout: "Tempo esgotado no Pandoc (mais de 2 minutos)"
  pandoc.taskPanicked: "A tarefa do Pandoc falhou: %{detail}"
  pandoc.startFailed: "Falha ao iniciar o Pandoc: %{detail}"
  pandoc.stdinFailed: "Falha ao escrever no stdin do Pandoc: %{detail}"
  pandoc.waitFailed: "Falha ao aguardar o Pandoc: %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "O caminho de saída precisa ter a extensão .pdf"
  pdf.dirNotFound: "O diretório de saída não existe"
  pdf.loadTimeout: "Tempo esgotado ao carregar HTML (10 s)"
  pdf.emptyOutput: "A operação de impressão gerou um PDF vazio"
  pdf.printTimeout: "Tempo esgotado na operação de impressão (60 s)"
  pdf.noPages: "O PDF não tem páginas"
  pdf.writeFailed: "Falha ao gravar o PDF com marcadores"

  # === Workflow execution ===
  workflow.alreadyRunning: "Já existe um fluxo de trabalho em execução. Aguarde a conclusão ou cancele."
  workflow.emptyYaml: "O YAML do fluxo de trabalho está vazio"
  workflow.invalidWorkspace: "A raiz do espaço de trabalho '%{path}' não é um diretório válido"
  workflow.parseFailed: "Falha ao analisar o YAML do fluxo de trabalho: %{detail}"
  workflow.tooManySteps: "O fluxo de trabalho tem %{count} etapas (máximo 50)"
  workflow.genieNotImplemented: "A etapa %{index} ('%{id}') usa execução genie ainda não implementada"
  workflow.webhookNotImplemented: "A etapa %{index} ('%{id}') usa execução webhook ainda não implementada"
  workflow.notRunning: "Nenhum fluxo de trabalho em execução no momento"
  workflow.circularDependency: "Dependência circular detectada nas etapas do fluxo de trabalho"
  workflow.noInteractivePrompt: "Prompt interativo não é suportado na execução do fluxo de trabalho"

  # === Hot exit ===
  hotExit.noWindows: "Nenhuma janela de documento para capturar"
  hotExit.captureEmitFailed: "Falha ao enviar solicitação de captura: %{detail}"
  hotExit.captureTimeout: "Tempo de captura esgotado: nenhuma janela respondeu"

  # === Content search ===
  search.queryTooShort: "A consulta precisa ter pelo menos 3 caracteres"

  # === CLI install ===
  cli.noFile: "A instalação parece ter tido sucesso, mas o arquivo não foi criado."
  cli.mismatch: "Instalação concluída, mas o conteúdo do arquivo não corresponde ao script esperado."

  # === Genies ===
  genie.pathBlocked: "O caminho do Genie está fora dos diretórios permitidos"

  # === MCP ===
  mcp.spawnInProgress: "A inicialização do sidecar MCP já está em andamento"
  mcp.configMismatch: "Falha na validação da configuração: o conteúdo gravado não corresponde"
`;
