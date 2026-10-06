# AI 지니

AI 지니는 AI를 사용하여 텍스트를 변환하는 프롬프트 템플릿입니다. 텍스트를 선택하고, 지니를 호출한 다음, 에디터를 벗어나지 않고 제안된 변경사항을 검토합니다.

## 빠른 시작

1. **설정 > 통합** 에서 AI 제공자를 구성합니다 ([AI 제공자](/ko/guide/ai-providers) 참조)
2. 에디터에서 일부 텍스트를 선택합니다
3. `Mod + Y`를 눌러 지니 선택기를 엽니다
4. 지니를 선택하거나 자유형 프롬프트를 입력합니다
5. 인라인 제안을 검토합니다 — 수락 또는 거부

## 지니 선택기

`Mod + Y` (또는 메뉴 **편집 → 지니 → 지니 검색…**)를 눌러 단일 통합 입력이 있는 스포트라이트 스타일 오버레이를 엽니다. 같은 하위 메뉴에는 모든 지니가 이름별로 나열되어 있으므로, 메뉴에서 바로 지니를 실행할 수도 있습니다.

**검색 및 자유형** — 타이핑하여 이름, 설명 또는 카테고리로 지니를 필터링합니다. 일치하는 지니가 없으면 입력이 자유형 프롬프트 필드가 됩니다.

**빠른 칩** — 범위가 "선택"이고 입력이 비어 있을 때 일반적인 동작에 대한 원클릭 버튼이 나타납니다 (다듬기, 요약, 문법, 다시 쓰기).

**2단계 자유형** — 지니가 일치하지 않을 때 `Enter`를 한 번 눌러 확인 힌트를 보고, 그 다음 `Enter`를 다시 눌러 AI 프롬프트로 제출합니다. 이렇게 하면 우발적인 제출을 방지합니다.

**범위 순환** — `Tab`을 눌러 범위를 순환합니다: 선택 → 블록 → 문서 → 전체.

**프롬프트 히스토리** — 자유형 모드 (일치하는 지니 없음)에서 `ArrowUp` / `ArrowDown`을 눌러 이전 프롬프트를 순환합니다. `Ctrl + R`을 눌러 검색 가능한 히스토리 드롭다운을 엽니다. 드롭다운의 **기록 지우기** 버튼은 저장된 히스토리(최대 100개 프롬프트)를 묻지 않고 한 번에 비웁니다. 유령 텍스트는 회색 힌트로 가장 최근의 일치하는 프롬프트를 표시합니다 — `Tab`을 눌러 수락하거나, `Escape`를 눌러 닫습니다 (입력한 내용을 바꾸면 다시 나타납니다).

### 처리 피드백

지니를 선택하거나 자유형 프롬프트를 제출한 후 선택기에 인라인 피드백이 표시됩니다:

- **처리 중** — 경과 시간 카운터가 있는 생각 표시기. `Escape`를 눌러 취소합니다.
- **미리보기** — AI 응답이 도착하는 대로 나타납니다: CLI 제공자는 생성되는 대로 스트리밍하고, REST 제공자는 요청이 완료되면 전체 답변을 한 번에 전달합니다. `수락`을 사용하여 적용하거나 `거부`를 사용하여 버립니다.
- **오류** — 문제가 발생하면 `다시 시도` 버튼과 함께 오류 메시지가 나타납니다.

상태 표시줄에도 AI 진행 상황이 표시됩니다 — 실행 중에는 경과 시간이 있는 회전 아이콘, 성공 시에는 짧은 "완료" 플래시, 또는 **다시 시도** 및 **닫기** 버튼이 있는 오류 표시기. **다시 시도** 는 피커를 닫은 뒤에도 실패한 요청을 같은 지니나 프롬프트로 현재 선택 영역에 다시 실행합니다. 다시 실행할 것이 없는 실패 (예: 공급자 미설정) 에서는 표시되지 않습니다. AI가 활성 상태이면 이전에 `F7`로 숨겼더라도 상태 표시줄이 자동으로 표시됩니다.

## 내장 지니

