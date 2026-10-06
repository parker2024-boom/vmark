# Decisions — Multi-Format Workspace + Rebrand — Plain-Text Workspace for Humans and AI

> Plan: `dev-docs/plans/20260506-multi-format-rebrand.md` — tracked in this repository until commit `abc253488` moved `dev-docs/` out of version control.
> Built: the multi-format workspace (`src/lib/formats/`).
> Defines: ADR-1, ADR-2, ADR-3, ADR-4, ADR-5, ADR-6, ADR-7, ADR-8, ADR-9, ADR-10, ADR-11, ADR-12, ADR-13. These ids are local to this plan: a comment that cites one of them
> next to code this plan built means the decision below, not the repository-wide
> `ADR-NNN` of a similar number.
>
> The text below is the plan's own, unedited except that one personal name was removed from ADR-13. It is a record of what was decided then; paths and
> work-item ids in it are as of the plan and may have moved since.

### ADR-1: Tagline is "the plain-text workspace where humans and AI collaborate"

**Decision:** Adopt this exact tagline.

**Mechanism:** "Plain-text workspace" is concrete and searchable. "Humans and AI collaborate" names the differentiator. The "and" matters — both parties read and write the same plain-text artifacts directly, with no translation layer.

**Confidence:** High.

### ADR-2: Generic `<SplitPaneEditor>` + format registry replaces global mode dispatch and the markdown-only entry-point allow-lists

**Decision:** Introduce `<SplitPaneEditor>` (source slot + preview slot + validator slot) and a format registry (`src/lib/formats/registry.ts`) mapping `extension → FormatConfig`. The registry **replaces** today's:
1. Top-level `sourceMode` / `forcedSourceMode` orchestration in `Editor.tsx`.
2. `useUnifiedMenuCommands` hardcoded markdown menu dispatch.
3. Frontend `MARKDOWN_EXTENSIONS` constant in `dropPaths.ts` → becomes `SUPPORTED_EXTENSIONS`, derived from `listFormats()`.
4. Rust `MARKDOWN_EXTENSIONS` and `has_markdown_extension` in `lib.rs` → becomes `SUPPORTED_EXTENSIONS` and `has_supported_extension`, mirroring the frontend registry via a shared YAML config or a single hardcoded list maintained in lockstep.
5. Rust `validate_openable_path` security gate → expands its allow-list to all registered formats.
6. `closeSave.ts` `MARKDOWN_FILTERS` → derived per-tab from the active format's `saveDialogFilters`.
7. `newFile.ts` `createUntitledTab(windowLabel)` → accepts optional `formatId` (defaults to markdown).

Markdown stays on its current Tiptap WYSIWYG path, registered as `kind: "wysiwyg"`. Editor mount, menu adapter selection, search wiring, side-panel keep-alive, export availability, read-only policy, content-search scope, and reload behavior all key off `FormatConfig`.

**Mechanism:** Without unifying mount with the surrounding orchestration, non-markdown tabs would still be governed by markdown-era global state. The registry is the single source of truth for "what does this tab do."

**Trade-off:** `useLargeFileSessionStore.markForcedSource()` (used today for >5MB files to force source-mode rendering) becomes a markdown-adapter-internal concern. Other formats don't need it because they don't have a WYSIWYG path.

**Confidence:** High. Standard pattern. The cost is concentrated in Phase 1A (substrate refactor, ~2 weeks) and Phase 1B (entry-point migration, ~1.5 weeks).

### ADR-3: Code files are viewer-mode by default

**Decision:** `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.css`, `.sh`, `.rb`, `.lua` open with CodeMirror syntax highlighting in **read-only mode by default**. A clearly-labeled "Enable editing" toggle promotes to read-write (no LSP, no autocomplete). An "Open in external editor" affordance deep-links to `$EDITOR`.

**Mechanism:** Read-only-default is a pre-commitment device against scope creep into LSP territory.

**`.rb` and `.lua` use `@codemirror/legacy-modes`.** No maintained Lezer-grammar pack exists for either — Phase 0 WI-0.6 audit confirmed legacy-modes is the same path the plan already uses for TOML, `.sh`, and `.bash` (1.6M weekly DL, current commits, MIT, zero CVEs). Quality is "syntax-coloring only," which fits viewer-mode posture.

**Removed from v1 scope:** `.zig` only (no maintained CodeMirror pack of any kind).

**Confidence:** Medium-high.

### ADR-4: HTML preview is defended by three independent layers

**Decision:** HTML preview security relies on three independent layers, each addressing a distinct threat. **Each layer must be implemented and tested separately** — they are not substitutes for each other.

| Layer | Threat addressed | Mechanism | Test surface |
|---|---|---|---|
| 1 — Iframe `sandbox=""` (empty allow-list) | Script execution, form submission, popups, same-origin access, top-frame navigation | HTML attribute on the host iframe: `<iframe sandbox="" srcdoc={content}>` | Spike WI-0.4: assert `<script>alert(1)</script>` does not execute, `<form>` cannot submit, `window.top` access throws |
| 2 — Injected `<meta http-equiv="Content-Security-Policy">` | Resource loading inside the document (remote `<img>`, remote fonts, remote stylesheets, inline `<script>` interpretation if sandbox is somehow bypassed) | `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` injected at the top of the rendered document | Assert remote `<img src="https://evil/...">` does not fetch (verify network panel); inline `<script>` is blocked by CSP independently of sandbox |
| 3 — `DOMPurify` sanitization | Defense in depth against parser quirks, mutation XSS, mXSS chains | `DOMPurify.sanitize(content, { USE_PROFILES: { html: true } })` before injection | Assert known mXSS payloads from DOMPurify's own test corpus are neutralized |

