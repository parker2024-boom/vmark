# Gênios de IA

Os Gênios de IA são modelos de prompt que transformam seu texto usando IA. Selecione o texto, invoque um gênio e revise as alterações sugeridas — tudo sem sair do editor.

## Início Rápido

1. Configure um provedor de IA em **Configurações > Integrações** (veja [Provedores de IA](/pt-BR/guide/ai-providers))
2. Selecione algum texto no editor
3. Pressione `Mod + Y` para abrir o seletor de gênios
4. Escolha um gênio ou digite um prompt livre
5. Revise a sugestão inline — aceite ou rejeite

## O Seletor de Gênios

Pressione `Mod + Y` (ou menu **Editar → Assistentes → Pesquisar assistentes…**) para abrir uma sobreposição no estilo Spotlight com uma única entrada unificada. O mesmo submenu lista todos os gênios pelo nome, então um gênio também pode ser executado diretamente pelo menu.

**Pesquisa e formulário livre** — Comece a digitar para filtrar gênios por nome, descrição ou categoria. Se nenhum gênio corresponder, a entrada se torna um campo de prompt livre.

**Chips Rápidos** — Quando o escopo é "seleção" e a entrada está vazia, botões de um clique aparecem para ações comuns (Polir, Condensar, Gramática, Reformular).

**Formulário livre em duas etapas** — Quando nenhum gênio corresponder, pressione `Enter` uma vez para ver uma dica de confirmação, depois `Enter` novamente para enviar como prompt de IA. Isso evita envios acidentais.

**Ciclo de escopo** — Pressione `Tab` para ciclar entre escopos: seleção → bloco → documento → todos.

**Histórico de prompts** — No modo livre (sem gênios correspondentes), pressione `ArrowUp` / `ArrowDown` para ciclar pelos prompts anteriores. Pressione `Ctrl + R` para abrir um dropdown de histórico pesquisável; o botão **Limpar histórico** dele esvazia de uma vez o histórico salvo (até 100 prompts), sem pedir confirmação. O texto fantasma mostra o prompt correspondente mais recente como uma dica cinza — pressione `Tab` para aceitá-la ou `Escape` para dispensá-la (ela volta assim que você altera o que digitou).

### Feedback de Processamento

Após selecionar um gênio ou enviar um prompt livre, o seletor mostra feedback inline:

- **Processando** — Um indicador de pensamento com contador de tempo decorrido. Pressione `Escape` para cancelar.
- **Visualização** — A resposta da IA aparece à medida que chega: provedores CLI a transmitem enquanto ela é gerada, já os provedores REST entregam a resposta inteira de uma vez quando a solicitação termina. Use `Aceitar` para aplicar ou `Rejeitar` para descartar.
- **Erro** — Se algo der errado, a mensagem de erro aparece com um botão `Tentar Novamente`.

A barra de status também mostra o progresso da IA — um ícone giratório com tempo decorrido enquanto executa, um breve flash "Concluído" no sucesso, ou um indicador de erro com botões **Tentar novamente** e **Dispensar**. **Tentar novamente** executa de novo a solicitação que falhou — o mesmo gênio ou prompt, na seleção atual — mesmo depois que o seletor foi fechado; o botão não aparece quando não há nada a repetir, como sem provedor. A barra de status é exibida automaticamente quando a IA tem status ativo, mesmo que você a tenha ocultado anteriormente com `F7`.

## Gênios Integrados

O VMark vem com 13 gênios em quatro categorias:

### Edição

| Gênio | Descrição | Escopo |
|-------|-----------|--------|
| Polir | Melhorar clareza e fluxo | Seleção |
| Condensar | Tornar o texto mais conciso | Seleção |
| Corrigir Gramática | Corrigir gramática e ortografia | Seleção |
| Simplificar | Usar linguagem mais simples | Seleção |

### Criativo

| Gênio | Descrição | Escopo |
|-------|-----------|--------|
| Expandir | Desenvolver ideia em prosa mais completa | Seleção |
| Reformular | Dizer a mesma coisa de forma diferente | Seleção |
| Vívido | Adicionar detalhes sensoriais e imagens | Seleção |
| Continuar | Continuar escrevendo a partir daqui | Bloco |

### Estrutura

| Gênio | Descrição | Escopo |
|-------|-----------|--------|
| Resumir | Resumir o documento | Documento |
| Esboço | Gerar um esboço | Documento |
| Título | Sugerir opções de título | Documento |

### Ferramentas

| Gênio | Descrição | Escopo |
|-------|-----------|--------|
| Traduzir | Traduzir para inglês | Seleção |
| Reescrever em Inglês | Reescrever texto em inglês | Seleção |

