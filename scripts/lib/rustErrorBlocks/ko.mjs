/**
 * The `errors:` block propagate-rust-errors.mjs appends to
 * src-tauri/locales/ko.yml. `%{name}` placeholders match en.yml verbatim.
 *
 * @coordinates-with scripts/propagate-rust-errors.mjs — the script that writes it
 * @module scripts/lib/rustErrorBlocks/ko
 */
export const ERRORS = `
errors:
  # === Core (lib.rs) ===
  core.htmlTooLarge: "HTML 콘텐츠가 너무 큽니다 (50MB 초과)"
  core.pathTraversal: "경로 탐색(..)은 허용되지 않습니다"
  core.pathNotAbsolute: "경로는 절대 경로여야 합니다"

  # === Pandoc export ===
  pandoc.pathTraversal: "출력 경로에 경로 탐색이 허용되지 않습니다"
  pandoc.emptySourceDir: "source_dir은 비워둘 수 없습니다"
  pandoc.sourcePathTraversal: "source_dir에 경로 탐색이 허용되지 않습니다"
  pandoc.invalidSourceDir: "잘못된 source_dir '%{dir}': %{detail}"
  pandoc.notADirectory: "source_dir '%{dir}'은(는) 디렉터리가 아닙니다"
  pandoc.notFound: "PATH에서 Pandoc을 찾을 수 없습니다"
  pandoc.exitedWithCode: "Pandoc이 코드 %{code}(으)로 종료되었습니다"
  pandoc.timeout: "Pandoc이 시간 초과되었습니다 (2분 초과)"
  pandoc.taskPanicked: "Pandoc 작업이 비정상 종료되었습니다: %{detail}"
  pandoc.startFailed: "Pandoc 시작 실패: %{detail}"
  pandoc.stdinFailed: "Pandoc 표준 입력 쓰기 실패: %{detail}"
  pandoc.waitFailed: "Pandoc 대기 실패: %{detail}"

  # === PDF export ===
  pdf.invalidExtension: "출력 경로는 .pdf 확장자를 사용해야 합니다"
  pdf.dirNotFound: "출력 디렉터리가 존재하지 않습니다"
  pdf.loadTimeout: "HTML 로드 시간 초과 (10초)"
  pdf.emptyOutput: "인쇄 작업이 빈 PDF를 생성했습니다"
  pdf.printTimeout: "인쇄 작업 시간 초과 (60초)"
  pdf.noPages: "PDF에 페이지가 없습니다"
  pdf.writeFailed: "북마크가 포함된 PDF 쓰기 실패"

  # === Workflow execution ===
  workflow.alreadyRunning: "이미 실행 중인 워크플로가 있습니다. 완료되거나 취소된 후 다시 시도하세요."
  workflow.emptyYaml: "워크플로 YAML이 비어 있습니다"
  workflow.invalidWorkspace: "작업 공간 루트 '%{path}'은(는) 유효한 디렉터리가 아닙니다"
  workflow.parseFailed: "워크플로 YAML 구문 분석 실패: %{detail}"
  workflow.tooManySteps: "워크플로에 %{count}개의 단계가 있습니다 (최대 50)"
  workflow.genieNotImplemented: "단계 %{index}('%{id}')는 아직 구현되지 않은 genie 실행을 사용합니다"
  workflow.webhookNotImplemented: "단계 %{index}('%{id}')는 아직 구현되지 않은 webhook 실행을 사용합니다"
  workflow.notRunning: "현재 실행 중인 워크플로가 없습니다"
  workflow.circularDependency: "워크플로 단계에서 순환 종속성이 감지되었습니다"
  workflow.noInteractivePrompt: "워크플로 실행에서는 대화형 프롬프트가 지원되지 않습니다"

  # === Hot exit ===
  hotExit.noWindows: "캡처할 문서 창이 없습니다"
  hotExit.captureEmitFailed: "캡처 요청 발송 실패: %{detail}"
  hotExit.captureTimeout: "캡처 시간 초과: 응답한 창이 없습니다"

  # === Content search ===
  search.queryTooShort: "검색어는 3자 이상이어야 합니다"

  # === CLI install ===
  cli.noFile: "설치가 성공한 것처럼 보이지만 파일이 생성되지 않았습니다."
  cli.mismatch: "설치가 완료되었지만 파일 내용이 예상 스크립트와 일치하지 않습니다."

  # === Genies ===
  genie.pathBlocked: "Genie 경로가 허용된 디렉터리 외부에 있습니다"

  # === MCP ===
  mcp.spawnInProgress: "MCP 사이드카 실행이 이미 진행 중입니다"
  mcp.configMismatch: "구성 검증 실패: 쓴 내용이 예상과 일치하지 않습니다"
`;
