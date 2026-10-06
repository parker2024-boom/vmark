# Genios de IA

Los Genios de IA son plantillas de prompts que transforman tu texto usando IA. Selecciona texto, invoca un genio y revisa los cambios sugeridos — todo sin salir del editor.

## Inicio Rápido

1. Configura un proveedor de IA en **Ajustes > Integraciones** (ver [Proveedores de IA](/es/guide/ai-providers))
2. Selecciona algo de texto en el editor
3. Pulsa `Mod + Y` para abrir el selector de genios
4. Elige un genio o escribe un prompt de forma libre
5. Revisa la sugerencia en línea — acepta o rechaza

## El Selector de Genios

Pulsa `Mod + Y` (o el menú **Editar → Genios → Buscar genios…**) para abrir un overlay estilo Spotlight con una sola entrada unificada. El mismo submenú enumera cada genio por su nombre, así que un genio también puede ejecutarse directamente desde el menú.

**Búsqueda y forma libre** — Empieza a escribir para filtrar genios por nombre, descripción o categoría. Si no hay genios coincidentes, la entrada se convierte en un campo de prompt de forma libre.

**Fichas Rápidas** — Cuando el alcance es "selección" y la entrada está vacía, aparecen botones de un clic para acciones comunes (Pulir, Condensar, Gramática, Reformular).

**Forma libre en dos pasos** — Cuando no hay genios coincidentes, pulsa `Enter` una vez para ver una pista de confirmación, luego `Enter` de nuevo para enviar como prompt de IA. Esto evita envíos accidentales.

**Cambio de alcance** — Pulsa `Tab` para cambiar entre alcances: selección → bloque → documento → todo.

**Historial de prompts** — En modo de forma libre (sin genios coincidentes), pulsa `ArrowUp` / `ArrowDown` para recorrer prompts anteriores. Pulsa `Ctrl + R` para abrir un menú desplegable de historial con búsqueda; su botón **Borrar historial** vacía de una vez el historial guardado (hasta 100 prompts), sin preguntar. El texto fantasma muestra el prompt coincidente más reciente como pista en gris — pulsa `Tab` para aceptarlo, o `Escape` para descartarlo (vuelve en cuanto cambias lo que escribiste).

### Retroalimentación de Procesamiento

Después de seleccionar un genio o enviar un prompt de forma libre, el selector muestra retroalimentación en línea:

- **Procesando** — Un indicador de pensamiento con contador de tiempo transcurrido. Pulsa `Escape` para cancelar.
- **Vista previa** — La respuesta de IA aparece a medida que llega: los proveedores CLI la transmiten mientras se genera, mientras que los proveedores REST entregan la respuesta completa de una vez cuando termina la solicitud. Usa `Aceptar` para aplicar o `Rechazar` para descartar.
- **Error** — Si algo sale mal, aparece el mensaje de error con un botón `Reintentar`.

La barra de estado también muestra el progreso de IA — un icono giratorio con tiempo transcurrido mientras se ejecuta, un breve destello de "Listo" al terminar, o un indicador de error con botones **Reintentar** y **Descartar**. **Reintentar** vuelve a ejecutar la solicitud fallida — el mismo genio o la misma instrucción, sobre la selección actual — incluso después de cerrar el selector; no aparece si no hay nada que repetir, por ejemplo sin proveedor. La barra de estado se muestra automáticamente cuando la IA tiene estado activo, incluso si la ocultaste previamente con `F7`.

## Genios Integrados

VMark viene con 13 genios en cuatro categorías:

### Edición

| Genio | Descripción | Alcance |
|-------|-------------|---------|
| Pulir | Mejorar claridad y fluidez | Selección |
| Condensar | Hacer el texto más conciso | Selección |
| Corregir Gramática | Corregir gramática y ortografía | Selección |
| Simplificar | Usar lenguaje más simple | Selección |

### Creativo

| Genio | Descripción | Alcance |
|-------|-------------|---------|
| Expandir | Desarrollar idea en prosa más completa | Selección |
| Reformular | Decir lo mismo de diferente manera | Selección |
| Vívido | Añadir detalles sensoriales e imágenes | Selección |
| Continuar | Continuar escribiendo desde aquí | Bloque |

### Estructura

| Genio | Descripción | Alcance |
|-------|-------------|---------|
| Resumir | Resumir el documento | Documento |
| Esquema | Generar un esquema | Documento |
| Titular | Sugerir opciones de título | Documento |

### Herramientas

| Genio | Descripción | Alcance |
|-------|-------------|---------|
| Traducir | Traducir al inglés | Selección |
| Reescribir en Inglés | Reescribir texto en inglés | Selección |