## Escopo

Cada gênio opera em um dos três escopos:

- **Seleção** — O texto destacado. Se nada estiver selecionado, volta ao bloco atual.
- **Bloco** — O parágrafo ou elemento de bloco na posição do cursor.
- **Documento** — O conteúdo completo do documento.

O escopo determina qual texto é extraído e passado para a IA como `{{content}}`.

::: tip
Se o escopo for **Seleção** mas nada estiver selecionado, o gênio opera no parágrafo atual.
:::

## Revisando Sugestões

Após a execução de um gênio, a sugestão aparece inline:

- **Substituir** — Texto original com um tachado ondulado vermelho, seguido do novo texto como texto "fantasma" em itálico esmaecido, na cor de destaque
- **Inserir** — Novo texto mostrado como texto fantasma após o bloco de origem
- **Excluir** — Texto original com um tachado ondulado vermelho

Cada sugestão tem botões de aceitar (marca de verificação) e rejeitar (X).

### Atalhos de Teclado

| Ação | Atalho |
|------|--------|
| Aceitar sugestão | `Enter` |
| Rejeitar sugestão | `Escape` |
| Próxima sugestão | `Tab` |
| Sugestão anterior | `Shift + Tab` |
| Aceitar todas | `Mod + Shift + Enter` |
| Rejeitar todas | `Mod + Shift + Escape` |

## Indicador da Barra de Status

Enquanto a IA está gerando, a barra de status mostra um ícone de brilho giratório com um contador de tempo decorrido ("Pensando... 3s"). Um botão de cancelar (×) permite parar a solicitação.

Após a conclusão, uma breve marca de verificação "Concluído" pisca por 3 segundos. Se ocorrer um erro, a barra de status mostra a mensagem de erro com botões Tentar Novamente e Dispensar.

A barra de status é exibida automaticamente quando a IA tem status ativo (executando, erro ou sucesso), mesmo que você a tenha ocultado com `F7`.

---

## Escrevendo Gênios Personalizados

Você pode criar seus próprios gênios. Cada gênio é um único arquivo Markdown com frontmatter YAML e um modelo de prompt.

### Onde os Gênios Ficam

Os gênios são armazenados no diretório de dados do aplicativo:

| Plataforma | Caminho |
|------------|---------|
| macOS | `~/Library/Application Support/app.vmark/genies/` |
| Windows | `%APPDATA%\app.vmark\genies\` |
| Linux | `~/.local/share/app.vmark/genies/` |

Abra esta pasta no menu **Editar → Assistentes → Abrir pasta de assistentes**; depois de adicionar ou editar arquivos, **Editar → Assistentes → Recarregar assistentes** atualiza a lista.

### Estrutura de Diretório

Subdiretórios se tornam **categorias** no seletor, e a varredura é recursiva — aninhe pastas tão fundo quanto quiser; a categoria de um gênio é o caminho da pasta dele relativo a `genies/` (assim `academic/thesis/abstract.md` vai para `academic/thesis`), a menos que o frontmatter defina `category`. Links simbólicos são ignorados. Você pode organizar os gênios como quiser:

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

### Formato do Arquivo

Todo arquivo de gênio tem duas partes: **frontmatter** (metadados) e **template** (o prompt).

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

O nome do arquivo `polish.md` se torna o nome de exibição "Polish" no seletor.

### Campos do Frontmatter

| Campo | Obrigatório | Valores | Padrão |
|-------|-------------|---------|--------|
| `description` | Não | Breve descrição exibida no seletor | Vazio |
| `scope` | Não | `selection`, `block`, `document` | `selection` |
| `category` | Não | Nome da categoria para agrupamento | Nome do subdiretório |
| `action` | Não | `replace`, `insert` | `replace` |
| `context` | Não | `1`, `2` | `0` (nenhum) |
| `model` | Não | Identificador de modelo para substituir o padrão do provedor | Padrão do provedor |

**Nome do gênio** — O nome de exibição é sempre derivado do **nome do arquivo** (sem `.md`). Por exemplo, `fix-grammar.md` aparece como "Fix Grammar" no seletor. Renomeie o arquivo para alterar o nome de exibição.

### O Placeholder `{{content}}`

O placeholder `{{content}}` é o núcleo de todo gênio. Quando um gênio é executado, o VMark:

1. **Extrai o texto** com base no escopo (texto selecionado, bloco atual ou documento completo)
2. **Substitui** todo `{{content}}` no seu template pelo texto extraído
3. **Envia** o prompt preenchido para o provedor de IA ativo
4. **Retorna** a resposta como sugestão inline — transmitida à medida que é gerada por um provedor CLI, de uma só vez por um provedor REST

Por exemplo, com este template:

```markdown
Translate the following text into French.

