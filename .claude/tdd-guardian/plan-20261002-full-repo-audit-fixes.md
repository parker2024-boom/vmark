---
title: "Full-repo audit fixes — every finding from the 2026-10-02 audit"
created_at: "2026-10-02 local"
mode: "full-plan"
---

# Full-repo audit fixes

**Status:** IN PROGRESS (started 2026-10-02). Waves 1–2 merged and green.
**Tree:** `fa785a700` (v0.9.91). **Branch:** `fix/full-repo-audit-20261002`.
**Evidence:** `dev-docs/deep-researches/20261002-full-repo-audit.md` (maintainer-local) — 129 findings (0 Critical, 24 High, 55 Medium, 50 Low). Each work item cites the audit section it closes; the audit carries the paths and the reasoning, this plan carries the decision and the check.
**Namespace:** `WI-RA<phase><lane>.<n>` (rule 60 §1) — a phase split across lanes carries the lane letter (`WI-RA1A.2`, `WI-RA13B.7`) so each lane is gated on its own. Decisions are `D<n>`.
**DoD:** `bash scripts/check-repo-audit-phase.sh <phase|all>` (rule 60 §3; self-tested, lands with the final wave and asserts, per phase, that the named regression tests exist and that `bash scripts/check-wi-linkage.sh .claude/tdd-guardian/plan-20261002-full-repo-audit-fixes.md --phase=<phase>` is green). Whole plan: `pnpm check:predelta`, `pnpm check:all`, `cargo test --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `bash scripts/check-cross-target.sh` all exit 0. RED evidence for each behaviour fix is recorded in the lane report and summarized in the status trail. This plan is tracked (not in `dev-docs/plans/`) so the DoD script, CI and lane worktrees can read it.

## Operating rules for this plan

1. **No banned moves.** No new entries in an existing baseline/allowlist/ignore file (two registries the audit itself asks for are new and are not exceptions to this: the cargo-audit acceptance file, which mirrors the npm one and is enforced two-way, and the Rust coverage floor, which ratchets up), no raised budgets or thresholds, no `skip`/`only`/`eslint-disable`/`#[allow]` to silence a check, no deleted failing test. A bound may change only with the mechanism stated in the commit message.
2. **Test first.** Every behaviour fix lands with a regression test that was run and seen failing before the fix. Docs, config and CSS are exempt (rule 10).
3. **Mechanism, not instance.** Where the audit names a class (removal-without-cleanup, drifted twins, check-then-act on window labels), grep the whole surface and fix every occurrence; then leave the assertion (test or gate) that makes its return loud.
4. **Files stay under the size gate.** `pnpm lint:file-size` ratchets down only; a baselined file may not grow. Extract instead.
5. **One lane, one worktree, disjoint files.** Lanes run in parallel in git worktrees; the file ownership column is binding. A lane that needs a file another lane owns stops and reports instead of editing it.

## Decisions

| # | Decision | Outcome | Owner |
|---|---|---|---|
| D1 | Where the ADRs live. The audit suggests `docs/adr/`, but `docs/` is gitignored (`.gitignore`), so that path cannot ship. | Tracked `.claude/adr/ADR-NNN-*.md`, reconstructed from the enforcing code and git history, each stating its evidence. Citations in AGENTS.md, CONTRIBUTING, rule 31, `server/mcp/README.md` and the feature ledger point there. A gate resolves every `ADR-N` token in tracked files to a file. | made here |
| D2 | `SECURITY.md` commitments (supported versions, response expectation) are the maintainer's to promise. | Written with the least binding accurate wording: latest release only, private reporting link, best-effort acknowledgement by a single maintainer. Flagged for confirmation in the final report. | maintainer: Codex review 2026-10-03 (thread `01a100be-c422-7b11-a787-0bd0040d1cf1`); 9 wording findings applied; Rust translations reviewed, no change |
| D3 | SVG `<style>` containment: shadow root per preview vs selector scoping. | **Selector scoping** (WI-RA8.2). A shadow root breaks three things the previews depend on: print and HTML/PDF export serialize the editor with `innerHTML`, which drops shadow content (the serializing API needs Safari 18, above the macOS 13.4 floor); app CSS styles the SVG on purpose (`mermaid-fallback.css`, sizing, the foreignObject line-height fix); pan/zoom and the link guard reach the SVG through the light DOM. The selector parser concern is met by not parsing selectors as text: the engine parses the sheet (a constructed stylesheet), each selector S is re-emitted as `:is([data-vmark-svg-scope="K"], [data-vmark-svg-scope="K"] *):is(S)`, and the output is re-parsed and rejected unless every selector has that shape. Keyframes are renamed per scope, page-wide at-rules dropped. Preview containers also get `contain: paint`: WebKit hit-tests an absolutely positioned element in a foreignObject against the whole window otherwise. | lane RA8 |
| D4 | `image-size` advisory: override to `>=2.0.3` or keep the acceptance with a corrected reason. | Try the override, run `test:content-server`; fall back to rewriting the reason only if pptxgenjs breaks. | lane RA16 |
| D5 | `src/services/mcpBridge/v2/` naming (no v1 ever existed). The audit says "keep or rename". | Keep. A rename touches ~60 files and every import for zero behaviour change; the directory header says what "v2" means. | made here |
| D6 | E2E: adding a macOS leg costs runner minutes. | Add it to the existing weekly workflow only (no per-PR cost). Flagged in the final report. | made here, maintainer may veto |
| D7 | `scripts/` enters the file-size gate. The audit suggests a frozen baseline; rule 1 above forbids new baseline entries. | Split the over-limit gate scripts so they pass without a baseline entry. | made here |
| D8 | Coverage `include` widens the denominator. | Write tests for the executable files that had none until the existing floors hold. The floors are not lowered. | made here |
| D9 | Low observations with no defect (85 non-React `.ts` under `components/`, three plugin entry styles). | Fix the concrete inversions (`lib/formats/adapters/markdown.tsx` importing from `components/`, `services/browser/lease.ts` store location, the 15 plugin dirs that match neither documented entry convention). Colocated pure helpers stay: AGENTS.md "keep features local" is the governing rule. | made here |