## Alcance

Cada genio opera en uno de tres alcances:

- **Selección** — El texto resaltado. Si no hay nada seleccionado, recurre al bloque actual.
- **Bloque** — El párrafo o elemento de bloque en la posición del cursor.
- **Documento** — El contenido completo del documento.

El alcance determina qué texto se extrae y se pasa a la IA como `{{content}}`.

::: tip
Si el alcance es **Selección** pero no hay nada seleccionado, el genio opera en el párrafo actual.
:::

## Revisión de Sugerencias

Después de que un genio se ejecuta, la sugerencia aparece en línea:

- **Reemplazar** — Texto original con un tachado ondulado rojo, seguido del nuevo texto como texto «fantasma» en cursiva atenuada y en el color de acento
- **Insertar** — Nuevo texto mostrado como texto fantasma después del bloque de origen
- **Eliminar** — Texto original con un tachado ondulado rojo

Cada sugerencia tiene botones de aceptar (marca de verificación) y rechazar (X).

### Atajos de Teclado

| Acción | Atajo |
|--------|-------|
| Aceptar sugerencia | `Enter` |
| Rechazar sugerencia | `Escape` |
| Siguiente sugerencia | `Tab` |
| Sugerencia anterior | `Shift + Tab` |
| Aceptar todas | `Mod + Shift + Enter` |
| Rechazar todas | `Mod + Shift + Escape` |

## Indicador de Barra de Estado

Mientras la IA genera, la barra de estado muestra un icono de destello giratorio con un contador de tiempo transcurrido ("Pensando... 3s"). Un botón de cancelar (×) permite detener la solicitud.

Al completarse, aparece brevemente una marca de verificación "Listo" durante 3 segundos. Si ocurre un error, la barra de estado muestra el mensaje de error con botones Reintentar y Descartar.

La barra de estado se muestra automáticamente cuando la IA tiene estado activo (ejecutándose, error o éxito), incluso si la ocultaste con `F7`.

---

## Escribir Genios Personalizados

Puedes crear tus propios genios. Cada genio es un único archivo Markdown con frontmatter YAML y una plantilla de prompt.

### Dónde Viven los Genios

Los genios se almacenan en el directorio de datos de la aplicación:

| Plataforma | Ruta |
|------------|------|
| macOS | `~/Library/Application Support/app.vmark/genies/` |
| Windows | `%APPDATA%\app.vmark\genies\` |
| Linux | `~/.local/share/app.vmark/genies/` |

Abre esta carpeta desde el menú **Editar → Genios → Abrir carpeta de genios**; después de añadir o editar archivos, **Editar → Genios → Recargar genios** actualiza la lista.

### Estructura de Directorios

Los subdirectorios se convierten en **categorías** en el selector, y la exploración es recursiva — anida carpetas con la profundidad que quieras; la categoría de un genio es la ruta de su carpeta relativa a `genies/` (así `academic/thesis/abstract.md` queda en `academic/thesis`) salvo que el frontmatter defina `category`. Los enlaces simbólicos se omiten. Puedes organizar los genios como desees:

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

### Formato de Archivo

Cada archivo de genio tiene dos partes: **frontmatter** (metadatos) y **plantilla** (el prompt).

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

El nombre de archivo `polish.md` se convierte en el nombre de visualización "Polish" en el selector.

### Campos del Frontmatter

| Campo | Requerido | Valores | Predeterminado |
|-------|-----------|---------|----------------|
| `description` | No | Descripción breve mostrada en el selector | Vacío |
| `scope` | No | `selection`, `block`, `document` | `selection` |
| `category` | No | Nombre de categoría para agrupación | Nombre del subdirectorio |
| `action` | No | `replace`, `insert` | `replace` |
| `context` | No | `1`, `2` | `0` (ninguno) |
| `model` | No | Identificador de modelo para anular el predeterminado del proveedor | Predeterminado del proveedor |

**Nombre del genio** — El nombre de visualización siempre se deriva del **nombre de archivo** (sin `.md`). Por ejemplo, `fix-grammar.md` aparece como "Fix Grammar" en el selector. Renombra el archivo para cambiar el nombre de visualización.

### El Marcador de Posición `{{content}}`

El marcador de posición `{{content}}` es el núcleo de cada genio. Cuando se ejecuta un genio, VMark:

1. **Extrae el texto** basándose en el alcance (texto seleccionado, bloque actual o documento completo)
2. **Reemplaza** cada `{{content}}` en tu plantilla con el texto extraído
3. **Envía** el prompt completado al proveedor de IA activo
4. **Devuelve** la respuesta como una sugerencia en línea — transmitida a medida que se genera desde un proveedor CLI, de una sola vez desde un proveedor REST

Por ejemplo, con esta plantilla:

```markdown
Translate the following text into French.