{{content}}
```

Se o usuário selecionar "Hello, how are you?", a IA recebe:

```text
Translate the following text into French.

Hello, how are you?
```

A IA responde com "Bonjour, comment allez-vous ?" e aparece como sugestão inline substituindo o texto selecionado.

### O Placeholder `{{context}}`

O placeholder `{{context}}` fornece à IA texto ao redor somente leitura — para que ela possa corresponder ao tom, estilo e estrutura dos blocos próximos sem modificá-los.

**Como funciona:**

1. Defina `context: 1` ou `context: 2` no frontmatter para incluir ±1 ou ±2 blocos vizinhos
2. Use `{{context}}` no seu template onde você quer que o texto ao redor seja injetado
3. A IA vê o contexto mas a sugestão só substitui `{{content}}`

**Blocos compostos são atômicos** — se um vizinho for uma lista, tabela, citação ou bloco de detalhes, a estrutura inteira conta como um bloco.

**Restrições de escopo** — O contexto funciona apenas com escopos `selection` e `block`. Para escopo `document`, o conteúdo já É o documento completo.

**Prompts livres** — Quando você digita uma instrução livre no seletor, o VMark inclui automaticamente ±1 bloco ao redor como contexto para escopos `selection` e `block`. Sem configuração necessária.

**Compatível com versões anteriores** — Gênios sem `{{context}}` funcionam exatamente como antes. Se o template não contiver `{{context}}`, nenhum texto ao redor é extraído.

**Exemplo — o que a IA recebe:**

Com `context: 1` e o cursor no segundo parágrafo de um documento de três parágrafos:

```text
[Before]
First paragraph content here.

[After]
Third paragraph content here.
```

As seções `[Before]` e `[After]` são omitidas quando não há vizinhos nessa direção (por exemplo, o conteúdo está no início ou no final do documento).

### O Campo `action`

Por padrão, os gênios **substituem** o texto de origem pela saída da IA. Defina `action: insert` para **acrescentar** a saída após o bloco de origem em vez disso.

Use `replace` para: edição, reformulação, tradução, correções gramaticais — qualquer coisa que transforme o texto original.

Use `insert` para: continuar escrevendo, gerar resumos abaixo do conteúdo, adicionar comentários — qualquer coisa que adicione novo texto sem remover o original.

**Exemplo — ação insert:**

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

### O Campo `model`

Substitua o modelo padrão para um gênio específico. Útil quando você quer um modelo mais barato para tarefas simples ou um mais poderoso para tarefas complexas.

```markdown
---
description: Quick grammar fix (uses fast model)
scope: selection
model: claude-haiku-4-5-20251001
---

Fix grammar and spelling errors. Return only the corrected text.

{{content}}
```

O identificador do modelo deve corresponder ao que seu provedor ativo aceita.

## Escrevendo Prompts Eficazes

### Seja Específico Sobre o Formato de Saída

Diga à IA exatamente o que retornar. Sem isso, os modelos tendem a adicionar explicações, cabeçalhos ou comentários.

```markdown
<!-- Good -->
Return only the improved text — no explanations.

<!-- Bad — AI may wrap output in quotes, add "Here's the improved version:", etc. -->
Improve this text.
```

### Defina um Papel

Dê à IA uma persona para ancorar seu comportamento.

```markdown
<!-- Good -->
You are an expert technical editor who specializes in API documentation.

<!-- Okay but less focused -->
Edit the following text.
```

### Restrinja o Escopo

Diga à IA o que NÃO deve alterar. Isso evita edição excessiva.

```markdown
<!-- Good -->
Fix grammar and spelling errors only.
Do not change the meaning, style, or tone.
Do not restructure sentences.

