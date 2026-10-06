# Decisions — CRLF invariant and the source-mode block model

> Plan: `dev-docs/plans/20260731-crlf-and-source-block-model.md` — a maintainer-local plan that was never tracked.
> Built: CRLF handling and the Source-mode block model.
> Defines: ADR-1, ADR-2. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

## ADR-1 — LF is the in-memory invariant

### The finding

VMark already models line endings as **metadata**: `documentStore` carries
`lineEnding`, settings carry `lineEndingsOnSave: preserve|lf|crlf`, and
`saveToPath.ts:107` applies `normalizeLineEndings(content, target)` at write
time. CodeMirror implements that invariant for free — it normalises CRLF when
constructing `Text`, so Source mode holds LF.

ProseMirror does not. Probing the production pipeline:

```
input:  "First para\r\nsecond line\r\n\r\nThird\r\n"
result: ONE text node — "First para\r\nsecond line"
```

A literal CR lives **inside a PM text node** and survives the round trip. In a
CRLF file WYSIWYG therefore sees no line break at all, just a control character
— which flows into word count, search, lint, and CJK formatting.

This is not a policy question about which surface is right. The architecture
already decided; one surface does not implement it.

Corroborating evidence that the mismatch is already being worked around:
`documentState.ts:90` documents `softContentEquals` as existing because
`doc.content` is LF while `diskContent` is EOL-normalised, and a strict compare
"left a CRLF doc dirty forever".

### Decision

Make LF the invariant for all in-memory editor text. Normalise at the
decoded-text → editor-model boundary; keep the exact decoded bytes in
`lastDiskContent`.

```ts
const toEditorText = (text: string): string => text.replace(/\r\n?/g, "\n");
```

Neither `loadContent` nor `parseMarkdown` alone is sufficient — there are six
ingress points, verified:

| Ingress | Entry point |
|---|---|
| First open | `useFinderFileOpen.ts:46` → `initDocument` (not `loadContent`) |
| Reload / watcher | `useExternalFileChanges.ts` → `loadContent` |
| Bootstrap | `useWorkspaceBootstrap.ts:100` |
| MCP writes | `hooks/mcpBridge/v2/document.ts:157` → `setContent`, parses separately |
| Markdown paste | `plugins/markdownPaste/tiptap.ts:103` → `parseMarkdown` direct |
| Crash recovery / tab transfer | legacy snapshots |

`parseMarkdown` gets a defensive normalise too, because paste and direct callers
bypass the store. Do **not** normalise on every keystroke — editor-generated
content already satisfies the invariant.

### State meanings, made explicit

| Field | Means |
|---|---|
| `content` | canonical LF editor text |
| `savedContent` | canonical LF snapshot of the last successful write |
| `lastDiskContent` | exact decoded bytes, CRLF and BOM included |

Post-save dirty tracking currently compares editor content against transformed
disk output — two different domains. Replace with both snapshots:

```ts
markSaved(tabId, { editorSnapshot: contentAtSaveStart, diskSnapshot: outputWritten });
// savedContent = editorSnapshot; lastDiskContent = diskSnapshot;
// isDirty = doc.content !== editorSnapshot;
```

That is the correct TOCTOU check and also covers hard-break normalisation.

**`softContentEquals` is not fully removable.** Drop it from dirty tracking, keep
it for watcher equivalence (rename to something like
`diskContentsEquivalentForWatcher`) — it deliberately ignores BOM and one
trailing newline as well as EOL, which are independent cloud-sync policies
documented in `linebreaks.ts:130`.

### Separate bug found in the same area

`useExternalFileChanges.ts:314` adopts a new `lastDiskContent` on an EOL-only
rewrite but leaves `lineEnding` **stale**, so `preserve` later restores the old
convention. Refresh the metadata from the raw disk text when adopting.

### Order

1. Failing tests first: store, save-race, reload, MCP, paste, crash recovery.
2. Canonical editor text + explicit editor/disk save snapshots.
3. Migrate disk-open paths to one `decodeDiskDocument` boundary.
4. Other ingress + harden `parseMarkdown`.
5. Remove `softContentEquals` from post-save; keep for watcher.

### Then close the parity gap