{{content}}
```

Si el usuario selecciona "Hello, how are you?", la IA recibe:

```text
Translate the following text into French.

Hello, how are you?
```

La IA responde con "Bonjour, comment allez-vous ?" y aparece como una sugerencia en línea reemplazando el texto seleccionado.

### El Marcador de Posición `{{context}}`

El marcador de posición `{{context}}` le da a la IA texto circundante de solo lectura — para que pueda coincidir con el tono, estilo y estructura de los bloques cercanos sin modificarlos.

**Cómo funciona:**

1. Establece `context: 1` o `context: 2` en el frontmatter para incluir ±1 o ±2 bloques vecinos
2. Usa `{{context}}` en tu plantilla donde quieras que se inyecte el texto circundante
3. La IA ve el contexto pero la sugerencia solo reemplaza `{{content}}`

**Los bloques compuestos son atómicos** — si un vecino es una lista, tabla, cita o bloque de detalles, toda la estructura cuenta como un bloque.

**Restricciones de alcance** — El contexto solo funciona con alcance `selection` y `block`. Para el alcance `document`, el contenido ya ES el documento completo.

**Prompts de forma libre** — Cuando escribes una instrucción de forma libre en el selector, VMark automáticamente incluye ±1 bloque circundante como contexto para los alcances `selection` y `block`. No se necesita configuración.

**Compatible con versiones anteriores** — Los genios sin `{{context}}` funcionan exactamente como antes. Si la plantilla no contiene `{{context}}`, no se extrae texto circundante.

**Ejemplo — lo que recibe la IA:**

Con `context: 1` y el cursor en el segundo párrafo de un documento de tres párrafos:

```text
[Before]
First paragraph content here.

[After]
Third paragraph content here.
```

Las secciones `[Before]` y `[After]` se omiten cuando no hay vecinos en esa dirección (ej., el contenido está al principio o al final del documento).

### El Campo `action`

Por defecto, los genios **reemplazan** el texto de origen con el resultado de la IA. Establece `action: insert` para **añadir** el resultado después del bloque de origen en su lugar.

Usa `replace` para: edición, reformulación, traducción, corrección de gramática — cualquier cosa que transforme el texto original.

Usa `insert` para: continuar escribiendo, generar resúmenes debajo del contenido, añadir comentarios — cualquier cosa que añada nuevo texto sin eliminar el original.

**Ejemplo — acción de inserción:**

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

### El Campo `model`

Anula el modelo predeterminado para un genio específico. Útil cuando quieres un modelo más económico para tareas simples o uno más potente para tareas complejas.

```markdown
---
description: Quick grammar fix (uses fast model)
scope: selection
model: claude-haiku-4-5-20251001
---

Fix grammar and spelling errors. Return only the corrected text.

{{content}}
```

El identificador del modelo debe coincidir con lo que acepta tu proveedor activo.

## Escribir Prompts Efectivos

### Sé Específico sobre el Formato de Salida

Dile a la IA exactamente qué devolver. Sin esto, los modelos tienden a añadir explicaciones, encabezados o comentarios.

```markdown
<!-- Good -->
Return only the improved text — no explanations.

<!-- Bad — AI may wrap output in quotes, add "Here's the improved version:", etc. -->
Improve this text.
```

### Establece un Rol

Dale a la IA un personaje para anclar su comportamiento.

```markdown
<!-- Good -->
You are an expert technical editor who specializes in API documentation.

<!-- Okay but less focused -->
Edit the following text.
```

### Limita el Alcance

Dile a la IA qué NO cambiar. Esto evita la sobre-edición.

```markdown
<!-- Good -->
Fix grammar and spelling errors only.
Do not change the meaning, style, or tone.
Do not restructure sentences.

