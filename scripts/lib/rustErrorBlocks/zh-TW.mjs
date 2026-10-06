/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/zh-TW.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/zh-TW
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "HTML 內容過大（超過 50 MB）"
  core.pathTraversal: "不允許使用路徑穿越（..）"
  core.pathNotAbsolute: "路徑必須為絕對路徑"

  # === Pandoc export ===
  pandoc.pathTraversal: "輸出路徑中不允許路徑穿越"
  pandoc.emptySourceDir: "source_dir 不能為空"
  pandoc.sourcePathTraversal: "source_dir 中不允許路徑穿越"
  pandoc.invalidSourceDir: "無效的 source_dir '%{dir}'：%{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' 不是目錄"
  pandoc.notFound: "在 PATH 中找不到 Pandoc"
  pandoc.exitedWithCode: "Pandoc 以狀態碼 %{code} 結束"
  pandoc.timeout: "Pandoc 逾時（超過 2 分鐘）"
  pandoc.taskPanicked: "Pandoc 工作異常終止：%{detail}"
  pandoc.startFailed: "啟動 Pandoc 失敗：%{detail}"
  pandoc.stdinFailed: "寫入 Pandoc 標準輸入失敗：%{detail}"
  pandoc.waitFailed: "等待 Pandoc 失敗：%{detail}"

  # === PDF export ===
  pdf.invalidExtension: "輸出路徑必須使用 .pdf 副檔名"
  pdf.dirNotFound: "輸出目錄不存在"
  pdf.loadTimeout: "HTML 載入逾時（10 秒）"
  pdf.emptyOutput: "列印操作產生了空白 PDF"
  pdf.printTimeout: "列印操作逾時（60 秒）"
  pdf.noPages: "PDF 沒有任何頁面"
  pdf.writeFailed: "寫入含書籤的 PDF 失敗"

  # === Workflow execution ===
  workflow.alreadyRunning: "已有工作流程正在執行。請等待完成或取消後再試。"
  workflow.emptyYaml: "工作流程 YAML 為空"
  workflow.invalidWorkspace: "工作區根目錄 '%{path}' 不是有效的目錄"
  workflow.parseFailed: "解析工作流程 YAML 失敗：%{detail}"
  workflow.tooManySteps: "工作流程包含 %{count} 個步驟（上限 50）"
  workflow.genieNotImplemented: "步驟 %{index}（'%{id}'）使用了尚未實作的 genie 執行方式"
  workflow.webhookNotImplemented: "步驟 %{index}（'%{id}'）使用了尚未實作的 webhook 執行方式"
  workflow.notRunning: "目前沒有正在執行的工作流程"
  workflow.circularDependency: "工作流程步驟中偵測到循環相依"
  workflow.noInteractivePrompt: "工作流程執行不支援互動式提示"

  # === Hot exit ===
  hotExit.noWindows: "沒有需要擷取的文件視窗"
  hotExit.captureEmitFailed: "發送擷取請求失敗：%{detail}"
  hotExit.captureTimeout: "擷取逾時：沒有視窗回應"

  # === Content search ===
  search.queryTooShort: "搜尋關鍵字至少需要 3 個字元"

  # === CLI install ===
  cli.noFile: "安裝似乎成功，但檔案未能建立。"
  cli.mismatch: "安裝完成，但檔案內容與預期指令稿不符。"

  # === Genies ===
  genie.pathBlocked: "Genie 路徑位於允許的目錄之外"

  # === MCP ===
  mcp.spawnInProgress: "MCP 側載程序正在啟動中"
  mcp.configMismatch: "設定校驗失敗：寫入內容與預期不符"
`;