## Phases

Waves are ordered by file conflict, not by priority inside a wave. Every phase is one lane.

### Wave 1

#### Phase RA1 — MCP write path and tab-removal cleanup (TS)
Owns: `src/services/mcpBridge/v2/{document,workspace,workspaceSave,workspaceSaveAs,selection}.ts` (+tests), `src/services/persistence/**`, `src/services/tabs/**`, `src/services/navigation/**`, `src/services/coherence/captureFunnel.ts`, `src/services/hotExit/restoreHelpers.ts`, `src/hooks/useWorkspaceBootstrap.ts`, `src/stores/tabStore*`, the `tabRemovalBus` module, wherever `fileSave.ts` lives.

- **WI-RA1B.1 — tab removal always cleans up document state.** Audit §3 High TS #1. Make cleanup a `tabRemovalBus` subscriber so every removal site (the nine listed) gets it; `handleSaveAllQuit` iterates tabs, not documents; MCP `workspace.close` reports the real `closeTab` result (pinned tab refused → not `closed: true`). Tests: closed-by-MCP tab is not written by Save All and Quit; each listed removal site leaves no orphan document; pinned-tab close reports the refusal.
- **WI-RA1A.2 — all three MCP disk writes go through `saveToPath`.** Audit §3 High TS #2. Tests: CRLF/BOM file written by MCP keeps its line endings and BOM and is clean afterwards; Save-As racing an in-flight autosave keeps the new path; concurrent writes to one path serialize; a history snapshot is taken; the write is atomic (no direct `writeTextFile`). Leave a gate/test that fails if `mcpBridge/v2` imports plugin-fs `writeTextFile`.
- **WI-RA1A.3 — `document.write` to the active WYSIWYG tab does not re-dirty.** Audit §3 High TS #3. `preventUpdate` meta; snapshot from the store after the write. Test: after a "saved" write the doc is clean, revision is the one returned, the next `expected_revision` is accepted.
- **WI-RA1B.4 — `handleSaveAllQuit` revalidates after its dialogs.** Audit §3 Medium TS #2. Mirror the `windowCloseFlow.ts` loop. Test: content edited while the dialog is open is what gets written.
- **WI-RA1B.5 — `handleMoveTo` removes the old path on the per-path chain.** Audit §3 Low. Test: a late autosave cannot recreate the old file.
- **WI-RA1A.6 — one tab/revision guard for the MCP handlers; finish the `readOperationArgs` migration; collapse the wysiwyg/source twin branches in `handleSelectionSet`/`handleDocumentWrite`.** Audit §1 Medium, §5.
- **WI-RA1A.7 — the pending-save grace window is one named constant/helper** used by all four sites. Audit §5 Medium.
- **WI-RA1A.8 — `handleRequest.test.ts` asserts the reply, not that `respond` was called**, without mocking the subject's direct imports. Audit §7 Medium.

#### Phase RA2 — Save-time normalization and Markdown round trip (TS)
Owns: `src/utils/linebreaks.ts`, `src/utils/markdownPipeline/**`, `src/plugins/markdownCopy/**`, `src/services/editor/sourcePeek.ts`.

- **WI-RA2.1 — hard-break normalization skips math, HTML blocks, tables and indented code.** Audit §3 High TS #4, #5. Protected ranges come from the parser, not from regex. Property test: for generated documents, normalization never changes bytes inside a protected construct, and `parse(serialize(parse(x)))` is stable.
- **WI-RA2.2 — backslash style: paragraph-final and literal trailing backslashes survive.** Audit §3 High TS #5 (`foo\`, `C:\dir\\`).
- **WI-RA2.3 — round-trip losses.** Audit §3 Medium TS #4: paragraph-final hard break, code-fence `meta`, loose vs tight lists, `<summary>` marks, image alt escaping, the stray-backtick escape scope, `'` → `&#39;` in inline-HTML merge. One test per loss, each seen RED.
- **WI-RA2.4 — one `serializeSlice` for copy and source peek; `docFromSlice` in `src/utils/markdownPipeline/`.** Audit §1 Medium #1, §3 Medium TS #5. Copy keeps load-bearing escapes and fence contents.
- **WI-RA2.5 — remove the stale cast at `pmInlineConverters.ts:201`.** Audit §1 Low. [no-test: type-only: a stale cast removed; typecheck is the check]

#### Phase RA3 — CJK formatter (TS)
Owns: `src/lib/cjkFormatter/**`, `src/lib/ghaWorkflow/cron/**`.

- **WI-RA3.1 — spacing rules never join paragraphs** (`[ \t]+`, and grep every rule for `\s` crossing a newline). Audit §3 High TS #6.
- **WI-RA3.2 — coverage gaps:** non-ASCII Latin, supplementary-plane Han, link-closing `)`. Audit §3 Medium TS #6.
- **WI-RA3.4 — property tests for cron** (`src/lib/ghaWorkflow/cron/**`, TypeScript). Audit §7 Low.
- **WI-RA3.3 — no quadratic backtracking on long alnum/base64 runs.** Audit §6 Medium. Growth test with `measureGrowth`/`growthExponent`.