VMark는 네 가지 카테고리에 걸쳐 13개의 지니를 제공합니다:

### 편집

| 지니 | 설명 | 범위 |
|------|------|------|
| 다듬기 | 명확성과 흐름을 개선 | 선택 |
| 요약 | 텍스트를 더 간결하게 만들기 | 선택 |
| 문법 수정 | 문법 및 철자 수정 | 선택 |
| 단순화 | 더 쉬운 언어 사용 | 선택 |

### 창의

| 지니 | 설명 | 범위 |
|------|------|------|
| 확장 | 아이디어를 더 완전한 문장으로 발전 | 선택 |
| 다시 표현 | 같은 내용을 다르게 표현 | 선택 |
| 생동감 | 감각적 세부 사항과 이미지 추가 | 선택 |
| 이어쓰기 | 여기서 글 계속 쓰기 | 블록 |

### 구조

| 지니 | 설명 | 범위 |
|------|------|------|
| 요약 | 문서 요약 | 문서 |
| 개요 | 개요 생성 | 문서 |
| 제목 | 제목 옵션 제안 | 문서 |

### 도구

| 지니 | 설명 | 범위 |
|------|------|------|
| 번역 | 영어로 번역 | 선택 |
| 영어로 다시 쓰기 | 텍스트를 영어로 다시 작성 | 선택 |

## 범위

각 지니는 세 가지 범위 중 하나에서 작동합니다:

- **선택** — 강조 표시된 텍스트. 선택된 것이 없으면 현재 블록으로 대체됩니다.
- **블록** — 커서 위치의 단락 또는 블록 요소.
- **문서** — 전체 문서 콘텐츠.

범위는 AI에 `{{content}}`로 추출되어 전달되는 텍스트를 결정합니다.

::: tip
범위가 **선택** 이지만 선택된 것이 없으면 지니는 현재 단락에서 작동합니다.
:::

## 제안 검토

지니가 실행된 후 제안이 인라인으로 나타납니다:

- **교체** — 빨간색 물결 취소선이 있는 원본 텍스트, 그 뒤에 강조 색상의 흐린 기울임꼴 "고스트" 텍스트로 표시된 새 텍스트
- **삽입** — 소스 블록 뒤에 고스트 텍스트로 표시된 새 텍스트
- **삭제** — 빨간색 물결 취소선이 있는 원본 텍스트

각 제안에는 수락 (체크마크) 및 거부 (X) 버튼이 있습니다.

### 키보드 단축키

| 동작 | 단축키 |
|------|--------|
| 제안 수락 | `Enter` |
| 제안 거부 | `Escape` |
| 다음 제안 | `Tab` |
| 이전 제안 | `Shift + Tab` |
| 모두 수락 | `Mod + Shift + Enter` |
| 모두 거부 | `Mod + Shift + Escape` |

## 상태 표시줄 표시기

AI가 생성 중일 때 상태 표시줄에 경과 시간 카운터가 있는 회전하는 반짝이 아이콘이 표시됩니다 ("생각 중... 3초"). 취소 버튼 (×)으로 요청을 중지할 수 있습니다.

완료 후 짧은 "완료" 체크마크가 3초 동안 깜박입니다. 오류가 발생하면 상태 표시줄에 다시 시도 및 닫기 버튼과 함께 오류 메시지가 표시됩니다.

AI가 활성 상태 (실행 중, 오류 또는 성공)이면 `F7`로 숨겼더라도 상태 표시줄이 자동으로 표시됩니다.

---

## 사용자 정의 지니 작성

직접 지니를 만들 수 있습니다. 각 지니는 YAML 프론트매터와 프롬프트 템플릿이 있는 단일 마크다운 파일입니다.

### 지니 저장 위치

지니는 애플리케이션 데이터 디렉토리에 저장됩니다:

| 플랫폼 | 경로 |
|--------|------|
| macOS | `~/Library/Application Support/app.vmark/genies/` |
| Windows | `%APPDATA%\app.vmark\genies\` |
| Linux | `~/.local/share/app.vmark/genies/` |

메뉴 **편집 → 지니 → 지니 폴더 열기** 에서 이 폴더를 엽니다. 파일을 추가하거나 편집한 후에는 **편집 → 지니 → 지니 새로 고침** 으로 목록을 갱신합니다.

### 디렉토리 구조

하위 디렉토리는 선택기에서 **카테고리** 가 되며, 검색은 재귀적으로 이루어집니다 — 폴더를 원하는 만큼 깊이 중첩할 수 있습니다. 프론트매터에서 `category`를 설정하지 않는 한 지니의 카테고리는 `genies/` 기준의 폴더 경로입니다 (따라서 `academic/thesis/abstract.md`는 `academic/thesis`에 들어갑니다). 심볼릭 링크는 건너뜁니다. 원하는 대로 지니를 구성할 수 있습니다:

```text
genies/
├── editing/
│   ├── polish.md
│   ├── condense.md
│   └── fix-grammar.md
├── creative/
│   ├── expand.md
│   └── rephrase.md
├── academic/          ← your custom category
│   ├── cite.md
│   └── abstract.md
└── my-workflows/      ← another custom category
    └── blog-intro.md
```

### 파일 형식

모든 지니 파일에는 **프론트매터** (메타데이터)와 **템플릿** (프롬프트)의 두 부분이 있습니다.

```markdown
---
description: Improve clarity and flow
scope: selection
category: editing
---

You are an expert editor. Improve the clarity, flow, and conciseness
of the following text while preserving the author's voice and intent.

Return only the improved text — no explanations.

{{content}}
```

파일명 `polish.md`는 선택기에서 표시 이름 "Polish"가 됩니다.

### 프론트매터 필드

| 필드 | 필수 여부 | 값 | 기본값 |
|------|---------|---|--------|
| `description` | 아니요 | 선택기에 표시되는 짧은 설명 | 비어 있음 |
| `scope` | 아니요 | `selection`, `block`, `document` | `selection` |
| `category` | 아니요 | 그룹화를 위한 카테고리 이름 | 하위 디렉토리 이름 |
| `action` | 아니요 | `replace`, `insert` | `replace` |
| `context` | 아니요 | `1`, `2` | `0` (없음) |
| `model` | 아니요 | 제공자 기본값을 재정의하는 모델 식별자 | 제공자 기본값 |

**지니 이름** — 표시 이름은 항상 **파일 이름** (`.md` 없이)에서 파생됩니다. 예를 들어 `fix-grammar.md`는 선택기에서 "Fix Grammar"로 나타납니다. 파일 이름을 변경하여 표시 이름을 변경합니다.

### `{{content}}` 플레이스홀더

`{{content}}` 플레이스홀더는 모든 지니의 핵심입니다. 지니가 실행될 때 VMark는:

1. 범위를 기반으로 **텍스트를 추출** 합니다 (선택된 텍스트, 현재 블록 또는 전체 문서)
2. 템플릿의 모든 `{{content}}`를 추출된 텍스트로 **교체** 합니다
3. 채워진 프롬프트를 활성 AI 제공자에게 **전송** 합니다
4. 응답을 인라인 제안으로 **반환** 합니다 — CLI 제공자에서는 생성되는 대로 스트리밍되고, REST 제공자에서는 한 번에 전달됩니다

예를 들어, 다음 템플릿이 있을 때:

```markdown
Translate the following text into French.

{{content}}
```

사용자가 "Hello, how are you?"를 선택하면 AI는 다음을 받습니다:

```text
Translate the following text into French.