**What sandbox does NOT do**: the empty `sandbox` attribute blocks scripts and same-origin access, but it **does not in itself prevent the document from making subresource requests** — that is CSP's job. Conflating the two layers is the most common implementation mistake; spike WI-0.4 must verify both independently.

**What `<meta>` CSP does NOT do**: per MDN, the `sandbox` CSP directive is ignored when delivered via `<meta>`. So `<meta http-equiv="Content-Security-Policy" content="sandbox">` is **not** equivalent to the iframe attribute and must not be relied on for sandboxing.

The Tauri webview's outer CSP (set in `tauri.conf.json` `app.security.csp`) is a fourth, system-level layer, independent of the three above.

**Trade-off:** Users cannot see externally-loaded images, fonts, or remote stylesheets in preview. Acceptable.

**Confidence:** Medium-high on each layer individually. Spike WI-0.4 closes the integration question.

### ADR-5: Schema-aware previews via `schemaDetector` hook, with deterministic precedence

**Decision:** Format registry entries for data formats accept an optional `schemaDetector(path: string, content: string) => SchemaId | null`.

**Detector precedence rules:**
1. **Path detection wins over content detection.** A `.github/workflows/ci.yml` with malformed YAML routes to the GHA renderer (which renders a degraded view with diagnostics) rather than falling back to a generic tree.
2. **Multiple detector hits resolved by registry order.** Detectors registered earlier win. Order is documented in `registry.ts` with a comment.
3. **Content detection on syntactically invalid content returns `null`.**
4. **Detectors are pure and synchronous.** No I/O; no async.

**Confidence:** Medium-high.

### ADR-6: Rebrand ships only after Phase 2 substrate **and** at least one schema-aware preview lands

**Decision:** Tagline propagation is Phase 6, gated on Phase 2 having shipped (markdown + txt + json + yaml + toml + GHA-via-registry + Cargo.toml dep tree).

**Confidence:** High.

### ADR-7: One file extension, one editor — no content sniffing

**Confidence:** High.

### ADR-8: Validator interface is normalized across all formats

**Decision:** `(content: string, path?: string) => ValidationDiagnostic[]` per § Format registry contract. Single gutter component consumes this shape.

**Confidence:** High.

### ADR-9: Print, export, copy-as-HTML, content-search scope expansion

**Decision (in v1):**
- Print, Export (PDF / HTML / DOCX), Copy-as-HTML: **disabled for non-markdown tabs** (greyed out with tooltip).
- Save As (source bytes): **available for all formats**.
- Content search (Cmd+Shift+F): **expands to all text-like registered formats** (markdown, txt, json, yaml, toml, html, svg, mmd) — but **excludes code-viewer formats by default** (settable via search scope UI per WI-1B.13).

**Confidence:** High.

### ADR-10: Kind change semantics

**Decision:** When a tab's path changes (rename, Save As, reopen) and the new extension maps to a different `FormatConfig`, the editor surface unmounts and the new surface mounts fresh. Document content is preserved as a string; **undo history is reset**, dirty state is preserved, and a one-time toast informs the user.

**Confidence:** High.

### ADR-11: Spike code disposition

**Decision:** Phase 0 spike code in `dev-docs/grills/multi-format/` is **deleted before Phase 1A begins**. If a spike result is to be promoted, it goes through a dedicated WI in Phase 1A, copied (not moved) and reviewed independently.

**Confidence:** High.

### ADR-12: Rust ↔ TS extension list synchronization

**Decision:** The Rust `SUPPORTED_EXTENSIONS` constant in `lib.rs` and the TypeScript registry's exported extension list are synchronized via a manually-maintained mirror with a CI guard. `scripts/check-ext-sync.sh` (NEW) compares the two lists at every PR; mismatch fails CI.

**Mechanism:** Code-generation from a single source (e.g., generating Rust from TS at build time) introduces a build-step dependency. Manual mirror with CI guard is simpler and proven (the project already does this for keyboard shortcuts per `.claude/rules/41-keyboard-shortcuts.md`).

**Confidence:** Medium-high.

### ADR-13: `codemirror-lang-mermaid` dependency contingency (rev 6)

**Decision:** `codemirror-lang-mermaid` 0.5.0 is pinned exactly. If any of the following triggers fire, switch to an internal fork in `src/lib/codemirror/lang-mermaid/` rather than upgrading or replacing the dep.

**Replace triggers (any one fires the contingency):**
1. Upstream is unmaintained for >12 months from the last release as of the trigger evaluation date.
2. A security advisory is filed against the package with no upstream response within 14 days.
3. A required Mermaid v12+ syntax feature is unsupported by the package and a maintainer issue receives no response in 30 days.

**Contingency action:** the project owner files a Phase-N+1 WI to fork the package locally. The fork is `src/lib/codemirror/lang-mermaid/` with a CHANGELOG noting the trigger and the upstream commit hash forked from.

**Mechanism:** `codemirror-lang-mermaid` failed the recency expectation already (last release predates this plan) but is otherwise functional. Codifying the trigger turns dependency risk into a named decision rather than a creeping liability.

**Confidence:** High on the trigger criteria; medium on the timing of when a fork would actually be needed.