#### Phase RA4 — Process execution and privilege (Rust)
Owns: `src-tauri/src/ai_provider/**`, `pandoc/run.rs`, `external_editor.rs`, `shell_integration.rs`, `cli_install/**`, `quarantine.rs`, `supported_files.rs`; may touch `workflow/genie_step.rs` for the stdin switch only.

- **WI-RA4.1 — delete the `cmd.exe /c` wrapper; prompts go to the child on stdin.** Audit §2 High. Test: a prompt containing `"`, `&`, `%VAR%` reaches the child as one unmodified value. Cross-target check must stay green.
- **WI-RA4.2 — `shell_integration` and `external_editor` accept only known executables.** Audit §2 Medium #3 (the PTY third is WI-RA6.6).
- **WI-RA4.3 — privileged CLI install does not trust a user-writable temp file.** Audit §2 Medium #4. Generate inside the privileged shell from a single-quoted literal; remove the target on mismatch.
- **WI-RA4.4 — `strip_workspace_quarantine_cmd` accepts only granted workspaces; pin the non-dereferencing behaviour with a test.** Audit §2 Low.

#### Phase RA5 — Workflow engine (Rust)
Owns: `src-tauri/src/workflow/{expressions,condition,runner,types}.rs` and new sibling modules.

- **WI-RA5.1 — references resolve in one left-to-right pass over the template only.** Audit §3 High Rust #1. Tests: step output containing `${HOME}` or a JS template literal is passed through verbatim; same for `condition.rs`.
- **WI-RA5.2 — `failure()` and `always()` are reachable.** Audit §3 Medium Rust #1. Test: an `if: always()` step runs after a failed step.
- **WI-RA5.3 — split `run_workflow_sequential`** into preflight, approval gate, execute-with-timeout, record. Audit §5.
- **WI-RA5.4 — narrow the struct-level `allow(dead_code)`** to the two unread fields, or delete the fields. Audit §1 Low.

#### Phase RA6 — PTY and terminal transcript (Rust, small TS)
Owns: `src-tauri/src/pty.rs`, `pty/**`, `terminal_transcript/**`, `src/hooks/useTerminalTranscript.ts`.

- **WI-RA6.1 — kill escalates and the reader is interruptible.** Audit §3 High Rust #2. SIGHUP → bounded grace → SIGKILL → `wait()`; one `terminate()` for both ownership states. Test with a HUP-ignoring child: no thread, fd or zombie survives.
- **WI-RA6.2 — `pty_close` on a started session terminates the shell.** Audit §3 Medium Rust #2.
- **WI-RA6.3 — hook config write preserves a symlinked `settings.json` and fsyncs before rename.** Audit §3 Medium Rust #5.
- **WI-RA6.4 — transcript open checks `is_file()` first; one UUID encoding.** Audit §3 Low.
- **WI-RA6.5 — transcript polling returns the delta, not the 2 MiB tail.** Audit §6 Medium.
- **WI-RA6.6 — `pty_spawn` accepts only shells from `list_available_shells()`, constrained args, allowlisted env keys.** Audit §2 Medium #3.

#### Phase RA7 — Window and quit lifecycle (Rust, small TS)
Owns: `src-tauri/src/window_manager/**`, `pdf_export_window.rs`, `quit.rs`, `single_instance.rs`, `app_setup.rs`, `tab_transfer.rs`, `workspace_transfer.rs`, and the TS callers of the two `claim_*` commands.

- **WI-RA7.1 — fixed-label window creation is check-and-build on the main thread.** Audit §3 High Rust #3. Every fixed label (`settings`, `main`, others found by grep).
- **WI-RA7.2 — PDF export waits for `Destroyed` before rebuilding the label.** Audit §3 Medium Rust #3.
- **WI-RA7.3 — quit broadcast honours window readiness.** Audit §3 Medium Rust #4.
- **WI-RA7.4 — `frontend_ready` is cleared when `main` dies.** Audit §3 Medium Rust #6.
- **WI-RA7.5 — `claim_tab_transfer`/`claim_workspace_transfer` take `tauri::Window`.** Audit §3 Low.
- **WI-RA7.6 — `FILE_OPEN_STATE.lock()` recovers from poison like every other site.** Audit §3 Low.
- **WI-RA7.7 — webview strings are escaped before logging.** Audit §2 Low (reuse `peer_text`).

#### Phase RA13a — Gate honesty (scripts)
Owns: `scripts/check-npm-audit*`, `scripts/check-new-deps*`, `scripts/check-scripts-parity.test.mjs`, `scripts/check-test-timer-isolation*`, `scripts/check-merge-drops*`, the other untested gates named in `gate-tests-baseline.json`, `.jscpd.json`, `knip.json`, the orphaned phase scripts and one-shots.

- **WI-RA13A.1 — fixture self-tests for `check-npm-audit.mjs` and `check-new-deps.sh`.** Audit §7 High #2.
- **WI-RA13A.2 — parity covers every script a `ci.yml` `run:` names.** Audit §7 High #2.
- **WI-RA13A.3 — timer-isolation gate resolves `__tests__/` and multi-dot names and flags real sleeps ≥ 100 ms.** Audit §7 Medium #2. The violations it then reports are fixed in RA14, not baselined.
- **WI-RA13A.4 — self-tests for the eight untested gates; empty `gate-tests-baseline.json`.** Audit §7 Low.
- **WI-RA13A.5 — delete the orphaned phase scripts (each verified: its plan is gone and nothing references it; `check-gha-phase.sh` stays, rule 60 names it as the template), `scripts/lib/dod-assertions.sh` if unreferenced, and the seven zero-reference one-shots.** Audit §1. [no-test: deletion of unreferenced scripts; each verified unreferenced before deleting]
- **WI-RA13A.6 — `.jscpd.json` and `knip.json` cruft.** Audit §1 Low. [no-test: config: keys the tools reject or report unneeded]