Hello, how are you?
```

AI는 "Bonjour, comment allez-vous ?"로 응답하며, 이 응답은 선택한 텍스트를 교체하는 인라인 제안으로 나타납니다.

### `{{context}}` 플레이스홀더

`{{context}}` 플레이스홀더는 AI에게 읽기 전용 주변 텍스트를 제공합니다 — 따라서 수정하지 않고 인근 블록의 어조, 스타일, 구조를 맞출 수 있습니다.

**작동 방식:**

1. 프론트매터에서 `context: 1` 또는 `context: 2`를 설정하여 ±1 또는 ±2 인근 블록을 포함
2. 주변 텍스트를 삽입할 위치에 템플릿에서 `{{context}}` 사용
3. AI는 컨텍스트를 보지만 제안은 `{{content}}`만 교체합니다

**복합 블록은 하나의 단위입니다** — 인근 블록이 목록, 표, 인용구 또는 details 블록이면 전체 구조가 하나의 블록으로 계산됩니다.

**범위 제한** — 컨텍스트는 `selection` 및 `block` 범위에서만 작동합니다. `document` 범위에서는 콘텐츠가 이미 전체 문서입니다.

**자유형 프롬프트** — 선택기에서 자유형 지시를 입력하면, VMark는 `selection` 및 `block` 범위에 대해 ±1 주변 블록을 컨텍스트로 자동 포함합니다. 별도의 구성이 필요 없습니다.

**하위 호환** — `{{context}}`가 없는 지니는 이전과 똑같이 작동합니다. 템플릿에 `{{context}}`가 없으면 주변 텍스트를 추출하지 않습니다.

**예시 — AI가 받는 내용:**

`context: 1`이고 세 단락으로 된 문서의 두 번째 단락에 커서가 있을 때:

```text
[Before]
First paragraph content here.

[After]
Third paragraph content here.
```

해당 방향에 인근 블록이 없으면 (예: 콘텐츠가 문서의 시작이나 끝에 있을 때) `[Before]`와 `[After]` 섹션은 생략됩니다.

### `action` 필드

기본적으로 지니는 소스 텍스트를 AI 출력으로 **교체** 합니다. `action: insert`를 설정하면 소스 블록 뒤에 출력을 **추가** 합니다.

편집, 재표현, 번역, 문법 수정 등 원본 텍스트를 변환하는 모든 것에 `replace`를 사용합니다.

이어쓰기, 콘텐츠 아래에 요약 생성, 주석 추가 등 원본을 제거하지 않고 새 텍스트를 추가하는 것에 `insert`를 사용합니다.

**예시 — insert 동작:**

```markdown
---
description: Continue writing from here
scope: block
action: insert
---

Continue writing naturally from where the following text leaves off.
Match the author's voice, style, and tone. Write 2-3 paragraphs.

Do not repeat or summarize the existing text — just continue it.

{{content}}
```

### `model` 필드

특정 지니의 기본 모델을 재정의합니다. 간단한 작업에는 더 저렴한 모델을, 복잡한 작업에는 더 강력한 모델을 원할 때 유용합니다.

```markdown
---
description: Quick grammar fix (uses fast model)
scope: selection
model: claude-haiku-4-5-20251001
---

Fix grammar and spelling errors. Return only the corrected text.

{{content}}
```

모델 식별자는 활성 제공자가 받아들이는 값과 일치해야 합니다.

## 효과적인 프롬프트 작성

### 출력 형식에 대해 구체적으로

AI가 무엇을 반환할지 정확히 알려주세요. 이것이 없으면 모델이 설명, 헤더 또는 주석을 추가하는 경향이 있습니다.

```markdown
<!-- Good -->
Return only the improved text — no explanations.

<!-- Bad — AI may wrap output in quotes, add "Here's the improved version:", etc. -->
Improve this text.
```

### 역할 설정

AI에 행동을 고정하는 페르소나를 부여합니다.

```markdown
<!-- Good -->
You are an expert technical editor who specializes in API documentation.

<!-- Okay but less focused -->
Edit the following text.
```

### 범위 제한

AI가 변경하지 않아야 할 것을 알려줍니다. 이는 과도한 편집을 방지합니다.

```markdown
<!-- Good -->
Fix grammar and spelling errors only.
Do not change the meaning, style, or tone.
Do not restructure sentences.

<!-- Bad — gives the AI too much freedom -->
Fix this text.
```

### 프롬프트에 마크다운 사용

프롬프트 템플릿에서 마크다운 서식을 사용할 수 있습니다. AI가 구조화된 출력을 만들기를 원할 때 도움이 됩니다.

```markdown
---
description: Generate a pros/cons analysis
scope: selection
action: insert
---

