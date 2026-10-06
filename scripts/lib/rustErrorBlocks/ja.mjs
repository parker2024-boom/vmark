/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/ja.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/ja
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "HTML コンテンツが大きすぎます（50 MB 超）"
  core.pathTraversal: "パストラバーサル（..）は許可されていません"
  core.pathNotAbsolute: "パスは絶対パスである必要があります"

  # === Pandoc export ===
  pandoc.pathTraversal: "出力パスにパストラバーサルは使用できません"
  pandoc.emptySourceDir: "source_dir は空にできません"
  pandoc.sourcePathTraversal: "source_dir にパストラバーサルは使用できません"
  pandoc.invalidSourceDir: "source_dir '%{dir}' が無効です: %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}' はディレクトリではありません"
  pandoc.notFound: "PATH に Pandoc が見つかりません"
  pandoc.exitedWithCode: "Pandoc が終了コード %{code} で終了しました"
  pandoc.timeout: "Pandoc がタイムアウトしました（2 分超過）"
  pandoc.taskPanicked: "Pandoc タスクが異常終了しました: %{detail}"
  pandoc.startFailed: "Pandoc の起動に失敗しました: %{detail}"
  pandoc.stdinFailed: "Pandoc の標準入力への書き込みに失敗しました: %{detail}"
  pandoc.waitFailed: "Pandoc の待機に失敗しました: %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "出力パスは .pdf 拡張子である必要があります"
  pdf.dirNotFound: "出力ディレクトリが存在しません"
  pdf.loadTimeout: "HTML の読み込みがタイムアウトしました（10 秒）"
  pdf.emptyOutput: "印刷操作で空の PDF が生成されました"
  pdf.printTimeout: "印刷操作がタイムアウトしました（60 秒）"
  pdf.noPages: "PDF にページがありません"
  pdf.writeFailed: "しおり付き PDF の書き込みに失敗しました"

  # === Workflow execution ===
  workflow.alreadyRunning: "別のワークフローがすでに実行中です。完了またはキャンセルをお待ちください。"
  workflow.emptyYaml: "ワークフロー YAML が空です"
  workflow.invalidWorkspace: "ワークスペースルート '%{path}' は有効なディレクトリではありません"
  workflow.parseFailed: "ワークフロー YAML の解析に失敗しました: %{detail}"
  workflow.tooManySteps: "ワークフローには %{count} 個のステップがあります（上限 50）"
  workflow.genieNotImplemented: "ステップ %{index}（'%{id}'）は未実装の genie 実行を使用しています"
  workflow.webhookNotImplemented: "ステップ %{index}（'%{id}'）は未実装の webhook 実行を使用しています"
  workflow.notRunning: "現在実行中のワークフローはありません"
  workflow.circularDependency: "ワークフローのステップに循環依存が検出されました"
  workflow.noInteractivePrompt: "ワークフロー実行では対話型プロンプトはサポートされていません"

  # === Hot exit ===
  hotExit.noWindows: "キャプチャするドキュメントウィンドウがありません"
  hotExit.captureEmitFailed: "キャプチャ要求の送信に失敗しました: %{detail}"
  hotExit.captureTimeout: "キャプチャがタイムアウトしました: ウィンドウからの応答がありません"

  # === Content search ===
  search.queryTooShort: "検索クエリは 3 文字以上である必要があります"

  # === CLI install ===
  cli.noFile: "インストールは成功したように見えますが、ファイルが作成されませんでした。"
  cli.mismatch: "インストールは完了しましたが、ファイル内容が想定したスクリプトと一致しません。"

  # === Genies ===
  genie.pathBlocked: "Genie のパスが許可されたディレクトリの外にあります"

  # === MCP ===
  mcp.spawnInProgress: "MCP サイドカーの起動がすでに進行中です"
  mcp.configMismatch: "設定の検証に失敗しました: 書き込まれた内容が想定と一致しません"
`;