#### Phase RA15a — Compliance and repository docs
Owns: root `*.md`, `.github/ISSUE_TEMPLATE/**`, `.claude/README.md`, `.claude/adr/**`, `.claude/rules/*.md`, `server/mcp/README.md`, `e2e/README.md`, `AGENTS.md`, `scripts/check-mcp-docs*`, a new ADR-reference gate.

- **WI-RA15A.1 — `SECURITY.md`, issue-template contact link, links from README and the privacy page.** Audit §4 High. (D2) [no-test: docs]
- **WI-RA15A.3 — CONTRIBUTING leads with the issues-only policy.** Audit §4 Medium. [no-test: docs]
- **WI-RA15A.4 — pnpm range and MSRV are stated and pinned** (`rust-toolchain.toml` or `rust-version`). Audit §4 Low. [no-test: docs and a manifest field; cargo check and clippy's incompatible_msrv lint hold it]
- **WI-RA15A.5 — ADRs exist where a clone can read them, and a gate resolves every citation.** Audit §9 High. (D1)
- **WI-RA15A.7 — `server/mcp/README.md` matches the code and is joined by `lint:mcp-docs`.** Audit §9 Medium.
- **WI-RA15A.8 — dangling doc references:** `e2e/README.md`, AGENTS.md e2e guide and `mod.test.rs`. Audit §9. [no-test: docs]
- **WI-RA15A.9 — `.claude/README.md` describes the tooling that exists.** Audit §9 Medium. [no-test: docs]
- **WI-RA15A.11 — prerequisites and env vars documented:** `tokei`, `zsh`, `gh`, the `VMARK_*` variables, the sidecar build step. Audit §9. [no-test: docs]

### Wave 2

#### Phase RA8 — Webview security (TS, Rust, config)
Owns: `src/utils/{svgSanitize,styleSafety,htmlAllowlists,htmlToMarkdown}.ts`, preview mount code for HTML/SVG/Mermaid, `src-tauri/tauri.conf.json` CSP, a new `on_navigation` handler, `server/content/src/server/{auth,assets}.ts`.

- **WI-RA8.1 — a click in a preview never navigates the editor webview.** Audit §2 Medium #1. `on_navigation` allowlist, `form-action 'none'`, clicks delegated to `openLinkTarget`.
- **WI-RA8.2 — SVG `<style>` cannot restyle the app.** Audit §2 Medium #2. (D3)
- **WI-RA8.3 — `/__auth?next=` rejects `/\`.** Audit §2 Low.
- **WI-RA8.4 — the session token is not appended for the external browser.** Audit §2 Low.
- **WI-RA8.5 — clipboard HTML is parsed with `DOMParser`.** Audit §2 Low.

#### Phase RA1C — MCP bridge and document-lifecycle follow-ups (TS)
Found by wave-1 lanes outside their ownership.

- **WI-RA1C.1 — a programmatic load does not bump the MCP revision.**
- **WI-RA1C.2 — the remaining bridge handlers use the shared tab guard and payload parse.**
- **WI-RA1C.3 — genie `fillTemplate` resolves in one pass and never interprets `$` patterns in content.**
- **WI-RA1C.4 — redundant explicit cleanup removed; document-iterating sites reviewed.**
- **WI-RA1C.5 — Save All and Quit across windows verified; MCP close of a divergent document decided.**
- **WI-RA1C.6 — `workspace.close` documents every refusal reason.**

#### Phase RA9a — Drifted and duplicated editor plugins (TS)
Owns: `src/plugins/shared/WysiwygPopupView.ts`, `mathPopup/**`, `codemirror/smartPasteImage.ts`, `imageHandler/**`, `editorPlugins/linkCommands.ts`, `imagePreview/resolveSrc.ts`, `imageView/resolveSrc.ts`, `src/services/media/resolveMediaSrc.ts`, `footnotePopup/tiptapCleanup.ts`, `multiCursor/inputHandling.ts`.

- **WI-RA9A.1 — WYSIWYG popups commit on click-outside like Source popups.** Audit §1 High #1.
- **WI-RA9A.2 — one image-paste resolver; Source pastes show the same toasts.** Audit §1 High #2.
- **WI-RA9A.3 — delete the dead link shortcut handlers.** Audit §1 High #3.
- **WI-RA9A.6 — one footnote cleanup algorithm with a `keepLabels` parameter.** Audit §1 Medium.
- **WI-RA9A.7 — multi-cursor Input/Backspace/Delete share one prologue/epilogue.** Audit §1 Medium. [no-test: behaviour-preserving refactor; the 564 existing multiCursor tests, including the property tests, are the contract]
- **WI-RA9A.8 — one `resolveSrc`.** Audit §1 Medium.
- **WI-RA9A.10 — a sibling-drift assertion** for the popup base pair (the audit's "maintain these standards" #1).

#### Phase RA9b — Components and export reader (TS/JS)
Owns: the five context-menu files, `components/Tabs/useMenuPosition.ts`, `WorkspaceRail/workspaceRailMenuLayout.ts`, `components/Terminal/useTerminalResize.ts`, `hooks/useSidebarResize.ts`, `hooks/useTabDragOut.ts`, `src/export/reader/**`, `mermaidPanZoom.ts`, `TerminalTabBar.tsx`.

- **WI-RA9B.4 — one menu-position clamp, never negative.** Audit §1 High #4.
- **WI-RA9B.5 — `useDocumentDrag` shared by sidebar and terminal resize; no listener leak; no whole-layout re-render per mousemove.** Audit §1 High #5, §6 Low.
- **WI-RA9B.9 — exported reader footnote navigation targets what the exporter emits; the file is linted and tested as code.** Audit §1 Medium.
- **WI-RA9B.11 — `useTabDragOut` removes its document listeners on unmount.** Audit §3 Low.
- **WI-RA9B.12 — stale casts in `mermaidPanZoom.ts` and `TerminalTabBar.tsx`.** Audit §1 Low. [no-test: type-only: stale casts removed; typecheck is the check]

#### Phase RA10a — Editor correctness (TS)
Owns: `services/files/applyModifyPolicy.ts`, `plugins/compositionGuard/**`, `hotExit/restoreListeners.ts`, `utils/exportNaming.ts`, `utils/historyTypes.ts`, `history/historyOperations.ts`, `components/Sidebar/HistoryView.tsx`, `stores/settingsStore/clamp.ts`.

- **WI-RA10A.1 — external-change reload flushes the editor before reading `isDirty`.** Audit §3 Medium TS #1.
- **WI-RA10A.2 — IME: composition start is mapped through transactions; external writes wait for composition end.** Audit §3 Medium TS #3.
- **WI-RA10A.11 — `restoreListeners` cannot leak an unlisten.** Audit §3 Low.
- **WI-RA10A.12 — truncation is surrogate-safe.** Audit §3 Low.
- **WI-RA10A.13 — history index read-modify-write is serialized.** Audit §3 Low.
- **WI-RA10A.16 — history revert goes through the save pipeline.**
- **WI-RA10A.14 — `historyMaxAgeDays` minimum is 1.** Audit §3 Low.

#### Phase RA10b — Editor performance (TS)
Owns: `components/Editor/SourceEditor.tsx`, `utils/cursorSync/**`, `usePreviewModel.ts`, `useTiptapContentSync.ts`, `plugins/blankLinesGuard/**`, `plugins/footnotePopup/tiptap.ts`, `hooks/useAutoSave.ts`, `useTiptapFlush.ts`, `plugins/aiSuggestion/tiptap.ts`, `stores/aiStore/genies.ts`, `src/main.tsx`, `vite.config.ts` chunking.

- **WI-RA10B.3 — Source mode cursor info is O(lines scanned), RAF-coalesced.** Audit §6 High #1. Growth test.
- **WI-RA10B.4 — split-view preview parse is debounced adaptively.** Audit §6 Medium.
- **WI-RA10B.5 — `blankLinesGuard` walks changed ranges only.** Audit §6 Medium.
- **WI-RA10B.6 — `footnotePopup` caches per doc.** Audit §6 Medium.
- **WI-RA10B.7 — autosave returns early when nothing is pending.** Audit §6 Medium.
- **WI-RA10B.8 — `aiSuggestion` decorations are keyed/mapped.** Audit §6 Low.
- **WI-RA10B.9 — genies load in one IPC.** Audit §6 Low.
- **WI-RA10B.10 — startup: App chunk preloaded, secure storage not awaited before import; bundle headroom restored without raising a budget.** Audit §6 Low.
- **WI-RA10B.15 — one `findNearestIndexOf`.** Audit §1 Medium. [no-test: behaviour-preserving refactor; the existing cursorSync tests are the contract]

#### Phase RA11 — Rust I/O and performance
Owns: `src-tauri/src/watcher.rs`, `atomic_replace.rs`, `app_paths.rs`, `content_search.rs`, `coherence/**`, `file_tree_walk.rs`, `workspace.rs`, `shell_env.rs`, `src/hooks/useWindowFileWatcher.ts`, `src/services/coherence/scanOnChange.ts`.

- **WI-RA11.1 — the watcher surfaces errors and rescans, batches events and targets the owning window.** Audit §3 Low, §6 Medium.
- **WI-RA11.2 — `atomic_replace` fsyncs the parent directory.** Audit §3 Low.
- **WI-RA11.3 — content search: one open + `fstat` per file, one deadline budget; function split.** Audit §5, §6.
- **WI-RA11.4 — coherence commands run blocking work on `spawn_blocking`, hash once, skip unchanged files.** Audit §6 High #2.
- **WI-RA11.5 — no sync I/O on the main thread** in `workspace.rs`, `watcher.rs`, `shell_env.rs`. Audit §6 Low.
- **WI-RA11.7 — `gha_lint` does not take a PATH prefix from the webview; no bare `Command::new`.**
- **WI-RA11.6 — file tree sends relative paths.** Audit §6 Low.

#### Phase RA12a — Rust cleanup
Owns: `src-tauri/src/content_server/**`, `Cargo.toml`, `pdf_export/page_spec.rs`, `rest_api.rs`, `browser/*_macos.rs`, `workflow/dir_fd.rs` (comments only), legacy-migration modules.

- **WI-RA12A.1 — delete the dormant content-server upgrade path and `ed25519-dalek`.** Audit §1 Medium. [no-test: deletion of code with no non-test caller and its dependency; cargo machete and the suite are the check]
- **WI-RA12A.2 — stale comments:** `block2`, `page_spec.rs`. Audit §1 Low. [no-test: comments only]
- **WI-RA12A.3 — one `ProviderEndpoint::resolve` in `rest_api.rs`.** Audit §5.
- **WI-RA12A.4 — every `unsafe` block carries a `// SAFETY:` comment; `nav_delegate_macos.rs` checks the class before the cast; clippy's `undocumented_unsafe_blocks` holds it.** Audit §2 Low.
- **WI-RA12A.7 — stale workflow completion-event comments.**
- **WI-RA12A.5 — legacy migration shims carry a version-based removal condition** (Rust and TS; comments carry no calendar dates, rule 22). Audit §1 Low. [no-test: comments only]

#### Phase RA16 — Dependencies and CI
Owns: `package.json` overrides, `pnpm-workspace.yaml`, `scripts/npm-audit-baseline.json`, `.github/workflows/**`, a cargo-audit acceptance file.

- **WI-RA16.1 — `image-size` advisory resolved.** Audit §8 Medium. (D4) [no-test: config: a dependency override; check-npm-audit.mjs and test:content-server are the check]
- **WI-RA16.2 — `minimumReleaseAge`; third-party actions pinned by SHA.** Audit §2 Low, §8 Low.
- **WI-RA16.3 — cargo-audit warnings carry tracked acceptance notes, enforced two-way.** Audit §8 Low.
- **WI-RA16.4 — Rust coverage has a liveness marker and a ratcheting floor.** Audit §7 Medium #1.
- **WI-RA16.5 — E2E: the darwin journeys run on macOS, the 16 unscheduled journeys run, `pdf-smoke` triggers on `PdfExportPage.tsx`.** Audit §7 Medium #4. (D6)

#### Phase RA18 — follow-ups found by earlier lanes (TS)
- **WI-RA18.1 — the MCP path guard derives allowed roots from live tabs only.**
- **WI-RA18.2 — external writers respect an in-progress IME composition; Source popups guard Enter.**
- **WI-RA18.3 — code-fence meta and loose lists round-trip; residual round-trip losses fixed.**
- **WI-RA18.4 — Source copy-on-select and hard-break detection use the parser.**
- **WI-RA18.5 — the remaining sanitizers parse in an inert document.**
- **WI-RA18.6 — the Source table menu uses the shared clamp.**
- **WI-RA18.7 — remaining truncations are surrogate-safe.**
- **WI-RA18.8 — bridge comment and handler cleanup.**
- **WI-RA18.9 — bundle headroom restored without raising a budget.**
- **WI-RA18.10 — content-server lint is clean and gated; subresource tokens.**
- **WI-RA18.11 — MCP history snapshots have their own kind.**

### Wave 3

#### Phase RA17 — Maintainability (TS)
- **WI-RA17A.1 — split `renumberFootnotes`.** Audit §5.
- **WI-RA17A.2 — extract hooks from `GeniePicker`, `UniversalToolbar`, `StepForm`.** Audit §5.
- **WI-RA17C.3 — execute WI-8: `sourcePopup` utils to `plugins/shared/`, retire the plugin-wide `pathNot` licenses and every plugin-to-plugin edge that can go.** Audit §5.
- **WI-RA17D.4 — terminal slices leave `uiStore`.** Audit §5.
- **WI-RA17D.6 — layer inversions and entry-point deviants (D9).** Audit §5 Low.

#### Phase RA13b — Gates on themselves
- **WI-RA13B.7 — `scripts/` is in the file-size gate with no new baseline entries; `check-i18n-keys.ts` is split and its header is true.** Audit §5 Medium. (D7)
- **WI-RA13B.8 — the mock-boundaries ratchet sees same-feature sibling mocks.** Audit §7 Medium #3.

#### Phase RA14 — Tests
- **WI-RA14A.2 — the sleeps the widened timer gate reports are replaced with fake timers or awaited conditions.** Audit §7 Medium #2. TZ and locale pinned; tests reading `Date.now()` use a fake clock, and the gate checks it.
- **WI-RA14B.3 — Rust tests for the untested disk-writing modules** (`coherence/state_write.rs`, `workspace_files`, `quarantine.rs`, `pty.rs`, `workflow/dir_fd.rs`, the rest by size). Audit §7 Medium #1.
- **WI-RA14C.4 — wiring-heavy tests assert behaviour** (`TiptapEditor.lifecycle`, `useGenieShortcuts.invokeGenie`). Audit §7 Medium #3.
- **WI-RA14C.5 — journeys for hot-exit crash recovery, MCP `document.write`, PDF export, AI genies, workflow execution, find/replace, i18n switching, the update checker and settings persistence.** Audit §7 Medium #4.

#### Phase RA15b — Shipped notices, release notes, guide
- **WI-RA15B.2 — `THIRD_PARTY_LICENSES` generated at build into `bundle.resources`, surfaced from About.** Audit §4 Medium.
- **WI-RA15B.6 — release notes reach `latest.json`; the bump rule has a notes step.** Audit §9 Medium.
- **WI-RA15C.10 — the 16 undocumented behaviours and 4 contradicting pages, in all locales; the trigger table in rule 21 gains their rows.** Audit §9 Medium.

#### Phase RA19 — TypeScript defects found by the docs and component lanes
- **WI-RA19.1 — shortcut import errors use the app's dialog convention.**
- **WI-RA19.2 — Close All closes every unpinned tab.**
- **WI-RA19.3 — AI Retry re-runs the failed invocation.**
- **WI-RA19.4 — remaining hard-coded English strings are translated.**
- **WI-RA19.5 — title-bar rename reports a name collision.**
- **WI-RA19.6 — combined save dialog path display verified.**
- **WI-RA19.7 — Korean punctuation.**
- **WI-RA19.8 — website deploys when its imported app sources change; About docs.**
- **WI-RA19.9 — a size budget that matches no file fails.**
- **WI-RA19.10 — StepForm under the size limit.**

#### Phase RA7C — Rust class sweep
- **WI-RA7C.1 — lock poison recovered everywhere, and gated.**
- **WI-RA7C.2 — no unescaped external text in logs.**
- **WI-RA7C.3 — durable renames.**
- **WI-RA7C.4 — no blocking work on the IPC thread or async workers.**
- **WI-RA7C.5 — commands take the calling window, not a label.**
- **WI-RA7C.6 — terminal exit detection, bounded writes, transcript delta parse.**
- **WI-RA7C.7 — rescan re-checks open documents; dead watcher subscription.**
- **WI-RA7C.8 — quit readiness tied to the close listeners.**

#### Phase RA14E — remove the frozen sibling mocks
- **WI-RA14E.1 — zero sibling mocks of app logic, no baseline.**

#### Phase RA20 — Close All with pinned tabs, and defects found by RA19
- **WI-RA20.1 — Close All closes pinned tabs too, behind a confirmation (maintainer decision 2026-10-03).**
- **WI-RA20.2 — closing a workspace is not stopped by a pinned tab.**
- **WI-RA20.3 — the reveal label names the platform's file manager everywhere.**
- **WI-RA20.4 — shortcut import errors are translated.**
- **WI-RA20.5 — the untitled fallback filename is translated.**
- **WI-RA20.6 — the AI response listener is released on cancel.**
- **WI-RA20.7 — with no AI provider configured, a genie shows the no-provider message instead of falling back (maintainer decision 2026-10-03).**

#### Phase RA21 — BOM lost on open, and defects the journeys found
- **WI-RA21.1 — a file's BOM is detected from bytes at every open path.**
- **WI-RA21.2 — the filesystem test fake matches the real plugin.**
- **WI-RA21.3 — Replace keeps its place and never re-matches inserted text.**
- **WI-RA21.4 — the last requested language wins.**
- **WI-RA21.5 — persisted settings choices survive restart and cross-window reset.**
- **WI-RA21.6 — a skipped update is not announced.**
- **WI-RA21.7 — PDF export failure states and accessible names.**
- **WI-RA21.8 — an unsaved document has no export containment root.**

#### Phase RA22 — the parts RA21 could not reach
- **WI-RA22.1 — a cross-window settings reset reaches nullable and map-valued settings.**
- **WI-RA22.2 — nullable settings are type-checked at load.**
- **WI-RA22.3 — PDF margin inputs have accessible names.**
- **WI-RA22.4 — unsaved documents have an explicit no-root containment; drive-root workspaces can embed images.**
- **WI-RA22.5 — the remaining filesystem fakes decode like the real plugin.**
- **WI-RA22.6 — Source search keeps its place after a replace.**
- **WI-RA22.7 — the unsupported-encoding detail is translated.**

#### Phase RA23 — multi-cursor typing cost
- **WI-RA23.1 — typing, Backspace and Delete at N cursors cost at most ~linear in N (measured N^2.30, 273 ms per keystroke at 500 cursors).**

#### Phase RA24 — the remaining follow-ups
- **WI-RA24.1 — Source popup links open through the host opener.**
- **WI-RA24.2 — Source search keeps its place after edits; counts match highlights.**
- **WI-RA24.3 — PDF margin fields accept a transient empty value.**
- **WI-RA24.4 — no English literals in export naming and tab-drag hints.**
- **WI-RA24.5 — remaining stale docs and comments.**
- **WI-RA24.6 — stale dependency known-violation removed.**
- **WI-RA24.7 — property-test timeouts use the liveness bound; no wall-clock import waits.**
- **WI-RA24.8 — gate gaps: hooks under file-size, file locks in lock policy, sleeps in fake-timer files, alias-mocked app modules.**
- **WI-RA24.9 — every bundle budget near its measured size; lazy TOML parser.**
- **WI-RA24.10 — word movement and fence scanning are linear.**
- **WI-RA24.11 — CJK pairs never span a paragraph break.**
- **WI-RA24.12 — workflow shell scripts pass actionlint.** [no-test: config: workflow shell fixes; actionlint reports 0 errors]
- **WI-RA24.13 — dead code and never-failing assertions left by the save-all change.**

#### Phase RA25 — maintainer decisions of 2026-10-03
- **WI-RA25.1 — YouTube, Vimeo and Bilibili embeds work in release builds.**
- **WI-RA25.2 — Save All and Quit saves every window.**

Also decided 2026-10-03, no work item: multi-cursor has no cap; files that are not UTF-8 and carry no BOM keep opening (no refusal); Retry acts on the current selection; Close All closes pinned tabs behind a confirmation (WI-RA20.1); no-provider message (WI-RA20.7).

#### Phase RA26 — ratchet regressions and the last leftovers
- **WI-RA26.1 — the legacy command errors in moved files become CommandError; the ratchet holds against the start.**
- **WI-RA26.2 — the round-trip losses added during this work are fixed, not recorded.**
- **WI-RA26.3 — a failed workspace restore rolls back a media tab.**
- **WI-RA26.4 — the version global survives unstubAllGlobals.**
- **WI-RA26.5 — the remaining fence regexes are linear.**
- **WI-RA26.6 — history names use the translated untitled name.**
- **WI-RA26.7 — every tier has a liveness bound; no per-test performance timeouts; no wall-clock import waits.**
- **WI-RA26.8 — the max-file-size description is true.** [no-test: copy: a locale string; lint:i18n holds it]

#### Phase RA27 — media tab rollback on open
- **WI-RA27.1 — opening a media file rolls back its tab when a later step throws.**

#### Phase RA28 — the phase gate and the last comment leftovers
- **WI-RA28.1 — `scripts/check-repo-audit-phase.sh` checks every phase mechanically, self-tested.**
- **WI-RA28.2 — hook comments carry no dates or dev-docs paths, gated.**
- **WI-RA28.3 — the coupling gate's error names a document a clone can open.**
- **WI-RA28.4 — scripts carry no dangling audit ids, gated.**

### Wave 4 (cross-cutting, strictly serial, after everything else merged)

Order: RA14D (may move ahead into wave 3 once the behaviour lanes are merged), RA12B, RA17F, RA17E, RA17G, then the DoD script and the final gate pass. Ownership for wave 3 and 4 lanes is in each lane brief.

- **WI-RA12B.6 — Rust module folder moves** (`menu_events*`, `mcp_server*`, `workspace*`, `file_*`). Audit §5 Low.
- **WI-RA17E.5 — provenance IDs resolve or are replaced by the behavioural reason; the gate checks them.** Audit §5 Medium.
- **WI-RA17F.7 — every `eslint-disable` carries a reason; avoidable ones are removed; the `as unknown as` clusters go through typed helpers.** Audit §1 Low.
- **WI-RA17G.8 — one header grammar, gated.** Audit §9 Low.
- **WI-RA17G.9 — no calendar dates in production comments, gated.**
- **WI-RA17G.10 — no untracked dev-docs paths in production comments, gated.**
- **WI-RA17G.11 — the comment gates are documented in rule 22 and AGENTS.md.** [no-test: docs]
- **WI-RA14D.1 — `coverage.include` covers `src/**`; the 14 executable files with no test get tests; a fixture test pins the include.** Audit §7 High #1. (D8)

## Findings with no work item, and why

- §8 Low, vite/esbuild/browserslist advisories: the audit confirms the baseline reasons are accurate. Nothing to change.
- §8 Low, `.cc-suite/audits/*.md` and `.tokenize/` tracked: intentional per the audit.
- §4 Low, license inventory (`khroma`, `jszip`, MPL crates): no obligation beyond notices, which WI-RA15B.2 ships.
- §8 summary, 46 outdated packages / four majors: a summary statistic, not a finding; major upgrades are their own plans.
- §7 Low, RED-first ordering unverifiable from history: a property of how PRs are squashed, not a defect in the tree.
- §6 Low, hot-exit capture ships up to ~43× doc size at quit: needs a measurement and a protocol decision that belongs with decision D2 of the feature-ledger plan (capture-on-quit). Revisit there.

## Status trail

- **Waves 1–2 (19 lanes) merged, 2026-10-03.** On the merged tree: `pnpm check:predelta` 47/47, `pnpm check:all` exit 0 (app 43,301 tests with coverage floors, gates 3,170, sidecar 746, content server 261, build and size budgets), `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` (3,733), `check-cross-target.sh` all exit 0. Merge conflicts were baseline JSON (resolved to the lower value / both removals) and one real one: two lanes extracted the workspace legacy migration to different files; kept `workspace/legacy.rs` (superset) with both lanes' version-based sunset notes. Integration finding fixed at merge: the Rust CI filter missed `src/utils/sanitize.ts`, which a new Rust test reads.

## Codex review

Rule 60 §6. Codex (gpt-5.6-sol, effort high, read-only, refute mode with a mandatory check per objection), thread `01a0f9d5-7f69-7141-83e8-dde1d64403a8`, verdict on v1: MAJOR GAPS, 24 objections.

- **Survived / folded in:** per-lane WI namespaces (its `check-wi-linkage --phase=RA13` run matched both sub-lanes); the plan is now tracked so worktrees and the DoD script can read it; a DoD script per rule 60 §3; manifest-qualified cargo commands (no root `Cargo.toml`); cron is TypeScript (`src/lib/ghaWorkflow/cron/`), moved from the Rust workflow lane to RA3; `check-gha-phase.sh` is referenced by rule 60 and is not deleted; the seven journeys the audit names beyond hot-exit and MCP write are in WI-RA14C.5; `Date.now()` isolation added to the timer work; coverage floors are not lowered; sunset notes are version-based; wave 4 is serial; RA8 owns the window-builder call sites it needs (it runs after RA7 merges).
- **Overruled, with evidence:** "ownership missing for RA15a/RA16/waves 3–4" — the binding ownership lists are in the lane briefs, which Codex read only in part (RA15A's brief owns the privacy pages, `Cargo.toml` `rust-version` and the ledger citations; RA16's owns `pnpm-lock.yaml`). "RA13a cannot be green while the widened timer gate reports violations" — the widened rules land report-only behind a tested, loud switch and RA14A flips it in the commit that fixes the last violation. "Shared `CARGO_TARGET_DIR` convoy" — measured: 43 s cold crate build per worktree with shared dependencies; lanes iterate with filtered runs and the full suite runs centrally after each merge.
- **Unchecked:** whether every one of the audit's "17" phase scripts is orphaned (Codex counted 16 candidates) — the lane verifies each before deleting; D9's list of deviant plugin directories (Codex counted 11, the audit 12 + 3) — the lane enumerates and commits the list.