Analyze the following text and produce a brief pros/cons list.

Format as:

**Pros:**
- point 1
- point 2

**Cons:**
- point 1
- point 2

{{content}}
```

### 프롬프트를 한 가지에 집중

지니 하나에 작업 하나. 여러 작업을 하나의 지니에 합치지 마세요 — 대신 지니를 따로 만드세요.

```markdown
<!-- Good — one clear job -->
---
description: Convert to active voice
scope: selection
---

Rewrite the following text using active voice.
Do not change the meaning.
Return only the rewritten text.

{{content}}
```

## 예시 사용자 정의 지니

### 학술 — 초록 작성

```markdown
---
description: Generate an academic abstract
scope: document
action: insert
---

Read the following paper and write a concise academic abstract
(150-250 words). Follow standard structure: background, methods,
results, conclusion.

{{content}}
```

### 블로그 — 후크 생성

```markdown
---
description: Write an engaging opening paragraph
scope: document
action: insert
---

Read the following draft and write a compelling opening paragraph
that hooks the reader. Use a question, surprising fact, or vivid
scene. Keep it under 3 sentences.

{{content}}
```

### 코드 — 코드 블록 설명

```markdown
---
description: Add a plain-English explanation above code
scope: selection
action: insert
---

Read the following code and write a brief plain-English explanation
of what it does. Use 1-2 sentences. Do not include the code itself
in your response.

{{content}}
```

### 이메일 — 전문적으로 만들기

```markdown
---
description: Rewrite in professional tone
scope: selection
---

Rewrite the following text in a professional, business-appropriate tone.
Keep the same meaning and key points. Remove casual language,
slang, and filler words.

Return only the rewritten text — no explanations.

{{content}}
```

### 번역 — 중국어 간체로

```markdown
---
description: Translate to Simplified Chinese
scope: selection
---

Translate the following text into Simplified Chinese.
Preserve the original meaning, tone, and formatting.
Use natural, idiomatic Chinese — not word-for-word translation.

Return only the translated text — no explanations.

{{content}}
```

### 컨텍스트 인식 — 주변에 맞추기

```markdown
---
description: Rewrite to match surrounding tone and style
scope: selection
context: 1
---

Rewrite the following content to fit naturally with its surrounding context.
Match the tone, style, and level of detail.

Return only the rewritten text — no explanations.

## Surrounding context (do not include in output):
{{context}}

## Content to rewrite:
{{content}}
```

### 검토 — 사실 확인

```markdown
---
description: Flag claims that need verification
scope: selection
action: insert
---

Read the following text and list any factual claims that should be
verified. For each claim, note why it might need checking (e.g.,
specific numbers, dates, statistics, or strong assertions).

Format as a bullet list. If everything looks solid, say
"No claims flagged for verification."

