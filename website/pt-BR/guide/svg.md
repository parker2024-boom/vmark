# Gráficos SVG

O VMark oferece suporte de primeira classe para SVG — Scalable Vector Graphics (Gráficos Vetoriais Escaláveis). Há duas formas de usar SVG em seus documentos, cada uma adequada a um fluxo de trabalho diferente.

| Método | Melhor Para | Fonte Editável? |
|--------|-------------|-----------------|
| [Incorporação de imagem](#incorporando-svg-como-imagem) (`![](file.svg)`) | Arquivos SVG estáticos no disco | Não |
| [Bloco de código](#blocos-de-codigo-svg) (` ```svg `) | SVG inline, gráficos gerados por IA | Sim |

## Incorporando SVG como Imagem

Use a sintaxe de imagem Markdown padrão para incorporar um arquivo SVG:

```markdown
![Diagrama de arquitetura](./assets/architecture.svg)
```

Isso funciona exatamente como imagens PNG ou JPEG — arraste e solte, cole ou insira via barra de ferramentas. Arquivos SVG são reconhecidos como imagens e renderizados inline.

**Quando usar isso:** Você tem um arquivo `.svg` (do Figma, Illustrator, Inkscape ou uma ferramenta de design) e quer exibi-lo no seu documento.

**Limitações:** O SVG é renderizado como imagem estática. Você não pode editar o código-fonte SVG inline, e nenhum controle de pan+zoom ou exportação aparece.

## Blocos de Código SVG

Encapsule a marcação SVG bruta em um bloco de código delimitado com o identificador de linguagem `svg`:

````markdown
```svg
<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="100" rx="10" fill="#4a6fa5"/>
  <text x="100" y="55" text-anchor="middle" fill="white"
        font-size="18" font-family="system-ui">Hello SVG</text>
</svg>
```text
````

O SVG é renderizado inline — assim como diagramas Mermaid — com controles interativos.

::: tip Exclusivo do VMark
Nem o Typora nem o Obsidian suportam blocos de código ` ```svg `. Este é um recurso exclusivo do VMark, projetado para fluxos de trabalho com IA onde ferramentas geram visualizações SVG (gráficos, ilustrações, ícones) que não se encaixam na gramática do Mermaid.
:::

### Quando Usar Blocos de Código

- **Gráficos gerados por IA** — Claude, ChatGPT e outras ferramentas de IA podem gerar gráficos, diagramas e ilustrações SVG diretamente. Cole o SVG em um bloco de código para renderizá-lo inline.
- **Criação de SVG inline** — Edite o código-fonte SVG diretamente no seu documento e veja resultados ao vivo.
- **Documentos autocontidos** — O SVG vive dentro do arquivo Markdown, sem dependência de arquivo externo.

## Editando no Modo WYSIWYG

No modo Texto Rico, blocos de código SVG são renderizados inline automaticamente.

### Entrando no Modo de Edição

Dê um duplo clique em um SVG renderizado para abrir o editor de código-fonte. Um cabeçalho de edição aparece com:

| Botão | Ação |
|-------|------|
| **Copiar** | Copiar código-fonte SVG para a área de transferência |
| **Cancelar** (X) | Reverter alterações e sair (também `Esc`) |
| **Salvar** (marca de verificação) | Aplicar alterações e sair |

Uma **prévia ao vivo** abaixo do editor é atualizada conforme você digita, para que você possa ver suas alterações em tempo real.

### Pan e Zoom

Passe o mouse sobre um SVG renderizado para revelar controles interativos:

| Ação | Como |
|------|------|
| **Zoom** | Segure `Cmd` (macOS) ou `Ctrl` (Windows/Linux) e role |
| **Pan** | Clique e arraste o SVG |
| **Resetar** | Clique no botão de reset (canto superior direito) |

Estes são os mesmos controles de pan+zoom usados para diagramas Mermaid.

### Exportar como PNG

Passe o mouse sobre um SVG renderizado para revelar o botão de **exportação** (canto superior direito, ao lado do botão de reset). Clique nele para escolher um tema de fundo:

| Tema | Fundo |
|------|-------|
| **Claro** | Branco (`#ffffff`) |
| **Escuro** | Escuro (`#1e1e1e`) |

O SVG é exportado como um PNG de resolução 2x via diálogo de salvamento do sistema.

## Prévia no Modo Fonte

No modo Fonte, quando o cursor estiver dentro de um bloco de código ` ```svg `, um painel de prévia flutuante aparece — o mesmo painel usado para diagramas Mermaid.

| Recurso | Descrição |
|---------|-----------|
| **Prévia ao vivo** | Atualiza imediatamente conforme você digita (sem debounce — renderização SVG é instantânea) |
| **Arrastar para mover** | Arraste o cabeçalho para reposicionar |
| **Redimensionar** | Arraste qualquer borda ou canto |
| **Zoom** | Botões `−` e `+`, ou `Cmd/Ctrl` + scroll (10% a 300%) |

::: info
A prévia de diagrama no modo Fonte vem desativada por padrão. Ative-a com **Visualizar → Alternar pré-visualização de diagrama** (`Alt + Mod + P`) ou pela paleta de comandos.
:::

## Validação SVG

O VMark valida o conteúdo SVG antes de renderizar:

- O conteúdo deve começar com `<svg` ou `<?xml`
- O XML deve ser bem formado (sem erros de parse)
- O elemento raiz deve ser `<svg>`

Se a validação falhar, uma mensagem de erro **SVG Inválido** é mostrada em vez do gráfico renderizado. Dê um duplo clique no erro para editar e corrigir o código-fonte.

## Fluxo de Trabalho com IA

Assistentes de codificação IA podem gerar SVG diretamente nos seus documentos VMark via ferramentas MCP. A IA envia um bloco de código com `language: "svg"` e o conteúdo SVG, que é renderizado inline automaticamente.

**Exemplo de prompt:**

> Crie um gráfico de barras mostrando a receita trimestral: T1 US$ 2,1M, T2 US$ 2,8M, T3 US$ 3,2M, T4 US$ 3,9M

A IA gera um gráfico de barras SVG que é renderizado inline no seu documento, com pan+zoom e exportação PNG disponíveis imediatamente.

## Comparação: Bloco de Código SVG vs Mermaid

| Recurso | ` ```svg ` | ` ```mermaid ` |
|---------|-----------|---------------|
| Entrada | Marcação SVG bruta | DSL Mermaid |
| Renderização | Instantânea (síncrona) | Assíncrona (debounce de 200ms) |
| Pan + Zoom | Sim | Sim |
| Exportação PNG | Sim | Sim |
| Prévia ao vivo | Sim | Sim |
| Adaptação de tema | Não (usa as próprias cores do SVG) | Sim (adapta-se a todos os temas) |
| Melhor para | Gráficos personalizados, visuais gerados por IA | Fluxogramas, diagramas de sequência, diagramas estruturados |

## Dicas

### Segurança

O VMark sanitiza o conteúdo SVG antes de renderizar. Tags de script e atributos de manipuladores de eventos (`onclick`, `onerror`, etc.) são removidos. Isso protege contra XSS ao colar SVG de fontes não confiáveis.

Referências externas também são removidas: `<use>` e `<image>` podem apontar para um fragmento do mesmo documento (`href="#arrowhead"`) ou para um conteúdo `data:image/…` inline, mas uma URL que aponta para fora da máquina é descartada. Sem isso, simplesmente abrir um documento contendo um diagrama não confiável buscaria essa URL — revelando seu endereço IP e o momento em que você abriu o arquivo. Ferramentas de diagrama como o Mermaid só referenciam fragmentos, então diagramas normais não são afetados.

A folha de estilos própria de um SVG (`<style>`) fica confinada a esse SVG: cada seletor é reescrito para que só possa corresponder a elementos dentro do SVG de onde veio, de modo que um diagrama não consegue reestilizar o editor nem outro diagrama. Apenas regras de estilo, `@media` e `@keyframes` são mantidas (os nomes de animação se tornam únicos por SVG); `@import`, `@font-face` e outras at-rules, referências externas `url()` e `position: fixed` / `sticky` são descartados. Elementos `<form>` são removidos (seu conteúdo é mantido).

Links dentro de um SVG renderizado nunca fazem o próprio VMark navegar. Clicar em um link da web o abre no navegador do sistema; um link relativo para um arquivo abre esse arquivo em uma aba do VMark; links `javascript:`, `file:` e `data:` nunca são abertos.

### Dimensionamento

Se o seu SVG não incluir atributos explícitos de `width`/`height`, adicione um `viewBox` para controlar sua proporção de aspecto:

```xml
<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">
  <!-- conteúdo -->
</svg>
```

### Qualidade de Exportação

A exportação PNG usa resolução 2x para exibição nítida em telas Retina. Uma cor de fundo sólida é adicionada automaticamente (o próprio SVG pode ter fundo transparente).