`parityFixtures.ts` documents why a CRLF fixture is currently withheld: it shows
~60 divergences for a reason unrelated to any action. Once LF is invariant that
reason disappears — add the fixture and move `lineEndingsLF`/`lineEndingsCRLF`
from unverified into `COVERED_ACTIONS`.

## ADR-2 — Source block ranges come from the syntax tree

### The finding

`shared/blockSpan.ts` resolves a "top-level block" as a run of non-blank lines.
Its header used to assert that a blank line separates blocks and that this is
markdown's own rule. **That is false.** CommonMark defines it only for
paragraphs; headings, quotes, thematic breaks, HTML and fences begin blocks with
no blank line, and lists and fences may contain blank lines internally.

The installed CodeMirror markdown parser already distinguishes all of these.
Four failures verified against the real `sourceBlockSpan`:

| Input | Caret | Result | Correct |
|---|---|---|---|
| ` ```js / code(); / ``` / paragraph` | paragraph | `{0,3}` — **swallowed the fence** | `{3,3}` |
| `- one / (blank) / - two` | item 1 | `{0,0}` — split | one `BulletList` |
| `paragraph / # heading` | paragraph | `{0,1}` — merged | two blocks |
| ` ``` / a / (blank) / b / ``` ` | `a` | `{0,1}` — stopped mid-fence | whole fence |

Row 1 was **destructive** — wrapping, converting or CJK-formatting that span
rewrote code the user never selected — and is already fixed in `7c79b779` by
making fences hard boundaries. Rows 2–4 remain: non-destructive over-reach.

The same pseudo-parser is duplicated across `blockSpan`, `listDetection`,
`blockquoteActions` and the line-movement helpers.

### Decision

Replace the heuristics with an adapter over `syntaxTree`/`ensureSyntaxTree`.
Do **not** expose one universal "block" range — different actions need different
units:

```ts
resolveLeafBlock(state, range)            // CJK formatting
resolveTouchedTopLevelBlocks(state, range) // alert/details wrapping
resolveEnclosingList(state, pos)          // list conversion
resolveEnclosingBlockquote(state, pos)    // quote toggling
resolveCodeBlock(state, pos)              // code toggle
selectionTouchesCodeBlock(state, range)   // see below
```

### Order

1. `markdownStructure.ts` adapter, tested standalone.
2. Highest-risk mutators: `sourceInsertActions`, `blockquoteActions`,
   `sourceCjkActions`, code-block range/toggle.
3. Context detection (code, list, quote, table, heading).
4. Selection and line movement last; then delete the regex scanners.

Compatibility wrappers can hold the existing signatures during migration. If a
destructive action cannot obtain a complete tree, **fail closed** rather than
silently falling back to the known-wrong heuristic.

### What this unlocks for the fence boundary

`7c79b779` gates on `ctx.inCodeBlock`, which describes one cursor position. A
selection may intersect a fence while its endpoint sits outside. Once the tree
adapter exists, swap the predicate to `selectionTouchesCodeBlock`, and re-check
it immediately before deferred adapter dispatch — `editorActionDispatch.ts:174`
revalidates ownership and read-only but not code context, and context-menu
dispatch bypasses `runEditorAction` entirely.

Two related defects to fix in the same pass:

- `collapseBlankLines` rewrites blank lines document-wide via a global regex,
  including inside fences. Cursor gating cannot fix a whole-document
  transformer; make it fence-aware, then it can join `CODE_BLOCK_SAFE_ACTIONS`.
- `moveLineUp`/`moveLineDown`/`joinLines` use blank-line and list heuristics.
  Inside a fence they should use plain CodeMirror line semantics.

## ADR-2 AMENDMENT 1 — the syntax tree is not a drop-in authority

Measured after fixing the GFM base. `base: markdownLanguage` was **necessary but
not sufficient**: it buys GFM, but VMark's flavour is GFM **plus** math,
frontmatter, wiki links, details, alerts and TOC, and lezer-markdown knows none
of them. It also adds emoji, which VMark does not have.

### Inline divergence (highlighting only)

