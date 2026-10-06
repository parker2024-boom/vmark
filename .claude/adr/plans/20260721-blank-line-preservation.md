# Decisions — Plan: Preserve blank-line runs through the WYSIWYG round trip

> Plan: `dev-docs/plans/20260721-blank-line-preservation.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: blank-line preservation (`src/utils/markdownPipeline/blankLineCapture.ts`).
> Defines: ADR-1, ADR-1a, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1 — Position-derived block attribute, **nullable / inherit** default (was: default 1)

Capture the inter-block blank-line count from MDAST positions into a PM block
attribute `blankLinesBefore`. **Default `null` = "inherit the serializer's
normal join"**, NOT `1`. Codex F-05: `mdast-util-to-markdown` emits **0**
separating blank lines for tight-list children and **1** for spread children;
a universal `1` would loosen every tight list. So: capture an explicit `0..N`
**only** for parsed source nodes with reliable positions; emit a custom join
**only** when the attribute is a number AND the feature is enabled; otherwise
return no custom result and let the serializer's default join stand.

- **Rejected — empty-paragraph nodes:** collapse on their own round trip.
- **Rejected — post-stringify text pass (Codex F-10):** custom converters
  synthesize/reshape nodes (alerts add a marker paragraph `pmBlockConverters.ts:111`;
  media promote to paragraph/HTML), so a text rewrite can't reliably locate
  block boundaries. Use a **metadata-driven custom `join`** instead
  (`mdast-util-to-markdown` join returns the number of blank lines —
  `types.d.ts:509`; serializer already passes options — `serializer.ts:54`).

### ADR-1a — Serializer enablement without mutable cached state (Codex F-10)

The serializer is **statically cached** (`serializer.ts:50,84`), so a `join`
callback must NOT close over a per-call setting. Enablement is expressed in the
DATA: when disabled, `blankLinesBefore` is simply absent/null on the nodes, so
the join returns its default. No per-call serializer variants, no mutable global.

### ADR-2 — Setting semantics

Correct `markdown.preserveLineBreaks`'s label/description (it does soft→hard
break conversion) and add `markdown.preserveBlankLines` (default **false**)
driving ADR-1. Help text states the v1 scope (round-trip preservation, not
authoring; inter-block only — see ADR-5).

### ADR-3 — v1 scope

v1 preserves blank-line runs that EXISTED between blocks in the loaded document,
across load→edit→serialize. **Excludes** leading/trailing document whitespace
(Codex F-14: the inter-block model has no join boundary there) and authoring new
runs inside WYSIWYG. New blocks get `null` (inherit). Cap captured runs at a
disclosed maximum (**ADR-6**).

### ADR-4 — Capture unconditionally, gate only serialization (Codex F-12)

Do NOT gate metadata **capture** on the setting. Content sync reacts only to
`content`/`editor`, not setting changes (`useTiptapContentSync.ts:54`), so if a
doc is parsed while disabled, the gaps are gone from PM and toggling on later
can't recover them. Therefore: **always capture** `blankLinesBefore` at parse;
gate only whether the serializer **emits** it. Toggling the setting then needs no
reparse.

### ADR-5 — Edit propagation (Codex F-11 — must be resolved, not deferred)

PM's mid-block split copies node attributes to BOTH halves
(`prosemirror-transform structure.ts:213`); a paragraph with `blankLinesBefore=4`
would give the new second paragraph `4` too → four spurious blank lines. Rule:
**`blankLinesBefore` is cleared to `null` on any node created by an edit**
(split, paste, block conversion, list-item split). Only nodes that came directly
from a parse retain a captured value. Implemented via an appended ProseMirror
step/appendTransaction that nulls the attribute on newly-created blocks. Behavior
enumerated for split-at-start/middle/end, join/backspace, lift/sink, convert,
move, paste, undo/redo (WI-1.5).

### ADR-6 — Max-run cap + whitespace scope

Cap `blankLinesBefore` at **10** (disclosed in help text; runs >10 clamp to 10).
Leading/trailing document whitespace is out of scope for v1 (ADR-3).