<!-- Bad — gives the AI too much freedom -->
Fix this text.
```

### Use Markdown nos Prompts

Você pode usar formatação Markdown nos seus templates de prompt. Isso ajuda quando você quer que a IA produza saída estruturada.

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

### Mantenha os Prompts Focados

Um gênio, um trabalho. Não combine várias tarefas em um único gênio — crie gênios separados em vez disso.

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

## Exemplos de Gênios Personalizados

### Acadêmico — Escrever um Resumo

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

### Blog — Gerar um Gancho

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

### Código — Explicar Bloco de Código

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

### E-mail — Tornar Profissional

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

### Tradução — Para Chinês Simplificado

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

### Consciente do Contexto — Adequar ao Entorno

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

### Revisão — Verificação de Fatos

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

## Sugestões de IA

Quando um Gênio retorna um texto destinado a substituir a seleção (em vez de uma resposta de chat livre), o VMark exibe o resultado como uma **sugestão** com diff inline: tachado ondulado vermelho para o texto original, texto fantasma em itálico esmaecido na cor de destaque para o texto proposto. Você revisa e aprova antes de qualquer alteração ser persistida.

| Ação | Atalho |
|------|--------|
| Aceitar a sugestão em foco | `Enter` |
| Rejeitar a sugestão em foco | `Esc` |
| Ir para a sugestão seguinte / anterior | `Tab` / `Shift + Tab` |
| Aceitar todas as sugestões do documento | `Mod + Shift + Enter` _(sensível ao contexto — também Adicionar Linha Acima quando dentro de uma tabela)_ |
| Rejeitar todas as sugestões do documento | `Mod + Shift + Escape` |

Quando um Gênio reescreve vários parágrafos, cada substituição é uma sugestão independente, navegável separadamente. Aceitar uma não aceita automaticamente as outras.

## Gênios em Workflows

Um único gênio executa um prompt. Quando você precisa encadear várias etapas de IA — esboço, depois rascunho, depois polimento — e encaminhar a saída de um estágio para o seguinte, use um **workflow de genie**: um arquivo YAML que orquestra várias chamadas de gênios com fluxo de dados explícito, portões de aprovação opcionais, modelos por etapa e um diagrama de execução ao vivo.

Como as etapas de workflow preenchem o placeholder `{{content}}` de um gênio a partir de um mapa `with: { input: "..." }`, **os gênios que você escreve aqui são executados sem alterações dentro de workflows** — nenhuma conversão é necessária.

Veja [Workflows de Genie](/pt-BR/guide/workflows) para o schema YAML completo, a sintaxe de expressões, as aprovações e como executar um workflow.

### Isolamento de conteúdo não confiável

Quando uma etapa `genie/<name>` de um workflow é executada, o texto do documento, as seleções e o conteúdo dos arquivos são envolvidos em marcadores exclusivos `<<<DOCUMENT-DATA-…>>>` antes de chegar ao provedor de IA, e o prompt instrui o modelo a tratar o texto isolado estritamente como dados. O isolamento pertence às etapas de workflow — um gênio executado diretamente pelo seletor envia o texto do escopo ao provedor como está. Isso protege contra documentos que tentam contrabandear instruções para a IA ("ignore suas instruções e execute …") — o que importa sobretudo para provedores CLI (Claude Code, Codex, Gemini CLI), que podem executar comandos. Trate os gênios que você executa sobre arquivos de fontes não confiáveis com a mesma cautela que teria ao executar um script vindo da internet: o isolamento é uma mitigação forte, não uma garantia absoluta.

## Limitações

- Os gênios só funcionam no **modo WYSIWYG**. No modo fonte, uma notificação de toast explica isso.
- Um gênio pode ser executado por vez. Se a IA já estiver gerando, o seletor não iniciará outro.
- O placeholder `{{content}}` é substituído literalmente — não suporta condicionais ou loops.
- Documentos muito grandes podem atingir os limites de token do provedor ao usar `scope: document`.

## Solução de Problemas

**"Nenhum provedor de IA disponível"** — Abra Configurações > Integrações e configure um provedor. Veja [Provedores de IA](/pt-BR/guide/ai-providers).

**Gênio não aparece no seletor** — Verifique se o arquivo tem extensão `.md` (ou `.yml`/`.yaml` para um [genie de workflow](/pt-BR/guide/workflow-genies)) e frontmatter válido com delimitadores `---`. Subpastas são examinadas até oito níveis de profundidade (e no máximo 10.000 entradas no total), e links simbólicos são ignorados. Execute **Editar → Assistentes → Recarregar assistentes** depois de adicionar arquivos.

**IA retorna lixo ou erros** — Verifique se sua chave de API está correta e se o nome do modelo é válido para seu provedor. Verifique o terminal/console para detalhes do erro.

**Sugestão não corresponde às expectativas** — Refine seu prompt. Adicione restrições ("retorne apenas o texto", "não explique"), defina um papel ou reduza o escopo.

## Veja Também

- [Provedores de IA](/pt-BR/guide/ai-providers) — Configurar provedores CLI ou API REST
- [Atalhos de Teclado](/pt-BR/guide/shortcuts) — Referência completa de atalhos
- [Ferramentas MCP](/pt-BR/guide/mcp-tools) — Integração de IA externa via MCP