| Syntax | Editor tree | Document parser |
|---|---|---|
| `H~2~O` / `~~struck~~` / `X^2^` | Subscript / Strikethrough / Superscript | same | 
| GFM table, `www.example.com` | Table…, URL | table…, link |
| `:smile:` | **Emoji** | plain text |
| `$x^2$` | **plain** | `math_inline` |
| `[[Page]]` | **Link** | `wikiLink` |
| `[^1]` | **Link, LinkReference** | `footnote_reference` |

Sub/superscript agree only because the pipeline sets `singleTilde: false`
deliberately, so `~x~` is subscript and not GFM strikethrough. VMark is
knowingly NOT 100% GFM there, and the editor happens to match.

### BLOCK divergence — this is what blocks ADR-2

| Construct | Editor top-level nodes | Document |
|---|---|---|
| `$$\nx^2\n$$` | `Paragraph` | `codeBlock` |
| `<details open>…</details>` | `HTMLBlock, Paragraph, HTMLBlock` — **three** | `detailsBlock` — **one** |
| `---\ntitle: x\n---` | `HorizontalRule, SetextHeading2, Paragraph` — **three** | `frontmatter, paragraph` |
| `> [!NOTE]` | `Blockquote` | `alertBlock` (compatible: one block either way) |
| ` ```mermaid ` | `FencedCode` | `codeBlock` (compatible) |
| `[TOC]` | `Paragraph` | `toc` (compatible) |

The first three are disqualifying for a naive migration:

- **Frontmatter is read as a thematic break plus a setext heading.** A
  tree-based block resolver would resolve nonsense at the top of any file with
  frontmatter — which is most of them — and it interacts with the setext
  protection already in `remarkPlugins.ts`.
- **A details block is three editor blocks and one document block.** Wrapping or
  converting "the block" would operate on a fragment.
- **A math block is a paragraph to the editor.** Converting it would fence a
  paragraph that is really a code block.

### Consequence for the plan

ADR-2 cannot simply query `syntaxTree`. One of:

1. **Extend the parser** — write lezer-markdown `MarkdownExtension`s for
   frontmatter, math blocks and details so the tree matches the pipeline. Most
   correct, most work, and creates a THIRD grammar to keep in sync with remark.
2. **Restrict the tree's authority** to the constructs it and remark agree on
   (paragraph, list, blockquote, fenced code, table, ATX heading) and fail
   closed near the others — the `source: "legacy" | "tree"` discrimination
   already planned, extended with a "tree disagrees with our flavour here" case.
3. **Do not use the tree for block spans at all**; use it only for FENCE
   containment, where editor and document already agree (`FencedCode` ↔
   `codeBlock`), and keep line heuristics elsewhere.

Option 3 delivers most of the safety win — fence containment is what the
destructive bugs were about — at a fraction of the risk, and is compatible with
doing 1 later. The recommended first subset should shrink to that.

Whichever is chosen, the migration needs a CONFORMANCE TEST comparing editor
top-level node spans against pipeline block boundaries across the corpus, so a
divergence is caught by the gate rather than by a user.

## ADR-2 AMENDMENT 2 — WITHDRAWN. Structure comes from remark, in a worker.

Thread `019fb62a-9772-7c01-ab61-e2264fed6c92`. Codex withdrew its own earlier
recommendation once the block-divergence measurements landed. **Do not use the
CodeMirror syntax tree for semantic block structure.** Lezer stays for
highlighting, decorations and presentation; it may never authorize a mutation or
define a semantic edit range.

### A correction to the premise

I claimed source mode already parses "with the same processor as the document".
That is only directionally true, and the difference matters.
`createMarkdownProcessor` (`processorFactory.ts:157`) shares the dialect plugins
but **deliberately diverges**, per its own header:

* "Skips normalizeBareListMarkers (preserves original positions)"
* "Skips preprocessEscapedMarkers (lint checks raw source)"

So there are two parse paths, and the design must name them rather than pretend
they are one:

| Mode | Purpose |
|---|---|
| `document` | production normalization and conversion behaviour |
| `source-position` | raw-input positions, no length-changing preprocessing |

A conformance gate proves they produce the same **semantic** structure while
differing in preprocessing.

### The architecture

A revision-keyed **structure service** owning the remark parse in a **Web
Worker**. The worker retains the MDAST; the UI receives a compact immutable
structure index. Toolbar context and actions read the index; lint asks the same
worker to run its rules against the retained MDAST. One parse per settled
revision, shared by every consumer.

Never store the full MDAST in Zustand or on the UI thread.

```ts
interface StructureKey {
  windowLabel: string; tabId: string; viewInstanceId: string;
  sourceEpoch: number; documentRevision: string;
}
type StructureStatus = "ready" | "stale" | "parsing" | "unsupported-size" | "failed";
```

Invalidate synchronously on every `docChanged` transaction, before a stale
result can be read. Selection-only changes do not invalidate.

A structure-dependent command on a cold cache captures its full identity
(action, origin, view, epoch, revision, selections), requests a priority parse,
shows busy feedback only past 100ms, and applies **only if nothing changed**. It
never runs against an older tree, never remaps stale ranges, and never falls
back to line heuristics.

### Why no hybrid

"Use Lezer where they agree" requires an agreement table maintained across
CodeMirror releases, VMark's remark plugins, nesting combinations, malformed
input and every future extension. That is the third grammar plus an arbitration
policy. Rejected.

The existing fence scanners may survive temporarily as **conservative vetoes** —
they can refuse an operation, never authorize one or define its range — and
finally consolidate into a single raw-text delimiter guard.

### Large files

| Size | Contract |
|---|---|
| `< 1 MiB` | parse after 200ms settled editing; priority parse on cold command |
| `1–5 MiB` | parse after 1.5s idle; priority parse on cold command; obsolete results dropped |
| `≥ 5 MiB` | no semantic parse — structural actions and markdown lint unavailable; textual operations remain |
| `≥ 50 MiB` | existing hard refusal |

The worker keeps the editor interactive; a cold command may wait up to 3s and
mutates nothing on timeout. This replaces the earlier `syntaxTreeAvailable`
policy entirely — it is neither consulted nor mirrored.

### Three live defects this exposed (all verified)

1. **The lint parse is SYNCHRONOUS on the UI thread.** `runActiveLint.ts:92`
   calls `runLintForFormat` directly. At the measured ~400ms/10K lines that is
   already a stall today, before any of this work.
2. **Keyboard shortcuts bypass the one mutation path.**
   `sourceShortcutsHelpers.ts` invokes adapters directly and reimplements
   heading/list/blockquote behaviour, contradicting `editorActionDispatch`. A
   structure gate wired only into toolbar/menu dispatch would be incomplete —
   so **close the bypasses before adding the gate**, or these files get churned
   twice.
3. **The parity harness's zero is narrower than it sounds.** Fixtures are
   paragraph, heading, list-item, blockquote, table, cjk, multi-para,
   multi-item-list, nested-list, untidy. There is **no** frontmatter, details,
   block math, alert or TOC fixture — precisely the constructs where the two
   parsers diverge most. ZERO DIVERGENCES IS VALID ONLY FOR THAT DOMAIN.

### Conformance gate

`markdownPipeline/__tests__/fidelity/sourceStructureConformance.test.ts`, over
every characterization fixture plus adversarial extension fixtures, comparing
three projections: production mdast, source-position mdast, and the worker
structure index. Projection covers hierarchy, top-level ordering, node types,
heading depth, list ordered/task state and nesting, code language/meta,
frontmatter/math/details/alerts/TOC, wiki links, footnotes, references, inline
math, and key attributes. Positions checked separately against raw source slices
with half-open UTF-16 offsets. Must cover LF, CRLF, CJK, surrogate pairs,
combining marks, RTL, incomplete fences, malformed extensions and nesting.
**No permanent divergence allowance** between the two semantic projections.

### Sequence

1. CRLF (ADR-1) — independent, already specified.
2. Close action-dispatch bypasses; classify structure-dependent actions.
3. Centralize dialect config; land the conformance tests.
4. Build the compact structure index.
5. Worker scheduling and exact-revision command deferral.
6. Reuse the worker MDAST for lint (fixes the UI stall).
7. Migrate destructive block actions and cursor context.
8. Migrate remaining semantic queries; delete the duplicate grammars.
9. Enforce the large-file contract and release gates.

Step 2 before step 7 is the ordering that avoids touching the action files twice.
