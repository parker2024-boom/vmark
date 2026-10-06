# AI 통합 (MCP)

VMark에는 Claude와 같은 AI 어시스턴트가 에디터와 직접 상호작용할 수 있게 해주는 내장 MCP (Model Context Protocol) 서버가 포함되어 있습니다.

## MCP란?

[Model Context Protocol](https://modelcontextprotocol.io/)은 AI 어시스턴트가 외부 도구 및 애플리케이션과 상호작용할 수 있게 해주는 개방형 표준입니다. VMark의 MCP 서버는 에디터 기능을 AI 어시스턴트가 다음과 같은 작업에 사용할 수 있는 도구로 노출합니다:

- 문서 내용 읽기 및 쓰기
- 서식 적용 및 구조 생성
- 문서 탐색 및 관리
- 특수 콘텐츠 삽입 (수학, 다이어그램, 위키 링크)

## 빠른 설정

VMark는 원클릭 설치로 AI 어시스턴트 연결을 쉽게 만들어 줍니다.

### 1. MCP 서버 활성화

**설정 → 통합** 을 열고 MCP 서버를 활성화합니다:

<div class="screenshot-container">
  <img src="/screenshots/mcp-settings-server.png" alt="VMark MCP Server Settings" />
</div>

- **MCP 서버 사용** - AI 연결을 허용하려면 켭니다
- **시작 시 자동 실행** - VMark 열 때 자동 시작
- **새 위치로 저장 및 지니 결과 자동 승인** - 기본적으로 꺼져 있습니다. AI가 묻지 않고 문서를 *새* 경로에 저장할 수 있게 하고, 지니가 결과를 제안 대신 바로 적용할 수 있게 합니다. 일반적인 AI 쓰기는 이 설정의 제한을 받지 않습니다 — 그 안전망은 [편집 체크포인트 기록](#편집-체크포인트)입니다 ([편집 작동 방식](#편집-작동-방식) 참조)

### 2. 설정 설치

AI 어시스턴트에 맞는 **설치** 를 클릭합니다:

<div class="screenshot-container">
  <img src="/screenshots/mcp-settings-install.png" alt="VMark MCP Install Configuration" />
</div>

지원되는 AI 어시스턴트:
- **Claude Desktop** - Anthropic의 데스크톱 앱
- **Claude Code** - 개발자용 CLI
- **Codex CLI** - OpenAI의 코딩 어시스턴트
- **Antigravity CLI** - Google의 `agy`, Gemini CLI의 후속 도구
- **Grok CLI** - xAI의 코딩 에이전트
- **opencode** - 특정 제공자에 묶이지 않는 오픈 소스 터미널 에이전트

**설치는 클라이언트별 자격 증명을 기록합니다.** 설치는 VMark MCP 서버의 경로와 함께, 클라이언트 자체 설정 파일의 `env.VMARK_MCP_TOKEN` (opencode는 `environment.VMARK_MCP_TOKEN`) 아래에 비밀 토큰을 넣습니다. 클라이언트마다 고유한 토큰을 받으며, 토큰은 다른 어디에도 저장되지 않습니다. 이 토큰은 클라이언트가 보고하는 이름을 믿는 대신, 어떤 클라이언트가 연결하는지 VMark에 알려 줍니다. 현재 토큰이 필요한 것은 위임된 작업 — 사용자를 대신해 `coherence_resolve`로 정합성 질문에 답하는 것 — 뿐이며, 다른 모든 도구는 토큰 없이도 동작합니다. 설치와 **복구** 는 아직 유효한 토큰을 그대로 유지합니다. 새 토큰을 발급하려면 제거한 뒤 다시 설치하세요. 어느 쪽이든 그 후에는 AI 클라이언트를 재시작하세요. 토큰은 비밀번호처럼 다루세요: 설정 파일을 이슈나 채팅에 붙여 넣지 마세요.

::: info Gemini CLI는 지원이 중단되었습니다
Google은 Gemini CLI를 Antigravity로 대체했습니다. 이전 VMark 설치가
`~/.gemini/settings.json`에 `vmark` 항목을 남겨 두었다면, 통합 패널에 해당 항목의
**지원 중단** 행이 **제거** 버튼과 함께 표시됩니다. 새로 설치할 때는 대신
Antigravity를 대상으로 합니다.
:::

::: info 기타 MCP 호환 클라이언트
Cursor, Windsurf 등 기타 MCP 호환 클라이언트도 VMark의 MCP 서버에 연결할 수 있습니다. MCP 서버 바이너리 경로를 지정하여 수동으로 구성하세요 (아래 [수동 설정](#수동-설정) 참조).
:::

#### CC-Switch

CC-Switch로 AI CLI를 관리한다면, 설치 화면에 **CC-Switch** 행도 표시됩니다. **CC-Switch에 추가** 는 VMark의 MCP 서버 — 그 바이너리 경로 — 를 CC-Switch에 넘기는 `ccswitch://v1/import` 링크를 엽니다. 그러면 CC-Switch가 그곳에서 관리하는 CLI에 `vmark` 항목을 기록합니다. 링크를 직접 붙여 넣고 싶다면 복사 버튼으로 링크 자체를 가져올 수 있습니다. 이 행은 VMark가 자체 MCP 바이너리를 확인할 때까지 비활성화됩니다.

#### 상태 아이콘

각 제공자에 상태 표시기가 표시됩니다:

| 아이콘 | 상태 | 의미 |
|--------|------|------|
| ✓ 초록 | 유효 | 설정이 올바르고 작동 중 |
| ⚠ 황색 | 경로 불일치 | VMark가 이동됨 — **복구** 클릭 |
| ✗ 빨강 | 바이너리 없음 | MCP 바이너리를 찾을 수 없음 — VMark 재설치 |
| 🗎 빨강 | 설정 읽기 불가 | VMark가 설정 파일을 읽거나 파싱할 수 없어, VMark 항목이 있는지 알 수 없음. 메시지에 파일과 이유가 표시됩니다. 파일을 수정하거나 옮긴 다음 **다시 확인** 을 클릭하세요 — 파싱될 때까지 설치와 복구는 보류됩니다. VMark가 읽을 수 없는 파일에 쓰면 내용이 손상될 위험이 있기 때문입니다 |
| ○ 회색 | 미설정 | 설치되지 않음 — **설치** 클릭 |

::: tip VMark를 이동했나요?
VMark.app을 다른 위치로 이동하면 상태가 황색 "경로 불일치"로 표시됩니다. **복구** 버튼을 클릭하기만 하면 새 경로로 설정이 업데이트됩니다.
:::

### 3. AI 어시스턴트 재시작

설치 또는 복구 후, **AI 어시스턴트를 완전히 재시작** 하세요 (종료 후 다시 열기). 새 설정을 로드합니다. VMark는 각 설정 변경 후 알림을 표시합니다.

### 4. 사용해 보기

AI 어시스턴트에서 다음과 같은 명령을 시도해 보세요:
- *"VMark 문서에 무엇이 있나요?"*
- *"양자 컴퓨팅 요약을 VMark에 작성해 주세요"*
- *"문서에 목차를 추가해 주세요"*

## 실제 사용 예시

Claude에게 질문하고 답변을 VMark 문서에 직접 작성하도록 합니다:

<div class="screenshot-container">
  <img src="/screenshots/mcp-claude.png" alt="Claude Desktop using VMark MCP" />
  <p class="screenshot-caption">Claude Desktop이 <code>document</code> → <code>set_content</code>를 호출하여 VMark에 씁니다</p>
</div>

<div class="screenshot-container">
  <img src="/screenshots/mcp-result.png" alt="Content rendered in VMark" />
  <p class="screenshot-caption">콘텐츠가 VMark에 즉시 나타나며 완전히 서식이 적용됩니다</p>
</div>

<!-- Styles in style.css -->

## 수동 설정

수동으로 설정하려면 다음 설정 파일 위치를 참조하세요:

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 또는 `%APPDATA%\Claude\claude_desktop_config.json` (Windows)를 편집합니다:

```json
{
  "mcpServers": {
    "vmark": {
      "command": "/Applications/VMark.app/Contents/MacOS/vmark-mcp-server"
    }
  }
}
```

### Claude Code

`~/.claude.json` 또는 프로젝트의 `.mcp.json`을 편집합니다:

```json
{
  "mcpServers": {
    "vmark": {
      "command": "/Applications/VMark.app/Contents/MacOS/vmark-mcp-server"
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`을 편집합니다:

```toml
[mcp_servers.vmark]
command = "/Applications/VMark.app/Contents/MacOS/vmark-mcp-server"
```

### Antigravity CLI

`~/.gemini/config/mcp_config.json`을 편집합니다:

```json
{
  "mcpServers": {
    "vmark": {
      "command": "/Applications/VMark.app/Contents/MacOS/vmark-mcp-server"
    }
  }
}
```

### Grok CLI

`~/.grok/config.toml`을 편집합니다:

```toml
[mcp_servers.vmark]
command = "/Applications/VMark.app/Contents/MacOS/vmark-mcp-server"
```

### opencode

`~/.config/opencode/opencode.json`을 편집합니다. opencode의 스키마는
`mcpServers` 스키마와 다릅니다: 키는 `mcp`이고, `command`는 프로그램과 그 인수를
담은 하나의 배열입니다:

```json
{
  "mcp": {
    "vmark": {
      "type": "local",
      "command": ["/Applications/VMark.app/Contents/MacOS/vmark-mcp-server"],
      "enabled": true
    }
  }
}
```

직접 작성한 설정이 `opencode.jsonc`에 있다면 그대로 두세요 — opencode는 두 파일을
병합하므로, `opencode.json`의 VMark 항목은 추가로 더해집니다. VMark가 일반 JSON
파일에 쓰는 이유는 `.jsonc` 파일의 주석을 보존한 채로 다시 쓸 수 없기 때문입니다.

::: warning `opencode.jsonc`에 이미 있는 `vmark` 항목이 우선합니다
opencode는 `config.json`, `opencode.json`, `opencode.jsonc` 순서로 병합하며, 마지막에
읽은 파일이 우선합니다. 따라서 이전에 `opencode.jsonc`에 `vmark` 항목을 직접 추가했다면,
그 항목이 VMark가 관리하는 항목을 재정의합니다 — VMark는 제공자를 유효하다고 보고하지만
opencode는 계속 예전 항목 (과 그 오래된 바이너리 경로) 을 사용합니다. 직접 작성한
`mcp.vmark` 블록을 `opencode.jsonc`에서 삭제하고 통합 패널이 관리하도록 하세요.
:::

::: tip 바이너리 경로 찾기
macOS에서 MCP 서버 바이너리는 VMark.app 내부에 있습니다:
- `VMark.app/Contents/MacOS/vmark-mcp-server`

Windows:
- `C:\Program Files\VMark\vmark-mcp-server.exe`

Linux:
- `/usr/bin/vmark-mcp-server` (또는 설치 위치)

포트는 자동으로 검색됩니다 — `args`는 필요하지 않습니다.
:::

### CLI 플래그 (고급)

MCP 서버 바이너리는 진단 및 레거시 설정을 위한 몇 가지 플래그를 지원합니다:

| 플래그 | 설명 |
|---|---|
| `--version` (또는 `-v`) | 버전을 출력하고 종료합니다 (실행 중인 VMark 와 일치해야 합니다). |
| `--health-check` | 바이너리의 자가 테스트를 실행하고 종료합니다: 내장된 모의 브리지를 대상으로 MCP 서버를 시작하고, 버전과 도구 개수를 JSON으로 출력하며, 도구 개수가 이 빌드의 예상과 다르면 0이 아닌 코드로 종료합니다. 실행 중인 VMark에는 **연결하지 않습니다** — 바이너리가 실행되는지 확인할 때 사용하고, 실제 브리지 상태는 **설정 → 통합** 에서 확인하세요. |
| `--port <번호>` | 수동 포트 재정의. 자동 검색 핸드셰이크를 건너뛰고 지정된 포트에 연결합니다. 브리지 포트가 외부에서 고정된 레거시 설정에서만 유용합니다. 자동 검색 방식을 권장합니다. |

예시:

```bash
vmark-mcp-server --health-check
vmark-mcp-server --version
vmark-mcp-server --port 9223   # 레거시 / 수동
```

## 작동 방식

```text
AI 어시스턴트 <--stdio--> MCP 서버 <--WebSocket--> VMark 에디터
```

1. **VMark가 WebSocket 브리지를 시작** 합니다 — 실행 시 사용 가능한 포트에서
2. **MCP 서버** 가 VMark의 앱 데이터 디렉터리에서 포트와 인증 토큰을 읽습니다
3. **MCP 서버** 가 WebSocket 브리지를 통해 연결 및 인증합니다
4. **AI 어시스턴트** 는 stdio를 통해 MCP 서버와 통신합니다
5. **명령이 브리지를 통해** VMark 에디터로 전달됩니다

## 사용 가능한 기능

연결되면 AI 어시스턴트는 아홉 가지 도구를 사용할 수 있습니다:

| 도구 | 다루는 범위 |
|------|-------------|
| `session` | 창, 탭, 활성 문서, 브라우저 탭 (읽기 전용) |
| `workspace` | 새로 만들기, 열기, 저장, 다른 이름으로 저장, 닫기, 탭 전환, 창 포커스, 워크스페이스 열기 |
| `document` | 문서 전체를 Markdown으로 읽고 쓰기, CJK 서식 변환 |
| `selection` | 선택한 텍스트 읽기 및 바꾸기 |
| `workflow` | GitHub Actions YAML용 CST 안전 패치와 유효성 검사 |
| `browser` / `browser_read` | macOS의 내장 브라우저 자동화 — 변경 작업과 읽기 전용 작업의 두 부분 |
| `coherence` / `coherence_resolve` | 정합성 계층 읽기, 사용자가 부여한 위임 범위에서 오래된 연결 해결 |

서식은 별도의 도구가 아닙니다: 어시스턴트가 Markdown을 작성하므로, 제목, 표, 수식, 다이어그램은 어시스턴트가 작성하는 그대로입니다.

전체 문서는 [MCP 도구 참조](/ko/guide/mcp-tools)를 참조하세요.

## MCP 상태 확인

VMark는 MCP 서버 상태를 확인하는 여러 방법을 제공합니다:

### 상태 표시줄 표시기

상태 표시줄 오른쪽에 **MCP** 표시기가 표시됩니다. 주의가 필요한 상황이면
위성 아이콘 옆에 짧은 상태 단어가 나타나고, 정상 연결일 때는 초록 아이콘만
표시됩니다. 마우스를 올리면 현재 연결된 AI 클라이언트가 이름과 버전과 함께 나열됩니다:

| 색상 | 단어 | 상태 |
|------|------|------|
| 초록 | — | 연결됨 및 실행 중 |
| 회색 | `off` | 연결 끊김 또는 중지됨 |
| 깜빡임 (애니메이션) | `…` | 시작 중 |
| 빨강 | `error` | 서버 실패 — 마우스를 올려 이유 확인 |

시작은 보통 1-2초 내에 완료됩니다.

표시기를 클릭하면 **설정 → 통합** 이 열립니다.

### 설정 패널

**설정 → 통합** 이 또 하나의 상태 확인 화면입니다 — 별도의 상태 대화상자는 없습니다. 브리지가 실행 중이면 수신 대기 중인 주소 (`localhost:<port>`, 복사 버튼 포함) 와 연결된 AI 클라이언트 수가 표시되며, 몇 초마다 갱신됩니다. **연결 테스트** 버튼 (브리지가 중지된 동안에는 **사이드카 확인** 으로 표시됨) 은 사이드카 자체의 `--health-check`를 실행하고 사이드카 버전, 도구 개수, 마지막 확인 시간을 보고합니다 — 설치된 바이너리가 동작하는지를 확인할 뿐, 클라이언트가 연결되어 있는지를 확인하지는 않습니다.

## 문제 해결

### "연결 거부" 또는 "활성 에디터 없음"

- VMark가 실행 중이고 문서가 열려 있는지 확인합니다
- 설정 → 통합에서 MCP 서버가 활성화되어 있는지 확인합니다
- MCP 브리지가 "실행 중" 상태인지 확인합니다
- 연결이 끊어진 경우 VMark를 재시작합니다

### VMark 이동 후 경로 불일치

VMark.app을 다른 위치로 이동한 경우 (예: 다운로드에서 응용 프로그램으로), 설정이 이전 경로를 가리킵니다:

1. **설정 → 통합** 을 엽니다
2. 영향을 받는 제공자 옆의 황색 ⚠ 경고 아이콘을 찾습니다
3. **복구** 를 클릭하여 경로를 업데이트합니다
4. AI 어시스턴트를 재시작합니다

### AI 어시스턴트에 도구가 표시되지 않음

- 설정 설치 후 AI 어시스턴트를 재시작합니다
- 설정이 설치되었는지 확인합니다 (설정에서 초록 체크 표시 확인)
- AI 어시스턴트의 로그에서 MCP 연결 오류를 확인합니다

### "활성 에디터 없음"으로 명령 실패

- VMark에서 문서 탭이 활성 상태인지 확인합니다
- 에디터 영역을 클릭하여 포커스를 줍니다
- 일부 명령은 먼저 텍스트를 선택해야 합니다

## 편집 작동 방식

간소화된 MCP 인터페이스는 읽기-쓰기 흐름을 따릅니다: AI 어시스턴트는 `document.read`를 호출해 현재 내용과 리비전 토큰을 받고, 이를 바탕으로 판단한 다음, 새 전체 내용으로 `document.write`를 호출합니다. 리비전 토큰은 모르는 사이에 덮어쓰는 것을 막아 줍니다: AI가 생각하는 동안 VMark에서 입력했다면, 쓰기는 `STALE`을 반환하고 AI는 다시 읽습니다.

GitHub Actions 워크플로우 YAML 파일에는 AI가 대신 `workflow.apply_patch`를 사용합니다 — VMark의 CST 인식 변경기는 원시 텍스트 재작성으로는 잃어버릴 주석, 앵커, 키 순서를 보존합니다.

`document.write`, `selection.set`, `workflow.apply_patch`에는 미리보기 단계가 없습니다 — 리비전 검사를 통과하는 즉시 변경 사항이 에디터에 반영됩니다. 안전망은 아래의 [편집 체크포인트 기록](#편집-체크포인트)입니다. 반영되기 전에 검토하고 싶다면 문서를 git으로 관리하고 diff를 검토하세요. 유일한 승인 게이트는 **새 위치로 저장 및 지니 결과 자동 승인** 입니다: 이 설정이 꺼져 있으면 (기본값) AI는 문서를 새 경로에 저장할 수 없습니다 — `workspace.save_as`는 `APPROVAL_REQUIRED`를 반환하고 VMark는 파일 이름을 알려 주는 토스트를 표시합니다. 설정이 켜져 있어도 `save_as`는 이미 존재하는 다른 파일을 덮어쓰지 않습니다.

## 편집 체크포인트

모든 AI 문서 변경 — `document.write`, `document.transform`, `selection.set`, `workflow.apply_patch` — 은 먼저 교체하려는 내용의 스냅숏을 만듭니다. 상태 표시줄의 **기록** 버튼을 누르면 포커스된 탭에 대해 각 AI 쓰기가 언제, 어떤 도구로 이루어졌는지 나열하는 팝오버가 열립니다. 행마다 클릭 한 번으로 실행하는 **이 쓰기 이전 상태로 복원** 이 있고, **이 탭의 기록 지우기** 동작도 있습니다. 복원하면 이전 내용이 되돌아오고 문서의 리비전이 올라가므로, 이전 리비전을 가진 AI 클라이언트는 다음 쓰기에서 복원한 내용을 덮어쓰는 대신 `STALE`을 받습니다.

체크포인트는 파일별로 보관되며 — 파일당 50개, 전체 5 MiB — VMark 앱 데이터 디렉터리의 `mcp-checkpoints.jsonl`에 저장되므로 재시작 후에도 유지됩니다. 제목 없는 문서는 탭별로 체크포인트가 만들어집니다.

## 보안 참고 사항

- MCP 서버는 로컬 연결만 허용합니다 (localhost)
- 외부 서버로 데이터가 전송되지 않습니다
- AI 파일 작업은 열린 워크스페이스 루트와 열린 문서의 폴더로 제한됩니다 — [개인 정보 보호](/ko/guide/privacy#ai-어시스턴트가-접근할-수-있는-범위) 참조
- 모든 처리가 사용자 머신에서 이루어집니다
- WebSocket 브리지는 로컬에서만 접근 가능합니다
- 설치된 각 클라이언트는 자체 `VMARK_MCP_TOKEN`을 가집니다. 토큰이 없거나, 알 수 없는 토큰이거나, 다른 클라이언트와 공유하는 토큰을 가진 클라이언트도 연결은 되지만, 위임된 작업은 거부되며 **설정 → 통합** 에서 해당 클라이언트를 설치하고 재시작하라는 메시지가 표시됩니다

## 다음 단계

- 사용 가능한 모든 [MCP 도구](/ko/guide/mcp-tools) 탐색하기
- [키보드 단축키](/ko/guide/shortcuts) 알아보기
- 다른 [기능](/ko/guide/features) 확인하기