<!-- Bad — gives the AI too much freedom -->
Fix this text.
```

### Usa Markdown en los Prompts

Puedes usar formato Markdown en tus plantillas de prompt. Esto ayuda cuando quieres que la IA produzca salida estructurada.

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

### Mantén los Prompts Enfocados

Un genio, un trabajo. No combines múltiples tareas en un solo genio — crea genios separados en su lugar.

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

## Ejemplos de Genios Personalizados

### Académico — Escribir un Resumen

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

### Blog — Generar un Gancho

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

### Código — Explicar Bloque de Código

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

### Email — Hacer Profesional

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

### Traducción — Al chino simplificado

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

### Consciente del Contexto — Ajustar al Entorno

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

### Revisión — Verificación de Hechos

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

## Sugerencias de IA

Cuando un Genio devuelve texto destinado a reemplazar la selección (en lugar de una respuesta de chat de forma libre), VMark lo presenta como una **sugerencia** con un diff en línea: tachado ondulado rojo para el texto original, texto fantasma en cursiva atenuada y en el color de acento para el texto propuesto. Tú revisas y apruebas antes de que cualquier cambio se persista.

| Acción | Atajo |
|---|---|
| Aceptar la sugerencia enfocada | `Enter` |
| Rechazar la sugerencia enfocada | `Esc` |
| Pasar a la sugerencia siguiente / anterior | `Tab` / `Shift + Tab` |
| Aceptar todas las sugerencias del documento | `Mod + Shift + Enter` _(sensible al contexto — también Añadir Fila Arriba cuando se está dentro de una tabla)_ |
| Rechazar todas las sugerencias del documento | `Mod + Shift + Escape` |

Cuando un Genio reescribe varios párrafos, cada reemplazo es una sugerencia navegable de forma independiente. Aceptar una no acepta automáticamente las demás.

## Genios en flujos de trabajo

Un solo genio ejecuta un solo prompt. Cuando necesitas encadenar varios pasos de IA — esquema, luego borrador, luego pulido — y encaminar la salida de una etapa a la siguiente, usa un **flujo de trabajo de genios**: un archivo YAML que orquesta varias llamadas a genios con un flujo de datos explícito, puertas de aprobación opcionales, modelos por paso y un diagrama de ejecución en vivo.

Como los pasos de un flujo de trabajo rellenan el marcador `{{content}}` de un genio a partir de un mapa `with: { input: "..." }`, **los genios que escribes aquí se ejecutan sin cambios dentro de los flujos de trabajo** — no hace falta ninguna conversión.

Consulta [Flujos de trabajo de genios](/es/guide/workflows) para ver el esquema YAML completo, la sintaxis de expresiones, las aprobaciones y cómo ejecutar uno.

### Aislamiento del contenido no confiable

Cuando se ejecuta un paso `genie/<name>` de un flujo de trabajo, el texto del documento, las selecciones y el contenido de los archivos se envuelven en marcadores únicos `<<<DOCUMENT-DATA-…>>>` antes de llegar al proveedor de IA, y el prompt indica al modelo que trate el texto delimitado estrictamente como datos. Este aislamiento es propio de los pasos de flujo de trabajo — un genio ejecutado directamente desde el selector envía el texto de su alcance al proveedor tal cual. Protege frente a documentos que intentan colar instrucciones a la IA («ignora tus instrucciones y ejecuta …»), lo que importa sobre todo con los proveedores CLI (Claude Code, Codex, Gemini CLI), que pueden ejecutar comandos. Trata los genios que ejecutas sobre archivos de fuentes no confiables con la misma cautela que aplicarías al ejecutar un script de internet: el aislamiento es una mitigación sólida, no una garantía absoluta.

## Limitaciones

- Los genios solo funcionan en **modo WYSIWYG**. En modo fuente, una notificación toast lo explica.
- Solo se puede ejecutar un genio a la vez. Si la IA ya está generando, el selector no iniciará otro.
- El marcador de posición `{{content}}` se reemplaza literalmente — no soporta condicionales ni bucles.
- Los documentos muy grandes pueden alcanzar los límites de tokens del proveedor cuando se usa `scope: document`.

## Solución de Problemas

**"No hay proveedor de IA disponible"** — Abre Ajustes > Integraciones y configura un proveedor. Ver [Proveedores de IA](/es/guide/ai-providers).

**El genio no aparece en el selector** — Verifica que el archivo tenga extensión `.md` (o `.yml`/`.yaml` para un [genio de flujo de trabajo](/es/guide/workflow-genies)) y frontmatter válido con delimitadores `---`. Las subcarpetas se exploran hasta ocho niveles de profundidad (y como máximo 10.000 entradas en total), y los enlaces simbólicos se omiten. Ejecuta **Editar → Genios → Recargar genios** después de añadir archivos.

**La IA devuelve basura o errores** — Verifica que tu clave API sea correcta y que el nombre del modelo sea válido para tu proveedor. Consulta el terminal/consola para detalles de error.

**La sugerencia no cumple las expectativas** — Refina tu prompt. Añade restricciones ("devuelve solo el texto", "no expliques"), establece un rol o reduce el alcance.

## Ver También

- [Proveedores de IA](/es/guide/ai-providers) — Configura proveedores CLI o API REST
- [Atajos de Teclado](/es/guide/shortcuts) — Referencia completa de atajos
- [Herramientas MCP](/es/guide/mcp-tools) — Integración de IA externa mediante MCP
