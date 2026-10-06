/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/zh-CN.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/zh-CN
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "HTML 内容过大（超过 50 MB）"
  core.pathTraversal: "不允许使用路径穿越（..）"
  core.pathNotAbsolute: "路径必须是绝对路径"

  # === Pandoc export ===
  pandoc.pathTraversal: "输出路径中不允许路径穿越"
  pandoc.emptySourceDir: "source_dir 不能为空"
  pandoc.sourcePathTraversal: "source_dir 中不允许路径穿越"
  pandoc.invalidSourceDir: "无效的 source_dir '%{dir}'：%{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' 不是一个目录"
  pandoc.notFound: "在 PATH 中未找到 Pandoc"
  pandoc.exitedWithCode: "Pandoc 以状态码 %{code} 退出"
  pandoc.timeout: "Pandoc 超时（超过 2 分钟）"
  pandoc.taskPanicked: "Pandoc 任务异常终止：%{detail}"
  pandoc.startFailed: "启动 Pandoc 失败：%{detail}"
  pandoc.stdinFailed: "向 Pandoc 标准输入写入失败：%{detail}"
  pandoc.waitFailed: "等待 Pandoc 失败：%{detail}"

  # === PDF export ===
  pdf.invalidExtension: "输出路径必须使用 .pdf 扩展名"
  pdf.dirNotFound: "输出目录不存在"
  pdf.loadTimeout: "HTML 加载超时（10 秒）"
  pdf.emptyOutput: "打印操作生成了空 PDF"
  pdf.printTimeout: "打印操作超时（60 秒）"
  pdf.noPages: "PDF 没有页面"
  pdf.writeFailed: "写入带书签的 PDF 失败"

  # === Workflow execution ===
  workflow.alreadyRunning: "已有工作流正在运行。请等待其完成或取消后再试。"
  workflow.emptyYaml: "工作流 YAML 为空"
  workflow.invalidWorkspace: "工作空间根目录 '%{path}' 不是有效的目录"
  workflow.parseFailed: "解析工作流 YAML 失败：%{detail}"
  workflow.tooManySteps: "工作流包含 %{count} 个步骤（上限 50）"
  workflow.genieNotImplemented: "步骤 %{index}（'%{id}'）使用了尚未实现的 genie 执行方式"
  workflow.webhookNotImplemented: "步骤 %{index}（'%{id}'）使用了尚未实现的 webhook 执行方式"
  workflow.notRunning: "当前没有正在运行的工作流"
  workflow.circularDependency: "工作流步骤中检测到循环依赖"
  workflow.noInteractivePrompt: "工作流执行中不支持交互式提示"

  # === Hot exit ===
  hotExit.noWindows: "没有需要捕获的文档窗口"
  hotExit.captureEmitFailed: "发送捕获请求失败：%{detail}"
  hotExit.captureTimeout: "捕获超时：没有窗口响应"

  # === Content search ===
  search.queryTooShort: "搜索关键字至少需要 3 个字符"

  # === CLI install ===
  cli.noFile: "安装似乎成功，但文件未能创建。"
  cli.mismatch: "安装完成，但文件内容与预期脚本不符。"

  # === Genies ===
  genie.pathBlocked: "Genie 路径位于允许的目录之外"

  # === MCP ===
  mcp.spawnInProgress: "MCP 侧载进程正在启动中"
  mcp.configMismatch: "配置校验失败：写入内容与预期不符"
`;