{{content}}
```

## AI 제안

지니가 (자유 형식 채팅 응답이 아니라) 선택 영역에 대한 교체로 의도된 텍스트를 반환하면, VMark는 인라인 diff와 함께 **제안** 으로 표시합니다: 원본 텍스트는 빨간색 물결 취소선으로, 제안된 텍스트는 강조 색상의 흐린 기울임꼴 고스트 텍스트로 표시됩니다. 변경 사항이 영구적으로 적용되기 전에 검토하고 승인하세요.

| 동작 | 단축키 |
|------|--------|
| 포커스된 제안 수락 | `Enter` |
| 포커스된 제안 거부 | `Esc` |
| 다음 / 이전 제안으로 이동 | `Tab` / `Shift + Tab` |
| 문서의 모든 제안 수락 | `Mod + Shift + Enter` _(컨텍스트 인식 — 표 안에 있을 때는 위에 행 추가)_ |
| 문서의 모든 제안 거부 | `Mod + Shift + Escape` |

지니가 여러 단락을 다시 작성하면, 각 교체는 독립적으로 탐색 가능한 별개의 제안입니다. 하나를 수락한다고 다른 것들이 자동 수락되지는 않습니다.

## 워크플로 속의 지니

지니 하나는 프롬프트 하나를 실행합니다. 여러 AI 단계를 연결해야 할 때 — 개요, 그다음 초안, 그다음 다듬기 — 그리고 한 단계의 출력을 다음 단계로 보내야 할 때는 **지니 워크플로**를 사용하세요: 명시적인 데이터 흐름, 선택적 승인 게이트, 단계별 모델, 실시간 실행 다이어그램으로 여러 지니 호출을 조율하는 YAML 파일입니다.

워크플로 단계는 `with: { input: "..." }` 맵으로 지니의 `{{content}}` 플레이스홀더를 채우므로, **여기서 작성한 지니는 워크플로 안에서도 수정 없이 실행됩니다** — 변환이 필요 없습니다.

전체 YAML 스키마, 표현식 구문, 승인, 실행 방법은 [지니 워크플로](/ko/guide/workflows)를 참조하세요.

### 신뢰할 수 없는 콘텐츠 격리

워크플로의 `genie/<name>` 단계가 실행되면, 문서 텍스트, 선택 영역, 파일 내용은 AI 제공자에게
전달되기 전에 고유한 `<<<DOCUMENT-DATA-…>>>` 마커로 감싸지며, 프롬프트는 모델에게 이렇게 격리된
텍스트를 엄격하게 데이터로만 취급하도록 지시합니다. 이 격리는 워크플로 단계에만 적용됩니다 — 선택기에서
직접 실행한 지니는 범위의 텍스트를 그대로 제공자에게 보냅니다. 이는 AI에게 지시를 몰래 끼워 넣으려는
문서("지시를 무시하고 … 실행하라")를 막아 주며 — 명령을 실행할 수 있는 CLI 제공자(Claude Code,
Codex, Gemini CLI)에서 특히 중요합니다. 신뢰할 수 없는 출처의 파일에 지니를 실행할 때는 인터넷에서 받은
스크립트를 실행할 때와 같은 주의를 기울이세요: 격리는 강력한 완화 수단이지, 절대적인 보장은 아닙니다.

## 제한 사항

- 지니는 **WYSIWYG 모드** 에서만 작동합니다. 소스 모드에서는 이를 설명하는 토스트 알림이 표시됩니다.
- 한 번에 하나의 지니만 실행할 수 있습니다. AI가 이미 생성 중이면 선택기가 다른 것을 시작하지 않습니다.
- `{{content}}` 플레이스홀더는 문자 그대로 교체됩니다 — 조건부나 루프를 지원하지 않습니다.
- 매우 큰 문서는 `scope: document`를 사용할 때 제공자 토큰 제한에 도달할 수 있습니다.

## 문제 해결

**"AI 제공자를 사용할 수 없음"** — 설정 > 통합을 열어 제공자를 구성하세요. [AI 제공자](/ko/guide/ai-providers)를 참조하세요.

**지니가 선택기에 나타나지 않음** — 파일에 `.md` 확장자(또는 [워크플로 지니](/ko/guide/workflow-genies)의 경우 `.yml`/`.yaml`)가 있고 `---` 펜스가 있는 유효한 프론트매터가 있는지 확인하세요. 하위 폴더는 최대 여덟 단계 깊이까지(전체 항목은 최대 10,000개) 검색되며, 심볼릭 링크는 건너뜁니다. 파일을 추가한 후에는 **편집 → 지니 → 지니 새로 고침** 을 실행하세요.

**AI가 쓰레기 또는 오류를 반환함** — API 키가 올바르고 모델 이름이 제공자에게 유효한지 확인하세요. 오류 세부 사항은 터미널/콘솔을 확인하세요.

**제안이 기대에 맞지 않음** — 프롬프트를 개선하세요. 제약 사항 추가 ("텍스트만 반환", "설명 없이"), 역할 설정, 또는 범위 좁히기.

## 참고

- [AI 제공자](/ko/guide/ai-providers) — CLI 또는 REST API 제공자 구성
- [키보드 단축키](/ko/guide/shortcuts) — 전체 단축키 참조
- [MCP 도구](/ko/guide/mcp-tools) — MCP를 통한 외부 AI 통합
